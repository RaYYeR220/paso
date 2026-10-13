"use client";

import { parseEvmAmount, type NetworkName } from "@paso/sdk";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { networkConfig } from "./config";
import { describeError } from "./errors";
import { baseTx, stellarAddress, stellarTx } from "./explorer";
import { formatBaseUsdc } from "./format";
import {
  IDLE_FUNDING,
  isFundingActive,
  trackerStages,
  transferOf,
  type FundingState,
  type FundingVia,
  type TrackerStage,
} from "./funding/machine";
import { burnAmountProblem, burnCeiling, FAUCET_AMOUNT, WALLET_BURN_MIN } from "./funding/limits";
import { baseBalanceFor, fundingFor, refreshAccount } from "./registry";
import { idleResource, type ResourceState } from "./resource";
import { useSigner } from "./signer";
import { noSubscription } from "./store";
import { useNow } from "./useNow";

/** How much can be brought over, known before anything starts. Amounts are in Base's 6-decimal units. */
export interface FundingLimits {
  /** What the testnet faucet sends per request: a fixed 1 USDC. */
  faucetAmount: bigint;
  /** `"1.00"`. */
  faucetAmountFormatted: string;
  /** The smallest amount a wallet can burn. */
  min: bigint;
  minFormatted: string;
  /** The most a wallet can burn: the USDC it holds on Base. `null` with the demo key, and until the balance is read. */
  max: bigint | null;
  maxFormatted: string | null;
  /** The app's own ceiling on one transfer on this network; `null` where there is none. */
  ceiling: bigint | null;
  ceilingFormatted: string | null;
}

/** Where the check that a wallet signs with its own key stands. A wallet is offered no transfer before it has passed. */
export type KeyCheck =
  /** Not a wallet, or a wallet this browser has seen sign with its key. */
  | { status: "passed" }
  | { status: "needed"; notice?: "declined"; problem?: string }
  | { status: "asking" };

/** Bringing USDC from Base to the connected owner's Stellar account, on one network. */
export interface Funding {
  /** The state machine: idle → requesting → burned → attesting → delivering → minted | failed. */
  state: FundingState;
  phase: FundingState["phase"];
  /** The three steps of the tracker, in Circle's words, each waiting, active, done or failed. */
  stages: TrackerStage[];
  /** True from the first click until the USDC is minted or the transfer fails. */
  isActive: boolean;
  /** Who pays the burn with the current signer: the wallet, or the testnet faucet. `null` when nothing is connected. */
  via: FundingVia | null;
  /** Seconds since the transfer began, ticking while it runs and frozen at the total once it is minted. */
  elapsedSeconds: number | null;
  /** USDC being brought over, as text (`"10.00"`); `null` when not known. */
  amountFormatted: string | null;
  links: {
    /** The burn on Base. */
    base: string | null;
    /** The mint on Stellar; the account itself when someone else delivered the message. */
    stellar: string | null;
  };
  /** The faucet's fixed amount, and the range a wallet burn accepts. */
  limits: FundingLimits;
  /** What was wrong with the amount typed, when `start` did not begin. */
  inputError: string | null;
  /** Whether the connected wallet has shown that it signs with its own key. `start` does nothing for a wallet until it has. */
  keyCheck: KeyCheck;
  /** Asks the wallet for the key check: one message that moves nothing. */
  checkKey(): Promise<void>;
  /**
   * Starts a transfer. With a wallet, `amount` is USDC as decimal text
   * (`"10"`) or in Base's 6-decimal units; with the demo key the faucet
   * decides the amount. Ignored while a transfer is in flight.
   */
  start(amount?: string | bigint): Promise<void>;
  /** Follows a burn that already happened, by its hash on Base. */
  resume(burnTxHash: Hex): boolean;
  /** After a failure: follows the burn on record again. */
  retry(): boolean;
  /** Back to idle. Does nothing while a burn is on record: that takes `stopTracking`. */
  reset(): void;
  /**
   * The burn on record: followed until it is delivered, whatever happens to
   * the page meanwhile. `saved` is false when the browser keeps no storage,
   * so a reload would forget the tracker (never the USDC).
   */
  tracked: { burnTxHash: Hex; link: string; saved: boolean } | null;
  /** Takes the burn off the record. The USDC is still the owner's and still arrives; it is only no longer followed here. */
  stopTracking(): void;
}

const idle = (): FundingState => IDLE_FUNDING;
const noBalance = (): ResourceState<bigint> => idleResource<bigint>();

/**
 * The inbound flow for the connected owner on `network`. A transfer in
 * flight survives a reload: it is picked up again as soon as the same owner
 * is connected on the same network.
 */
export function useFunding(network: NetworkName): Funding {
  const signer = useSigner(network);
  const owner = signer.status === "connected" ? signer.address : null;
  const controller = owner ? fundingFor(network, owner) : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getState ?? idle, idle);
  const [inputError, setInputError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ asking: boolean; notice?: "declined"; problem?: string }>({ asking: false });

  useEffect(() => {
    controller?.restore();
  }, [controller]);

  const isDemo = signer.isDemo;
  // Only a wallet pays its own burn, so only a wallet's USDC on Base sets a ceiling.
  const balance = owner && !isDemo ? baseBalanceFor(network, owner) : null;
  const held = useSyncExternalStore(balance?.subscribe ?? noSubscription, balance?.getState ?? noBalance, noBalance);
  const max = held.data;
  const ceiling = isDemo ? null : burnCeiling(network);
  const chainName = networkConfig(network).evm.chain.name;

  const minted = state.phase === "minted";
  useEffect(() => {
    if (minted && owner) refreshAccount(network, owner);
  }, [minted, owner, network]);

  const burnKnown = "transfer" in state;
  useEffect(() => {
    if (burnKnown) void balance?.refresh();
  }, [burnKnown, balance]);

  const active = isFundingActive(state);
  const now = useNow("second", active);

  const { evmClients, keyProven, proveKey } = signer.wallet;
  const proven = isDemo || keyProven;
  const checkKey = useCallback(async () => {
    setCheck({ asking: true });
    try {
      await proveKey();
      setCheck({ asking: false });
    } catch (error) {
      const problem = describeError(error);
      setCheck(problem.kind === "rejected" ? { asking: false, notice: "declined" } : { asking: false, problem: problem.message });
    }
  }, [proveKey]);

  const start = useCallback(
    async (amount?: string | bigint) => {
      if (!controller) return;
      setInputError(null);
      if (isDemo) {
        await controller.start({ via: "demo" });
        return;
      }
      if (!proven) return;
      let units: bigint;
      try {
        units = typeof amount === "bigint" ? amount : parseEvmAmount(amount ?? "");
      } catch (error) {
        setInputError(error instanceof Error ? error.message : "Enter an amount");
        return;
      }
      const problem = burnAmountProblem(units, { min: WALLET_BURN_MIN, max, ceiling }, chainName);
      if (problem) {
        setInputError(problem);
        return;
      }
      await controller.start({ via: "wallet", amount: units, clients: evmClients });
    },
    [controller, isDemo, proven, evmClients, max, ceiling, chainName],
  );
  const resume = useCallback((burnTxHash: Hex) => controller?.resume(burnTxHash) ?? false, [controller]);
  const retry = useCallback(() => controller?.retry() ?? false, [controller]);
  const reset = useCallback(() => {
    setInputError(null);
    controller?.reset();
  }, [controller]);
  const stopTracking = useCallback(() => {
    controller?.stopTracking();
  }, [controller]);

  return useMemo(() => {
    const transfer = transferOf(state);
    const burnTxHash = transfer?.burnTxHash ?? (state.phase === "requesting" ? state.burnTxHash : undefined);
    const amount = transfer?.amount ?? (state.phase === "requesting" ? state.amount : null);

    let elapsedSeconds: number | null = null;
    if (state.phase === "minted") {
      elapsedSeconds = Math.max(0, Math.round((state.finishedAt - state.transfer.startedAt) / 1000));
    } else if (active && now !== null) {
      const since = state.phase === "requesting" ? state.startedAt : (transfer?.startedAt ?? now);
      elapsedSeconds = Math.max(0, Math.floor((now - since) / 1000));
    }

    // The record changes only together with the state, so reading it here keeps the two in step.
    const onRecord = controller?.tracked() ?? null;
    const keyCheck: KeyCheck = proven
      ? { status: "passed" }
      : check.asking
        ? { status: "asking" }
        : { status: "needed", ...(check.notice ? { notice: check.notice } : {}), ...(check.problem ? { problem: check.problem } : {}) };

    return {
      state,
      phase: state.phase,
      stages: trackerStages(state),
      isActive: active,
      via: owner ? (isDemo ? "demo" : "wallet") : null,
      elapsedSeconds,
      amountFormatted: amount ? formatBaseUsdc(BigInt(amount)) : null,
      links: {
        base: burnTxHash ? baseTx(burnTxHash, network) : null,
        stellar:
          state.phase === "minted"
            ? state.stellarTxHash
              ? stellarTx(state.stellarTxHash, network)
              : stellarAddress(state.transfer.twin, network)
            : null,
      },
      limits: {
        faucetAmount: FAUCET_AMOUNT,
        faucetAmountFormatted: formatBaseUsdc(FAUCET_AMOUNT),
        min: WALLET_BURN_MIN,
        minFormatted: formatBaseUsdc(WALLET_BURN_MIN),
        max,
        maxFormatted: max === null ? null : formatBaseUsdc(max),
        ceiling,
        ceilingFormatted: ceiling === null ? null : formatBaseUsdc(ceiling),
      },
      inputError,
      keyCheck,
      checkKey,
      start,
      resume,
      retry,
      reset,
      tracked: onRecord
        ? { burnTxHash: onRecord.transfer.burnTxHash, link: baseTx(onRecord.transfer.burnTxHash, network), saved: onRecord.saved }
        : null,
      stopTracking,
    };
  }, [state, active, now, owner, network, isDemo, max, ceiling, inputError, proven, check, checkKey, controller, start, resume, retry, reset, stopTracking]);
}
