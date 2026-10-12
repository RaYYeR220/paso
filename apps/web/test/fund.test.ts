import { NETWORKS, twinAddress } from "@paso/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as fundRoute } from "@/app/api/demo/fund/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { getRelayer, Relayer, type DemoFundResult } from "@/lib/server/relayer";
import { live, post } from "./helpers";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const env = { RELAYER_SECRET: Keypair.random().secret(), DEMO_PAYER_PRIVATE_KEY: generatePrivateKey() };
const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;

/** A relayer whose burn on Base is replaced, so only the faucet's rules are exercised. */
function faucet(overrides: Record<string, string> = {}, burn?: () => Promise<DemoFundResult>) {
  const relayer = new Relayer(loadConfig({ ...env, ...overrides }));
  const internals = relayer as unknown as { burnForDemo: (owner: string) => Promise<DemoFundResult> };
  const burnForDemo = vi.spyOn(internals, "burnForDemo").mockImplementation(
    burn ??
      (async (owner) => ({
        burnTxHash: `0x${"ab".repeat(32)}`,
        sourceDomain: 6,
        twin: twinAddress(owner as `0x${string}`, "testnet"),
        amount: "1000000",
      })),
  );
  return { relayer, burnForDemo };
}

afterEach(() => vi.restoreAllMocks());

describe("the demo faucet", () => {
  it("burns one USDC for the owner's account and says where to follow it", async () => {
    const { relayer, burnForDemo } = faucet();
    const owner = randomOwner();

    expect(await relayer.demoFund({ owner }, "203.0.113.1")).toEqual({
      burnTxHash: `0x${"ab".repeat(32)}`,
      sourceDomain: 6,
      twin: twinAddress(owner, "testnet"),
      amount: "1000000",
    });
    expect(burnForDemo).toHaveBeenCalledWith(owner, relayer.config.payer?.address);
  });

  it("funds an owner twice a day and no more, whoever asks", async () => {
    const { relayer, burnForDemo } = faucet();
    const owner = randomOwner();

    await relayer.demoFund({ owner }, "203.0.113.1");
    await relayer.demoFund({ owner: owner.toLowerCase() }, "203.0.113.2");
    const refused = await relayer.demoFund({ owner }, "203.0.113.3").catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("rate_limited");
    expect((refused as ApiError).status).toBe(429);
    expect((refused as ApiError).extra.retryAfterSeconds).toBeGreaterThan(23 * 3600);
    expect(burnForDemo).toHaveBeenCalledTimes(2);
  });

  it("serves a caller five times an hour and no more, whatever the owner", async () => {
    const { relayer, burnForDemo } = faucet();

    for (let i = 0; i < 5; i += 1) await relayer.demoFund({ owner: randomOwner() }, "203.0.113.9");
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.9")).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.10")).resolves.toBeDefined();
    expect(burnForDemo).toHaveBeenCalledTimes(6);
  });

  it("does not count a request that failed", async () => {
    let attempts = 0;
    const { relayer } = faucet({ DEMO_FUND_PER_IP_PER_HOUR: "1", DEMO_FUND_PER_OWNER_PER_DAY: "1" }, async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rpc"), { shortMessage: "insufficient funds for gas" });
      return { burnTxHash: "0x00", sourceDomain: 6, twin: "C", amount: "1000000" };
    });
    const owner = randomOwner();

    await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("insufficient funds for gas"),
    });
    await expect(relayer.demoFund({ owner }, "203.0.113.1")).resolves.toBeDefined();
    await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("burns one request at a time, so the payer's transactions keep their order", async () => {
    const order: string[] = [];
    const { relayer } = faucet({}, async () => {
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("end");
      return { burnTxHash: "0x00", sourceDomain: 6, twin: "C", amount: "1000000" };
    });

    await Promise.all([
      relayer.demoFund({ owner: randomOwner() }, "203.0.113.1"),
      relayer.demoFund({ owner: randomOwner() }, "203.0.113.2"),
    ]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("exists on testnet only", async () => {
    const { relayer, burnForDemo } = faucet({ PASO_NETWORK: "mainnet" });

    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(burnForDemo).not.toHaveBeenCalled();
  });

  it("is unavailable without a payer, and refuses anything but an Ethereum address", async () => {
    const without = new Relayer(loadConfig({ RELAYER_SECRET: env.RELAYER_SECRET }));
    await expect(without.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
    });

    const { relayer } = faucet();
    await expect(relayer.demoFund({ owner: "GABC" }, "203.0.113.1")).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.demoFund(null, "203.0.113.1")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe.skipIf(!live)("on testnet", () => {
  it("GET /api/health reports the network, the relayer and the payer, and no secrets", async () => {
    const response = await healthRoute();
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      network: "testnet",
      hub: NETWORKS.testnet.stellar.hub,
      relayer: { address: getRelayer().address, xlm: expect.stringMatching(/^\d+(\.\d+)?$/) },
      maxResourceFee: "5000000",
    });
    expect(body.latestLedger).toBeGreaterThan(0);
    expect(Number(body.relayer.xlm)).toBeGreaterThan(1);
    if (process.env.DEMO_PAYER_PRIVATE_KEY) {
      expect(body.payer).toMatchObject({
        address: privateKeyToAccount(process.env.DEMO_PAYER_PRIVATE_KEY as `0x${string}`).address,
        chain: "Base Sepolia",
        usdc: expect.stringMatching(/^\d+(\.\d+)?$/),
        eth: expect.stringMatching(/^\d+(\.\d+)?$/),
      });
    }
    for (const secret of [process.env.RELAYER_SECRET, process.env.DEMO_PAYER_PRIVATE_KEY]) {
      if (secret) expect(text).not.toContain(secret);
    }
  });

  it("POST /api/demo/fund says so when the payer has no test USDC, and does not count the request", async () => {
    const health = await (await healthRoute()).json();
    if (!health.payer || Number(health.payer.usdc) >= 1) return;
    const owner = randomOwner();

    for (let i = 0; i < 3; i += 1) {
      const response = await fundRoute(post("/api/demo/fund", { owner }, { "x-forwarded-for": "198.51.100.77" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "unavailable", detail: expect.stringContaining("out of test USDC") });
    }
  });
});
