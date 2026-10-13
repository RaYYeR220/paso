"use client";

import { receiveMessageOnEvm, type NetworkName } from "@paso/sdk";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { networkConfig } from "./config";
import { exitStages, IDLE_EXIT, type ExitStage, type ExitState } from "./exit";
import { baseTx, stellarTx } from "./explorer";
import { exitWatcherFor } from "./registry";
import { useSigner } from "./signer";
import { noSubscription } from "./store";
import { useAction } from "./useAction";
import { useNow } from "./useNow";

/** USDC sent back to Base, followed from the burn on Stellar to the mint on Base, on one network. */
export interface Exit {
  state: ExitState;
  phase: ExitState["phase"];
  /** The three steps, in Circle's words, each waiting, active or done. */
  stages: ExitStage[];
  /** Seconds since the burn, ticking while it is followed and frozen once it is minted. */
  elapsedSeconds: number | null;
  links: {
    /** The burn on Stellar. */
    stellar: string | null;
    /** The mint on Base, once it is known. */
    base: string | null;
  };
  /**
   * True when the last step is the owner's to make: Circle has attested the
   * burn, the server does not pay for mints on this network, and a wallet is
   * connected that can submit one.
   */
  canMint: boolean;
  /** Has the connected wallet submit the mint on Base. It pays the gas; the USDC goes to the recipient that was signed for. */
  mint(): Promise<void>;
  /**
   * The burn on record: followed until it is minted, whatever happens to the
   * page meanwhile. `saved` is false when the browser keeps no storage, so a
   * reload would forget the tracker (never the USDC).
   */
  tracked: { stellarTxHash: string; link: string; saved: boolean } | null;
  /** Takes the transfer off the record and off the screen. The USDC still arrives on Base. */
  stopTracking(): void;
}

const idle = (): ExitState => IDLE_EXIT;

/**
 * Follows the connected owner's transfer back to Base on `network`. One in
 * flight survives a reload: it is picked up again as soon as the same owner
 * is connected on the same network.
 */
export function useExit(network: NetworkName): Exit {
  const signer = useSigner(network);
  const owner = signer.status === "connected" ? signer.address : null;
  const watcher = owner ? exitWatcherFor(network, owner) : null;
  const action = useAction(network);
  const state = useSyncExternalStore(watcher?.subscribe ?? noSubscription, watcher?.getState ?? idle, idle);
  const waiting = state.phase === "attesting" || state.phase === "attested" || state.phase === "minting";
  const now = useNow("second", waiting);

  useEffect(() => {
    watcher?.restore();
  }, [watcher]);

  const done = action.state.phase === "done" && action.state.request.kind === "exit" ? action.state : null;
  const hash = done?.hash ?? null;
  const finishedAt = done?.finishedAt ?? null;
  useEffect(() => {
    if (hash !== null && finishedAt !== null) watcher?.watch({ network, stellarTxHash: hash, startedAt: finishedAt });
  }, [watcher, network, hash, finishedAt]);

  const stopTracking = useCallback(() => watcher?.stopTracking(), [watcher]);

  const hasWallet = !signer.isDemo && signer.wallet.address !== null;
  const { evmClients } = signer.wallet;
  const mint = useCallback(async () => {
    if (!watcher || !hasWallet) return;
    await watcher.mint(async ({ message, attestation, onSubmitted }) => {
      const clients = await evmClients();
      return receiveMessageOnEvm({ ...clients, message, attestation, network: networkConfig(network), onSubmitted });
    });
  }, [watcher, hasWallet, evmClients, network]);

  return useMemo(() => {
    const transfer = state.phase === "idle" ? null : state.transfer;
    const until = state.phase === "minted" ? state.finishedAt : waiting ? now : null;
    const mintTxHash = state.phase === "minted" || state.phase === "minting" ? state.baseTxHash : undefined;
    // The record changes only together with the state, so reading it here keeps the two in step.
    const onRecord = watcher?.tracked() ?? null;
    return {
      state,
      phase: state.phase,
      stages: exitStages(state),
      elapsedSeconds: transfer && until !== null ? Math.max(0, Math.floor((until - transfer.startedAt) / 1000)) : null,
      links: {
        stellar: transfer ? stellarTx(transfer.stellarTxHash, network) : null,
        base: mintTxHash ? baseTx(mintTxHash, network) : null,
      },
      canMint: state.phase === "attested" && hasWallet,
      mint,
      tracked: onRecord
        ? {
            stellarTxHash: onRecord.transfer.stellarTxHash,
            link: stellarTx(onRecord.transfer.stellarTxHash, network),
            saved: onRecord.saved,
          }
        : null,
      stopTracking,
    };
  }, [state, waiting, now, network, watcher, hasWallet, mint, stopTracking]);
}
