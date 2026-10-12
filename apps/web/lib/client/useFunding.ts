"use client";

import { parseEvmAmount } from "@paso/sdk";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
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
import { fundingFor, refreshAccount } from "./registry";
import { useSigner } from "./signer";
import { noSubscription } from "./store";
import { useNow } from "./useNow";

/** Bringing USDC from Base to the connected owner's Stellar account. */
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
  /** What was wrong with the amount typed, when `start` did not begin. */
  inputError: string | null;
  /**
   * Starts a transfer. With a wallet, `amount` is USDC as decimal text
   * (`"10"`) or in Base's 6-decimal units; with the demo key the faucet
   * decides the amount. Ignored while a transfer is in flight.
   */
  start(amount?: string | bigint): Promise<void>;
  /** Follows a burn that already happened, by its hash on Base. */
  resume(burnTxHash: Hex): boolean;
  /** After a failure that left the burn intact: follows it again. */
  retry(): boolean;
  /** Back to idle. */
  reset(): void;
}

const idle = (): FundingState => IDLE_FUNDING;

/**
 * The inbound flow for the connected owner. A transfer in flight survives a
 * reload: it is picked up again as soon as the same owner is connected.
 */
export function useFunding(): Funding {
  const signer = useSigner();
  const owner = signer.status === "connected" ? signer.address : null;
  const controller = owner ? fundingFor(owner) : null;
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription, controller?.getState ?? idle, idle);
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    controller?.restore();
  }, [controller]);

  const minted = state.phase === "minted";
  useEffect(() => {
    if (minted && owner) refreshAccount(owner);
  }, [minted, owner]);

  const active = isFundingActive(state);
  const now = useNow("second", active);

  const isDemo = signer.isDemo;
  const evmClients = signer.wallet.evmClients;
  const start = useCallback(
    async (amount?: string | bigint) => {
      if (!controller) return;
      setInputError(null);
      if (isDemo) {
        await controller.start({ via: "demo" });
        return;
      }
      let units: bigint;
      try {
        units = typeof amount === "bigint" ? amount : parseEvmAmount(amount ?? "");
        if (units <= 0n) throw new Error("Enter an amount above zero");
      } catch (error) {
        setInputError(error instanceof Error ? error.message : "Enter an amount");
        return;
      }
      await controller.start({ via: "wallet", amount: units, clients: evmClients });
    },
    [controller, isDemo, evmClients],
  );
  const resume = useCallback((burnTxHash: Hex) => controller?.resume(burnTxHash) ?? false, [controller]);
  const retry = useCallback(() => controller?.retry() ?? false, [controller]);
  const reset = useCallback(() => {
    setInputError(null);
    controller?.reset();
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

    return {
      state,
      phase: state.phase,
      stages: trackerStages(state),
      isActive: active,
      via: owner ? (isDemo ? "demo" : "wallet") : null,
      elapsedSeconds,
      amountFormatted: amount ? formatBaseUsdc(BigInt(amount)) : null,
      links: {
        base: burnTxHash ? baseTx(burnTxHash) : null,
        stellar:
          state.phase === "minted"
            ? state.stellarTxHash
              ? stellarTx(state.stellarTxHash)
              : stellarAddress(state.transfer.twin)
            : null,
      },
      inputError,
      start,
      resume,
      retry,
      reset,
    };
  }, [state, active, now, owner, isDemo, inputError, start, resume, retry, reset]);
}
