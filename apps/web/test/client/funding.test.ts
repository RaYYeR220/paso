import type { FundFromEvmArgs, FundFromEvmResult } from "@paso/sdk";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure, type DeliverResponse, type DemoFundResponse } from "@/lib/client/api";
import {
  createFundingController,
  faucetFailure,
  fundingStorageKey,
  type EvmClients,
  type FundingDeps,
} from "@/lib/client/funding/controller";
import {
  fundingReducer,
  IDLE_FUNDING,
  isFundingActive,
  trackerStages,
  type FundingEvent,
  type FundingFailure,
  type FundingState,
  type Transfer,
} from "@/lib/client/funding/machine";
import { memoryStorage, type KeyValueStore } from "@/lib/client/storage";
import {
  BURN,
  delivered,
  forever,
  funded,
  network,
  OTHER_BURN,
  owner,
  pending,
  recordingLog,
  scripted,
  settle,
  STELLAR_HASH,
  twin,
  until,
} from "./helpers";

const transfer: Transfer = {
  network: "testnet",
  chain: "base",
  burnTxHash: BURN,
  sourceDomain: 6,
  owner: owner.address,
  twin,
  amount: "10000000",
  via: "wallet",
  startedAt: 1_000,
};

const unavailable: FundingFailure = { code: "unavailable", message: "not answering", retryable: true };

function run(events: FundingEvent[], from: FundingState = IDLE_FUNDING): FundingState {
  return events.reduce(fundingReducer, from);
}

const request: FundingEvent = { type: "REQUEST", via: "wallet", chain: "base", owner: owner.address, amount: "10000000", at: 500 };

describe("fundingReducer", () => {
  it("walks the whole way from idle to minted", () => {
    let state = run([request]);
    expect(state).toMatchObject({ phase: "requesting", step: "starting", startedAt: 500, amount: "10000000" });

    state = run([{ type: "STEP", step: "approving" }], state);
    state = run([{ type: "STEP", step: "approved", approveTxHash: OTHER_BURN }], state);
    state = run([{ type: "STEP", step: "burning" }], state);
    state = run([{ type: "STEP", step: "confirming", burnTxHash: BURN }], state);
    expect(state).toMatchObject({ phase: "requesting", step: "confirming", approveTxHash: OTHER_BURN, burnTxHash: BURN });

    state = run([{ type: "BURNED", transfer }], state);
    expect(state).toEqual({ phase: "burned", transfer });

    state = run([{ type: "PENDING", attestation: "not_found" }], state);
    expect(state).toEqual({ phase: "attesting", transfer, startedAt: 1_000, attestation: "not_found" });

    state = run([{ type: "PENDING", attestation: "pending", delayReason: "insufficient_fee" }], state);
    expect(state).toMatchObject({ phase: "attesting", attestation: "pending", delayReason: "insufficient_fee", startedAt: 1_000 });

    state = run([{ type: "DELIVERING" }], state);
    expect(state).toEqual({ phase: "delivering", transfer, startedAt: 1_000 });

    state = run([{ type: "DELIVERED", hash: STELLAR_HASH, route: "forwarder", at: 21_000 }], state);
    expect(state).toEqual({ phase: "minted", transfer, stellarTxHash: STELLAR_HASH, route: "forwarder", finishedAt: 21_000 });
  });

  it("counts a delivery without a hash as minted", () => {
    const state = run([request, { type: "BURNED", transfer }, { type: "DELIVERED", route: "direct", at: 9 }]);
    expect(state).toEqual({ phase: "minted", transfer, route: "direct", finishedAt: 9 });
    expect("stellarTxHash" in state).toBe(false);
  });

  it("goes back to attesting when a long answer turns out to be pending", () => {
    const state = run([request, { type: "BURNED", transfer }, { type: "DELIVERING" }, { type: "PENDING", attestation: "pending" }]);
    expect(state).toMatchObject({ phase: "attesting", attestation: "pending", startedAt: 1_000 });
  });

  it("returns to idle when the owner declines, and says so", () => {
    expect(run([request, { type: "CANCELLED" }])).toEqual({ phase: "idle", notice: "cancelled" });
    expect(run([request, { type: "BURNED", transfer }, { type: "CANCELLED" }]).phase).toBe("burned");
  });

  it("fails from any phase in flight and keeps the burn it knows", () => {
    expect(run([request, { type: "FAILED", reason: unavailable, at: 7 }])).toEqual({ phase: "failed", reason: unavailable, chain: "base", failedAt: 7 });
    for (const before of [[], [{ type: "PENDING", attestation: "pending" }], [{ type: "DELIVERING" }]] as FundingEvent[][]) {
      const state = run([request, { type: "BURNED", transfer }, ...before, { type: "FAILED", reason: unavailable, at: 7 }]);
      expect(state).toEqual({ phase: "failed", reason: unavailable, transfer, chain: "base", failedAt: 7 });
    }
  });

  it("resumes a burn from idle, from minted and from failed, never over one in flight", () => {
    expect(run([{ type: "RESUMED", transfer }])).toEqual({ phase: "burned", transfer });
    const failed = run([request, { type: "BURNED", transfer }, { type: "FAILED", reason: unavailable, at: 7 }]);
    expect(run([{ type: "RESUMED", transfer }], failed)).toEqual({ phase: "burned", transfer });

    const other = { ...transfer, burnTxHash: OTHER_BURN };
    const attesting = run([{ type: "RESUMED", transfer }, { type: "PENDING", attestation: "pending" }]);
    expect(run([{ type: "RESUMED", transfer: other }], attesting)).toBe(attesting);
  });

  it("ignores a second request while one is in flight", () => {
    const requesting = run([request]);
    expect(run([{ ...request, amount: "1" }], requesting)).toBe(requesting);
    const burned = run([{ type: "BURNED", transfer }], requesting);
    expect(run([request], burned)).toBe(burned);
  });

  it("starts over after minted or failed", () => {
    const minted = run([request, { type: "BURNED", transfer }, { type: "DELIVERED", route: "forwarder", at: 9 }]);
    expect(run([request], minted).phase).toBe("requesting");
    expect(run([{ type: "RESET" }], minted)).toBe(IDLE_FUNDING);
  });

  it("ignores events that do not belong to the phase", () => {
    const stray: FundingEvent[] = [
      { type: "STEP", step: "burning" },
      { type: "BURNED", transfer },
      { type: "PENDING", attestation: "pending" },
      { type: "DELIVERING" },
      { type: "DELIVERED", route: "forwarder", at: 1 },
      { type: "FAILED", reason: unavailable, at: 1 },
      { type: "CANCELLED" },
    ];
    for (const event of stray) expect(fundingReducer(IDLE_FUNDING, event)).toBe(IDLE_FUNDING);
    const minted = run([request, { type: "BURNED", transfer }, { type: "DELIVERED", route: "forwarder", at: 9 }]);
    expect(run([{ type: "PENDING", attestation: "pending" }, { type: "FAILED", reason: unavailable, at: 1 }], minted)).toBe(minted);
  });

  it("knows which phases are in flight", () => {
    expect(isFundingActive(IDLE_FUNDING)).toBe(false);
    expect(isFundingActive(run([request]))).toBe(true);
    expect(isFundingActive(run([request, { type: "BURNED", transfer }]))).toBe(true);
    expect(isFundingActive(run([request, { type: "FAILED", reason: unavailable, at: 1 }]))).toBe(false);
  });
});

describe("trackerStages", () => {
  const statuses = (state: FundingState) => trackerStages(state, "Base").map((stage) => stage.status);

  it("uses Circle's words, with the chain the USDC leaves", () => {
    expect(trackerStages(IDLE_FUNDING, "Base").map((stage) => stage.label)).toEqual(["Burned on Base", "Attested by Circle", "Minted on Stellar"]);
    expect(trackerStages(IDLE_FUNDING, "Arbitrum")[0]?.label).toBe("Burned on Arbitrum");
  });

  it("moves one step at a time", () => {
    expect(statuses(run([request]))).toEqual(["active", "waiting", "waiting"]);
    expect(statuses(run([request, { type: "BURNED", transfer }]))).toEqual(["done", "active", "waiting"]);
    expect(statuses(run([request, { type: "BURNED", transfer }, { type: "DELIVERING" }]))).toEqual(["done", "done", "active"]);
    expect(statuses(run([request, { type: "BURNED", transfer }, { type: "DELIVERED", route: "direct", at: 1 }]))).toEqual(["done", "done", "done"]);
  });

  it("marks the step that failed", () => {
    expect(statuses(run([request, { type: "FAILED", reason: unavailable, at: 1 }]))).toEqual(["failed", "waiting", "waiting"]);
    expect(statuses(run([request, { type: "BURNED", transfer }, { type: "FAILED", reason: unavailable, at: 1 }]))).toEqual(["done", "failed", "waiting"]);
    const undeliverable: FundingFailure = { code: "undeliverable", message: "no", retryable: false };
    expect(statuses(run([request, { type: "BURNED", transfer }, { type: "FAILED", reason: undeliverable, at: 1 }]))).toEqual(["done", "done", "failed"]);
  });
});

interface Harness {
  storage: KeyValueStore;
  log: ReturnType<typeof recordingLog>;
  demoFund: ReturnType<typeof scripted<DemoFundResponse>>;
  deliver: ReturnType<typeof scripted<DeliverResponse>>;
  clock: { now: number };
  slow: { fire: boolean };
  make(overrides?: Partial<FundingDeps>): ReturnType<typeof createFundingController>;
}

function harness(script: { demoFund?: (DemoFundResponse | Error)[]; deliver?: (DeliverResponse | Error)[]; storage?: KeyValueStore } = {}): Harness {
  const storage = script.storage ?? memoryStorage();
  const log = recordingLog();
  const demoFund = scripted<DemoFundResponse>(script.demoFund ?? [funded()]);
  const deliver = scripted<DeliverResponse>(script.deliver ?? []);
  const clock = { now: 1_000 };
  const slow = { fire: false };
  return {
    storage,
    log,
    demoFund,
    deliver,
    clock,
    slow,
    make: (overrides = {}) =>
      createFundingController(owner.address, {
        network,
        api: { demoFund, deliver },
        storage,
        log: log.for,
        now: () => clock.now,
        sleep: () => Promise.resolve(),
        after: (_ms, callback) => {
          if (slow.fire) callback();
          return () => undefined;
        },
        ...overrides,
      }),
  };
}

const key = fundingStorageKey("testnet", owner.address);

describe("funding with the faucet", () => {
  it("burns through the faucet, follows the burn and ends minted", async () => {
    const h = harness({ deliver: [pending("not_found"), pending(), delivered(STELLAR_HASH)] });
    const controller = h.make();
    const phases: string[] = [];
    controller.subscribe(() => phases.push(controller.getState().phase));

    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");

    expect(phases).toEqual(["requesting", "burned", "attesting", "attesting", "minted"]);
    expect(controller.getState()).toMatchObject({ phase: "minted", stellarTxHash: STELLAR_HASH, route: "forwarder" });
    expect(h.demoFund.calls).toEqual([[owner.address]]);
    expect(h.deliver.calls).toHaveLength(3);
    expect(h.deliver.calls[0]?.[0]).toEqual({ sourceDomain: 6, txHash: BURN });
    expect(h.storage.getItem(key)).toBeNull();
    expect(h.log.entries.get(`fund:${BURN}`)).toMatchObject({
      kind: "receive",
      status: "done",
      amount: "10000000",
      chain: "base",
      evmTxHash: BURN,
      stellarTxHash: STELLAR_HASH,
    });
  });

  it("treats a delivery someone else made as success", async () => {
    const h = harness({ deliver: [delivered()] });
    const controller = h.make();
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");
    const state = controller.getState();
    expect(state.phase === "minted" && state.stellarTxHash).toBeUndefined();
    expect(h.log.entries.get(`fund:${BURN}`)).toMatchObject({ status: "done" });
  });

  it("shows delivering once an answer takes longer than a lookup", async () => {
    const h = harness({ deliver: [pending()] });
    const controller = h.make();
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "attesting", "attesting");
    h.slow.fire = true;
    await until(() => controller.getState().phase === "delivering", "delivering");
  });

  it("starts one transfer for two clicks", async () => {
    const h = harness({ deliver: [] });
    const controller = h.make();
    const first = controller.start({ via: "demo" });
    const second = controller.start({ via: "demo" });
    await Promise.all([first, second]);
    await controller.start({ via: "demo" });
    expect(h.demoFund.calls).toHaveLength(1);
    expect(controller.getState().phase).toBe("burned");
  });

  it("reports a rate limit as such, with the wait", async () => {
    const limited = new ApiFailure("rate_limited", 429, "This account has already been funded by the demo faucet; try again later", 3_600);
    const h = harness({ demoFund: [limited] });
    const controller = h.make();
    await controller.start({ via: "demo" });
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "failed", reason: { code: "rate_limited", retryAfterSeconds: 3_600, retryable: true } });
    expect(state.phase === "failed" && state.reason.message).toMatch(/already had test USDC/);
    expect(h.deliver.calls).toHaveLength(0);
    expect(h.storage.getItem(key)).toBeNull();
  });

  it("tells an empty faucet, a switched-off faucet and a used-up day apart", () => {
    const refusal = (detail: string, code = "unavailable", status = 503) => faucetFailure(new ApiFailure(code, status, detail), "Base Sepolia");
    expect(refusal("The demo faucet is out of test USDC on Base Sepolia")).toMatchObject({ code: "faucet_empty", retryable: true });
    expect(refusal("The demo faucet is out of gas on Base Sepolia").code).toBe("faucet_empty");
    expect(refusal("The demo faucet is out of test USDC on Base Sepolia").message).toMatch(/run dry.*Base Sepolia/);
    expect(refusal("The demo faucet has no payer configured")).toMatchObject({ code: "faucet_off", retryable: false });
    expect(refusal("The demo faucet exists on testnet only", "not_found", 404).code).toBe("faucet_off");
    expect(refusal("The demo faucet has given out all it gives in a day; try again later").code).toBe("faucet_daily_limit");
    expect(refusal("This address has used the demo faucet too often; try again later", "rate_limited", 429)).toMatchObject({
      code: "rate_limited",
      message: expect.stringMatching(/too often/),
    });
    expect(refusal("The demo faucet could not send USDC on Base Sepolia; try again later")).toMatchObject({ code: "unavailable", retryable: true });
    expect(faucetFailure(new ApiFailure("network", 0, "The server could not be reached"), "Base Sepolia").code).toBe("unavailable");
  });

  it("fails with the faucet's reason and can start again afterwards", async () => {
    const empty = new ApiFailure("unavailable", 503, "The demo faucet is out of test USDC on Base Sepolia");
    const h = harness({ demoFund: [empty, funded()], deliver: [delivered(STELLAR_HASH)] });
    const controller = h.make();
    await controller.start({ via: "demo" });
    expect(controller.getState()).toMatchObject({ phase: "failed", reason: { code: "faucet_empty" } });
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");
  });
});

describe("following a burn", () => {
  it("keeps asking through outages and limits, then delivers", async () => {
    const h = harness({
      deliver: [
        new ApiFailure("unavailable", 503, "The relayer is busy; try again in a moment"),
        new ApiFailure("rate_limited", 429, "Too many requests; try again shortly", 2),
        new ApiFailure("network", 0, "The server could not be reached"),
        pending(),
        delivered(STELLAR_HASH),
      ],
    });
    const sleeps: number[] = [];
    const controller = h.make({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");
    expect(h.deliver.calls).toHaveLength(5);
    expect(sleeps).toEqual([2_000, 2_000, 6_000, 2_000]);
  });

  it("shows the attestation service as unreachable while the route is down", async () => {
    const h = harness({ deliver: [new ApiFailure("unavailable", 503, "busy")] });
    const controller = h.make();
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "attesting", "attesting");
    expect(controller.getState()).toMatchObject({ phase: "attesting", attestation: "unreachable" });
  });

  it("never calls a burn failed because the route is down, however long", async () => {
    const down = () => new ApiFailure("unavailable", 503, "busy");
    const outage = Array.from({ length: 40 }, down);
    const h = harness({ deliver: [...outage, delivered(STELLAR_HASH)] });
    const sleeps: number[] = [];
    const phases = new Set<string>();
    const controller = h.make({
      sleep: async (ms) => {
        sleeps.push(ms);
        expect(h.storage.getItem(key)).not.toBeNull();
      },
    });
    controller.subscribe(() => phases.add(controller.getState().phase));
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");

    expect(phases.has("failed")).toBe(false);
    expect(phases.has("idle")).toBe(false);
    expect(sleeps.slice(0, 6)).toEqual([2_000, 4_000, 6_000, 8_000, 10_000, 10_000]);
    expect(h.deliver.calls).toHaveLength(41);
    expect(h.storage.getItem(key)).toBeNull();
  });

  it("keeps a burn on record when the server says it cannot be delivered, and can ask again", async () => {
    const h = harness({
      deliver: [new ApiFailure("simulation_failed", 422, "The message cannot be delivered: Error(Contract, #1)"), delivered(STELLAR_HASH)],
    });
    const controller = h.make();
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "failed", "failed");
    expect(controller.getState()).toMatchObject({ phase: "failed", reason: { code: "undeliverable" }, transfer: { burnTxHash: BURN } });
    expect(h.storage.getItem(key)).not.toBeNull();
    expect(controller.tracked()).toMatchObject({ transfer: { burnTxHash: BURN }, saved: true });
    expect(h.log.entries.get(`fund:${BURN}`)).toMatchObject({ status: "failed" });

    expect(controller.retry()).toBe(true);
    await until(() => controller.getState().phase === "minted", "minted");
    expect(h.storage.getItem(key)).toBeNull();
    expect(controller.tracked()).toBeNull();
  });

  it("refuses a hash that is not a USDC burn to Stellar", async () => {
    const h = harness({ deliver: [new ApiFailure("bad_request", 400, "That transaction does not carry a USDC transfer")] });
    const controller = h.make();
    expect(controller.resume(OTHER_BURN)).toBe(true);
    await until(() => controller.getState().phase === "failed", "failed");
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      reason: { code: "burn_not_found", message: "That transaction does not carry a USDC transfer" },
    });
  });

  it("goes on waiting, less often, for a burn Circle has not heard of", async () => {
    const h = harness({ deliver: [pending("not_found"), pending("not_found"), pending("not_found"), delivered(STELLAR_HASH)] });
    const sleeps: number[] = [];
    const controller = h.make({
      burnNotFoundAfterMs: 60_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        expect(controller.getState()).toMatchObject({ phase: "attesting", attestation: "not_found" });
        h.clock.now += 45_000;
      },
    });
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "minted", "minted");
    expect(sleeps).toEqual([2_000, 2_000, 10_000]);
    expect(h.deliver.calls).toHaveLength(4);
  });
});

describe("a burn on record", () => {
  async function inFlight(script: Parameters<typeof harness>[0] = { deliver: [pending()] }) {
    const h = harness(script);
    let wake: () => void = () => undefined;
    const controller = h.make({ sleep: () => new Promise<void>((resolve) => (wake = resolve)) });
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "attesting", "attesting");
    return { h, controller, wake: () => wake() };
  }

  it("is written before the faucet's answer is acted on", async () => {
    const h = harness({ deliver: [] });
    const seen: (string | null)[] = [];
    const controller = h.make();
    controller.subscribe(() => {
      if (controller.getState().phase === "burned") seen.push(h.storage.getItem(key));
    });
    await controller.start({ via: "demo" });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] ?? "null")).toMatchObject({ burnTxHash: BURN, via: "demo" });
  });

  it("refuses a reset: the burn stays followed and stored", async () => {
    const { h, controller, wake } = await inFlight({ deliver: [pending(), delivered(STELLAR_HASH)] });
    expect(controller.reset()).toBe(false);
    expect(controller.getState().phase).toBe("attesting");
    expect(h.storage.getItem(key)).not.toBeNull();
    wake();
    await until(() => controller.getState().phase === "minted", "minted");
  });

  it("refuses a second start, and a different burn by hash, without touching the first", async () => {
    const { h, controller } = await inFlight();
    await controller.start({ via: "demo" });
    expect(controller.resume(OTHER_BURN)).toBe(false);
    expect(h.demoFund.calls).toHaveLength(1);
    expect(JSON.parse(h.storage.getItem(key) ?? "null")).toMatchObject({ burnTxHash: BURN });
  });

  it("refuses a new start after a final answer too, until the owner stops tracking", async () => {
    const h = harness({
      demoFund: [funded(), funded(OTHER_BURN)],
      deliver: [new ApiFailure("bad_request", 400, "That transaction does not carry a USDC transfer")],
    });
    const controller = h.make();
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "failed", "failed");

    await controller.start({ via: "demo" });
    expect(controller.reset()).toBe(false);
    expect(h.demoFund.calls).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ phase: "failed", transfer: { burnTxHash: BURN } });

    expect(controller.stopTracking()).toBe(true);
    expect(controller.getState()).toBe(IDLE_FUNDING);
    expect(h.storage.getItem(key)).toBeNull();
    await controller.start({ via: "demo" });
    expect(h.demoFund.calls).toHaveLength(2);
  });

  it("is taken off only by stopping the tracker, which also stops the questions", async () => {
    const { h, controller, wake } = await inFlight();
    expect(controller.stopTracking()).toBe(true);
    wake();
    await settle();
    expect(controller.getState()).toBe(IDLE_FUNDING);
    expect(controller.tracked()).toBeNull();
    expect(h.deliver.calls).toHaveLength(1);
    expect(h.storage.getItem(key)).toBeNull();
    expect(controller.stopTracking()).toBe(false);
  });

  it("is cleared when the USDC is delivered", async () => {
    const { h, controller, wake } = await inFlight({ deliver: [pending(), delivered(STELLAR_HASH)] });
    expect(controller.tracked()).not.toBeNull();
    wake();
    await until(() => controller.getState().phase === "minted", "minted");
    expect(controller.tracked()).toBeNull();
    expect(h.storage.getItem(key)).toBeNull();
    expect(controller.reset()).toBe(true);
  });

  it("resumes after a reload that happened during an outage, and after a final answer", async () => {
    const down = new ApiFailure("network", 0, "The server could not be reached");
    const before = harness({ deliver: [down] });
    await before.make().start({ via: "demo" });
    await settle();

    const reloaded = harness({ storage: before.storage, deliver: [new ApiFailure("simulation_failed", 422, "no")] }).make();
    expect(reloaded.restore()).toBe(true);
    await until(() => reloaded.getState().phase === "failed", "failed");

    const again = harness({ storage: before.storage, deliver: [delivered(STELLAR_HASH)] }).make();
    expect(again.restore()).toBe(true);
    await until(() => again.getState().phase === "minted", "minted");
    expect(before.storage.getItem(key)).toBeNull();
  });

  it("lives in memory when the browser keeps no storage, and says so", async () => {
    const blocked: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    for (const storage of [blocked, null]) {
      const deliver = scripted<DeliverResponse>([pending(), delivered(STELLAR_HASH)]);
      let wake: () => void = () => undefined;
      const controller = createFundingController(owner.address, {
        network,
        api: { demoFund: scripted<DemoFundResponse>([funded()]), deliver },
        storage,
        sleep: () => new Promise<void>((resolve) => (wake = resolve)),
        after: () => () => undefined,
      });
      await controller.start({ via: "demo" });
      await until(() => controller.getState().phase === "attesting", "attesting");
      expect(controller.tracked()).toMatchObject({ transfer: { burnTxHash: BURN }, saved: false });
      expect(controller.reset()).toBe(false);
      await controller.start({ via: "demo" });
      expect(controller.getState().phase).toBe("attesting");
      wake();
      await until(() => controller.getState().phase === "minted", "minted");
      expect(controller.tracked()).toBeNull();
    }
  });
});

describe("resuming after a reload", () => {
  it("keeps the transfer in storage while it is in flight", async () => {
    const h = harness({ deliver: [pending()] });
    const controller = h.make();
    h.clock.now = 5_000;
    await controller.start({ via: "demo" });
    await until(() => controller.getState().phase === "attesting", "attesting");
    expect(JSON.parse(h.storage.getItem(key) ?? "null")).toEqual({
      network: "testnet",
      chain: "base",
      burnTxHash: BURN,
      sourceDomain: 6,
      owner: owner.address,
      twin,
      amount: "1000000",
      via: "demo",
      startedAt: 5_000,
    });
  });

  it("picks the transfer up in a new page and keeps its clock", async () => {
    const before = harness({ deliver: [pending()] });
    before.clock.now = 5_000;
    await before.make().start({ via: "demo" });
    await settle();

    const after = harness({ storage: before.storage, deliver: [pending(), delivered(STELLAR_HASH)] });
    after.clock.now = 65_000;
    const reloaded = after.make();
    expect(reloaded.getState()).toBe(IDLE_FUNDING);
    expect(reloaded.restore()).toBe(true);
    expect(reloaded.getState()).toMatchObject({ phase: "burned", transfer: { burnTxHash: BURN, startedAt: 5_000, via: "demo" } });

    await until(() => reloaded.getState().phase === "minted", "minted");
    expect(reloaded.getState()).toMatchObject({ phase: "minted", transfer: { startedAt: 5_000 }, finishedAt: 65_000 });
    expect(after.demoFund.calls).toHaveLength(0);
    expect(after.storage.getItem(key)).toBeNull();
  });

  it("has nothing to restore on a clean start, or from another owner or network", () => {
    expect(harness().make().restore()).toBe(false);
    const foreign = memoryStorage({ [key]: JSON.stringify({ ...transfer, owner: `0x${"99".repeat(20)}` }) });
    expect(harness({ storage: foreign }).make().restore()).toBe(false);
    const mainnet = memoryStorage({ [key]: JSON.stringify({ ...transfer, network: "mainnet" }) });
    expect(harness({ storage: mainnet }).make().restore()).toBe(false);
    const garbage = memoryStorage({ [key]: "{not json" });
    expect(harness({ storage: garbage }).make().restore()).toBe(false);
  });

  it("follows a burn by hash and stores it", async () => {
    const h = harness({ deliver: [delivered(STELLAR_HASH)] });
    const controller = h.make();
    expect(controller.resume("0x1234" as Hex)).toBe(false);
    expect(controller.resume(OTHER_BURN)).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "burned", transfer: { burnTxHash: OTHER_BURN, amount: null, twin } });
    expect(controller.resume(BURN)).toBe(false);
    await until(() => controller.getState().phase === "minted", "minted");
  });

  it("restores only once", async () => {
    const h = harness({ storage: memoryStorage({ [key]: JSON.stringify(transfer) }), deliver: [] });
    const controller = h.make();
    expect(controller.restore()).toBe(true);
    expect(controller.restore()).toBe(false);
    await settle();
    expect(h.deliver.calls).toHaveLength(1);
  });
});

describe("funding from the wallet", () => {
  const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

  function wallet(options: { balance?: bigint; write?: (args: { functionName: string }) => Promise<Hex> } = {}) {
    const writeContract = vi.fn(options.write ?? (async ({ functionName }) => (functionName === "approve" ? OTHER_BURN : BURN)));
    const clients = async (): Promise<EvmClients> =>
      ({
        walletClient: { account: { address: owner.address }, writeContract },
        publicClient: {
          readContract: async () => options.balance ?? 50_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      }) as unknown as EvmClients;
    /** Stands in for the SDK: approves, burns, and reports the burn. */
    const fund = async ({ walletClient }: FundFromEvmArgs): Promise<FundFromEvmResult> => {
      const write = walletClient.writeContract as unknown as (args: { functionName: string }) => Promise<Hex>;
      const approveTxHash = await write({ functionName: "approve" });
      const burnTxHash = await write({ functionName: "depositForBurnWithHook" });
      return { burnTxHash, approveTxHash, route: "forwarder", twin, maxFee: 0n };
    };
    return { writeContract, clients, fund };
  }

  it("reports each wallet prompt, then follows the burn", async () => {
    const h = harness({ deliver: [delivered(STELLAR_HASH)] });
    const { clients, fund } = wallet();
    const controller = h.make({ fund });
    const steps: string[] = [];
    controller.subscribe(() => {
      const state = controller.getState();
      steps.push(state.phase === "requesting" ? state.step : state.phase);
    });

    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    await until(() => controller.getState().phase === "minted", "minted");

    expect(steps).toEqual(["starting", "approving", "approved", "burning", "confirming", "burned", "minted"]);
    expect(controller.getState()).toMatchObject({ phase: "minted", transfer: { burnTxHash: BURN, amount: "10000000", via: "wallet", sourceDomain: 6 } });
    expect(h.demoFund.calls).toHaveLength(0);
    expect(h.log.entries.get(`fund:${BURN}`)).toMatchObject({ amount: "100000000", status: "done" });
  });

  it("puts the burn on record the moment Base has it", async () => {
    const h = harness();
    const { clients } = wallet();
    let stored: string | null = "unset";
    const fund = async ({ walletClient }: FundFromEvmArgs): Promise<FundFromEvmResult> => {
      const write = walletClient.writeContract as unknown as (args: { functionName: string }) => Promise<Hex>;
      const burnTxHash = await write({ functionName: "depositForBurnWithHook" });
      stored = h.storage.getItem(key);
      return forever<FundFromEvmResult>().then(() => ({ burnTxHash, route: "forwarder", twin, maxFee: 0n }));
    };
    void h.make({ fund }).start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    await until(() => stored !== "unset", "the burn to be sent");
    expect(JSON.parse(stored ?? "null")).toMatchObject({ burnTxHash: BURN, amount: "10000000", via: "wallet" });

    const reloaded = harness({ storage: h.storage, deliver: [pending("not_found")] }).make();
    expect(reloaded.restore()).toBe(true);
    await until(() => reloaded.getState().phase === "attesting", "attesting");
  });

  it("returns to idle when the owner declines, without calling it a failure", async () => {
    const h = harness();
    const { clients, fund } = wallet({ write: async () => Promise.reject(rejection()) });
    const controller = h.make({ fund });
    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    expect(controller.getState()).toEqual({ phase: "idle", notice: "cancelled" });
    expect(h.storage.getItem(key)).toBeNull();
    expect(h.log.entries.size).toBe(0);
  });

  it("stops before any prompt when the wallet holds too little USDC", async () => {
    const h = harness();
    const { clients, fund, writeContract } = wallet({ balance: 2_500_000n });
    const controller = h.make({ fund });
    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "failed", reason: { code: "insufficient_usdc" } });
    expect(state.phase === "failed" && state.reason.message).toBe("The wallet holds 2.5 USDC on Base Sepolia; this transfer needs 10.");
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("explains a wallet on the wrong network and one without gas", async () => {
    const wrongChain = harness().make();
    await wrongChain.start({
      via: "wallet",
      chain: "base",
      amount: 1n,
      clients: () => Promise.reject(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 })),
    });
    expect(wrongChain.getState()).toMatchObject({ phase: "failed", reason: { code: "wrong_network" } });

    const { clients, fund } = wallet({ write: async () => Promise.reject(new Error("insufficient funds for gas * price + value")) });
    const noGas = harness().make({ fund });
    await noGas.start({ via: "wallet", chain: "base", amount: 1n, clients });
    expect(noGas.getState()).toMatchObject({ phase: "failed", reason: { code: "insufficient_gas" } });
  });

  it("follows a burn whose confirmation could not be read", async () => {
    const h = harness({ deliver: [pending("not_found")] });
    const { clients } = wallet();
    const fund = async ({ walletClient }: FundFromEvmArgs): Promise<FundFromEvmResult> => {
      const write = walletClient.writeContract as unknown as (args: { functionName: string }) => Promise<Hex>;
      await write({ functionName: "depositForBurnWithHook" });
      throw new Error("fetch failed");
    };
    const controller = h.make({ fund });
    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    await until(() => controller.getState().phase === "attesting", "attesting");
    expect(controller.getState()).toMatchObject({ phase: "attesting", transfer: { burnTxHash: BURN, amount: "10000000" } });
    expect(JSON.parse(h.storage.getItem(key) ?? "null")).toMatchObject({ burnTxHash: BURN });
  });

  it("says so when the wallet never reports whether the burn was sent", async () => {
    const h = harness();
    const { clients, fund } = wallet({
      write: async ({ functionName }) => {
        if (functionName === "approve") return OTHER_BURN;
        throw new Error("Internal JSON-RPC error.");
      },
    });
    const controller = h.make({ fund });
    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    const state = controller.getState();
    expect(state).toMatchObject({ phase: "failed", reason: { code: "burn_unconfirmed", retryable: false } });
    expect(state.phase === "failed" && state.reason.message).toMatch(/did not say whether the burn was sent.*activity/);
    expect(controller.tracked()).toBeNull();

    expect(controller.resume(BURN)).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "burned", transfer: { burnTxHash: BURN } });
  });

  it("forgets a burn that reverted", async () => {
    const h = harness();
    const { clients } = wallet();
    const fund = async ({ walletClient }: FundFromEvmArgs): Promise<FundFromEvmResult> => {
      const write = walletClient.writeContract as unknown as (args: { functionName: string }) => Promise<Hex>;
      const hash = await write({ functionName: "depositForBurnWithHook" });
      throw new Error(`The burn reverted on Base: ${hash}`);
    };
    const controller = h.make({ fund });
    await controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    expect(controller.getState()).toMatchObject({ phase: "failed", reason: { code: "unknown", message: "The transaction reverted on Base. Nothing was sent." } });
    expect(h.storage.getItem(key)).toBeNull();
  });

  it("refuses an amount of nothing", async () => {
    const controller = harness().make();
    await controller.start({ via: "wallet", chain: "base", amount: 0n, clients: wallet().clients });
    expect(controller.getState()).toMatchObject({ phase: "failed", reason: { message: "Enter an amount above zero" } });
  });

  it("still follows a burn that confirms after the request was dismissed", async () => {
    const h = harness({ deliver: [delivered(STELLAR_HASH)] });
    const { clients } = wallet();
    let finish: () => void = () => undefined;
    const fund = async ({ walletClient }: FundFromEvmArgs): Promise<FundFromEvmResult> => {
      const write = walletClient.writeContract as unknown as (args: { functionName: string }) => Promise<Hex>;
      const burnTxHash = await write({ functionName: "depositForBurnWithHook" });
      await new Promise<void>((resolve) => (finish = resolve));
      return { burnTxHash, route: "forwarder", twin, maxFee: 0n };
    };
    const controller = h.make({ fund });
    const started = controller.start({ via: "wallet", chain: "base", amount: 10_000_000n, clients });
    await until(() => {
      const state = controller.getState();
      return state.phase === "requesting" && state.step === "confirming";
    }, "the burn to be sent");
    expect(controller.reset()).toBe(false);
    finish();
    await started;
    await until(() => controller.getState().phase === "minted", "minted");
    expect(controller.getState()).toMatchObject({ phase: "minted", transfer: { burnTxHash: BURN } });
  });
});
