import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  askExit,
  createExitWatcher,
  isHubExit,
  exitStages,
  exitStorageKey,
  type BaseReader,
  type ExitAnswer,
  type ExitTransfer,
  type SubmitMint,
} from "@/lib/client/exit";
import { NETWORKS } from "@paso/sdk";
import { memoryStorage, type KeyValueStore } from "@/lib/client/storage";
import inbound from "../fixtures/delivered-message.json";
import exitFixture from "../fixtures/exit-message.json";
import { forever, owner, scripted, settle } from "./helpers";

const EXIT = "6c".repeat(32);
const MESSAGE: Hex = `0x${"aa".repeat(376)}`;
const ATTESTATION: Hex = `0x${"bb".repeat(130)}`;
const MINT: Hex = `0x${"d8".repeat(32)}`;
const key = exitStorageKey("mainnet", owner.address);

const transfer: ExitTransfer = { network: "mainnet", stellarTxHash: EXIT, startedAt: 1_000 };
const attested: ExitAnswer = { status: "attested", message: MESSAGE, attestation: ATTESTATION };
const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

interface Chain {
  /** What `usedNonces` says, read after read; the last answer from then on. */
  received?: boolean[];
  receipt?: ("success" | "reverted" | null)[];
}

function harness(script: (ExitAnswer | Error)[], storage: KeyValueStore | null = memoryStorage(), chain: Chain = {}) {
  const ask = scripted<ExitAnswer>(script);
  const received = [...(chain.received ?? [false])];
  const receipts = [...(chain.receipt ?? [null])];
  const next = <T>(answers: T[]): T => (answers.length > 1 ? answers.shift()! : answers[0]!);
  const base = {
    isReceived: vi.fn(async () => next(received)),
    receipt: vi.fn(async () => next(receipts)),
  } satisfies BaseReader;
  const timers: (() => void)[] = [];
  const clock = { now: 1_000 };
  const watcher = createExitWatcher({
    network: "mainnet",
    ask,
    base,
    storage,
    storageKey: key,
    now: () => clock.now,
    setTimeout: (run) => {
      timers.push(run);
      return run;
    },
    clearTimeout: (handle) => {
      const at = timers.indexOf(handle as () => void);
      if (at >= 0) timers.splice(at, 1);
    },
  });
  /** Lets the next scheduled look happen. */
  const tick = async () => {
    timers.shift()?.();
    await settle(3);
  };
  const stored = () => JSON.parse(storage?.getItem(key) ?? "null") as ExitTransfer | null;
  return { ask, base, watcher, storage, clock, timers, tick, stored };
}

/** A wallet whose answer to the mint is decided by the test. */
function walletMint() {
  let settleWith: { resolve: (result: { hash?: Hex; alreadyReceived: boolean }) => void; reject: (error: unknown) => void } | undefined;
  let submitted: ((hash: Hex) => void) | undefined;
  const submit = vi.fn<SubmitMint>(
    ({ onSubmitted }) =>
      new Promise((resolve, reject) => {
        submitted = onSubmitted;
        settleWith = { resolve, reject };
      }),
  );
  return {
    submit,
    sent: (hash: Hex) => submitted?.(hash),
    confirm: (result: { hash?: Hex; alreadyReceived: boolean }) => settleWith?.resolve(result),
    fail: (error: unknown) => settleWith?.reject(error),
  };
}

async function attestedExit(storage?: KeyValueStore | null, chain?: Chain) {
  const h = harness([attested], storage, chain);
  h.watcher.watch(transfer);
  await settle(3);
  return h;
}

describe("an exit the server leaves to the wallet", () => {
  it("stops at the last step, with the message and its attestation in hand", async () => {
    const h = await attestedExit();

    expect(h.watcher.getState()).toEqual({ phase: "attested", transfer, message: MESSAGE, attestation: ATTESTATION });
    expect(exitStages(h.watcher.getState())).toEqual([
      { id: "burned", label: "Burned on Stellar", status: "done" },
      { id: "attested", label: "Attested by Circle", status: "done" },
      { id: "minted", label: "Minted on Base", status: "active" },
    ]);
    expect(h.stored()).toEqual(transfer);
    // The server has said all it has to say: it is not asked again.
    await h.tick();
    expect(h.ask.calls).toHaveLength(1);
  });

  it("asks Base first, and is done when the message has been received already", async () => {
    const h = await attestedExit(undefined, { received: [true] });

    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, finishedAt: 1_000 });
    expect(h.stored()).toBeNull();
  });

  it("notices a mint someone else made while the wallet was not asked", async () => {
    const h = await attestedExit(undefined, { received: [false, false, true] });
    await h.tick();
    expect(h.watcher.getState().phase).toBe("attested");

    h.clock.now = 30_000;
    await h.tick();
    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, finishedAt: 30_000 });
  });

  it("treats an unreadable Base as not received yet, and goes on", async () => {
    const h = harness([attested]);
    h.base.isReceived.mockRejectedValueOnce(new Error("fetch failed"));
    h.watcher.watch(transfer);
    await settle(3);

    expect(h.watcher.getState().phase).toBe("attested");
  });
});

describe("the mint in the wallet", () => {
  it("is pending from the click until Base confirms it, then done with its transaction", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    expect(h.watcher.getState()).toEqual({ phase: "minting", transfer, message: MESSAGE, attestation: ATTESTATION });
    expect(wallet.submit).toHaveBeenCalledWith({ message: MESSAGE, attestation: ATTESTATION, onSubmitted: expect.any(Function) });
    expect(exitStages(h.watcher.getState())[2]).toMatchObject({ status: "active" });

    wallet.sent(MINT);
    expect(h.watcher.getState()).toMatchObject({ phase: "minting", baseTxHash: MINT });
    expect(h.stored()).toEqual({ ...transfer, mintTxHash: MINT });

    h.clock.now = 9_000;
    wallet.confirm({ hash: MINT, alreadyReceived: false });
    await minting;
    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, baseTxHash: MINT, finishedAt: 9_000 });
    expect(h.stored()).toBeNull();
    expect(h.watcher.tracked()).toBeNull();
  });

  it("is asked for once, however often the button is pressed", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    void h.watcher.mint(wallet.submit);
    void h.watcher.mint(wallet.submit);
    await settle(3);

    expect(wallet.submit).toHaveBeenCalledTimes(1);
  });

  it("goes back to waiting for the wallet when the owner declines, and says nothing is wrong", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    wallet.fail(rejection());
    await minting;

    expect(h.watcher.getState()).toEqual({ phase: "attested", transfer, message: MESSAGE, attestation: ATTESTATION, notice: "declined" });
    expect(h.stored()).toEqual(transfer);

    const again = walletMint();
    void h.watcher.mint(again.submit);
    expect(again.submit).toHaveBeenCalledTimes(1);
    expect(h.watcher.getState()).toMatchObject({ phase: "minting" });
    expect("notice" in h.watcher.getState()).toBe(false);
  });

  it("is done without a transaction of its own when someone else got there first", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    h.clock.now = 4_000;
    wallet.confirm({ alreadyReceived: true });
    await minting;

    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, finishedAt: 4_000 });
    expect(h.stored()).toBeNull();
  });

  it("says why when the wallet could not send it, and can be tried again", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    wallet.fail(Object.assign(new Error("insufficient funds for gas * price + value"), { name: "InsufficientFundsError" }));
    await minting;

    expect(h.watcher.getState()).toEqual({
      phase: "attested",
      transfer,
      message: MESSAGE,
      attestation: ATTESTATION,
      problem: "The wallet does not hold enough ETH on Base to pay for gas.",
    });
    expect(h.stored()).toEqual(transfer);
  });

  it("forgets a mint that reverted, and offers the step again", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    wallet.sent(MINT);
    wallet.fail(Object.assign(new Error(`The mint reverted on Base: ${MINT}`), { name: "TransactionRevertedError" }));
    await minting;

    expect(h.watcher.getState()).toMatchObject({ phase: "attested", problem: expect.stringMatching(/reverted on Base/) });
    expect(h.stored()).toEqual(transfer);
  });

  it("keeps waiting for a mint that was sent when its confirmation could not be read", async () => {
    const h = await attestedExit(undefined, { received: [false, false, true], receipt: [null, "success"] });
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    wallet.sent(MINT);
    wallet.fail(new Error("The request timed out"));
    await minting;

    expect(h.watcher.getState()).toMatchObject({ phase: "minting", baseTxHash: MINT });
    expect(h.stored()).toEqual({ ...transfer, mintTxHash: MINT });

    // The wallet is not asked a second time: Base is, until it says what became of the first.
    const again = walletMint();
    void h.watcher.mint(again.submit);
    expect(again.submit).not.toHaveBeenCalled();

    await h.tick();
    h.clock.now = 20_000;
    await h.tick();
    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, baseTxHash: MINT, finishedAt: 20_000 });
  });

  it("drops the answer of a wallet that was still open when the tracker was stopped", async () => {
    const h = await attestedExit();
    const wallet = walletMint();

    const minting = h.watcher.mint(wallet.submit);
    h.watcher.stopTracking();
    wallet.sent(MINT);
    wallet.confirm({ hash: MINT, alreadyReceived: false });
    await minting;

    expect(h.watcher.getState()).toEqual({ phase: "idle" });
    expect(h.stored()).toBeNull();
  });
});

describe("the mint after a reload", () => {
  it("is offered again when the page was closed before the wallet was asked", async () => {
    const before = await attestedExit();

    const after = harness([attested], before.storage);
    expect(after.watcher.restore()).toBe(true);
    await settle(3);

    expect(after.watcher.getState()).toEqual({ phase: "attested", transfer, message: MESSAGE, attestation: ATTESTATION });
    const wallet = walletMint();
    void after.watcher.mint(wallet.submit);
    expect(wallet.submit).toHaveBeenCalledTimes(1);
  });

  it("is not asked for twice when the page was closed with the mint on its way", async () => {
    const before = await attestedExit();
    const wallet = walletMint();
    void before.watcher.mint(wallet.submit);
    wallet.sent(MINT);

    const after = harness([attested], before.storage, { received: [false, true], receipt: ["success"] });
    after.watcher.restore();
    await settle(3);

    expect(after.watcher.getState()).toEqual({ phase: "minting", transfer, message: MESSAGE, attestation: ATTESTATION, baseTxHash: MINT });
    const again = walletMint();
    void after.watcher.mint(again.submit);
    expect(again.submit).not.toHaveBeenCalled();

    after.clock.now = 50_000;
    await after.tick();
    expect(after.watcher.getState()).toMatchObject({ phase: "minted", baseTxHash: MINT, finishedAt: 50_000 });
    expect(after.stored()).toBeNull();
  });

  it("is offered again when the mint that was on its way turned out to have reverted", async () => {
    const before = await attestedExit();
    const wallet = walletMint();
    void before.watcher.mint(wallet.submit);
    wallet.sent(MINT);

    const after = harness([attested], before.storage, { received: [false], receipt: ["reverted"] });
    after.watcher.restore();
    await settle(3);
    await after.tick();

    expect(after.watcher.getState()).toMatchObject({ phase: "attested", problem: expect.stringMatching(/reverted on Base/) });
    expect(after.stored()).toEqual(transfer);
  });

  it("is over when the server says the USDC has been minted meanwhile", async () => {
    const before = await attestedExit();

    const after = harness([{ status: "minted" }], before.storage);
    after.watcher.restore();
    await settle(3);

    expect(after.watcher.getState()).toMatchObject({ phase: "minted" });
    expect(after.base.isReceived).not.toHaveBeenCalled();
  });
});

describe("a transfer back on one network and the same owner on the other", () => {
  it("are kept apart: a record of the other network is never picked up", () => {
    const foreign = memoryStorage({ [key]: JSON.stringify({ ...transfer, network: "testnet" }) });
    expect(harness([], foreign).watcher.restore()).toBe(false);
    expect(harness([], foreign).watcher.tracked()).toBeNull();

    const unnamed = memoryStorage({ [key]: JSON.stringify({ stellarTxHash: EXIT, startedAt: 1_000 }) });
    expect(harness([], unnamed).watcher.restore()).toBe(false);
  });

  it("take a record made before networks were named to be testnet's, and nothing else's", async () => {
    const testnetKey = exitStorageKey("testnet", owner.address);
    const storage = memoryStorage({ [testnetKey]: JSON.stringify({ stellarTxHash: EXIT, startedAt: 1_000 }) });
    const watcher = createExitWatcher({ network: "testnet", ask: () => forever<ExitAnswer>(), storage, storageKey: testnetKey });

    expect(watcher.restore()).toBe(true);
    expect(watcher.getState()).toMatchObject({ phase: "attesting", transfer: { network: "testnet", stellarTxHash: EXIT, startedAt: 1_000 } });
    expect(JSON.parse(storage.getItem(testnetKey) ?? "null")).toEqual({ network: "testnet", stellarTxHash: EXIT, startedAt: 1_000 });
  });

  it("refuse to follow a burn handed over for the other network", () => {
    const h = harness([]);
    expect(h.watcher.watch({ ...transfer, network: "testnet" })).toBe(false);
    expect(h.watcher.getState()).toEqual({ phase: "idle" });
    expect(h.stored()).toBeNull();
  });
});

describe("askExit, for a server that hands the mint back", () => {
  const options = { url: "/api/cctp/complete", network: "mainnet" as const };
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads the message and its attestation", async () => {
    expect(await askExit(EXIT, { ...options, fetch: answering(200, attested) })).toEqual(attested);
  });

  it("goes on waiting when what came back is not a message and an attestation", async () => {
    for (const body of [
      { status: "attested" },
      { status: "attested", message: "hello", attestation: ATTESTATION },
      { status: "attested", message: MESSAGE, attestation: 5 },
      { status: "attested", message: "0x", attestation: ATTESTATION },
    ]) {
      expect(await askExit(EXIT, { ...options, fetch: answering(200, body) })).toEqual({ status: "pending", attestation: "pending" });
    }
  });

  it("does not offer the wallet a message that is not an exit from this network's hub", async () => {
    const offered = { ...attested, message: exitFixture.message as Hex };
    const checked = (network: "testnet" | "mainnet") =>
      askExit(EXIT, { ...options, fetch: answering(200, offered), accepts: (message) => isHubExit(message, NETWORKS[network]) });

    expect(await checked("testnet")).toEqual(offered);
    expect(await checked("mainnet")).toEqual({ status: "pending", attestation: "pending" });

    expect(isHubExit(exitFixture.message as Hex, NETWORKS.testnet)).toBe(true);
    expect(isHubExit(exitFixture.message.toUpperCase().replace("0X", "0x") as Hex, NETWORKS.testnet)).toBe(true);
    expect(isHubExit(inbound.message as Hex, NETWORKS.testnet)).toBe(false);
    expect(isHubExit(MESSAGE, NETWORKS.testnet)).toBe(false);
    expect(isHubExit("0x1234", NETWORKS.testnet)).toBe(false);
  });

  it("says the relayer is not serving the network, instead of calling the transfer unsupported", async () => {
    const declined = answering(503, { error: "unavailable", detail: "This server is not serving mainnet right now", reason: "not_serving" });
    await expect(askExit(EXIT, { ...options, fetch: declined })).rejects.toMatchObject({ reason: "not_serving" });
  });
});
