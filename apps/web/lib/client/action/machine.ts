import type { Call, Prepared } from "@paso/sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type { Address } from "viem";
import type { ProblemError } from "../errors";
import { comparePanels, NO_PANELS, type Panels, type SignedMessage } from "./panels";

/** What the owner asks the account to do, as typed into a form. Amounts are decimal text or 7-decimal units. */
export type ActionRequest =
  /** Send USDC to `G…` / `C…`, or to the Stellar account of `0x…` / an ENS name. */
  | { kind: "transfer"; to: string; amount: string | bigint }
  /** Send USDC back to Base, to an Ethereum address or ENS name. */
  | { kind: "exit"; recipient: string; amount: string | bigint }
  /** Call any contract function that asks the account for authorisation. */
  | { kind: "invoke"; contract: string; fn: string; args: xdr.ScVal[] };

/** Where the USDC goes, and how the owner named the place. */
export interface Recipient {
  /** As typed. */
  input: string;
  kind: "stellar" | "evm" | "ens";
  /** The Stellar address credited by a transfer. Absent for an exit. */
  stellar?: string;
  /** The Ethereum address behind an `0x…` or ENS recipient. */
  evm?: Address;
  /** The ENS name, when one was typed. */
  name?: string;
}

/** A prepared call, ready for the owner to read and sign. */
export interface Review {
  request: ActionRequest;
  owner: Address;
  /** The SDK's prepared call: typed data, entry, expiry. */
  prepared: Prepared;
  /** Exactly the calls the wallet shows: `prepared.calls`. */
  calls: Call[];
  /** The whole message the wallet shows: account, calls, payload. */
  message: SignedMessage;
  recipient: Recipient | null;
  /** USDC moved, in 7-decimal units; `null` for a generic call. */
  amount: bigint | null;
  /** When the call was prepared, in milliseconds. */
  preparedAt: number;
}

/** What was put in front of the account contract, next to what the wallet showed. */
export interface Submission {
  /** The calls the wallet showed and the owner signed. */
  shownCalls: Call[];
  /** The calls that were submitted. They differ from `shownCalls` only when the call was altered after signing. */
  attemptedCalls: Call[];
  /** The message the account contract rebuilds from what was submitted. */
  attempted: SignedMessage;
  /** True when an argument was changed after signing, to show the refusal. */
  tampered: boolean;
}

/** Relayer codes that mean: the call was looked at and turned down. Nothing moved. */
export type RefusalCode = "bad_signature" | "simulation_failed" | "bad_request";

export type ActionState =
  | { phase: "idle"; notice?: "rejected" }
  | { phase: "preparing"; request: ActionRequest }
  | ({ phase: "review"; notice?: "rejected" } & Review)
  | ({
      phase: "signing";
      tamper: boolean;
      /** When the wallet was asked, in milliseconds. */
      since: number;
    } & Review)
  | ({
      phase: "relaying";
      /** When the signed call was sent to the relayer, in milliseconds. */
      since: number;
    } & Review &
      Submission)
  | ({ phase: "done"; hash: string; deployHash?: string; finishedAt: number } & Review & Submission)
  | ({
      phase: "refused";
      code: RefusalCode;
      detail: string;
      reason: string;
      /**
       * The transaction the refusal belongs to. A relayer checks a call
       * before it sends anything, so a refusal comes with no transaction:
       * this is `null`, and nothing was sent.
       */
      txHash: string | null;
    } & Review &
      Submission)
  /** The signature ran out before it was used. One click prepares the same call again. */
  | ({ phase: "expired"; detail: string } & Review)
  | { phase: "failed"; stage: "prepare" | "sign" | "relay"; request: ActionRequest; error: ProblemError; review?: Review };

export type ActionEvent =
  | { type: "PREPARE"; request: ActionRequest }
  | { type: "PREPARED"; review: Review }
  | { type: "PREPARE_FAILED"; error: ProblemError }
  | { type: "SIGN"; tamper: boolean; at: number }
  /** The owner declined in the wallet: back to the review, nothing is wrong. */
  | { type: "SIGN_REJECTED" }
  | { type: "SIGN_FAILED"; error: ProblemError }
  | { type: "SIGNED"; attempted: SignedMessage; tampered: boolean; at: number }
  | { type: "RELAYED"; hash: string; deployHash?: string; at: number }
  | { type: "REFUSED"; code: RefusalCode; detail: string; reason: string; txHash: string | null }
  | { type: "EXPIRED"; detail: string }
  | { type: "RELAY_FAILED"; error: ProblemError }
  /** Back from the review to the form. */
  | { type: "BACK" }
  | { type: "RESET" };

export const IDLE_ACTION: ActionState = { phase: "idle" };

/** True while the flow is waiting for the network or the wallet: nothing else can start. */
export function isActionBusy(state: ActionState): boolean {
  return state.phase === "preparing" || state.phase === "signing" || state.phase === "relaying";
}

/** The prepared call a state is about, when there is one. */
export function reviewOf(state: ActionState): Review | undefined {
  switch (state.phase) {
    case "idle":
    case "preparing":
      return undefined;
    case "failed":
      return state.review;
    default: {
      const { request, owner, prepared, calls, message, recipient, amount, preparedAt } = state;
      return { request, owner, prepared, calls, message, recipient, amount, preparedAt };
    }
  }
}

function submissionOf(state: Review & Submission): Submission {
  const { shownCalls, attemptedCalls, attempted, tampered } = state;
  return { shownCalls, attemptedCalls, attempted, tampered };
}

/** Every transition of the outbound flow. An event that does not apply to the current phase changes nothing. */
export function actionReducer(state: ActionState, event: ActionEvent): ActionState {
  switch (event.type) {
    case "PREPARE":
      if (isActionBusy(state)) return state;
      return { phase: "preparing", request: event.request };

    case "PREPARED":
      if (state.phase !== "preparing") return state;
      return { phase: "review", ...event.review };

    case "PREPARE_FAILED":
      if (state.phase !== "preparing") return state;
      return { phase: "failed", stage: "prepare", request: state.request, error: event.error };

    case "SIGN": {
      if (state.phase !== "review") return state;
      return { phase: "signing", tamper: event.tamper, since: event.at, ...reviewOf(state)! };
    }

    case "SIGN_REJECTED":
      if (state.phase !== "signing") return state;
      return { phase: "review", notice: "rejected", ...reviewOf(state)! };

    case "SIGN_FAILED": {
      if (state.phase !== "signing") return state;
      const review = reviewOf(state)!;
      return { phase: "failed", stage: "sign", request: review.request, error: event.error, review };
    }

    case "SIGNED": {
      if (state.phase !== "signing") return state;
      const review = reviewOf(state)!;
      return {
        phase: "relaying",
        since: event.at,
        ...review,
        shownCalls: review.calls,
        attemptedCalls: event.attempted.calls,
        attempted: event.attempted,
        tampered: event.tampered,
      };
    }

    case "RELAYED":
      if (state.phase !== "relaying") return state;
      return {
        phase: "done",
        ...reviewOf(state)!,
        ...submissionOf(state),
        hash: event.hash,
        ...(event.deployHash ? { deployHash: event.deployHash } : {}),
        finishedAt: event.at,
      };

    case "REFUSED":
      if (state.phase !== "relaying") return state;
      return {
        phase: "refused",
        ...reviewOf(state)!,
        ...submissionOf(state),
        code: event.code,
        detail: event.detail,
        reason: event.reason,
        txHash: event.txHash,
      };

    case "EXPIRED":
      if (state.phase !== "review" && state.phase !== "signing" && state.phase !== "relaying") return state;
      return { phase: "expired", detail: event.detail, ...reviewOf(state)! };

    case "RELAY_FAILED": {
      if (state.phase !== "relaying") return state;
      const review = reviewOf(state)!;
      return { phase: "failed", stage: "relay", request: review.request, error: event.error, review };
    }

    case "BACK":
      return state.phase === "review" ? IDLE_ACTION : state;

    case "RESET":
      return IDLE_ACTION;
  }
}

/**
 * The two panels for a state: "Your wallet shows" and "The contract
 * verifies", with the lines that differ marked and the verdict between them.
 */
export function panelsOf(state: ActionState, nameOf?: (address: string) => string | undefined): Panels {
  switch (state.phase) {
    case "idle":
    case "preparing":
      return NO_PANELS;
    case "review":
    case "signing":
    case "expired":
      return comparePanels(state.message, null, "unsigned", nameOf);
    case "relaying":
      return comparePanels(state.message, state.attempted, "checking", nameOf);
    case "done":
      return comparePanels(state.message, state.attempted, "match", nameOf);
    case "refused":
      return comparePanels(state.message, state.attempted, "refused", nameOf);
    case "failed":
      return state.review ? comparePanels(state.review.message, null, "unsigned", nameOf) : NO_PANELS;
  }
}
