import { prepare, type FundFromEvmArgs, type FundFromEvmResult, type PrepareOptions, type RelayResult } from "paso-sdk";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionController, type ActionDeps } from "@/lib/client/action/controller";
import { mergeActivity } from "@/lib/client/activity/merge";
import { chainsOf, serverMintsOn, storedChain } from "@/lib/client/chains";
import { describeError } from "@/lib/client/errors";
import {
  createExitWatcher,
  exitStages,
  exitStorageKey,
  isHubExit,
  type ChainReader,
  type ExitAnswer,
  type ExitTransfer,
  type SubmitMint,
} from "@/lib/client/exit";
import { createFundingController, fundingStorageKey, readTransfer, type EvmClients } from "@/lib/client/funding/controller";
import { burnAmountProblem, gasReserve, USDC_GAS_RESERVE } from "@/lib/client/funding/limits";
import { chainOfState, trackerStages } from "@/lib/client/funding/machine";
import { memoryStorage, type KeyValueStore } from "@/lib/client/storage";
import arcExit from "../fixtures/arc-exit-message.json";
import baseExit from "../fixtures/exit-message.json";
import {
  BURN,
  delivered,
  network,
  OTHER_BURN,
  owner,
  pending,
  recordingLog,
  recordingServer,
  scripted,
  settle,
  STELLAR_HASH,
  twin,
  until,
} from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the chains the app offers", () => {
  it("are the SDK's, Base first, the same five on each network", () => {
    expect(chainsOf("testnet").map((chain) => [chain.name, chain.shortLabel, chain.cctpDomain])).toEqual([
      ["base", "Base", 6],
      ["ethereum", "Ethereum", 0],
      ["arbitrum", "Arbitrum", 3],
      ["optimism", "OP Mainnet", 2],
      ["arc", "Arc", 26],
    ]);
    expect(chainsOf("mainnet").map((chain) => chain.label)).toEqual(["Base", "Ethereum", "Arbitrum", "OP Mainnet", "Arc"]);
  });

  it("read a record that names no chain as Base's, and one that names an unknown chain as nobody's", () => {
    expect(storedChain(undefined, "testnet")).toBe("base");
    expect(storedChain("arc", "testnet")).toBe("arc");
    expect(storedChain("solana", "testnet")).toBeNull();
    expect(storedChain(6, "testnet")).toBeNull();
  });

  it("have the server mint only on Base, and only where it says it pays for mints", () => {
    expect(serverMintsOn("base", true)).toBe(true);
    expect(serverMintsOn("arc", true)).toBe(false);
    expect(serverMintsOn("base", false)).toBe(false);
  });

  it("name the chain and its gas when a wallet fails there", () => {
    const arbitrum = { chain: "Arbitrum Sepolia", gas: "ETH" };
    expect(describeError(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }), arbitrum)).toMatchObject({
      message: "The wallet is on another network. Switch it to Arbitrum Sepolia and try again.",
    });
    expect(describeError(new Error("insufficient funds for gas * price + value"), { chain: "Arc Testnet", gas: "USDC" })).toMatchObject({
      message: "The wallet does not hold enough USDC on Arc Testnet to pay for gas.",
    });
    expect(describeError(new Error("The burn reverted on Arc: 0xabc"))).toMatchObject({
      code: "reverted",
      message: "The transaction reverted on Arc. Nothing was sent.",
    });
  });
});

describe("how much can be brought from Arc, where gas is paid in USDC", () => {
  it("keeps some of the USDC back for the gas, and says so", () => {
    expect(gasReserve(chainsOf("testnet").find((chain) => chain.name === "arc")!)).toBe(USDC_GAS_RESERVE);
    expect(gasReserve(chainsOf("testnet")[0]!)).toBe(0n);

    const limits = { min: 3n, max: 10_000_000n, gasReserve: USDC_GAS_RESERVE };
    expect(burnAmountProblem(9_980_000n, limits, "Arc Testnet")).toBeNull();
    expect(burnAmountProblem(10_000_000n, limits, "Arc Testnet")).toBe(
      "The wallet holds 10 USDC on Arc Testnet, and the gas comes out of it: bring at most 9.98",
    );
    expect(burnAmountProblem(1n, { min: 3n, max: 15_000n, gasReserve: USDC_GAS_RESERVE }, "Arc Testnet")).toBe(
      "The smallest amount that can be brought over is 0.000003 USDC",
    );
    expect(burnAmountProblem(5n, { min: 3n, max: 15_000n, gasReserve: USDC_GAS_RESERVE }, "Arc Testnet")).toBe(
      "The wallet holds no USDC on Arc Testnet to bring over",
    );
  });
});

/** A wallet on whatever chain it is handed for, holding `balance` USDC there. */
function wallet(balance = 50_000_000n) {
  const writeContract = vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "approve" ? OTHER_BURN : BURN));
  const clients = vi.fn(
    async (): Promise<EvmClients> =>
      ({
        walletClient: { account: { address: owner.address }, writeContract },
        publicClient: { readContract: async () => balance, waitForTransactionReceipt: async () => ({ status: "success" }) },
      }) as unknown as EvmClients,
  );
  const funded: FundFromEvmArgs[] = [];
  const fund = async (args: FundFromEvmArgs): Promise<FundFromEvmResult> => {
    funded.push(args);
    const write = args.walletClient.writeContract as unknown as (call: { functionName: string }) => Promise<Hex>;
    const approveTxHash = await write({ functionName: "approve" });
    const burnTxHash = await write({ functionName: "depositForBurnWithHook" });
    return { burnTxHash, approveTxHash, route: "forwarder", twin, maxFee: 0n };
  };
  return { clients, fund, funded, writeContract };
}

function funding(storage: KeyValueStore = memoryStorage(), script: Parameters<typeof scripted<ReturnType<typeof delivered>>>[0] = []) {
  const deliver = scripted(script);
  const log = recordingLog();
  const make = (fund?: (args: FundFromEvmArgs) => Promise<FundFromEvmResult>) =>
    createFundingController(owner.address, {
      network,
      api: { demoFund: scripted([]), deliver },
      storage,
      log: log.for,
      now: () => 1_000,
      sleep: () => Promise.resolve(),
      after: () => () => undefined,
      ...(fund ? { fund } : {}),
    });
  return { deliver, log, storage, make };
}

const key = fundingStorageKey("testnet", owner.address);

describe("bringing USDC from Arbitrum", () => {
  it("switches the wallet there, burns there, follows the burn under Arbitrum's domain, and keeps the chain on record", async () => {
    const h = funding(memoryStorage(), [pending("not_found"), delivered(STELLAR_HASH)]);
    const w = wallet();
    const controller = h.make(w.fund);
    const seen: (string | null)[] = [];
    controller.subscribe(() => seen.push(chainOfState(controller.getState())));

    await controller.start({ via: "wallet", chain: "arbitrum", amount: 10_000_000n, clients: w.clients });
    expect(w.clients).toHaveBeenCalledTimes(1);
    expect(w.funded[0]).toMatchObject({ chain: "arbitrum", amount: 10_000_000n, network });
    expect(JSON.parse(h.storage.getItem(key) ?? "null")).toMatchObject({ chain: "arbitrum", sourceDomain: 3, burnTxHash: BURN });

    await until(() => controller.getState().phase === "minted", "minted");
    expect(new Set(seen)).toEqual(new Set(["arbitrum"]));
    expect(h.deliver.calls.map(([burn]) => burn)).toEqual([
      { sourceDomain: 3, txHash: BURN },
      { sourceDomain: 3, txHash: BURN },
    ]);
    expect(trackerStages(controller.getState(), "Arbitrum").map((stage) => [stage.label, stage.status])).toEqual([
      ["Burned on Arbitrum", "done"],
      ["Attested by Circle", "done"],
      ["Minted on Stellar", "done"],
    ]);

    const entry = h.log.entries.get(`fund:${BURN}`)!;
    expect(entry).toMatchObject({ chain: "arbitrum", evmTxHash: BURN, status: "done" });
    expect(mergeActivity([], [entry], { account: twin, network })[0]).toMatchObject({
      title: "Received 10.00 USDC from Arbitrum",
      links: { evm: { label: "Arbitrum", href: `https://sepolia.arbiscan.io/tx/${BURN}` } },
    });
  });

  it("says what the wallet holds there when it is too little, naming the chain", async () => {
    const h = funding();
    const w = wallet(2_500_000n);
    const controller = h.make(w.fund);
    await controller.start({ via: "wallet", chain: "arbitrum", amount: 10_000_000n, clients: w.clients });
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      chain: "arbitrum",
      reason: { code: "insufficient_usdc", message: "The wallet holds 2.5 USDC on Arbitrum Sepolia; this transfer needs 10." },
    });
    expect(w.writeContract).not.toHaveBeenCalled();
  });

  it("on Arc, counts the gas against the same USDC before the wallet is asked", async () => {
    const h = funding();
    const w = wallet(10_000_000n);
    const controller = h.make(w.fund);
    await controller.start({ via: "wallet", chain: "arc", amount: 10_000_000n, clients: w.clients });
    expect(controller.getState()).toMatchObject({
      phase: "failed",
      reason: {
        code: "insufficient_usdc",
        message: "The wallet holds 10 USDC on Arc Testnet; this transfer needs 10, and the gas comes out of the same USDC.",
      },
    });
    expect(w.writeContract).not.toHaveBeenCalled();
  });

  it("follows a burn the wallet never confirmed on the chain it was asked for", async () => {
    const h = funding(memoryStorage(), [pending()]);
    const w = wallet();
    w.writeContract.mockImplementation(async ({ functionName }) => {
      if (functionName === "approve") return OTHER_BURN;
      throw new Error("Internal JSON-RPC error.");
    });
    const controller = h.make(w.fund);
    await controller.start({ via: "wallet", chain: "optimism", amount: 1_000_000n, clients: w.clients });
    expect(controller.getState()).toMatchObject({ phase: "failed", chain: "optimism", reason: { code: "burn_unconfirmed" } });

    expect(controller.resume(BURN, "optimism")).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "burned", transfer: { chain: "optimism", sourceDomain: 2 } });
    await settle();
    expect(h.deliver.calls[0]?.[0]).toEqual({ sourceDomain: 2, txHash: BURN });
  });
});

describe("a transfer on record after a reload", () => {
  const record = { network: "testnet", burnTxHash: BURN, owner: owner.address, twin, amount: "500000", via: "wallet", startedAt: 900 };

  it("is followed on the chain it left", async () => {
    const h = funding(memoryStorage({ [key]: JSON.stringify({ ...record, chain: "arc", sourceDomain: 26 }) }), [pending()]);
    const controller = h.make();
    expect(controller.restore()).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "burned", transfer: { chain: "arc", sourceDomain: 26 } });
    await settle();
    expect(h.deliver.calls[0]?.[0]).toEqual({ sourceDomain: 26, txHash: BURN });
    expect(controller.tracked()?.transfer.chain).toBe("arc");
  });

  it("is read as a burn on Base when it was kept before there was a choice", async () => {
    const legacy = memoryStorage({ [key]: JSON.stringify({ ...record, sourceDomain: 6 }) });
    expect(readTransfer(JSON.parse(legacy.getItem(key)!), network, owner.address)).toMatchObject({ chain: "base", sourceDomain: 6 });

    const h = funding(legacy, [pending()]);
    const controller = h.make();
    expect(controller.restore()).toBe(true);
    expect(controller.getState()).toMatchObject({ phase: "burned", transfer: { chain: "base", burnTxHash: BURN } });
    await settle();
    expect(h.deliver.calls[0]?.[0]).toEqual({ sourceDomain: 6, txHash: BURN });
  });

  it("is not read when its chain is not listed, or does not match its domain", () => {
    expect(readTransfer({ ...record, chain: "solana", sourceDomain: 5 }, network, owner.address)).toBeNull();
    expect(readTransfer({ ...record, chain: "arc", sourceDomain: 6 }, network, owner.address)).toBeNull();
    expect(readTransfer({ ...record, chain: "arc", sourceDomain: 26 }, network, owner.address)).toMatchObject({ chain: "arc" });
  });
});

describe("sending USDC back to Arc", () => {
  const ARC_EXIT = arcExit.message as Hex;
  const ATTESTATION = arcExit.attestation as Hex;
  const MINT = arcExit.mintTransaction as Hex;
  const EXIT = arcExit.stellarTransaction;
  const exitKey = exitStorageKey("testnet", owner.address);
  const transfer: ExitTransfer = { network: "testnet", chain: "arc", stellarTxHash: EXIT, startedAt: 1_000 };

  function watcher(script: (ExitAnswer | Error)[], storage: KeyValueStore = memoryStorage(), received: boolean[] = [false]) {
    const ask = scripted<ExitAnswer>(script);
    const answers = [...received];
    const reader = {
      isReceived: vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]!)),
      receipt: vi.fn(async () => null),
    } satisfies ChainReader;
    const made = createExitWatcher({
      network: "testnet",
      ask,
      reader,
      storage,
      storageKey: exitKey,
      now: () => 9_000,
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
    });
    return { ask, reader, watcher: made, storage };
  }

  it("prepares an exit to Arc's domain, signs it and records the chain", async () => {
    vi.stubGlobal("fetch", async () => Response.json([{ finalityThreshold: 1000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 0 }]));
    const relay = scripted<RelayResult>([{ hash: STELLAR_HASH }]);
    const log = recordingLog();
    const controller = createActionController(owner.address, {
      network,
      relayUrl: "/api/relay",
      resolveName: async () => null,
      log: log.for,
      prepare: (action, options: PrepareOptions) => prepare(action, { ...options, server: recordingServer() }),
      relay: relay as unknown as ActionDeps["relay"],
    });

    await controller.prepare({ kind: "exit", recipient: owner.address, amount: "0.2", chain: "arc" });
    const review = controller.getState();
    expect(review.phase).toBe("review");
    const [call] = review.phase === "review" ? review.calls : [];
    expect(call).toMatchObject({ fn: "exit" });
    expect(call?.args[2]).toBe("26");

    await controller.sign(owner);
    expect(controller.getState().phase).toBe("done");
    expect(log.entries.get(`tx:${STELLAR_HASH}`)).toMatchObject({ kind: "exit", chain: "arc", counterparty: owner.address });
  });

  it("asks the server about it for Arc, and accepts only an exit to Arc from the hub", async () => {
    expect(isHubExit(ARC_EXIT, network, "arc")).toBe(true);
    expect(isHubExit(ARC_EXIT, network)).toBe(false);
    expect(isHubExit(baseExit.message as Hex, network, "arc")).toBe(false);

    const h = watcher([{ status: "attested", message: ARC_EXIT, attestation: ATTESTATION }]);
    expect(h.watcher.watch(transfer)).toBe(true);
    await settle(3);
    expect(h.ask.calls[0]).toEqual([EXIT, expect.anything(), "arc"]);
    expect(h.reader.isReceived).toHaveBeenCalledWith(ARC_EXIT, "arc");
    expect(h.watcher.getState()).toEqual({ phase: "attested", transfer, message: ARC_EXIT, attestation: ATTESTATION });
    expect(exitStages(h.watcher.getState(), "Arc").map((stage) => [stage.label, stage.status])).toEqual([
      ["Burned on Stellar", "done"],
      ["Attested by Circle", "done"],
      ["Minted on Arc", "active"],
    ]);
    expect(JSON.parse(h.storage.getItem(exitKey) ?? "null")).toEqual(transfer);
  });

  it("has the wallet mint on Arc, and keeps that mint on record until Arc confirms it", async () => {
    const h = watcher([{ status: "attested", message: ARC_EXIT, attestation: ATTESTATION }]);
    h.watcher.watch(transfer);
    await settle(3);

    let confirm: (result: { hash?: Hex; alreadyReceived: boolean }) => void = () => undefined;
    const submit = vi.fn<SubmitMint>(
      ({ onSubmitted }) =>
        new Promise((resolve) => {
          onSubmitted(MINT);
          confirm = resolve;
        }),
    );
    const minting = h.watcher.mint(submit);
    expect(submit).toHaveBeenCalledWith({ message: ARC_EXIT, attestation: ATTESTATION, chain: "arc", onSubmitted: expect.any(Function) });
    expect(h.watcher.getState()).toMatchObject({ phase: "minting", mintTxHash: MINT });
    expect(JSON.parse(h.storage.getItem(exitKey) ?? "null")).toEqual({ ...transfer, mintTxHash: MINT });

    confirm({ hash: MINT, alreadyReceived: false });
    await minting;
    expect(h.watcher.getState()).toEqual({ phase: "minted", transfer, mintTxHash: MINT, finishedAt: 9_000 });
    expect(h.storage.getItem(exitKey)).toBeNull();
  });

  it("says the mint reverted on Arc Testnet when it did, and offers the step again", async () => {
    const h = watcher([{ status: "attested", message: ARC_EXIT, attestation: ATTESTATION }]);
    h.watcher.watch(transfer);
    await settle(3);
    await h.watcher.mint(async ({ onSubmitted }) => {
      onSubmitted(MINT);
      throw new Error(`The mint reverted on Arc: ${MINT}`);
    });
    expect(h.watcher.getState()).toMatchObject({
      phase: "attested",
      problem: "The mint reverted on Arc Testnet. Nothing was minted, and it can be tried again.",
    });
  });

  it("is picked up after a reload for Arc, with the mint the wallet sent, and not asked for again", async () => {
    const storage = memoryStorage({ [exitKey]: JSON.stringify({ ...transfer, mintTxHash: MINT }) });
    const h = watcher([{ status: "attested", message: ARC_EXIT, attestation: ATTESTATION }], storage);
    expect(h.watcher.restore()).toBe(true);
    await settle(3);
    expect(h.ask.calls[0]?.[2]).toBe("arc");
    expect(h.watcher.getState()).toMatchObject({ phase: "minting", transfer: { chain: "arc" }, mintTxHash: MINT });

    const again = vi.fn<SubmitMint>();
    await h.watcher.mint(again);
    expect(again).not.toHaveBeenCalled();
  });

  it("reads a record kept before there was a choice as an exit to Base", async () => {
    const storage = memoryStorage({ [exitKey]: JSON.stringify({ network: "testnet", stellarTxHash: EXIT, startedAt: 1_000 }) });
    const h = watcher([], storage);
    expect(h.watcher.restore()).toBe(true);
    expect(h.watcher.tracked()?.transfer).toEqual({ network: "testnet", chain: "base", stellarTxHash: EXIT, startedAt: 1_000 });
    expect(h.ask.calls[0]?.[2]).toBe("base");

    const unknown = memoryStorage({ [exitKey]: JSON.stringify({ ...transfer, chain: "solana" }) });
    expect(watcher([], unknown).watcher.restore()).toBe(false);
  });

  it("refuses to follow an exit for a chain the network does not list", () => {
    const h = watcher([]);
    expect(h.watcher.watch({ ...transfer, chain: "solana" as ExitTransfer["chain"] })).toBe(false);
    expect(h.storage.getItem(exitKey)).toBeNull();
  });
});
