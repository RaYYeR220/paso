import { NETWORKS, twinAddress, type FundFromEvmArgs, type FundFromEvmResult } from "paso-sdk";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure, type DeliverResponse, type DemoFundResponse } from "@/lib/client/api";
import { createFundingController, fundingStorageKey, type EvmClients, type FundingDeps } from "@/lib/client/funding/controller";
import { burnAmountProblem, burnCeiling, MAINNET_BURN_CEILING, WALLET_BURN_MIN } from "@/lib/client/funding/limits";
import { memoryStorage, type KeyValueStore } from "@/lib/client/storage";
import { BURN, delivered, funded, OTHER_BURN, owner, pending, scripted, settle, STELLAR_HASH, until } from "./helpers";

const mainnet = NETWORKS.mainnet;
const testnet = NETWORKS.testnet;
const mainnetTwin = twinAddress(owner.address, mainnet);

function harness(
  script: { deliver?: (DeliverResponse | Error)[]; storage?: KeyValueStore; network?: typeof mainnet } = {},
  overrides: Partial<FundingDeps> = {},
) {
  const storage = script.storage ?? memoryStorage();
  const demoFund = scripted<DemoFundResponse>([funded()]);
  const deliver = scripted<DeliverResponse>(script.deliver ?? []);
  const network = script.network ?? mainnet;
  const controller = createFundingController(owner.address, {
    network,
    api: { demoFund, deliver },
    storage,
    ceiling: burnCeiling(network.name),
    now: () => 1_000,
    sleep: () => Promise.resolve(),
    after: () => () => undefined,
    ...overrides,
  });
  return { storage, demoFund, deliver, controller };
}

function wallet() {
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }): Promise<Hex> => (functionName === "approve" ? OTHER_BURN : BURN));
  const clients = vi.fn(
    async (): Promise<EvmClients> =>
      ({
        walletClient: { account: { address: owner.address }, writeContract },
        publicClient: {
          readContract: async () => 500_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      }) as unknown as EvmClients,
  );
  const funds: FundFromEvmArgs[] = [];
  const fund = async (args: FundFromEvmArgs): Promise<FundFromEvmResult> => {
    funds.push(args);
    const write = args.walletClient.writeContract as unknown as (call: { functionName: string }) => Promise<Hex>;
    const burnTxHash = await write({ functionName: "depositForBurnWithHook" });
    return { burnTxHash, route: "forwarder", twin: mainnetTwin, maxFee: 0n };
  };
  return { writeContract, clients, fund, funds };
}

const declined = (reason: string, detail: string, retryAfter?: number) =>
  new ApiFailure("unavailable", 503, detail, retryAfter, reason as ApiFailure["reason"]);

describe("the faucet on mainnet", () => {
  it("is not asked at all: the request ends before it leaves the browser", async () => {
    const h = harness();

    await h.controller.start({ via: "demo" });

    expect(h.controller.getState()).toMatchObject({
      phase: "failed",
      reason: { code: "faucet_off", message: "The faucet exists on testnet only.", retryable: false },
    });
    expect(h.demoFund.calls).toHaveLength(0);
    expect(h.controller.tracked()).toBeNull();
    expect(h.storage.getItem(fundingStorageKey("mainnet", owner.address))).toBeNull();
  });
});

describe("how much one transfer may bring over", () => {
  const limits = (ceiling: bigint | null) => ({ min: WALLET_BURN_MIN, max: 500_000_000n, ceiling });

  it("has a ceiling on mainnet, of 25 USDC, and none on testnet", () => {
    expect(MAINNET_BURN_CEILING).toBe(25_000_000n);
    expect(burnCeiling("mainnet")).toBe(25_000_000n);
    expect(burnCeiling("testnet")).toBeNull();
  });

  it("says why an amount above the ceiling is not taken", () => {
    expect(burnAmountProblem(25_000_000n, limits(25_000_000n), "Base")).toBeNull();
    expect(burnAmountProblem(25_000_001n, limits(25_000_000n), "Base")).toBe(
      "On mainnet this app brings over at most 25 USDC at a time: the software has not been audited.",
    );
    expect(burnAmountProblem(25_000_001n, limits(null), "Base Sepolia")).toBeNull();
  });

  it("puts what the wallet holds before the ceiling: there is nothing to cap in an empty wallet", () => {
    expect(burnAmountProblem(30_000_000n, { min: WALLET_BURN_MIN, max: 10_000_000n, ceiling: 25_000_000n }, "Base")).toBe(
      "The wallet holds 10 USDC on Base",
    );
  });

  it("is enforced where the burn is made, not only where the amount is typed", async () => {
    const h = harness();
    const { clients, fund, writeContract } = wallet();
    const controller = createFundingController(owner.address, {
      network: mainnet,
      api: { demoFund: h.demoFund, deliver: h.deliver },
      storage: h.storage,
      ceiling: burnCeiling("mainnet"),
      fund,
    });

    await controller.start({ via: "wallet", chain: "base", amount: 25_000_001n, clients });

    expect(controller.getState()).toMatchObject({
      phase: "failed",
      reason: { code: "over_ceiling", message: expect.stringContaining("at most 25 USDC at a time"), retryable: false },
    });
    expect(clients).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
    expect(controller.tracked()).toBeNull();
  });

  it("lets the ceiling itself through, on the network's own Base and to the network's own account", async () => {
    const { clients, fund, funds } = wallet();
    const h = harness({ deliver: [delivered(STELLAR_HASH)] }, { fund });

    await h.controller.start({ via: "wallet", chain: "base", amount: 25_000_000n, clients });
    await until(() => h.controller.getState().phase === "minted", "minted");

    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({ amount: 25_000_000n, owner: owner.address, network: mainnet });
    expect(h.controller.getState()).toMatchObject({
      transfer: { network: "mainnet", twin: mainnetTwin, sourceDomain: 6, via: "wallet", amount: "25000000" },
    });
    expect(mainnetTwin).not.toBe(twinAddress(owner.address, testnet));
  });
});

describe("a burn the relayer is not delivering right now", () => {
  const following = async (script: (DeliverResponse | Error)[]) => {
    const { clients, fund } = wallet();
    const h = harness({ deliver: script }, { fund });
    await h.controller.start({ via: "wallet", chain: "base", amount: 1_000_000n, clients });
    return h;
  };

  it("stays tracked, and says the relayer has spent its day", async () => {
    const h = await following([declined("daily_budget", "The relayer has used up what it spends on fees in a day; try again later")]);
    await settle();

    expect(h.controller.getState()).toMatchObject({ phase: "attesting", attestation: "unreachable", held: "daily_budget" });
    expect(h.controller.tracked()).toMatchObject({ transfer: { burnTxHash: BURN }, saved: true });
    expect(JSON.parse(h.storage.getItem(fundingStorageKey("mainnet", owner.address)) ?? "null")).toMatchObject({ burnTxHash: BURN, network: "mainnet" });
  });

  it("keeps asking, and delivers when the relayer pays again", async () => {
    const h = await following([
      declined("daily_budget", "spent"),
      declined("daily_budget", "spent"),
      pending(),
      delivered(STELLAR_HASH),
    ]);
    await until(() => h.controller.getState().phase === "minted", "minted");

    expect(h.deliver.calls).toHaveLength(4);
    expect(h.controller.getState()).toMatchObject({ phase: "minted", stellarTxHash: STELLAR_HASH });
    expect(h.controller.tracked()).toBeNull();
  });

  it("tells apart a relayer that is not serving the network, one at its reserve, and a plain outage", async () => {
    const notServing = await following([declined("not_serving", "This server is not serving mainnet right now")]);
    await settle();
    expect(notServing.controller.getState()).toMatchObject({ phase: "attesting", held: "not_serving" });

    const low = await following([declined("low_balance", "The relayer's account is down to what it keeps")]);
    await settle();
    expect(low.controller.getState()).toMatchObject({ phase: "attesting", held: "low_balance" });

    const outage = await following([new ApiFailure("unavailable", 503, "The server could not complete the request; try again")]);
    await settle();
    const state = outage.controller.getState();
    expect(state).toMatchObject({ phase: "attesting", attestation: "unreachable" });
    expect("held" in state).toBe(false);
  });

  it("drops the reason as soon as the relayer answers about the burn again", async () => {
    const h = await following([declined("hourly_limit", "limit"), pending("pending")]);
    await settle();

    const state = h.controller.getState();
    expect(state).toMatchObject({ phase: "attesting", attestation: "pending" });
    expect("held" in state).toBe(false);
  });
});

describe("a transfer on one network and the same owner on the other", () => {
  it("are kept apart: each controller stores, restores and follows only its own burn", async () => {
    const storage = memoryStorage();
    const { clients, fund } = wallet();
    const onTestnet = harness({ storage, network: testnet }, { fund });
    await onTestnet.controller.start({ via: "wallet", chain: "base", amount: 1_000_000n, clients });
    expect(onTestnet.controller.tracked()).toMatchObject({ transfer: { network: "testnet" } });

    // A page on mainnet, same browser, same owner: nothing to restore, and free to start its own.
    const onMainnet = harness({ storage }, { fund });
    expect(onMainnet.controller.restore()).toBe(false);
    expect(onMainnet.controller.tracked()).toBeNull();
    expect(onMainnet.controller.resume(OTHER_BURN)).toBe(true);
    expect(onMainnet.controller.tracked()).toMatchObject({ transfer: { network: "mainnet", burnTxHash: OTHER_BURN, twin: mainnetTwin } });

    // And the other way round: a reload on testnet finds testnet's burn, not mainnet's.
    const reloaded = harness({ storage, network: testnet });
    expect(reloaded.controller.restore()).toBe(true);
    expect(reloaded.controller.tracked()).toMatchObject({ transfer: { network: "testnet", burnTxHash: BURN } });
  });

  it("never takes a record of the other network for its own, even under its own key", () => {
    const foreign = { network: "testnet", burnTxHash: BURN, sourceDomain: 6, owner: owner.address, twin: "C", amount: "1", via: "wallet", startedAt: 1 };
    const storage = memoryStorage({ [fundingStorageKey("mainnet", owner.address)]: JSON.stringify(foreign) });

    const h = harness({ storage });

    expect(h.controller.restore()).toBe(false);
    expect(h.controller.tracked()).toBeNull();
  });
});
