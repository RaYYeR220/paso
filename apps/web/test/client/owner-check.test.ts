import { NETWORKS, prepare, twinAddress, type OwnerCheck, type OwnerKind, type PrepareOptions, type RelayResult } from "@paso/sdk";
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createActionController, type ActionDeps, type RecipientCheck } from "@/lib/client/action/controller";
import { cautionsFor, type ActionRequest } from "@/lib/client/action/machine";
import { createOwnerChecker } from "@/lib/client/ownerCheck";
import { owner, RECIPIENT, recordingServer, scripted, STELLAR_HASH } from "./helpers";

const mainnet = NETWORKS.mainnet;
const OTHER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const offlinePrepare: typeof prepare = (action, options: PrepareOptions) =>
  prepare(action, { ...options, server: recordingServer(owner.address, mainnet) });

function harness(check: RecipientCheck | Error | null, overrides: Partial<ActionDeps> = {}) {
  const relay = scripted<RelayResult>([{ hash: STELLAR_HASH }]);
  const inspectRecipient = vi.fn(async (): Promise<RecipientCheck> => {
    if (check instanceof Error) throw check;
    return check ?? { kind: "wallet", deployed: true };
  });
  const controller = createActionController(owner.address, {
    network: mainnet,
    relayUrl: "/api/relay",
    resolveName: async (name) => (name === "safe.eth" ? OTHER : null),
    prepare: offlinePrepare,
    relay: relay as unknown as ActionDeps["relay"],
    inspectRecipient,
    ...overrides,
  });
  const signer = { signTypedData: vi.fn(owner.signTypedData) };
  return { controller, relay, signer, inspectRecipient };
}

const to = (recipient: string): ActionRequest => ({ kind: "transfer", to: recipient, amount: "1" });

describe("sending to the account of an Ethereum address", () => {
  it("is blocked when the address is a smart contract, until that is overridden in so many words", async () => {
    const { controller, signer, relay, inspectRecipient } = harness({ kind: "contract", deployed: false });

    await controller.prepare(to(OTHER));
    expect(inspectRecipient).toHaveBeenCalledWith(OTHER);
    expect(controller.getState()).toMatchObject({ phase: "review", cautions: ["recipient_contract"] });

    await controller.sign(signer);
    await controller.sign(signer, { confirmed: ["recipient_unknown"] });
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(relay.calls).toHaveLength(0);
    expect(controller.getState().phase).toBe("review");

    await controller.sign(signer, { confirmed: ["recipient_contract"] });
    expect(controller.getState()).toMatchObject({ phase: "done" });
  });

  it("asks for a confirmation when the address could not be checked, or the check itself failed", async () => {
    for (const check of [{ kind: "unknown", deployed: null } as RecipientCheck, new Error("fetch failed")]) {
      const { controller, signer } = harness(check);
      await controller.prepare(to(OTHER));
      expect(controller.getState()).toMatchObject({ phase: "review", cautions: ["recipient_unknown"] });

      await controller.sign(signer);
      expect(signer.signTypedData).not.toHaveBeenCalled();
      await controller.sign(signer, { confirmed: ["recipient_unknown"] });
      expect(controller.getState().phase).toBe("done");
    }
  });

  it("says that a smart wallet not deployed yet cannot be told apart, for an address that has never used its account", async () => {
    const { controller, signer } = harness({ kind: "wallet", deployed: false });

    await controller.prepare(to(OTHER));
    expect(controller.getState()).toMatchObject({ phase: "review", cautions: ["recipient_unproven"] });
    await controller.sign(signer);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    await controller.sign(signer, { confirmed: ["recipient_unproven"] });
    expect(controller.getState().phase).toBe("done");
  });

  it("asks nothing for a regular wallet whose account exists", async () => {
    const { controller, signer } = harness({ kind: "wallet", deployed: true });

    await controller.prepare(to(OTHER));
    expect(controller.getState()).toMatchObject({ phase: "review", cautions: [] });
    await controller.sign(signer);
    expect(controller.getState().phase).toBe("done");
  });

  it("checks the address behind a name the same way", async () => {
    const { controller, inspectRecipient } = harness({ kind: "contract", deployed: false });

    await controller.prepare(to("safe.eth"));

    expect(inspectRecipient).toHaveBeenCalledWith(OTHER);
    expect(controller.getState()).toMatchObject({ phase: "review", cautions: ["recipient_contract"], recipient: { kind: "ens", evm: OTHER } });
  });

  it("does not ask about a Stellar address, the owner's own address, or the recipient of a transfer back to Base", async () => {
    for (const request of [
      to(RECIPIENT),
      to(owner.address),
      to(twinAddress(OTHER, mainnet)),
      { kind: "exit", recipient: OTHER, amount: "1" } as ActionRequest,
    ]) {
      const { controller, inspectRecipient } = harness({ kind: "contract", deployed: false });
      await controller.prepare(request);
      expect(inspectRecipient).not.toHaveBeenCalled();
      expect(controller.getState()).toMatchObject({ phase: "review", cautions: [] });
    }
  });

  it("asks again, and needs the answer again, when an expired request is signed anew", async () => {
    const { controller, signer, clock } = (() => {
      const clock = { now: 1_000 };
      return { ...harness({ kind: "contract", deployed: false }, { now: () => clock.now }), clock };
    })();
    await controller.prepare(to(OTHER));
    clock.now += 10 * 60_000;
    await controller.sign(signer, { confirmed: ["recipient_contract"] });
    expect(controller.getState().phase).toBe("expired");

    await controller.signAgain(signer);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ phase: "review", cautions: ["recipient_contract"] });
    await controller.sign(signer, { confirmed: ["recipient_contract"] });
    expect(controller.getState().phase).toBe("done");
  });
});

describe("which cautions a recipient calls for", () => {
  it("puts a contract before everything else", () => {
    expect(cautionsFor({ kind: "contract", deployed: true })).toEqual(["recipient_contract"]);
    expect(cautionsFor({ kind: "contract", deployed: null })).toEqual(["recipient_contract"]);
    expect(cautionsFor({ kind: "unknown", deployed: true })).toEqual(["recipient_unknown"]);
    expect(cautionsFor({ kind: "wallet", deployed: null })).toEqual(["recipient_unproven"]);
    expect(cautionsFor({ kind: "wallet", deployed: false })).toEqual(["recipient_unproven"]);
    expect(cautionsFor({ kind: "wallet", deployed: true })).toEqual([]);
    expect(cautionsFor(null)).toEqual([]);
  });
});

describe("asking once per address", () => {
  const answer = (kind: OwnerKind): OwnerCheck => ({ kind, chains: [] });

  it("keeps an answer that settles the question, and asks again after one that does not", async () => {
    const kinds: OwnerKind[] = ["unknown", "wallet", "contract"];
    const ask = vi.fn(async () => answer(kinds.shift() ?? "contract"));
    const check = createOwnerChecker(ask);

    expect((await check(OTHER)).kind).toBe("unknown");
    expect((await check(OTHER)).kind).toBe("wallet");
    expect((await check(OTHER.toLowerCase() as Address)).kind).toBe("wallet");
    expect(ask).toHaveBeenCalledTimes(2);
    expect((await check(owner.address)).kind).toBe("contract");
  });

  it("shares one question between callers that ask at the same time, and answers unknown when the question fails", async () => {
    const ask = vi.fn(async () => answer("wallet"));
    const check = createOwnerChecker(ask);
    await Promise.all([check(OTHER), check(OTHER), check(OTHER)]);
    expect(ask).toHaveBeenCalledTimes(1);

    const failing = createOwnerChecker(async () => Promise.reject(new Error("fetch failed")));
    expect(await failing(OTHER)).toEqual({ kind: "unknown", chains: [] });
  });
});
