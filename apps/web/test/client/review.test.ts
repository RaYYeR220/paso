import {
  DEFAULT_VALIDITY_LEDGERS,
  LEDGER_SECONDS,
  networkId,
  NETWORKS,
  prepare,
  RelayError,
  type PrepareOptions,
  type RelayResult,
} from "@paso/sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { parseArguments } from "@/lib/client/action/args";
import { createActionController, type ActionDeps } from "@/lib/client/action/controller";
import { isUnconfirmed, panelsOf, type ActionRequest } from "@/lib/client/action/machine";
import { comparePanels, differingLines, messageLines, type SignedMessage } from "@/lib/client/action/panels";
import { LATEST_LEDGER, owner, RECIPIENT, recordingServer, scripted, STELLAR_HASH, twin } from "./helpers";

const testnet = NETWORKS.testnet;
const mainnet = NETWORKS.mainnet;
const transferRequest: ActionRequest = { kind: "transfer", to: RECIPIENT, amount: "5" };
const VALID_MS = DEFAULT_VALIDITY_LEDGERS * LEDGER_SECONDS * 1000;

const offlinePrepare: typeof prepare = (action, options: PrepareOptions) => {
  const config = typeof options.network === "string" ? NETWORKS[options.network] : options.network;
  return prepare(action, { ...options, server: recordingServer(owner.address, config) });
};

function harness(script: (RelayResult | Error | (() => Promise<RelayResult>))[] = [{ hash: STELLAR_HASH }], overrides: Partial<ActionDeps> = {}, network = testnet) {
  const relay = scripted<RelayResult>(script);
  const clock = { now: 1_000_000 };
  const controller = createActionController(owner.address, {
    network,
    relayUrl: "/api/relay",
    resolveName: async () => null,
    now: () => clock.now,
    prepare: offlinePrepare,
    relay: relay as unknown as ActionDeps["relay"],
    ...overrides,
  });
  return { controller, relay, clock, signer: { signTypedData: vi.fn(owner.signTypedData) } };
}

describe("the network in the review", () => {
  const message = (salt: string): SignedMessage => ({
    salt: salt as SignedMessage["salt"],
    account: twin,
    calls: [{ contract: testnet.stellar.usdc, fn: "transfer", args: [twin, RECIPIENT, "5"] }],
    payload: "0x01",
  });

  it("is the first line of the message, with what the salt means in words", () => {
    expect(messageLines(message(networkId(testnet)))[0]).toEqual({
      id: "salt",
      label: "salt",
      value: networkId(testnet),
      name: "Stellar testnet",
      differs: false,
    });
    expect(messageLines(message(networkId(mainnet)))[0]).toMatchObject({ value: networkId(mainnet), name: "Stellar mainnet" });
    expect(messageLines(message(`0x${"ab".repeat(32)}`))[0]).toMatchObject({ name: "not a network this app knows" });
  });

  it("differs when the wallet was shown one network and the contract checks another", () => {
    const shown = message(networkId(testnet));
    const rebuilt = message(networkId(mainnet));

    expect(differingLines(shown, rebuilt)).toEqual(["salt"]);
    expect(comparePanels(shown, rebuilt, "refused").wallet[0]).toMatchObject({ id: "salt", differs: true });
  });

  it("comes from the prepared call itself, on each network", async () => {
    for (const network of [testnet, mainnet]) {
      const { controller, signer } = harness(undefined, {}, network);
      await controller.prepare(transferRequest);
      const review = controller.getState();
      expect(review).toMatchObject({ phase: "review", network: network.name, message: { salt: networkId(network) } });
      expect(panelsOf(review).wallet[0]).toMatchObject({ id: "salt", name: `Stellar ${network.name}` });

      await controller.sign(signer);
      const done = controller.getState();
      expect(done).toMatchObject({ phase: "done", attempted: { salt: networkId(network) } });
      expect(panelsOf(done).contract?.[0]).toMatchObject({ id: "salt", name: `Stellar ${network.name}`, differs: false });
    }
  });
});

describe("how long a signature lasts", () => {
  it("is about two minutes, and the review says until when", async () => {
    const { controller, clock } = harness();

    await controller.prepare(transferRequest);

    expect(VALID_MS).toBe(120_000);
    expect(controller.getState()).toMatchObject({
      phase: "review",
      validUntilLedger: LATEST_LEDGER + DEFAULT_VALIDITY_LEDGERS,
      expiresAt: clock.now + VALID_MS,
    });
  });

  it("is not asked for when too little of it is left to get the call through", async () => {
    const early = harness();
    await early.controller.prepare(transferRequest);
    early.clock.now += 79_000;
    await early.controller.sign(early.signer);
    expect(early.signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(early.controller.getState().phase).toBe("done");

    const late = harness();
    await late.controller.prepare(transferRequest);
    late.clock.now += 81_000;
    await late.controller.sign(late.signer);
    expect(late.signer.signTypedData).not.toHaveBeenCalled();
    expect(late.controller.getState()).toMatchObject({ phase: "expired", detail: "This request was prepared too long ago to be signed." });

    // One click prepares it afresh, with a new two minutes.
    await late.controller.signAgain(late.signer);
    expect(late.controller.getState()).toMatchObject({ phase: "done", expiresAt: late.clock.now + VALID_MS });
  });

  it("is what bounds the questions to a relayer that does not answer: half a minute past it, they stop", async () => {
    vi.useFakeTimers();
    try {
      const lost = () => new RelayError("relay_failed", 0, "fetch failed");
      const calls: number[] = [];
      const { controller, clock } = harness([], {
        retryDelayMs: 30_000,
        relay: (async () => {
          calls.push(clock.now);
          throw lost();
        }) as ActionDeps["relay"],
      });
      const start = clock.now;
      await controller.prepare(transferRequest);
      const signing = controller.sign(owner);
      for (let i = 0; i < 40; i += 1) {
        await vi.advanceTimersByTimeAsync(8_000);
        clock.now += 8_000;
      }
      await signing;

      const state = controller.getState();
      expect(isUnconfirmed(state)).toBe(true);
      expect(Math.max(...calls) - start).toBeLessThanOrEqual(VALID_MS + 30_000);
      expect(calls.length).toBeGreaterThan(3);
      // The signed request is still good until then: the state says when.
      expect(state.phase === "failed" && state.review).toMatchObject({ expiresAt: start + VALID_MS });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a generic call in the review", () => {
  const invoke = (args: string): ActionRequest => ({
    kind: "invoke",
    contract: testnet.stellar.usdc,
    fn: "approve",
    args: parseArguments(args),
  });

  it("marks every argument with its type, which the wallet's text does not carry", async () => {
    const { controller } = harness();
    await controller.prepare(invoke([`address:${twin}`, `address:${RECIPIENT}`, "i128:5", "string:5", "u32:1200"].join("\n")));

    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", cautions: [] });
    const args = panelsOf(review).wallet.filter((line) => line.label === "args");
    expect(args.map((line) => [line.value, line.type])).toEqual([
      [twin, "address"],
      [RECIPIENT, "address"],
      ["5", "i128"],
      ["5", "string"],
      ["1200", "u32"],
    ]);
    expect(args.every((line) => line.warning === undefined)).toBe(true);
  });

  it("flags text that can mislead in a wallet, and does not sign until the owner has said they read it", async () => {
    const { controller, signer } = harness();
    await controller.prepare({
      kind: "invoke",
      contract: testnet.stellar.usdc,
      fn: "approve",
      args: [
        ...parseArguments(`address:${twin}`),
        nativeToScVal("1\nfn: transfer", { type: "string" }),
        nativeToScVal(RECIPIENT, { type: "string" }),
        ...parseArguments("symbol:ok"),
      ],
    });

    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", cautions: ["arguments"] });
    const args = panelsOf(review).wallet.filter((line) => line.label === "args");
    expect(args.map((line) => line.warning)).toEqual([
      undefined,
      "contains a line break, and text shaped like another line of the message",
      "looks like an address, and is text",
      undefined,
    ]);

    await controller.sign(signer);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    await controller.sign(signer, { confirmed: ["arguments"] });
    expect(controller.getState().phase).toBe("done");
  });

  it("says when a value cannot be read at all", async () => {
    const { controller } = harness();
    const request: ActionRequest = {
      kind: "invoke",
      contract: testnet.stellar.usdc,
      fn: "swap",
      args: [nativeToScVal([1, 2, 3])],
    };
    await controller.prepare(request);

    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", cautions: ["arguments"] });
    expect(panelsOf(review).wallet.find((line) => line.label === "args")).toMatchObject({
      type: "vec",
      warning: "bound by its hash: the value itself cannot be read here",
    });
  });

  it("leaves the transfers and the exits the app builds as they were: no types, no flags", async () => {
    const { controller } = harness();
    await controller.prepare(transferRequest);

    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", cautions: [] });
    expect(panelsOf(review).wallet.every((line) => line.type === undefined && line.warning === undefined)).toBe(true);
  });
});
