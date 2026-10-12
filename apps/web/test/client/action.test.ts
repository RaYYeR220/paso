import { prepare, RelayError, SimulationError, type PrepareOptions, type RelayResult, type Signed } from "@paso/sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { parseArguments } from "@/lib/client/action/args";
import {
  createActionController,
  defaultTamper,
  messageOfEntry,
  postRelay,
  type ActionDeps,
  type RelayFacts,
} from "@/lib/client/action/controller";
import {
  actionReducer,
  IDLE_ACTION,
  isActionBusy,
  isUnconfirmed,
  panelsOf,
  reviewOf,
  type ActionEvent,
  type ActionRequest,
  type ActionState,
  type Review,
} from "@/lib/client/action/machine";
import { comparePanels, differingLines, messageLines, type SignedMessage } from "@/lib/client/action/panels";
import type { ProblemError } from "@/lib/client/errors";
import { LATEST_LEDGER, network, owner, RECIPIENT, recordingLog, recordingServer, scripted, settle, STELLAR_HASH, twin, until } from "./helpers";

const USDC = network.stellar.usdc;
const HUB = network.stellar.hub;
const transferRequest: ActionRequest = { kind: "transfer", to: RECIPIENT, amount: "5" };

const offlinePrepare: typeof prepare = (action, options: PrepareOptions) => prepare(action, { ...options, server: recordingServer() });

function harness(script: { relay?: (RelayResult | Error)[] } = {}, overrides: Partial<ActionDeps> = {}) {
  const relay = scripted<RelayResult>(script.relay ?? [{ hash: STELLAR_HASH }]);
  const log = recordingLog();
  const clock = { now: 1_000_000 };
  const controller = createActionController(owner.address, {
    network,
    relayUrl: "/api/relay",
    resolveName: async () => null,
    log: log.for,
    now: () => clock.now,
    prepare: offlinePrepare,
    relay: relay as unknown as ActionDeps["relay"],
    ...overrides,
  });
  const phases: string[] = [];
  controller.subscribe(() => phases.push(controller.getState().phase));
  return { controller, relay, log, clock, phases };
}

const submittedTo = (relay: ReturnType<typeof scripted<RelayResult>>, call = 0) => relay.calls[call]?.[0] as Signed;

/** A relayer's refusal, with what it says about sending. */
const answer = (code: ConstructorParameters<typeof RelayError>[0], status: number, detail: string, facts: RelayFacts = {}) =>
  Object.assign(new RelayError(code, status, detail), facts);
/** A refusal the relayer decided before sending anything, having checked that the call has not run. */
const notSent = (code: ConstructorParameters<typeof RelayError>[0], detail: string) => answer(code, 422, detail, { sent: false });

const fixtureMessage: SignedMessage = {
  account: twin,
  calls: [{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "5"] }],
  payload: "0x01",
};
const reviewFixture: Review = {
  request: transferRequest,
  owner: owner.address,
  prepared: { calls: fixtureMessage.calls } as Review["prepared"],
  calls: fixtureMessage.calls,
  message: fixtureMessage,
  recipient: null,
  amount: 5n,
  preparedAt: 1,
};

describe("the outbound flow", () => {
  it("prepares, shows exactly what the wallet will show, signs and relays", async () => {
    const { controller, relay, log, phases } = harness({ relay: [{ hash: STELLAR_HASH, deployHash: "aa".repeat(32) }] });

    await controller.prepare(transferRequest);
    const review = controller.getState();
    expect(review.phase).toBe("review");
    if (review.phase !== "review") return;
    expect(review.calls).toEqual([{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "50000000"] }]);
    expect(review.calls).toBe(review.prepared.calls);
    expect(review.message).toEqual({
      account: twin,
      calls: review.calls,
      payload: review.prepared.typedData.message.payload,
    });
    expect(review.amount).toBe(50_000_000n);
    expect(review.recipient).toEqual({ input: RECIPIENT, kind: "stellar", stellar: RECIPIENT });
    expect(review.prepared.validUntilLedger).toBe(LATEST_LEDGER + 120);
    expect(panelsOf(review)).toMatchObject({ verdict: "unsigned", contract: null, differingLines: [] });

    await controller.sign(owner);
    const done = controller.getState();
    expect(phases).toEqual(["preparing", "review", "signing", "relaying", "done"]);
    expect(done).toMatchObject({ phase: "done", hash: STELLAR_HASH, deployHash: "aa".repeat(32), tampered: false });
    if (done.phase !== "done") return;
    expect(done.attemptedCalls).toEqual(done.shownCalls);
    expect(done.attempted).toEqual(done.message);
    expect(panelsOf(done)).toMatchObject({ verdict: "match", differingLines: [] });

    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.[1]).toBe("/api/relay");
    expect(submittedTo(relay).signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(log.entries.get(`tx:${STELLAR_HASH}`)).toMatchObject({
      kind: "send",
      status: "done",
      amount: "50000000",
      counterparty: RECIPIENT,
      stellarTxHash: STELLAR_HASH,
    });
  });

  it("sends to the Stellar account of an Ethereum address or a name", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const { controller } = harness({}, { resolveName: async (name) => (name === "friend.eth" ? other.address : null) });
    await controller.prepare({ kind: "transfer", to: "friend.eth", amount: "1" });
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "review", recipient: { kind: "ens", name: "friend.eth", evm: other.address } });
    if (state.phase !== "review") return;
    expect(state.calls[0]?.args[1]).toBe(state.recipient?.stellar);
    expect(state.calls[0]?.args[1]).not.toBe(twin);
  });

  it("relays a generic call and logs it under its function name", async () => {
    const { controller, log } = harness();
    const args = parseArguments(`address:${twin}\naddress:${HUB}\ni128:1\nu32:${LATEST_LEDGER + 200}`);
    await controller.prepare({ kind: "invoke", contract: USDC, fn: "approve", args });
    const review = controller.getState();
    expect(review.phase === "review" && review.calls).toEqual([
      { contract: USDC, fn: "approve", args: [twin, HUB, "1", String(LATEST_LEDGER + 200)] },
    ]);
    await controller.sign(owner);
    expect(controller.getState().phase).toBe("done");
    expect(log.entries.get(`tx:${STELLAR_HASH}`)).toMatchObject({ kind: "call", note: "approve", counterparty: USDC, amount: null });
  });
});

describe("tampering after the signature", () => {
  const refusal = notSent(
    "bad_signature",
    "The account refused the signature with BadSignature (account error #2): the call that would run is not the call the owner signed",
  );

  it("is refused, and both versions of the call are reported with the line that differs", async () => {
    const { controller, relay, log, phases } = harness({ relay: [refusal] });
    await controller.prepare(transferRequest);
    await controller.sign(owner, { tamper: true });

    const state = controller.getState();
    expect(phases).toEqual(["preparing", "review", "signing", "relaying", "refused"]);
    expect(state.phase).toBe("refused");
    if (state.phase !== "refused") return;

    expect(state.code).toBe("bad_signature");
    expect(state.txHash).toBeNull();
    expect(state.detail).toContain("BadSignature");
    expect(state.reason).toBe("BadSignature (#2): the transaction does not match what was signed. Nothing moved.");
    expect(state.tampered).toBe(true);
    expect(state.shownCalls).toEqual([{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "50000000"] }]);
    expect(state.attemptedCalls).toEqual([{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "500000000"] }]);

    const panels = panelsOf(state, (address) => (address === USDC ? "USDC" : undefined));
    expect(panels.verdict).toBe("refused");
    expect(panels.differingLines).toEqual(["call.0.args.2", "payload"]);
    expect(panels.wallet.filter((line) => line.differs).map((line) => line.value)).toEqual(["50000000", state.message.payload]);
    expect(panels.contract?.filter((line) => line.differs).map((line) => line.value)).toEqual(["500000000", state.attempted.payload]);
    expect(panels.wallet.find((line) => line.label === "contract")).toMatchObject({ value: USDC, name: "USDC", differs: false });
    expect(state.attempted.payload).not.toBe(state.message.payload);

    // What went to the relayer is the altered call under the untouched signature.
    const submitted = submittedTo(relay);
    expect(messageOfEntry(submitted.entries[0]!, network).calls).toEqual(state.attemptedCalls);
    expect(submitted.calls).toEqual(state.shownCalls);
    expect(log.entries.size).toBe(1);
    expect([...log.entries.values()][0]).toMatchObject({ kind: "refused", status: "refused", note: "did not match the signature" });
  });

  it("alters the argument it is told to", async () => {
    const { controller } = harness({ relay: [refusal] });
    await controller.prepare(transferRequest);
    await controller.sign(owner, { tamper: { index: 1, value: nativeToScVal(HUB, { type: "address" }) } });
    const state = controller.getState();
    expect(state.phase === "refused" && state.attemptedCalls[0]?.args).toEqual([twin, HUB, "50000000"]);
    expect(state.phase === "refused" && panelsOf(state).differingLines).toEqual(["call.0.args.1", "payload"]);
  });

  it("picks the amount by default: ten times over, or one where there was none", async () => {
    const { controller, relay } = harness({ relay: [{ hash: STELLAR_HASH }, { hash: STELLAR_HASH }] });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    const transfer = defaultTamper(submittedTo(relay));
    expect(transfer.index).toBe(2);
    expect(transfer.value.type === "scvI128" && transfer.value.i128.lo).toBe(500_000_000n);

    controller.reset();
    await controller.prepare({ kind: "invoke", contract: USDC, fn: "approve", args: parseArguments(`address:${twin}\naddress:${HUB}\ni128:0\nu32:9`) });
    await controller.sign(owner);
    const approve = defaultTamper(submittedTo(relay, 1));
    expect(approve.index).toBe(2);
    expect(approve.value.type === "scvI128" && approve.value.i128.lo).toBe(1n);
  });

  it("fails cleanly when the call has nothing to alter", async () => {
    const { controller, relay } = harness();
    await controller.prepare({ kind: "invoke", contract: USDC, fn: "authorized", args: parseArguments(`address:${twin}`) });
    await controller.sign(owner, { tamper: true });
    expect(controller.getState()).toMatchObject({ phase: "failed", stage: "sign", error: { message: "This call has no amount to alter" } });
    expect(relay.calls).toHaveLength(0);
  });
});

describe("refusals that are not about the signature", () => {
  it("reports a call that would fail as refused, with identical calls", async () => {
    const { controller } = harness({ relay: [notSent("simulation_failed", "HostError: Error(Contract, #10)")] });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "refused", code: "simulation_failed", tampered: false, txHash: null });
    expect(state.phase === "refused" && state.reason).toBe("The call would fail, so it was not sent. The account does not hold enough USDC.");
    expect(state.phase === "refused" && panelsOf(state)).toMatchObject({ verdict: "refused", differingLines: [] });
  });
});

describe("an expired signature", () => {
  const expired = new RelayError("expired", 409, "The signature was valid up to ledger 5000120 and the network is at 5000121; prepare and sign again");

  it("asks to sign again, and one click prepares, signs and relays the same request", async () => {
    const { controller, relay, phases } = harness({ relay: [expired, { hash: STELLAR_HASH }] });
    await controller.prepare(transferRequest);
    const first = reviewOf(controller.getState())!;
    await controller.sign(owner);

    const state = controller.getState();
    expect(state).toMatchObject({ phase: "expired", request: transferRequest });
    expect(state.phase === "expired" && state.detail).toContain("prepare and sign again");
    expect(panelsOf(state)).toMatchObject({ verdict: "unsigned", contract: null });

    await controller.signAgain(owner);
    expect(phases).toEqual(["preparing", "review", "signing", "relaying", "expired", "preparing", "review", "signing", "relaying", "done"]);
    expect(controller.getState()).toMatchObject({ phase: "done", hash: STELLAR_HASH, calls: first.calls });
    expect(relay.calls).toHaveLength(2);
    expect(submittedTo(relay, 1).signature).toMatch(/^0x/);
  });

  it("does not ask the wallet to sign a request that has gone stale", async () => {
    const signer = { signTypedData: vi.fn(owner.signTypedData) };
    const { controller, relay, clock } = harness({}, { staleAfterMs: 60_000 });
    await controller.prepare(transferRequest);
    clock.now += 61_000;
    await controller.sign(signer);
    expect(controller.getState().phase).toBe("expired");
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(relay.calls).toHaveLength(0);

    await controller.signAgain(signer);
    expect(controller.getState().phase).toBe("done");
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("signs again only from the expired state", async () => {
    const { controller, relay } = harness();
    await controller.signAgain(owner);
    expect(controller.getState()).toBe(IDLE_ACTION);
    await controller.prepare(transferRequest);
    await controller.signAgain(owner);
    expect(controller.getState().phase).toBe("review");
    expect(relay.calls).toHaveLength(0);
  });
});

describe("the wallet says no", () => {
  it("goes back to the review, which is not an error", async () => {
    const signer = { signTypedData: vi.fn().mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 })) };
    const { controller, relay, phases, log } = harness();
    await controller.prepare(transferRequest);
    await controller.sign(signer);
    expect(phases).toEqual(["preparing", "review", "signing", "review"]);
    expect(controller.getState()).toMatchObject({ phase: "review", notice: "rejected" });
    expect(relay.calls).toHaveLength(0);
    expect(log.entries.size).toBe(0);

    signer.signTypedData.mockImplementation(owner.signTypedData);
    await controller.sign(signer);
    expect(controller.getState().phase).toBe("done");
  });

  it("refuses a signature from another key before it reaches the relayer", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const { controller, relay } = harness();
    await controller.prepare(transferRequest);
    await controller.sign(stranger);
    expect(controller.getState()).toMatchObject({ phase: "failed", stage: "sign", error: { code: "wrong_signer" } });
    expect(relay.calls).toHaveLength(0);
  });
});

describe("how long it has been waiting", () => {
  it("stamps the moment the wallet was asked and the moment the call was sent", async () => {
    const seen: ActionState[] = [];
    const { controller, clock } = harness();
    controller.subscribe(() => seen.push(controller.getState()));
    const slowSigner = {
      signTypedData: async (typedData: Parameters<typeof owner.signTypedData>[0]) => {
        clock.now += 4_000;
        return owner.signTypedData(typedData);
      },
    };

    await controller.prepare(transferRequest);
    clock.now += 30_000;
    const askedAt = clock.now;
    await controller.sign(slowSigner as Parameters<typeof controller.sign>[0]);

    const signing = seen.find((state) => state.phase === "signing");
    const relaying = seen.find((state) => state.phase === "relaying");
    expect(signing).toMatchObject({ phase: "signing", since: askedAt });
    expect(relaying).toMatchObject({ phase: "relaying", since: askedAt + 4_000 });
    expect(controller.getState()).toMatchObject({ phase: "done", finishedAt: askedAt + 4_000 });
  });

  it("starts the clock again when an expired request is signed again", async () => {
    const seen: ActionState[] = [];
    const { controller, clock } = harness({
      relay: [new RelayError("expired", 409, "prepare and sign again"), { hash: STELLAR_HASH }],
    });
    controller.subscribe(() => seen.push(controller.getState()));
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    clock.now += 60_000;
    await controller.signAgain(owner);
    const sends = seen.filter((state) => state.phase === "relaying").map((state) => state.phase === "relaying" && state.since);
    expect(sends).toEqual([1_000_000, 1_060_000]);
  });

  it("carries the stamps through the reducer and drops them at rest", () => {
    const signing = actionReducer({ phase: "review", ...reviewFixture }, { type: "SIGN", tamper: true, at: 111 });
    expect(signing).toMatchObject({ phase: "signing", tamper: true, since: 111 });
    const relaying = actionReducer(signing, { type: "SIGNED", attempted: reviewFixture.message, tampered: true, at: 222 });
    expect(relaying).toMatchObject({ phase: "relaying", since: 222, tampered: true });
    const refused = actionReducer(relaying, { type: "REFUSED", code: "bad_signature", detail: "d", reason: "r", txHash: null });
    expect(refused).toMatchObject({ phase: "refused", txHash: null });
    expect("since" in refused).toBe(false);
    expect("since" in actionReducer(relaying, { type: "RELAYED", hash: "h", at: 333 })).toBe(false);
  });
});

describe("one submission per signature", () => {
  it("relays once for a double click", async () => {
    const { controller, relay } = harness();
    await controller.prepare(transferRequest);
    const first = controller.sign(owner);
    const second = controller.sign(owner);
    await Promise.all([first, second]);
    await controller.sign(owner);
    expect(relay.calls).toHaveLength(1);
    expect(controller.getState().phase).toBe("done");
  });

  it("asks the wallet once while a signature is pending", async () => {
    let release: (signature: `0x${string}`) => void = () => undefined;
    const signer = { signTypedData: vi.fn(() => new Promise<`0x${string}`>((resolve) => (release = resolve))) };
    const { controller, relay } = harness();
    await controller.prepare(transferRequest);
    const review = reviewOf(controller.getState())!;
    const signing = controller.sign(signer);
    void controller.sign(signer);
    void controller.prepare(transferRequest);
    await settle(3);
    expect(controller.getState().phase).toBe("signing");
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);

    release(await owner.signTypedData(review.prepared.typedData));
    await signing;
    expect(relay.calls).toHaveLength(1);
  });

  it("prepares once for two clicks on the form", async () => {
    const prepareSpy = vi.fn(offlinePrepare);
    const { controller } = harness({}, { prepare: prepareSpy });
    await Promise.all([controller.prepare(transferRequest), controller.prepare(transferRequest)]);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(controller.getState().phase).toBe("review");
  });

  it("keeps a late answer away from the screen after a reset, and still logs it", async () => {
    let answer: (result: RelayResult) => void = () => undefined;
    const relay = vi.fn(() => new Promise<RelayResult>((resolve) => (answer = resolve)));
    const { controller, log } = harness({}, { relay: relay as unknown as ActionDeps["relay"] });
    await controller.prepare(transferRequest);
    const signing = controller.sign(owner);
    await until(() => controller.getState().phase === "relaying", "relaying");
    controller.reset();
    expect(controller.getState()).toBe(IDLE_ACTION);

    await controller.prepare({ kind: "transfer", to: RECIPIENT, amount: "7" });
    answer({ hash: STELLAR_HASH });
    await signing;
    expect(controller.getState()).toMatchObject({ phase: "review", amount: 70_000_000n });
    expect(log.entries.get(`tx:${STELLAR_HASH}`)).toMatchObject({ status: "done", amount: "50000000" });
  });
});

describe("failures", () => {
  it("explains input the SDK refuses, before anything is signed", async () => {
    const { controller, phases } = harness();
    await controller.prepare({ kind: "transfer", to: "not an address", amount: "5" });
    expect(phases).toEqual(["preparing", "failed"]);
    expect(controller.getState()).toMatchObject({ phase: "failed", stage: "prepare", error: { message: expect.stringMatching(/G… or C…/) } });

    await controller.prepare({ kind: "transfer", to: "nobody.eth", amount: "5" });
    expect(controller.getState()).toMatchObject({ phase: "failed", error: { code: "name_not_found" } });
  });

  it("explains a call the network says would fail", async () => {
    const failing: typeof prepare = async () => {
      throw new SimulationError("HostError: Error(Contract, #10)\nbalance is not sufficient to spend");
    };
    const { controller } = harness({}, { prepare: failing });
    await controller.prepare(transferRequest);
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      stage: "prepare",
      request: transferRequest,
      error: { code: "simulation_failed", message: "This call would fail. The account does not hold enough USDC." },
    });
  });

  const down = () => new RelayError("unavailable", 503, "The relayer is busy; try again in a moment");

  it("offers the same signed call again when the relayer is unavailable, and reports the match once", async () => {
    const { controller, relay, log, phases } = harness({ relay: [down(), { hash: STELLAR_HASH }] }, { retryDelayMs: 0 });
    const retrying: (boolean | undefined)[] = [];
    controller.subscribe(() => {
      const state = controller.getState();
      if (state.phase === "relaying") retrying.push(state.retrying);
    });
    await controller.prepare(transferRequest);
    await controller.sign(owner);

    expect(controller.getState()).toMatchObject({ phase: "done", hash: STELLAR_HASH });
    expect(panelsOf(controller.getState()).verdict).toBe("match");
    expect(phases.filter((phase) => phase === "done")).toHaveLength(1);
    expect(log.entries.size).toBe(1);
    expect(retrying).toEqual([undefined, true]);
    expect(relay.calls).toHaveLength(2);
    expect(submittedTo(relay, 1)).toBe(submittedTo(relay, 0));
  });

  it("keeps asking while the transaction is on its way, and reports the match when it has landed", async () => {
    const onItsWay = () => answer("unavailable", 503, `Transaction ${STELLAR_HASH} is on its way; ask again in a moment`, { sent: true });
    const { controller, relay, log, phases } = harness(
      { relay: [down(), onItsWay(), onItsWay(), { hash: STELLAR_HASH, deployHash: "aa".repeat(32) }] },
      { retryDelayMs: 0 },
    );
    await controller.prepare(transferRequest);
    await controller.sign(owner);

    expect(controller.getState()).toMatchObject({ phase: "done", hash: STELLAR_HASH, deployHash: "aa".repeat(32) });
    expect(phases.filter((phase) => phase === "refused" || phase === "failed")).toEqual([]);
    expect(phases.filter((phase) => phase === "done")).toHaveLength(1);
    expect(relay.calls).toHaveLength(4);
    for (let call = 1; call < 4; call += 1) expect(submittedTo(relay, call)).toBe(submittedTo(relay, 0));
    expect([...log.entries.values()]).toEqual([expect.objectContaining({ kind: "send", status: "done", stellarTxHash: STELLAR_HASH })]);
  });

  it("asks again after any answer that judges nothing: a lost connection, nonsense, a full house", async () => {
    for (const nothing of [
      new TypeError("fetch failed"),
      new RelayError("relay_failed", 504, "<html>"),
      new RelayError("rate_limited", 429, "slow down"),
      down(),
    ]) {
      const { controller, relay } = harness({ relay: [nothing, { hash: STELLAR_HASH }] }, { retryDelayMs: 0 });
      await controller.prepare(transferRequest);
      await controller.sign(owner);
      expect(relay.calls).toHaveLength(2);
      expect(controller.getState()).toMatchObject({ phase: "done", hash: STELLAR_HASH });
    }
  });

  it("never asks twice once the relayer has answered about the call", async () => {
    for (const [answered, phase] of [
      [notSent("bad_signature", "Error(Contract, #2)"), "refused"],
      [notSent("simulation_failed", "HostError: Error(Contract, #10)"), "refused"],
      [new RelayError("expired", 409, "prepare and sign again"), "expired"],
      [answer("transaction_failed", 502, "Transaction was included and failed", { sent: true }), "failed"],
    ] as const) {
      const { controller, relay } = harness({ relay: [answered, { hash: STELLAR_HASH }] }, { retryDelayMs: 0 });
      await controller.prepare(transferRequest);
      await controller.sign(owner);
      expect(relay.calls).toHaveLength(1);
      expect(controller.getState().phase).toBe(phase);
    }
  });

  it("waits as long as the relayer asks before asking again", async () => {
    vi.useFakeTimers();
    try {
      const wait = answer("unavailable", 503, "on its way", { sent: true, retryAfterSeconds: 3 });
      const { controller, relay } = harness({ relay: [wait, { hash: STELLAR_HASH }] }, { retryDelayMs: 0 });
      await controller.prepare(transferRequest);
      const signing = controller.sign(owner);

      await vi.advanceTimersByTimeAsync(2_900);
      expect(relay.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await signing;
      expect(relay.calls).toHaveLength(2);
      expect(controller.getState().phase).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the screen back when a reset comes during the second attempt", async () => {
    const { controller, relay } = harness({ relay: [down()] }, { retryDelayMs: 0 });
    await controller.prepare(transferRequest);
    const signing = controller.sign(owner);
    await until(() => relay.calls.length === 2, "the second attempt");
    controller.reset();
    expect(controller.getState()).toBe(IDLE_ACTION);
    void signing;
  });
});

describe("a call whose outcome was never learned", () => {
  /** A relayer that gives the same non-answer for as long as it is asked, while a minute passes per request. */
  function unanswered(nothing: () => Error, overrides: Partial<ActionDeps> = {}) {
    const run = harness({}, { retryDelayMs: 0, ...overrides });
    const calls: Signed[] = [];
    const relay = async (signed: Signed): Promise<RelayResult> => {
      calls.push(signed);
      run.clock.now += 60_000;
      throw nothing();
    };
    const controller = createActionController(owner.address, {
      network,
      relayUrl: "/api/relay",
      resolveName: async () => null,
      log: run.log.for,
      now: () => run.clock.now,
      prepare: offlinePrepare,
      relay,
      retryDelayMs: 0,
      ...overrides,
    });
    const phases: string[] = [];
    controller.subscribe(() => phases.push(controller.getState().phase));
    return { controller, calls, log: run.log, phases };
  }
  const lost = () => new TypeError("fetch failed");
  const down = () => new RelayError("unavailable", 503, "The relayer is busy; try again in a moment");
  const neutral = { phase: "failed", stage: "relay", error: { code: "unconfirmed", retryable: false } };
  const sentence = "We could not confirm this call. Check the activity list before trying again.";

  it("is neither refused nor matched when the answer that comes after a lost one does not say the call was not sent", async () => {
    const refusalShaped = new RelayError("bad_signature", 422, "The network refused the authorisation: the signed entry does not cover the call that would run");
    const { controller, relay, log, phases } = harness({ relay: [lost(), refusalShaped] }, { retryDelayMs: 0 });
    await controller.prepare(transferRequest);
    await controller.sign(owner);

    const state = controller.getState();
    expect(state).toMatchObject(neutral);
    expect(state.phase === "failed" && state.error.message).toBe(sentence);
    expect(isUnconfirmed(state)).toBe(true);
    expect(phases).not.toContain("refused");
    expect(phases).not.toContain("done");
    expect(["match", "refused"]).not.toContain(panelsOf(state).verdict);
    expect(relay.calls).toHaveLength(2);
    expect(submittedTo(relay, 1)).toBe(submittedTo(relay, 0));
    // Nothing is written down as refused: the activity list is where the truth will show.
    expect(log.entries.size).toBe(0);
    // The account to look at travels with the state.
    expect(state.phase === "failed" && state.review?.prepared.account).toBe(twin);
  });

  it("is refused after a lost answer when the relayer says in so many words that it was not sent", async () => {
    const { controller } = harness({ relay: [lost(), notSent("bad_signature", "Error(Contract, #2)")] }, { retryDelayMs: 0 });
    await controller.prepare(transferRequest);
    await controller.sign(owner);

    expect(controller.getState()).toMatchObject({ phase: "refused", code: "bad_signature" });
  });

  it("is not called refused on the relayer's word alone when that word does not say what was sent", async () => {
    for (const code of ["bad_signature", "simulation_failed", "bad_request"] as const) {
      const { controller, log } = harness({ relay: [new RelayError(code, 422, "no claim about sending")] });
      await controller.prepare(transferRequest);
      await controller.sign(owner);

      expect(controller.getState()).toMatchObject(neutral);
      expect(log.entries.size).toBe(0);
    }
  });

  it("is not offered for signing again when the signature expired after a request that may have gone through", async () => {
    const expired = () => new RelayError("expired", 409, "prepare and sign again");

    const afterLoss = harness({ relay: [lost(), expired()] }, { retryDelayMs: 0 });
    await afterLoss.controller.prepare(transferRequest);
    await afterLoss.controller.sign(owner);
    expect(afterLoss.controller.getState()).toMatchObject(neutral);

    // Told that nothing was sent, or with no earlier request to wonder about, an expired signature is just that.
    const cleared = harness({ relay: [lost(), answer("expired", 409, "prepare and sign again", { sent: false })] }, { retryDelayMs: 0 });
    await cleared.controller.prepare(transferRequest);
    await cleared.controller.sign(owner);
    expect(cleared.controller.getState().phase).toBe("expired");

    const first = harness({ relay: [expired()] });
    await first.controller.prepare(transferRequest);
    await first.controller.sign(owner);
    expect(first.controller.getState().phase).toBe("expired");
  });

  it("stops asking when the signature can no longer be used, and says it could not confirm", async () => {
    for (const nothing of [lost, down, () => new RelayError("relay_failed", 500, "<html>")]) {
      const { controller, calls, phases, log } = unanswered(nothing);
      await controller.prepare(transferRequest);
      await controller.sign(owner);

      // Eleven minutes from the preparation, one request a minute.
      expect(calls).toHaveLength(11);
      expect(new Set(calls).size).toBe(1);
      expect(controller.getState()).toMatchObject(neutral);
      expect(phases).not.toContain("refused");
      expect(log.entries.size).toBe(0);
    }
  });

  it("says the call was not sent when every non-answer said so, and keeps the request for another try", async () => {
    const busy = () => answer("unavailable", 503, "The relayer is busy; try again in a moment", { sent: false });
    const { controller } = unanswered(busy);
    await controller.prepare(transferRequest);
    await controller.sign(owner);

    const failed = controller.getState();
    expect(failed).toMatchObject({ phase: "failed", stage: "relay", request: transferRequest, error: { code: "unavailable", retryable: true } });
    expect(isUnconfirmed(failed)).toBe(false);
    expect(failed.phase === "failed" && failed.review?.calls).toHaveLength(1);

    const turnedAway = unanswered(() => new RelayError("rate_limited", 429, "slow down"));
    await turnedAway.controller.prepare(transferRequest);
    await turnedAway.controller.sign(owner);
    expect(turnedAway.controller.getState()).toMatchObject({ phase: "failed", error: { code: "rate_limited" } });
  });

  it("can be told how long to keep asking", async () => {
    const { controller, calls } = unanswered(lost, { giveUpAfterMs: 3 * 60_000 });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    expect(calls).toHaveLength(3);
  });
});

describe("postRelay", () => {
  async function signedTransfer(): Promise<Signed> {
    const { controller, relay } = harness();
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    return submittedTo(relay);
  }
  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
    );

  it("sends the signed call and nothing else, the same bytes every time", async () => {
    const signed = await signedTransfer();
    const fetcher = respond({ hash: STELLAR_HASH, deployHash: "aa".repeat(32) });

    expect(await postRelay(signed, "/api/relay", fetcher)).toEqual({ hash: STELLAR_HASH, deployHash: "aa".repeat(32) });
    await postRelay(signed, "/api/relay", fetcher);

    const [first, second] = fetcher.mock.calls.map(([, init]) => String(init?.body));
    expect(second).toBe(first);
    expect(JSON.parse(first!)).toEqual({ network: "testnet", owner: owner.address, func: expect.any(String), auth: signed.entries });
    expect(fetcher.mock.calls[0]![0]).toBe("/api/relay");
  });

  it("passes on what the relayer says about sending, and how long to wait", async () => {
    const signed = await signedTransfer();
    const failure = async (fetcher: ReturnType<typeof respond>) => (await postRelay(signed, "/api/relay", fetcher).catch((error: unknown) => error)) as RelayError & RelayFacts;

    const refused = await failure(respond({ error: "bad_signature", detail: "BadSignature", sent: false }, 422));
    expect(refused).toBeInstanceOf(RelayError);
    expect(refused).toMatchObject({ code: "bad_signature", status: 422, detail: "BadSignature", sent: false });

    const onItsWay = await failure(respond({ error: "unavailable", detail: "on its way", sent: true, hash: STELLAR_HASH }, 503, { "retry-after": "3" }));
    expect(onItsWay).toMatchObject({ code: "unavailable", sent: true, retryAfterSeconds: 3 });

    const silent = await failure(respond({ error: "bad_signature", detail: "no claim" }, 422));
    expect("sent" in silent).toBe(false);
    expect("sent" in (await failure(respond({ error: "bad_signature", sent: "no" }, 422)))).toBe(false);

    const nonsense = await failure(respond("<html>Gateway Timeout</html>", 504));
    expect(nonsense).toMatchObject({ code: "relay_failed", status: 504 });
    expect("sent" in nonsense).toBe(false);
  });
});

describe("leaving the review", () => {
  it("goes back from the review to the form, and nowhere else", async () => {
    const { controller } = harness();
    controller.back();
    await controller.prepare(transferRequest);
    controller.back();
    expect(controller.getState()).toBe(IDLE_ACTION);
  });
});

describe("actionReducer", () => {
  const message: SignedMessage = { account: twin, calls: [{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "5"] }], payload: "0x01" };
  const review = {
    request: transferRequest,
    owner: owner.address,
    prepared: { calls: message.calls } as Review["prepared"],
    calls: message.calls,
    message,
    recipient: null,
    amount: 5n,
    preparedAt: 1,
  } satisfies Review;
  const problem: ProblemError = { kind: "error", code: "unavailable", message: "down", retryable: true };
  const run = (events: ActionEvent[], from: ActionState = IDLE_ACTION) => events.reduce(actionReducer, from);
  const toRelaying: ActionEvent[] = [
    { type: "PREPARE", request: transferRequest },
    { type: "PREPARED", review },
    { type: "SIGN", tamper: false, at: 10 },
    { type: "SIGNED", attempted: message, tampered: false, at: 20 },
  ];

  it("ignores every event that does not belong to the phase", () => {
    const stray: ActionEvent[] = [
      { type: "PREPARED", review },
      { type: "PREPARE_FAILED", error: problem },
      { type: "SIGN", tamper: false, at: 10 },
      { type: "SIGN_REJECTED" },
      { type: "SIGN_FAILED", error: problem },
      { type: "SIGNED", attempted: message, tampered: false, at: 20 },
      { type: "RELAYED", hash: "h", at: 1 },
      { type: "REFUSED", code: "bad_signature", detail: "d", reason: "r", txHash: null },
      { type: "EXPIRED", detail: "d" },
      { type: "RELAY_FAILED", error: problem },
      { type: "BACK" },
    ];
    for (const event of stray) expect(actionReducer(IDLE_ACTION, event)).toBe(IDLE_ACTION);
  });

  it("does not start a second request while one is busy", () => {
    for (const steps of [1, 3, 4]) {
      const busy = run(toRelaying.slice(0, steps));
      expect(isActionBusy(busy)).toBe(true);
      expect(actionReducer(busy, { type: "PREPARE", request: transferRequest })).toBe(busy);
    }
  });

  it("reaches every end state from relaying", () => {
    const relaying = run(toRelaying);
    expect(run([{ type: "RELAYED", hash: "h", at: 9 }], relaying)).toMatchObject({ phase: "done", hash: "h", finishedAt: 9, calls: message.calls });
    expect(run([{ type: "REFUSED", code: "bad_signature", detail: "d", reason: "r", txHash: null }], relaying)).toMatchObject({
      phase: "refused",
      code: "bad_signature",
      txHash: null,
      detail: "d",
      shownCalls: message.calls,
      attemptedCalls: message.calls,
    });
    expect(run([{ type: "EXPIRED", detail: "d" }], relaying)).toMatchObject({ phase: "expired", request: transferRequest });
    expect(run([{ type: "RELAY_FAILED", error: problem }], relaying)).toMatchObject({ phase: "failed", stage: "relay", review });
  });

  it("starts a new request from any state that is at rest", () => {
    const relaying = run(toRelaying);
    const resting = [
      IDLE_ACTION,
      run(toRelaying.slice(0, 2)),
      run([{ type: "RELAYED", hash: "h", at: 9 }], relaying),
      run([{ type: "REFUSED", code: "bad_request", detail: "d", reason: "r", txHash: null }], relaying),
      run([{ type: "EXPIRED", detail: "d" }], relaying),
      run([{ type: "RELAY_FAILED", error: problem }], relaying),
    ];
    for (const state of resting) {
      expect(isActionBusy(state)).toBe(false);
      expect(actionReducer(state, { type: "PREPARE", request: transferRequest })).toEqual({ phase: "preparing", request: transferRequest });
    }
  });

  it("resets from anywhere", () => {
    expect(run([{ type: "RESET" }], run(toRelaying))).toBe(IDLE_ACTION);
  });

  it("has no panels before there is a message", () => {
    expect(panelsOf(IDLE_ACTION)).toEqual({ wallet: [], contract: null, verdict: "none", differingLines: [] });
    expect(panelsOf(run(toRelaying)).verdict).toBe("checking");
    expect(panelsOf(run([{ type: "PREPARE", request: transferRequest }, { type: "PREPARE_FAILED", error: problem }])).verdict).toBe("none");
  });
});

describe("panels", () => {
  const shown: SignedMessage = {
    account: twin,
    calls: [{ contract: USDC, fn: "transfer", args: [twin, RECIPIENT, "50000000"] }],
    payload: "0xaa",
  };

  it("lists the message line by line, in the order the wallet shows it", () => {
    expect(messageLines(shown).map(({ id, label, value }) => [id, label, value])).toEqual([
      ["account", "account", twin],
      ["call.0.contract", "contract", USDC],
      ["call.0.fn", "fn", "transfer"],
      ["call.0.args.0", "args", twin],
      ["call.0.args.1", "args", RECIPIENT],
      ["call.0.args.2", "args", "50000000"],
      ["payload", "payload", "0xaa"],
    ]);
    expect(messageLines(shown).every((line) => !line.differs)).toBe(true);
  });

  it("marks nothing when both sides agree", () => {
    expect(differingLines(shown, { ...shown, calls: [...shown.calls] })).toEqual([]);
    expect(comparePanels(shown, shown, "match").contract?.some((line) => line.differs)).toBe(false);
  });

  it("marks a changed function, a changed contract and lines only one side has", () => {
    const attempted: SignedMessage = {
      account: twin,
      calls: [
        { contract: HUB, fn: "exit", args: [twin, RECIPIENT] },
        { contract: USDC, fn: "burn", args: [] },
      ],
      payload: "0xaa",
    };
    expect(differingLines(shown, attempted)).toEqual(["call.0.contract", "call.0.fn", "call.0.args.2", "call.1.contract", "call.1.fn"]);
    const panels = comparePanels(shown, attempted, "refused");
    expect(panels.wallet.find((line) => line.id === "call.0.args.2")?.differs).toBe(true);
    expect(panels.contract?.find((line) => line.id === "call.1.fn")?.differs).toBe(true);
    expect(panels.contract?.find((line) => line.id === "account")?.differs).toBe(false);
  });
});
