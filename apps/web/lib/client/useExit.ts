"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { NETWORK_NAME, ROUTES } from "./config";
import {
  askExit,
  createExitWatcher,
  exitStages,
  exitStorageKey,
  IDLE_EXIT,
  type ExitStage,
  type ExitState,
  type ExitWatcher,
} from "./exit";
import { baseTx, stellarTx } from "./explorer";
import { useSigner } from "./signer";
import { browserStorage } from "./storage";
import { noSubscription } from "./store";
import { useAction } from "./useAction";
import { useNow } from "./useNow";

/** USDC sent back to Base, followed from the burn on Stellar to the mint on Base. */
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
   * The burn on record: followed until it is minted, whatever happens to the
   * page meanwhile. `saved` is false when the browser keeps no storage, so a
   * reload would forget the tracker (never the USDC).
   */
  tracked: { stellarTxHash: string; link: string; saved: boolean } | null;
  /** Takes the transfer off the record and off the screen. The USDC still arrives on Base. */
  stopTracking(): void;
}

const watchers = new Map<string, ExitWatcher>();

function watcherFor(owner: Address): ExitWatcher {
  const key = owner.toLowerCase();
  let watcher = watchers.get(key);
  if (!watcher) {
    watcher = createExitWatcher({
      ask: (txHash, signal) => askExit(txHash, { url: ROUTES.complete, network: NETWORK_NAME, signal }),
      storage: browserStorage(),
      storageKey: exitStorageKey(NETWORK_NAME, owner),
    });
    watchers.set(key, watcher);
  }
  return watcher;
}

const idle = (): ExitState => IDLE_EXIT;

/**
 * Follows the connected owner's transfer back to Base. One in flight survives
 * a reload: it is picked up again as soon as the same owner is connected.
 */
export function useExit(): Exit {
  const signer = useSigner();
  const owner = signer.status === "connected" ? signer.address : null;
  const watcher = owner ? watcherFor(owner) : null;
  const action = useAction();
  const state = useSyncExternalStore(watcher?.subscribe ?? noSubscription, watcher?.getState ?? idle, idle);
  const now = useNow("second", state.phase === "attesting");

  useEffect(() => {
    watcher?.restore();
  }, [watcher]);

  const done = action.state.phase === "done" && action.state.request.kind === "exit" ? action.state : null;
  const hash = done?.hash ?? null;
  const finishedAt = done?.finishedAt ?? null;
  useEffect(() => {
    if (hash !== null && finishedAt !== null) watcher?.watch({ stellarTxHash: hash, startedAt: finishedAt });
  }, [watcher, hash, finishedAt]);

  const stopTracking = useCallback(() => watcher?.stopTracking(), [watcher]);

  return useMemo(() => {
    const transfer = state.phase === "idle" ? null : state.transfer;
    const until = state.phase === "minted" ? state.finishedAt : state.phase === "attesting" ? now : null;
    // The record changes only together with the state, so reading it here keeps the two in step.
    const onRecord = watcher?.tracked() ?? null;
    return {
      state,
      phase: state.phase,
      stages: exitStages(state),
      elapsedSeconds: transfer && until !== null ? Math.max(0, Math.floor((until - transfer.startedAt) / 1000)) : null,
      links: {
        stellar: transfer ? stellarTx(transfer.stellarTxHash) : null,
        base: state.phase === "minted" && state.baseTxHash ? baseTx(state.baseTxHash) : null,
      },
      tracked: onRecord
        ? { stellarTxHash: onRecord.transfer.stellarTxHash, link: stellarTx(onRecord.transfer.stellarTxHash), saved: onRecord.saved }
        : null,
      stopTracking,
    };
  }, [state, now, watcher, stopTracking]);
}
