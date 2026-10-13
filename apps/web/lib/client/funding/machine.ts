import type { EvmChainName, InboundRoute, NetworkName } from "paso-sdk";
import type { Address, Hex } from "viem";
import type { DeclineReason } from "../api";

/** Who pays the burn: the connected wallet, or the testnet faucet on Base Sepolia. */
export type FundingVia = "wallet" | "demo";

/** A burn on an EVM chain on its way to a Stellar account. Plain JSON: it is kept in `localStorage` while in flight. */
export interface Transfer {
  network: NetworkName;
  /** The chain the USDC left. A record kept before there was a choice names none, and is read as Base. */
  chain: EvmChainName;
  burnTxHash: Hex;
  /** CCTP domain of the chain the burn happened on. */
  sourceDomain: number;
  owner: Address;
  /** The Stellar account being funded. */
  twin: string;
  /** USDC burned, in the chain's 6-decimal units, as text; `null` when tracking a burn made elsewhere. */
  amount: string | null;
  via: FundingVia;
  /** When tracking began, in milliseconds. Survives a reload, so the timer does too. */
  startedAt: number;
}

/** What the wallet is being asked for while the burn is prepared. */
export type RequestStep =
  /** Asking the faucet, or getting the wallet onto the chain. */
  | "starting"
  /** The wallet shows the USDC approval. */
  | "approving"
  /** The approval is sent and waiting for the chain. */
  | "approved"
  /** The wallet shows the burn. */
  | "burning"
  /** The burn is sent and waiting for the chain. */
  | "confirming";

/** What Circle's attestation service last said about the burn. */
export type AttestationProgress = "not_found" | "pending" | "unreachable";

export type FundingFailureCode =
  /** The faucet's per-caller or per-account limit. */
  | "rate_limited"
  /** The faucet has no test USDC or no gas left. */
  | "faucet_empty"
  /** The faucet is switched off, or this is not testnet. */
  | "faucet_off"
  /** The faucet has given out its daily total. */
  | "faucet_daily_limit"
  | "insufficient_usdc"
  /** More than the app brings over in one transfer on this network. */
  | "over_ceiling"
  | "insufficient_gas"
  | "wrong_network"
  /** Circle never saw the burn: wrong hash, or the burn did not confirm. */
  | "burn_not_found"
  /** The wallet was asked for the burn and never said whether it was sent. */
  | "burn_unconfirmed"
  /** The burn is attested and cannot be delivered to Stellar. */
  | "undeliverable"
  | "unavailable"
  | "unknown";

export interface FundingFailure {
  code: FundingFailureCode;
  /** One sentence for the person in front of the screen. */
  message: string;
  detail?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export type FundingState =
  | { phase: "idle"; notice?: "cancelled" }
  | {
      phase: "requesting";
      via: FundingVia;
      /** The chain the USDC leaves. */
      chain: EvmChainName;
      owner: Address;
      /** 6-decimal units as text; `null` until the faucet says how much it sent. */
      amount: string | null;
      step: RequestStep;
      startedAt: number;
      approveTxHash?: Hex;
      burnTxHash?: Hex;
    }
  | { phase: "burned"; transfer: Transfer }
  | {
      phase: "attesting";
      transfer: Transfer;
      startedAt: number;
      attestation: AttestationProgress;
      /** Why Circle holds a fast transfer back, when it says. */
      delayReason?: string;
      /**
       * Why the relayer is not delivering for now, when it says: it is not
       * serving the network, or has spent what it spends. The burn is not
       * affected. Circle has attested it or will, and it can be delivered
       * later, by this relayer or by anyone.
       */
      held?: DeclineReason;
    }
  | { phase: "delivering"; transfer: Transfer; startedAt: number }
  | {
      phase: "minted";
      transfer: Transfer;
      /** Absent when someone else delivered the message first: the USDC arrived all the same. */
      stellarTxHash?: string;
      route: InboundRoute;
      finishedAt: number;
    }
  | {
      phase: "failed";
      reason: FundingFailure;
      transfer?: Transfer;
      /** The chain the request was for: a burn that may have been sent is looked for there. */
      chain: EvmChainName;
      failedAt: number;
    };

export type FundingEvent =
  | { type: "REQUEST"; via: FundingVia; chain: EvmChainName; owner: Address; amount: string | null; at: number }
  | { type: "STEP"; step: RequestStep; approveTxHash?: Hex; burnTxHash?: Hex }
  | { type: "BURNED"; transfer: Transfer }
  /** Tracking picked up again: after a reload, or for a burn made elsewhere. */
  | { type: "RESUMED"; transfer: Transfer }
  | { type: "PENDING"; attestation: AttestationProgress; delayReason?: string; held?: DeclineReason }
  | { type: "DELIVERING" }
  | { type: "DELIVERED"; hash?: string; route: InboundRoute; at: number }
  | { type: "FAILED"; reason: FundingFailure; at: number }
  /** The owner declined in the wallet. */
  | { type: "CANCELLED" }
  | { type: "RESET" };

export const IDLE_FUNDING: FundingState = { phase: "idle" };

/** True while a transfer is being requested or followed: a second one cannot start. */
export function isFundingActive(state: FundingState): boolean {
  return (
    state.phase === "requesting" ||
    state.phase === "burned" ||
    state.phase === "attesting" ||
    state.phase === "delivering"
  );
}

/** The transfer a state is about, when the burn is known. */
export function transferOf(state: FundingState): Transfer | undefined {
  return "transfer" in state ? state.transfer : undefined;
}

/** Every transition of the inbound flow. An event that does not apply to the current phase changes nothing. */
export function fundingReducer(state: FundingState, event: FundingEvent): FundingState {
  switch (event.type) {
    case "REQUEST":
      if (isFundingActive(state)) return state;
      return {
        phase: "requesting",
        via: event.via,
        chain: event.chain,
        owner: event.owner,
        amount: event.amount,
        step: "starting",
        startedAt: event.at,
      };

    case "STEP":
      if (state.phase !== "requesting") return state;
      return {
        ...state,
        step: event.step,
        ...(event.approveTxHash ? { approveTxHash: event.approveTxHash } : {}),
        ...(event.burnTxHash ? { burnTxHash: event.burnTxHash } : {}),
      };

    case "BURNED":
      if (state.phase !== "requesting") return state;
      return { phase: "burned", transfer: event.transfer };

    case "RESUMED":
      if (isFundingActive(state)) return state;
      return { phase: "burned", transfer: event.transfer };

    case "PENDING":
      if (state.phase !== "burned" && state.phase !== "attesting" && state.phase !== "delivering") return state;
      return {
        phase: "attesting",
        transfer: state.transfer,
        startedAt: state.phase === "burned" ? state.transfer.startedAt : state.startedAt,
        attestation: event.attestation,
        ...(event.delayReason ? { delayReason: event.delayReason } : {}),
        ...(event.held ? { held: event.held } : {}),
      };

    case "DELIVERING":
      if (state.phase !== "burned" && state.phase !== "attesting") return state;
      return {
        phase: "delivering",
        transfer: state.transfer,
        startedAt: state.phase === "burned" ? state.transfer.startedAt : state.startedAt,
      };

    case "DELIVERED":
      if (state.phase !== "burned" && state.phase !== "attesting" && state.phase !== "delivering") return state;
      return {
        phase: "minted",
        transfer: state.transfer,
        ...(event.hash ? { stellarTxHash: event.hash } : {}),
        route: event.route,
        finishedAt: event.at,
      };

    case "FAILED": {
      if (!isFundingActive(state)) return state;
      const transfer = transferOf(state);
      const chain = transfer?.chain ?? (state.phase === "requesting" ? state.chain : undefined);
      if (!chain) return state;
      return { phase: "failed", reason: event.reason, ...(transfer ? { transfer } : {}), chain, failedAt: event.at };
    }

    case "CANCELLED":
      if (state.phase !== "requesting") return state;
      return { phase: "idle", notice: "cancelled" };

    case "RESET":
      return IDLE_FUNDING;
  }
}

export type StageStatus = "waiting" | "active" | "done" | "failed";

/** One of the three steps of a transfer, in Circle's words. */
export interface TrackerStage {
  id: "burned" | "attested" | "minted";
  /** "Burned on Arbitrum", "Attested by Circle", "Minted on Stellar". */
  label: string;
  status: StageStatus;
}

function stages(chainLabel: string, burned: StageStatus, attested: StageStatus, minted: StageStatus): TrackerStage[] {
  return [
    { id: "burned", label: `Burned on ${chainLabel}`, status: burned },
    { id: "attested", label: "Attested by Circle", status: attested },
    { id: "minted", label: "Minted on Stellar", status: minted },
  ];
}

/**
 * The three-step tracker for a state: which step is done, which is running,
 * which is waiting. `chainLabel` names the chain the USDC leaves: "Base",
 * "Arbitrum", "Arc".
 */
export function trackerStages(state: FundingState, chainLabel: string): TrackerStage[] {
  switch (state.phase) {
    case "idle":
      return stages(chainLabel, "waiting", "waiting", "waiting");
    case "requesting":
      return stages(chainLabel, "active", "waiting", "waiting");
    case "burned":
    case "attesting":
      return stages(chainLabel, "done", "active", "waiting");
    case "delivering":
      return stages(chainLabel, "done", "done", "active");
    case "minted":
      return stages(chainLabel, "done", "done", "done");
    case "failed":
      if (!state.transfer) return stages(chainLabel, "failed", "waiting", "waiting");
      return state.reason.code === "undeliverable"
        ? stages(chainLabel, "done", "done", "failed")
        : stages(chainLabel, "done", "failed", "waiting");
  }
}

/** The chain a state is about: its transfer's, or the one being asked for. `null` while idle. */
export function chainOfState(state: FundingState): EvmChainName | null {
  if (state.phase === "idle") return null;
  if (state.phase === "requesting") return state.chain;
  if (state.phase === "failed") return state.transfer?.chain ?? state.chain;
  return state.transfer.chain;
}
