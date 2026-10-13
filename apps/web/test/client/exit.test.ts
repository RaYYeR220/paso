import { describe, expect, it } from "vitest";
import { askExit, createExitWatcher, exitStages, exitStorageKey, IDLE_EXIT, type ExitAnswer, type ExitTransfer } from "@/lib/client/exit";
import { memoryStorage, type KeyValueStore } from "@/lib/client/storage";
import { owner, scripted, settle } from "./helpers";

const EXIT = "6c".repeat(32);
const OTHER_EXIT = "7d".repeat(32);
const BASE_MINT = `0x${"d8".repeat(32)}`;
const key = exitStorageKey("testnet", owner.address);

const transfer: ExitTransfer = { network: "testnet", stellarTxHash: EXIT, startedAt: 1_000, chain: "base" };
const waiting = (attestation: "not_found" | "pending" | "unreachable" = "pending"): ExitAnswer => ({ status: "pending", attestation });
const minted: ExitAnswer = { status: "minted", hash: BASE_MINT };

function harness(script: (ExitAnswer | Error)[], storage: KeyValueStore | null = memoryStorage()) {
  const ask = scripted<ExitAnswer>(script);
  const waits: number[] = [];
  const pendingRuns: (() => void)[] = [];
  const clock = { now: 1_000 };
  const watcher = createExitWatcher({
    network: "testnet",
    ask,
    storage,
    storageKey: key,
    now: () => clock.now,
    setTimeout: (run, ms) => {
      waits.push(ms);
      pendingRuns.push(run);
      return run;
    },
    clearTimeout: (handle) => {
      const at = pendingRuns.indexOf(handle as () => void);
      if (at >= 0) pendingRuns.splice(at, 1);
    },
  });
  /** Lets the next scheduled question go out. */
  const tick = async () => {
    pendingRuns.shift()?.();
    await settle(3);
  };
  return { ask, waits, clock, watcher, storage, tick };
}

describe("following USDC back to Base", () => {
  it("goes from the burn on Stellar to the mint on Base", async () => {
    const h = harness([waiting("not_found"), waiting(), minted]);
    expect(exitStages(h.watcher.getState(), "Base").map((stage) => stage.status)).toEqual(["waiting", "waiting", "waiting"]);

    expect(h.watcher.watch(transfer)).toBe(true);
    expect(h.watcher.getState()).toMatchObject({ phase: "attesting", transfer });
    expect(exitStages(h.watcher.getState(), "Base")).toEqual([
      { id: "burned", label: "Burned on Stellar", status: "done" },
      { id: "attested", label: "Attested by Circle", status: "active" },
      { id: "minted", label: "Minted on Base", status: "waiting" },
    ]);

    await settle(3);
    await h.tick();
    h.clock.now = 10_000;
    await h.tick();
    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, mintTxHash: BASE_MINT, finishedAt: 10_000 });
    expect(exitStages(h.watcher.getState(), "Base").map((stage) => stage.status)).toEqual(["done", "done", "done"]);
    expect(h.ask.calls.map((call) => call[0])).toEqual([EXIT, EXIT, EXIT]);
    expect(h.waits).toEqual([2_000, 2_000]);
  });

  it("puts the burn on record at once and clears it only when it is minted", async () => {
    const h = harness([waiting(), minted]);
    h.watcher.watch(transfer);
    expect(JSON.parse(h.storage?.getItem(key) ?? "null")).toEqual(transfer);
    expect(h.watcher.tracked()).toEqual({ transfer, saved: true });
    await settle(3);
    expect(h.storage?.getItem(key)).not.toBeNull();
    await h.tick();
    expect(h.watcher.getState().phase).toBe("minted");
    expect(h.storage?.getItem(key)).toBeNull();
    expect(h.watcher.tracked()).toBeNull();
  });

  it("keeps waiting through failed answers, more patiently each time, and never drops the record", async () => {
    const down = () => new Error("fetch failed");
    const h = harness([down(), down(), down(), down(), down(), down(), down(), waiting(), minted]);
    h.watcher.watch(transfer);
    await settle(3);
    for (let round = 0; round < 7; round += 1) {
      expect(h.watcher.getState()).toMatchObject({ phase: "attesting", attestation: "unreachable" });
      expect(h.storage?.getItem(key)).not.toBeNull();
      await h.tick();
    }
    await h.tick();
    expect(h.watcher.getState().phase).toBe("minted");
    expect(h.waits).toEqual([2_000, 4_000, 6_000, 8_000, 10_000, 10_000, 10_000, 2_000]);
  });

  it("refuses a second burn while one is on record", async () => {
    const h = harness([waiting()]);
    expect(h.watcher.watch(transfer)).toBe(true);
    expect(h.watcher.watch({ network: "testnet", chain: "base", stellarTxHash: OTHER_EXIT, startedAt: 2_000 })).toBe(false);
    expect(h.watcher.watch(transfer)).toBe(true);
    await settle(3);
    expect(h.watcher.getState()).toMatchObject({ transfer: { stellarTxHash: EXIT } });
    expect(JSON.parse(h.storage?.getItem(key) ?? "null")).toEqual(transfer);
    expect(h.ask.calls).toHaveLength(1);
  });

  it("picks the burn up after a reload and keeps its clock", async () => {
    const before = harness([waiting()]);
    before.watcher.watch(transfer);
    await settle(3);

    const after = harness([minted], before.storage);
    expect(after.watcher.getState()).toBe(IDLE_EXIT);
    expect(after.watcher.restore()).toBe(true);
    expect(after.watcher.restore()).toBe(false);
    after.clock.now = 30_000;
    await settle(3);
    expect(after.watcher.getState()).toEqual({ phase: "minted", transfer, mintTxHash: BASE_MINT, finishedAt: 30_000 });
    expect(harness([]).watcher.restore()).toBe(false);
  });

  it("is taken off the record only by stopping the tracker", async () => {
    const h = harness([waiting(), waiting()]);
    h.watcher.watch(transfer);
    await settle(3);
    h.watcher.stopTracking();
    await h.tick();
    expect(h.watcher.getState()).toBe(IDLE_EXIT);
    expect(h.storage?.getItem(key)).toBeNull();
    expect(h.ask.calls).toHaveLength(1);
    expect(h.watcher.watch({ network: "testnet", chain: "base", stellarTxHash: OTHER_EXIT, startedAt: 2_000 })).toBe(true);
  });

  it("keeps the record when the server cannot follow transfers, and asks again after a reload", async () => {
    const h = harness([{ status: "unsupported" }]);
    h.watcher.watch(transfer);
    await settle(3);
    expect(h.watcher.getState()).toEqual({ phase: "untracked", transfer });
    expect(exitStages(h.watcher.getState(), "Base").map((stage) => stage.status)).toEqual(["done", "active", "waiting"]);
    expect(h.waits).toEqual([]);
    expect(h.storage?.getItem(key)).not.toBeNull();

    const later = harness([minted], h.storage);
    expect(later.watcher.restore()).toBe(true);
    await settle(3);
    expect(later.watcher.getState().phase).toBe("minted");
  });

  it("lives in memory when the browser keeps no storage, and says so", async () => {
    const h = harness([waiting()], null);
    h.watcher.watch(transfer);
    expect(h.watcher.tracked()).toEqual({ transfer, saved: false });
    expect(h.watcher.watch({ network: "testnet", chain: "base", stellarTxHash: OTHER_EXIT, startedAt: 2_000 })).toBe(false);
  });
});

describe("askExit", () => {
  const options = { url: "/api/cctp/complete", network: "testnet" as const };
  const answering = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("posts the network and the Stellar transaction", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ status: "pending", attestation: "pending" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await askExit(EXIT, { ...options, fetch: fetcher })).toEqual({ status: "pending", attestation: "pending" });
    expect(requests).toEqual([{ url: "/api/cctp/complete", body: { network: "testnet", txHash: EXIT } }]);
  });

  it("reads a mint with and without its hash", async () => {
    expect(await askExit(EXIT, { ...options, fetch: answering(200, { status: "minted", hash: BASE_MINT }) })).toEqual(minted);
    expect(await askExit(EXIT, { ...options, fetch: answering(200, { status: "minted" }) })).toEqual({ status: "minted" });
  });

  it("tells a server without the route apart from a server that failed", async () => {
    expect(await askExit(EXIT, { ...options, fetch: answering(404, {}) })).toEqual({ status: "unsupported" });
    await expect(askExit(EXIT, { ...options, fetch: answering(503, { error: "unavailable" }) })).rejects.toThrow(/503/);
  });
});
