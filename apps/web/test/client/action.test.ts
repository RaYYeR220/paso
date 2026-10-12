import { prepare, RelayError, SimulationError, type PrepareOptions, type RelayResult, type Signed } from "@paso/sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { parseArguments } from "@/lib/client/action/args";
import { createActionController, defaultTamper, messageOfEntry, type ActionDeps } from "@/lib/client/action/controller";
import {
  actionReducer,
  IDLE_ACTION,
  isActionBusy,
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
  const refusal = new RelayError(
    "bad_signature",
    422,
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
    const { controller } = harness({ relay: [new RelayError("simulation_failed", 422, "HostError: Error(Contract, #10)")] });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "refused", code: "simulation_failed", tampered: false });
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

  it("keeps the request when the relayer is down, so it can be tried again", async () => {
    const { controller } = harness({ relay: [new RelayError("unavailable", 503, "The relayer is busy; try again in a moment"), { hash: STELLAR_HASH }] });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    const failed = controller.getState();
    expect(failed).toMatchObject({ phase: "failed", stage: "relay", request: transferRequest, error: { code: "unavailable", retryable: true } });
    expect(failed.phase === "failed" && failed.review?.calls).toHaveLength(1);

    await controller.prepare(transferRequest);
    await controller.sign(owner);
    expect(controller.getState().phase).toBe("done");
  });

  it("treats a relayer that answers nonsense as a failure, not a refusal", async () => {
    const { controller } = harness({ relay: [new RelayError("relay_failed", 500, "<html>")] });
    await controller.prepare(transferRequest);
    await controller.sign(owner);
    expect(controller.getState()).toMatchObject({ phase: "failed", stage: "relay", error: { code: "relay_failed" } });
  });

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
    { type: "SIGN", tamper: false },
    { type: "SIGNED", attempted: message, tampered: false },
  ];

  it("ignores every event that does not belong to the phase", () => {
    const stray: ActionEvent[] = [
      { type: "PREPARED", review },
      { type: "PREPARE_FAILED", error: problem },
      { type: "SIGN", tamper: false },
      { type: "SIGN_REJECTED" },
      { type: "SIGN_FAILED", error: problem },
      { type: "SIGNED", attempted: message, tampered: false },
      { type: "RELAYED", hash: "h", at: 1 },
      { type: "REFUSED", code: "bad_signature", detail: "d", reason: "r" },
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
    expect(run([{ type: "REFUSED", code: "bad_signature", detail: "d", reason: "r" }], relaying)).toMatchObject({
      phase: "refused",
      code: "bad_signature",
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
      run([{ type: "REFUSED", code: "bad_request", detail: "d", reason: "r" }], relaying),
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
