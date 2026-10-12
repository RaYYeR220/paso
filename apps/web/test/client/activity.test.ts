import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { accountTopics, loadChainActivity, parseTransfer, type ChainTransfer } from "@/lib/client/activity/events";
import { activityLogKey, createActivityLog, type LogEntry } from "@/lib/client/activity/log";
import { mergeActivity } from "@/lib/client/activity/merge";
import { createResource, type ResourceEnvironment } from "@/lib/client/resource";
import { memoryStorage } from "@/lib/client/storage";
import { BURN, network, RECIPIENT, settle, STELLAR_HASH, twin } from "./helpers";

const { usdc, forwarder, hub } = network.stellar;
const context = { account: twin, network };
const T0 = Date.parse("2026-10-12T12:00:00Z");

const address = (strkey: string) => new Address(strkey).toScVal();
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const asset = nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", { type: "string" });

function event(topic: xdr.ScVal[], value: xdr.ScVal, overrides: Partial<{ id: string; txHash: string; at: number }> = {}) {
  return {
    id: overrides.id ?? "0000000000000000001-0000000001",
    ledger: 5_000_000,
    ledgerClosedAt: new Date(overrides.at ?? T0).toISOString(),
    txHash: overrides.txHash ?? STELLAR_HASH,
    topic,
    value,
  };
}

const chain = (overrides: Partial<ChainTransfer>): ChainTransfer => ({
  id: "e1",
  direction: "in",
  via: "transfer",
  amount: 100_000_000n,
  counterparty: forwarder,
  at: T0,
  ledger: 5_000_000,
  txHash: STELLAR_HASH,
  ...overrides,
});

const entry = (overrides: Partial<LogEntry>): LogEntry => ({
  id: "l1",
  kind: "receive",
  status: "pending",
  amount: "100000000",
  counterparty: null,
  at: T0,
  ...overrides,
});

describe("parseTransfer", () => {
  const symbol = (name: string) => xdr.ScVal.scvSymbol(name);

  it("reads a transfer in either direction", () => {
    expect(parseTransfer(event([symbol("transfer"), address(forwarder), address(twin), asset], i128(100_000_000n)), twin)).toMatchObject({
      direction: "in",
      via: "transfer",
      amount: 100_000_000n,
      counterparty: forwarder,
      at: T0,
      txHash: STELLAR_HASH,
    });
    expect(parseTransfer(event([symbol("transfer"), address(twin), address(RECIPIENT), asset], i128(5n)), twin)).toMatchObject({
      direction: "out",
      counterparty: RECIPIENT,
      amount: 5n,
    });
  });

  it("reads a mint with and without the admin topic, and a burn", () => {
    expect(parseTransfer(event([symbol("mint"), address(twin), asset], i128(7n)), twin)).toMatchObject({ direction: "in", via: "mint", counterparty: null });
    expect(parseTransfer(event([symbol("mint"), address(RECIPIENT), address(twin), asset], i128(7n)), twin)).toMatchObject({ direction: "in", via: "mint" });
    expect(parseTransfer(event([symbol("burn"), address(twin), asset], i128(7n)), twin)).toMatchObject({ direction: "out", via: "burn" });
  });

  it("reads an amount carried in a map", () => {
    const data = nativeToScVal({ amount: 9n, to_muxed_id: 4n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } });
    expect(parseTransfer(event([symbol("transfer"), address(RECIPIENT), address(twin), asset], data), twin)?.amount).toBe(9n);
  });

  it("skips events that are not about the account or not about an amount", () => {
    expect(parseTransfer(event([symbol("transfer"), address(RECIPIENT), address(hub), asset], i128(1n)), twin)).toBeNull();
    expect(parseTransfer(event([symbol("approve"), address(twin), address(hub), asset], i128(1n)), twin)).toBeNull();
    expect(parseTransfer(event([symbol("mint"), address(RECIPIENT), asset], i128(1n)), twin)).toBeNull();
    expect(parseTransfer(event([symbol("transfer"), address(twin), address(hub), asset], xdr.ScVal.scvVoid()), twin)).toBeNull();
    expect(parseTransfer(event([], i128(1n)), twin)).toBeNull();
  });

  it("asks for every event that names the account", () => {
    const topics = accountTopics(twin);
    const self = address(twin).toXdr("base64");
    expect(topics).toHaveLength(5);
    expect(topics.every((pattern) => pattern.includes(self))).toBe(true);
    expect(topics.map((pattern) => pattern.length)).toEqual([4, 4, 4, 3, 3]);
  });
});

describe("loadChainActivity", () => {
  const symbol = (name: string) => xdr.ScVal.scvSymbol(name);
  const incoming = (id: string, at: number) => event([symbol("transfer"), address(forwarder), address(twin), asset], i128(1n), { id, at, txHash: id });

  function server(pages: ReturnType<typeof incoming>[][], health = { latestLedger: 5_160_000, oldestLedger: 5_039_000, oldestLedgerCloseTime: "1791219717" }) {
    const requests: Record<string, unknown>[] = [];
    return {
      requests,
      getHealth: async () => ({ status: "healthy", ...health }),
      getEvents: async (request: Record<string, unknown>) => {
        requests.push(request);
        const events = pages.shift() ?? [];
        return { events, cursor: events.at(-1)?.id ?? "end", latestLedger: health.latestLedger };
      },
    };
  }

  it("starts inside the window the network still has, and returns newest first", async () => {
    const rpc = server([[incoming("a", T0), incoming("b", T0 + 60_000)]]);
    const activity = await loadChainActivity(twin, network, rpc as never);
    expect(activity.transfers.map((transfer) => transfer.id)).toEqual(["b", "a"]);
    expect(activity.since).toBe(1_791_219_717_000);
    expect(rpc.requests).toHaveLength(1);
    expect(rpc.requests[0]).toMatchObject({ startLedger: 5_039_016, limit: 1_000 });
    expect(rpc.requests[0]?.filters).toEqual([{ type: "contract", contractIds: [usdc], topics: accountTopics(twin) }]);
  });

  it("answers with an empty list for an account nothing has happened to", async () => {
    const activity = await loadChainActivity(twin, network, server([[]]) as never);
    expect(activity.transfers).toEqual([]);
  });

  it("follows the cursor while pages come back full", async () => {
    const full = Array.from({ length: 1_000 }, (_, index) => incoming(`p1-${index}`, T0 + index));
    const rpc = server([full, [incoming("last", T0 + 5_000_000)]]);
    const activity = await loadChainActivity(twin, network, rpc as never);
    expect(activity.transfers).toHaveLength(1_001);
    expect(activity.transfers[0]?.id).toBe("last");
    expect(rpc.requests[1]).toMatchObject({ cursor: "p1-999" });
    expect(rpc.requests[1]).not.toHaveProperty("startLedger");
  });

  it("lets a failing network fail: the caller decides what to show", async () => {
    const rpc = { getHealth: async () => Promise.reject(new TypeError("Failed to fetch")), getEvents: async () => ({ events: [] }) };
    await expect(loadChainActivity(twin, network, rpc as never)).rejects.toThrow("Failed to fetch");
  });
});

describe("mergeActivity", () => {
  it("is empty when nothing happened", () => {
    expect(mergeActivity([], [], context)).toEqual([]);
  });

  it("words an arrival from Base, a payment in, a payment out and a withdrawal", () => {
    const items = mergeActivity(
      [
        chain({ id: "a", at: T0 + 4 }),
        chain({ id: "b", at: T0 + 3, counterparty: RECIPIENT, txHash: "b".repeat(64) }),
        chain({ id: "c", at: T0 + 2, direction: "out", counterparty: RECIPIENT, amount: 50_000_000n, txHash: "c".repeat(64) }),
        chain({ id: "d", at: T0 + 1, direction: "out", counterparty: hub, amount: 20_000_000n, txHash: "d".repeat(64) }),
        chain({ id: "e", at: T0, via: "mint", counterparty: null, txHash: "e".repeat(64) }),
      ],
      [],
      context,
    );
    expect(items.map((item) => [item.kind, item.title, item.crossChain])).toEqual([
      ["received", "Received 10.00 USDC from Base", true],
      ["received", "Received 10.00 USDC from GBBD…FLA5", false],
      ["sent", "Sent 5.00 USDC to GBBD…FLA5", false],
      ["exit", "Sent 2.00 USDC back to Base", true],
      ["received", "Received 10.00 USDC from Base", true],
    ]);
    expect(items.every((item) => item.status === "confirmed" && item.source === "chain")).toBe(true);
    expect(items[0]?.links).toEqual({ stellar: `https://stellar.expert/explorer/testnet/tx/${STELLAR_HASH}`, base: null });
    expect(items[2]?.counterparty).toBe(RECIPIENT);
  });

  it("shows a movement both records know once, with the Base link only the browser has", () => {
    const items = mergeActivity(
      [chain({})],
      [entry({ id: `fund:${BURN}`, status: "done", stellarTxHash: `0x${STELLAR_HASH.toUpperCase()}`, baseTxHash: BURN })],
      context,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "e1",
      title: "Received 10.00 USDC from Base",
      source: "both",
      links: { stellar: `https://stellar.expert/explorer/testnet/tx/${STELLAR_HASH}`, base: `https://sepolia.basescan.org/tx/${BURN}` },
    });
  });

  it("shows a transfer still on its way, from the browser's record alone", () => {
    const [item] = mergeActivity([], [entry({ baseTxHash: BURN })], context);
    expect(item).toMatchObject({
      kind: "received",
      status: "pending",
      title: "Receiving 10.00 USDC from Base",
      source: "session",
      links: { base: `https://sepolia.basescan.org/tx/${BURN}`, stellar: `https://stellar.expert/explorer/testnet/contract/${twin}` },
    });
  });

  it("pairs a delivery made by someone else with the mint that followed it", () => {
    const items = mergeActivity(
      [chain({ id: "old", at: T0 - 3_600_000, txHash: "1".repeat(64) }), chain({ id: "mint", at: T0 + 20_000, txHash: "2".repeat(64) })],
      [entry({ status: "done", baseTxHash: BURN })],
      context,
    );
    expect(items.map((item) => [item.id, item.source, item.links.base !== null])).toEqual([
      ["mint", "both", true],
      ["old", "chain", false],
    ]);
  });

  it("keeps a refusal and a call without a transfer, which only the browser knows about", () => {
    const items = mergeActivity(
      [],
      [
        entry({ id: "r", kind: "refused", status: "refused", amount: "50000000", counterparty: RECIPIENT, note: "did not match the signature", at: T0 + 2 }),
        entry({ id: "c", kind: "call", status: "done", amount: null, counterparty: usdc, note: "approve", stellarTxHash: "3".repeat(64), at: T0 + 1 }),
        entry({ id: "f", kind: "receive", status: "failed", at: T0 }),
      ],
      context,
    );
    expect(items.map((item) => [item.kind, item.status, item.title])).toEqual([
      ["refused", "refused", "Refused: did not match the signature"],
      ["call", "confirmed", "Called approve on CBIE…DAMA"],
      ["received", "failed", "10.00 USDC from Base did not arrive"],
    ]);
    expect(items[0]?.links.stellar).toBe(`https://stellar.expert/explorer/testnet/contract/${twin}`);
    expect(items[1]?.links.stellar).toBe(`https://stellar.expert/explorer/testnet/tx/${"3".repeat(64)}`);
  });

  it("names the Base recipient of a withdrawal the browser made", () => {
    const evm = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
    const [item] = mergeActivity(
      [chain({ direction: "out", counterparty: hub, amount: 20_000_000n })],
      [entry({ kind: "exit", status: "done", amount: "20000000", counterparty: evm, stellarTxHash: STELLAR_HASH })],
      context,
    );
    expect(item).toMatchObject({ kind: "exit", title: "Sent 2.00 USDC back to Base · 0x7880…767C", counterparty: evm, source: "both" });
  });

  it("orders everything newest first", () => {
    const items = mergeActivity(
      [chain({ id: "older", at: T0, txHash: "4".repeat(64) }), chain({ id: "newest", at: T0 + 30_000, txHash: "5".repeat(64) })],
      [entry({ id: "middle", kind: "refused", status: "refused", at: T0 + 10_000 })],
      context,
    );
    expect(items.map((item) => item.id)).toEqual(["newest", "middle", "older"]);
  });
});

describe("the session log", () => {
  const key = activityLogKey("testnet", twin);

  it("survives a reload", () => {
    const storage = memoryStorage();
    const log = createActivityLog(storage, key);
    log.put(entry({ id: "a", at: 1 }));
    log.put(entry({ id: "b", at: 2 }));
    expect(createActivityLog(storage, key).list().map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("replaces an entry with the same id and tells its watchers", () => {
    const log = createActivityLog(memoryStorage(), key);
    let notified = 0;
    log.subscribe(() => (notified += 1));
    log.put(entry({ id: "a", status: "pending" }));
    log.put(entry({ id: "a", status: "done", stellarTxHash: STELLAR_HASH }));
    expect(log.list()).toEqual([entry({ id: "a", status: "done", stellarTxHash: STELLAR_HASH })]);
    expect(notified).toBe(2);
  });

  it("keeps the newest entries and drops the rest", () => {
    const log = createActivityLog(memoryStorage(), key, 3);
    for (let index = 0; index < 5; index += 1) log.put(entry({ id: `e${index}`, at: index }));
    expect(log.list().map((item) => item.id)).toEqual(["e4", "e3", "e2"]);
  });

  it("works without storage and shrugs off what it cannot read", () => {
    const log = createActivityLog(null, key);
    log.put(entry({ id: "a" }));
    expect(log.list()).toHaveLength(1);
    expect(createActivityLog(memoryStorage({ [key]: "{broken" }), key).list()).toEqual([]);
    expect(createActivityLog(memoryStorage({ [key]: JSON.stringify([{ nope: true }, entry({ id: "ok" })]) }), key).list()).toHaveLength(1);
  });
});

describe("createResource", () => {
  function environment(): ResourceEnvironment & { tick(): void; show(): void; visible: boolean; time: number } {
    let onTick: () => void = () => undefined;
    let onShow: () => void = () => undefined;
    const env = {
      visible: true,
      time: 100,
      now: () => env.time,
      isVisible: () => env.visible,
      onVisible(callback: () => void) {
        onShow = callback;
        return () => (onShow = () => undefined);
      },
      every(_ms: number, callback: () => void) {
        onTick = callback;
        return () => (onTick = () => undefined);
      },
      tick: () => onTick(),
      show: () => onShow(),
    };
    return env;
  }

  it("reads when first watched, then on every tick while the page is visible", async () => {
    const env = environment();
    let reads = 0;
    const resource = createResource(async () => (reads += 1), { intervalMs: 10_000, environment: env });
    expect(resource.getState().status).toBe("idle");

    const stop = resource.subscribe(() => undefined);
    expect(resource.getState()).toMatchObject({ status: "loading", refreshing: true });
    await settle(2);
    expect(resource.getState()).toEqual({ status: "ready", data: 1, error: null, updatedAt: 100, refreshing: false });

    env.tick();
    await settle(2);
    expect(reads).toBe(2);

    env.visible = false;
    env.tick();
    env.tick();
    await settle(2);
    expect(reads).toBe(2);

    env.visible = true;
    env.show();
    await settle(2);
    expect(reads).toBe(3);

    stop();
    env.tick();
    await settle(2);
    expect(reads).toBe(3);
  });

  it("shares one read between callers that ask at the same time", async () => {
    let reads = 0;
    const resource = createResource(async () => (reads += 1), { environment: environment() });
    await Promise.all([resource.refresh(), resource.refresh(), resource.refresh()]);
    expect(reads).toBe(1);
  });

  it("keeps the last answer when a later read fails, and says why", async () => {
    const answers: (number | Error)[] = [7, new TypeError("Failed to fetch")];
    const resource = createResource(
      async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      { environment: environment() },
    );
    await resource.refresh();
    await resource.refresh();
    expect(resource.getState()).toMatchObject({ status: "ready", data: 7, error: expect.stringMatching(/network did not answer/i) });
  });

  it("reports an error when there is nothing to fall back on", async () => {
    const resource = createResource(async () => Promise.reject(new Error("boom")), { environment: environment() });
    await resource.refresh();
    expect(resource.getState()).toMatchObject({ status: "error", data: null, error: "boom" });
  });
});
