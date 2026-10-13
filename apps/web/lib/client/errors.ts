import type { RelayErrorCode } from "@paso/sdk";

/**
 * What went wrong, in words a person can act on.
 *
 * `rejected` is the owner saying no in the wallet. It is a decision, not a
 * failure: flows return to where they were and show nothing alarming.
 */
export type Problem =
  | { kind: "rejected" }
  | {
      kind: "error";
      /** Stable identifier: a relayer or API code, or one of the codes below. */
      code: string;
      /** One short sentence for the person in front of the screen. */
      message: string;
      /** The original explanation, for a details disclosure. */
      detail?: string;
      /** Whether trying the same thing again can work. */
      retryable: boolean;
      retryAfterSeconds?: number;
    };

export type ProblemError = Extract<Problem, { kind: "error" }>;

type RelayCode = RelayErrorCode | "relay_failed";

const RELAY_MESSAGES: Record<RelayCode, string> = {
  expired: "The signature expired before it was sent. Sign again.",
  bad_signature: "BadSignature (#2): the transaction does not match what was signed. Nothing moved.",
  simulation_failed: "The call would fail, so it was not sent.",
  bad_request: "The relayer does not accept this call.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  transaction_failed: "The transaction was sent and did not apply on Stellar. Nothing moved.",
  unavailable: "The relayer cannot reach Stellar right now. Try again in a moment.",
  relay_failed: "The relayer did not answer. Try again.",
};

const RETRYABLE_RELAY_CODES: readonly string[] = ["rate_limited", "unavailable", "relay_failed", "expired"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The error and everything it was caused by, outermost first. */
function chain(error: unknown): Record<string, unknown>[] {
  const links: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && isRecord(current); depth += 1) {
    links.push(current);
    current = current.cause;
  }
  return links;
}

function text(error: unknown): string {
  return chain(error)
    .flatMap((link) => [link.shortMessage, link.details, link.message])
    .filter((part): part is string => typeof part === "string")
    .join(" · ");
}

function firstMessage(error: unknown): string {
  for (const link of chain(error)) {
    if (typeof link.shortMessage === "string" && link.shortMessage) return link.shortMessage;
    if (typeof link.message === "string" && link.message) return link.message;
  }
  return typeof error === "string" && error ? error : "Something went wrong";
}

/** True when the owner declined the request in their wallet. */
export function isUserRejection(error: unknown): boolean {
  return chain(error).some(
    (link) =>
      link.code === 4001 ||
      link.code === "ACTION_REJECTED" ||
      link.name === "UserRejectedRequestError" ||
      (typeof link.message === "string" && /user (rejected|denied|cancel)|rejected the request|request rejected/i.test(link.message)),
  );
}

/** The sentence for a relayer refusal. */
export function relayMessage(code: string, detail?: string): string {
  const message = RELAY_MESSAGES[code as RelayCode] ?? RELAY_MESSAGES.relay_failed;
  if ((code === "simulation_failed" || code === "bad_request") && detail) {
    return `${message} ${simulationReason(detail)}`;
  }
  return message;
}

/** A refusal in a few words, for a list: "did not match the signature". */
export function refusalSummary(code: string): string {
  switch (code) {
    case "bad_signature":
      return "did not match the signature";
    case "simulation_failed":
      return "the call would have failed";
    default:
      return "the relayer did not accept the call";
  }
}

/** Soroban's explanation of a failed call, reduced to what a person can use. */
function simulationReason(detail: string): string {
  if (/balance is not sufficient|Error\(Contract, #10\)/i.test(detail)) return "The account does not hold enough USDC.";
  if (/trustline|Error\(Contract, #13\)/i.test(detail)) return "The recipient cannot hold USDC yet: it has no USDC trustline.";
  if (/allowance/i.test(detail)) return "The spending allowance is not enough.";
  const firstLine = detail.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

function problem(code: string, message: string, retryable: boolean, detail?: string, retryAfterSeconds?: number): ProblemError {
  return {
    kind: "error",
    code,
    message,
    retryable,
    ...(detail && detail !== message ? { detail } : {}),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
  };
}

/**
 * Maps anything a flow can throw — a relayer refusal, an API refusal, an SDK
 * error, a wallet error — to a `Problem`.
 */
export function describeError(error: unknown): Problem {
  if (isUserRejection(error)) return { kind: "rejected" };

  const links = chain(error);
  const named = (name: string) => links.find((link) => link.name === name);
  const all = text(error);

  const relay = named("RelayError");
  if (relay && typeof relay.code === "string") {
    const detail = typeof relay.detail === "string" ? relay.detail : undefined;
    return problem(relay.code, relayMessage(relay.code, detail), RETRYABLE_RELAY_CODES.includes(relay.code), detail);
  }

  const api = named("ApiFailure");
  if (api && typeof api.code === "string") {
    const detail = typeof api.detail === "string" ? api.detail : undefined;
    const retryAfter = typeof api.retryAfterSeconds === "number" ? api.retryAfterSeconds : undefined;
    switch (api.code) {
      case "network":
        return problem("network", "The server could not be reached. Check the connection and try again.", true, detail);
      case "rate_limited":
        return problem("rate_limited", RELAY_MESSAGES.rate_limited, true, detail, retryAfter);
      case "unavailable":
        return problem("unavailable", detail ?? "The server could not complete the request. Try again.", true, detail);
      default:
        return problem(api.code, detail ?? "The server refused the request.", false, detail);
    }
  }

  const simulation = named("SimulationError");
  if (simulation) {
    const detail = typeof simulation.detail === "string" ? simulation.detail : all;
    if (simulation.expired === true) return problem("expired", RELAY_MESSAGES.expired, true, detail);
    return problem("simulation_failed", `This call would fail. ${simulationReason(detail)}`, false, detail);
  }

  if (named("AuthorizationEntriesError")) {
    return problem("unsupported_call", "This call needs more than one signature from the account, which is not supported.", false, all);
  }
  if (named("NameNotFoundError")) {
    return problem("name_not_found", firstMessage(error), false);
  }

  if (/65 bytes|smart-contract wallets/i.test(all)) {
    return problem(
      "smart_wallet",
      "This wallet signs as a smart contract. A Paso account needs a regular wallet: MetaMask, Rabby, Coinbase Wallet extension or a Ledger.",
      false,
      all,
    );
  }
  if (/was signed by 0x[0-9a-fA-F]{40}, but the account belongs to/.test(all)) {
    return problem("wrong_signer", "The wallet signed with a different address. Switch to the connected address and sign again.", true, all);
  }
  if (links.some((link) => link.name === "ProviderNotFoundError" || link.name === "ConnectorNotFoundError")) {
    return problem("no_wallet", "No wallet was found in this browser. Install one, or try without a wallet.", false, all);
  }
  if (links.some((link) => link.code === -32002) || /already pending|request already/i.test(all)) {
    return problem("wallet_busy", "The wallet already has a request open. Open the wallet to answer it.", true, all);
  }
  if (links.some((link) => link.code === 4902 || link.name === "ChainMismatchError" || link.name === "SwitchChainError" || link.name === "ChainNotConfiguredError")) {
    return problem("wrong_network", "The wallet is on another network. Switch it to Base and try again.", true, all);
  }
  if (links.some((link) => link.name === "InsufficientFundsError") || /insufficient funds/i.test(all)) {
    return problem("insufficient_gas", "The wallet does not hold enough ETH on Base to pay for gas.", false, all);
  }
  if (/transfer amount exceeds balance|exceeds balance/i.test(all)) {
    return problem("insufficient_usdc", "The wallet does not hold enough USDC on Base.", false, all);
  }
  if (/reverted on Base/.test(all)) {
    return problem("reverted", "The transaction reverted on Base. Nothing was sent.", true, all);
  }
  if (/execution reverted|exceeds allowance/i.test(all)) {
    return problem("would_revert", "The wallet says this transaction would fail, so it was not sent. Nothing left the wallet.", true, all);
  }
  if (/Iris answered|Iris lists no burn fee/.test(all)) {
    return problem("circle_unreachable", "Circle's attestation service did not answer. Try again in a moment.", true, all);
  }
  if (/failed to fetch|fetch failed|networkerror|load failed|network request failed|timed out|timeout/i.test(all)) {
    return problem("network", "The network did not answer. Check the connection and try again.", true, all);
  }

  // The SDK validates input before it reaches the network and explains itself in one sentence.
  return problem("unknown", firstMessage(error), false);
}

/** `describeError` for places where a rejection cannot happen or is handled before. */
export function describeFailure(error: unknown): ProblemError {
  const described = describeError(error);
  return described.kind === "error"
    ? described
    : problem("rejected", "The request was declined in the wallet.", true);
}
