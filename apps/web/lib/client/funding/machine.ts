import type { InboundRoute, NetworkName } from "@paso/sdk";
import type { Address, Hex } from "viem";

/** Who pays the burn on Base: the connected wallet, or the testnet faucet. */
export type FundingVia = "wallet" | "demo";

/** A burn on Base on its way to a Stellar account. Plain JSON: it is kept in `localStorage` while in flight. */
export interface Transfer {
  network: NetworkName;
  burnTxHash: Hex;
  /** CCTP domain of the chain the burn happened on. */
  sourceDomain: number;
  owner: Address;
  /** The Stellar account being funded. */
  twin: string;
  /** USDC burned, in Base's 6-decimal units, as text; `null` when tracking a burn made elsewhere. */
  amount: string | null;
  via: FundingVia;
  /** When tracking began, in milliseconds. Survives a reload, so the timer does too. */
  startedAt: number;
}

/** What the wallet is being asked for while the burn is prepared. */
export type RequestStep =
  /** Asking the faucet, or getting the wallet onto Base. */
  | "starting"
  /** The wallet shows the USDC approval. */
  | "approving"
  /** The approval is sent and waiting for Base. */
  | "approved"
  /** The wallet shows the burn. */
  | "burning"
  /** The burn is sent and waiting for Base. */
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
  | { phase: "failed"; reason: FundingFailure; transfer?: Transfer; failedAt: number };

export type FundingEvent =
  | { type: "REQUEST"; via: FundingVia; owner: Address; amount: string | null; at: number }
  | { type: "STEP"; step: RequestStep; approveTxHash?: Hex; burnTxHash?: Hex }
  | { type: "BURNED"; transfer: Transfer }
  /** Tracking picked up again: after a reload, or for a burn made elsewhere. */
  | { type: "RESUMED"; transfer: Transfer }
  | { type: "PENDING"; attestation: AttestationProgress; delayReason?: string }
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
      return { phase: "failed", reason: event.reason, ...(transfer ? { transfer } : {}), failedAt: event.at };
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
  label: "Burned on Base" | "Attested by Circle" | "Minted on Stellar";
  status: StageStatus;
}

const STAGE_LABELS = {
  burned: "Burned on Base",
  attested: "Attested by Circle",
  minted: "Minted on Stellar",
} as const;

function stages(burned: StageStatus, attested: StageStatus, minted: StageStatus): TrackerStage[] {
  return [
    { id: "burned", label: STAGE_LABELS.burned, status: burned },
    { id: "attested", label: STAGE_LABELS.attested, status: attested },
    { id: "minted", label: STAGE_LABELS.minted, status: minted },
  ];
}

/** The three-step tracker for a state: which step is done, which is running, which is waiting. */
export function trackerStages(state: FundingState): TrackerStage[] {
  switch (state.phase) {
    case "idle":
      return stages("waiting", "waiting", "waiting");
    case "requesting":
      return stages("active", "waiting", "waiting");
    case "burned":
    case "attesting":
      return stages("done", "active", "waiting");
    case "delivering":
      return stages("done", "done", "active");
    case "minted":
      return stages("done", "done", "done");
    case "failed":
      if (!state.transfer) return stages("failed", "waiting", "waiting");
      return state.reason.code === "undeliverable"
        ? stages("done", "done", "failed")
        : stages("done", "failed", "waiting");
  }
}
