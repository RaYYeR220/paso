import { isDeployed, twinAddress } from "@paso/sdk";
import { rpc } from "@stellar/stellar-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { parseArguments } from "@/lib/client/action/args";
import { createActionController } from "@/lib/client/action/controller";
import { panelsOf, type ActionRequest } from "@/lib/client/action/machine";
import { networkConfig, ROUTES } from "@/lib/client/config";
import { ensureDemoKey } from "@/lib/client/demoKey";
import { memoryStorage } from "@/lib/client/storage";
import { recordingLog } from "./helpers";

/**
 * Runs the outbound flow for real, the way a visitor without a wallet does:
 * a key made on the spot, no funds, the app's own relayer.
 *
 *   PASO_SMOKE_URL=http://localhost:3000 pnpm test:web test/client/smoke.test.ts
 *
 * It reaches Stellar testnet and the server at that address, so it only runs
 * when the address is given.
 */
const baseUrl = process.env.PASO_SMOKE_URL?.replace(/\/$/, "");
const NETWORK = networkConfig("testnet");

describe.skipIf(!baseUrl)("live: a demo key against a running server", () => {
  it("relays a signed approval, then is refused when the same call is altered after signing", async () => {
    const account = privateKeyToAccount(ensureDemoKey("testnet", memoryStorage()));
    const signer = { signTypedData: account.signTypedData };
    const twin = twinAddress(account.address, NETWORK);
    const { usdc, hub, rpcUrl } = NETWORK.stellar;
    const server = new rpc.Server(rpcUrl);
    const log = recordingLog();
    const controller = createActionController(account.address, {
      network: NETWORK,
      relayUrl: `${baseUrl}${ROUTES.relay}`,
      resolveName: async () => null,
      log: log.for,
    });

    /** USDC `approve(from = account, spender = hub, amount = 1, expiration_ledger = now + 200)`: needs a signature, no balance. */
    const approval = async (): Promise<ActionRequest> => {
      const { sequence } = await server.getLatestLedger();
      return {
        kind: "invoke",
        contract: usdc,
        fn: "approve",
        args: parseArguments([`address:${twin}`, `address:${hub}`, "i128:1", `u32:${sequence + 200}`].join("\n")),
      };
    };

    expect(await isDeployed(account.address, NETWORK, server)).toBe(false);

    await controller.prepare(await approval());
    const review = controller.getState();
    expect(review, JSON.stringify(review)).toMatchObject({ phase: "review" });
    if (review.phase !== "review") return;
    expect(review.calls).toMatchObject([{ contract: usdc, fn: "approve", args: [twin, hub, "1", expect.any(String)] }]);

    const startedAt = Date.now();
    await controller.sign(signer);
    const done = controller.getState();
    expect(done, JSON.stringify(done)).toMatchObject({ phase: "done" });
    if (done.phase !== "done") return;
    expect(done.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(panelsOf(done).verdict).toBe("match");
    expect(await isDeployed(account.address, NETWORK, server)).toBe(true);
    console.info(
      `[smoke] owner ${account.address} account ${twin}\n` +
        `[smoke] approve relayed in ${Date.now() - startedAt} ms: ${done.hash}` +
        (done.deployHash ? ` (account deployed in ${done.deployHash})` : ""),
    );

    controller.reset();
    await controller.prepare(await approval());
    const tamperedAt = Date.now();
    await controller.sign(signer, { tamper: true });
    const refused = controller.getState();
    expect(refused, JSON.stringify(refused)).toMatchObject({ phase: "refused", code: "bad_signature", tampered: true });
    if (refused.phase !== "refused") return;
    expect(refused.shownCalls[0]?.args[2]).toBe("1");
    expect(refused.attemptedCalls[0]?.args[2]).toBe("10");
    expect(panelsOf(refused).differingLines).toEqual(["call.0.args.2", "payload"]);
    console.info(
      `[smoke] altered approve refused in ${Date.now() - tamperedAt} ms: ${refused.code} — ${refused.detail}\n` +
        `[smoke] wallet showed amount ${refused.shownCalls[0]?.args[2]}, submitted ${refused.attemptedCalls[0]?.args[2]}`,
    );

    expect([...log.entries.values()].map((entry) => entry.kind).sort()).toEqual(["call", "refused"]);
  }, 180_000);
});
