"use client";

import { DEFAULT_EVM_CHAIN, receiveMessageOnEvm, type EvmChainConfig, type NetworkName } from "paso-sdk";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { chainOf } from "./chains";
import { networkConfig } from "./config";
import { exitStages, IDLE_EXIT, type ExitStage, type ExitState } from "./exit";
import { evmTx, stellarTx } from "./explorer";
import { exitWatcherFor } from "./registry";
import { useSigner } from "./signer";
import { noSubscription } from "./store";
import { useAction } from "./useAction";
import { useNow } from "./useNow";

/** USDC sent back to an EVM chain, followed from the burn on Stellar to the mint on that chain, on one network. */
export interface Exit {
  state: ExitState;
  phase: ExitState["phase"];
  /** The chain the transfer is minted on; `null` while nothing is followed. */
  chain: EvmChainConfig | null;
  /** The three steps, in Circle's words, each waiting, active or done. */
  stages: ExitStage[];
  /** Seconds since the burn, ticking while it is followed and frozen once it is minted. */
  elapsedSeconds: number | null;
  links: {
    /** The burn on Stellar. */
    stellar: string | null;
    /** The mint on the chain, once it is known. */
    evm: string | null;
  };
  /**
   * True when the last step is the owner's to make: Circle has attested the
   * burn, the server does not pay for mints on this chain, and a wallet is
   * connected that can submit one.
   */
  canMint: boolean;
  /** Has the connected wallet submit the mint on the transfer's chain. It pays the gas; the USDC goes to the recipient that was signed for. */
  mint(): Promise<void>;
  /**
   * The burn on record: followed until it is minted, whatever happens to the
   * page meanwhile. `saved` is false when the browser keeps no storage, so a
   * reload would forget the tracker (never the USDC).
   */
  tracked: { stellarTxHash: string; link: string; saved: boolean } | null;
  /** Takes the transfer off the record and off the screen. The USDC still arrives on its chain. */
  stopTracking(): void;
}

const idle = (): ExitState => IDLE_EXIT;

/**
 * Follows the connected owner's transfer back to an EVM chain on `network`.
 * One in flight survives a reload: it is picked up again, for the chain it
 * is for, as soon as the same owner is connected on the same network.
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
  const destination = done?.request.kind === "exit" ? (done.request.chain ?? DEFAULT_EVM_CHAIN) : DEFAULT_EVM_CHAIN;
  useEffect(() => {
    if (hash !== null && finishedAt !== null) {
      watcher?.watch({ network, chain: destination, stellarTxHash: hash, startedAt: finishedAt });
    }
  }, [watcher, network, destination, hash, finishedAt]);

  const stopTracking = useCallback(() => watcher?.stopTracking(), [watcher]);

  const hasWallet = !signer.isDemo && signer.wallet.address !== null;
  const { evmClients } = signer.wallet;
  const mint = useCallback(async () => {
    if (!watcher || !hasWallet) return;
    await watcher.mint(async ({ message, attestation, chain, onSubmitted }) => {
      const clients = await evmClients(chain);
      return receiveMessageOnEvm({ ...clients, message, attestation, network: networkConfig(network), chain, onSubmitted });
    });
  }, [watcher, hasWallet, evmClients, network]);

  return useMemo(() => {
    const transfer = state.phase === "idle" ? null : state.transfer;
    const chain = transfer ? chainOf(networkConfig(network), transfer.chain) : null;
    const until = state.phase === "minted" ? state.finishedAt : waiting ? now : null;
    const mintTxHash = state.phase === "minted" || state.phase === "minting" ? state.mintTxHash : undefined;
    // The record changes only together with the state, so reading it here keeps the two in step.
    const onRecord = watcher?.tracked() ?? null;
    return {
      state,
      phase: state.phase,
      chain,
      stages: exitStages(state, (chain ?? chainOf(networkConfig(network))).shortLabel),
      elapsedSeconds: transfer && until !== null ? Math.max(0, Math.floor((until - transfer.startedAt) / 1000)) : null,
      links: {
        stellar: transfer ? stellarTx(transfer.stellarTxHash, network) : null,
        evm: mintTxHash && chain ? evmTx(mintTxHash, network, chain.name) : null,
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
