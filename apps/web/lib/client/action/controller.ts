import {
  DEFAULT_VALIDITY_LEDGERS,
  describeCalls,
  entryTypedData,
  LEDGER_SECONDS,
  networkId,
  prepare,
  RelayError,
  relayRequest,
  sign,
  withArgument,
  saltNetwork,
  type NetworkConfig,
  type Prepared,
  type RelayErrorCode,
  type RelayResult,
  type Signed,
  type TypedDataSigner,
} from "@paso/sdk";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { isAddressEqual, type Address } from "viem";
import type { ActivityLog, LogEntry } from "../activity/log";
import { describeError, describeFailure, refusalSummary, relayMessage, type ProblemError } from "../errors";
import { createStore, type Listener } from "../store";
import { buildAction } from "./build";
import {
  actionReducer,
  cautionsFor,
  IDLE_ACTION,
  isActionBusy,
  reviewOf,
  UNCONFIRMED,
  UNCONFIRMED_MESSAGE,
  type ActionEvent,
  type ActionRequest,
  type ActionState,
  type Caution,
  type RecipientCheck,
  type RefusalCode,
  type Review,
} from "./machine";

export type { RecipientCheck } from "./machine";
import { hasConcerns, type SignedMessage } from "./panels";

/** One argument of the root call, replaced after signing. */
export interface Tamper {
  /** Position of the argument in the root call. */
  index: number;
  value: xdr.ScVal;
}

export interface SignOptions {
  /**
   * Alter the call after it is signed, the way a dishonest relayer or front
   * end would have to, and submit that. `true` changes the amount; a `Tamper`
   * names the argument and its new value. The account contract refuses.
   *
   * A demonstration, and testnet's only. Anywhere else nothing is signed
   * when it is asked for: a signature given to watch a refusal must never be
   * one that could move real funds.
   */
  tamper?: boolean | Tamper;
  /**
   * The cautions of the review that the owner has answered. While one is
   * missing, nothing is signed: a transfer to a smart contract's account, to
   * name the worst, never goes out because a button was pressed in passing.
   */
  confirmed?: readonly Caution[];
}

export interface ActionDeps {
  /** The network every call is prepared for, signed for and relayed on. */
  network: NetworkConfig;
  /** Where signed calls are sent. */
  relayUrl: string;
  resolveName: (name: string) => Promise<Address | null>;
  /**
   * Looks at the Ethereum address whose Stellar account a transfer pays:
   * whether it is a wallet or a contract, and whether its account exists.
   * Without it nothing is known and nothing is asked.
   */
  inspectRecipient?: (address: Address) => Promise<RecipientCheck>;
  /** The session log of an account, so calls show up in its activity. */
  log?: (twin: string) => Pick<ActivityLog, "put"> | null;
  now?: () => number;
  prepare?: typeof prepare;
  sign?: typeof sign;
  /** One request to the relayer for a signed call. Defaults to `postRelay`. */
  relay?: (signed: Signed, relayUrl: string) => Promise<RelayResult>;
  withArgument?: typeof withArgument;
  /**
   * A prepared call older than this is prepared again instead of signed.
   * By default that is the call's own lifetime, about two minutes, less the
   * time it takes to get a signed call through: asking the wallet for a
   * signature that will have run out by the time it is used wastes a prompt.
   */
  staleAfterMs?: number;
  /** How long to wait before asking a relayer again that gave no answer. The wait doubles from there, up to a few seconds. */
  retryDelayMs?: number;
  /**
   * How long after a call was prepared the relayer is still asked about it.
   * By default until the signature has run out, plus the time it takes the
   * network to say so: past that no answer can change what happened.
   */
  giveUpAfterMs?: number;
}

/** What a relayer's answer says beyond its code, when it says it. */
export interface RelayFacts {
  /**
   * `false`: the relayer decided before handing anything to the network, and
   * has checked that the call has not run. `true`: a transaction went out.
   * Absent: the relayer makes no claim, and neither may the screen.
   */
  sent?: boolean;
  retryAfterSeconds?: number;
}

/**
 * One request to the relayer for a signed call.
 *
 * The body is made from the signed call alone, so asking again sends the
 * same bytes and the relayer recognises the call. A refusal is thrown as a
 * `RelayError` that also carries the relayer's `RelayFacts`.
 */
export async function postRelay(signed: Signed, relayUrl: string, fetcher: typeof fetch = fetch): Promise<RelayResult> {
  const response = await fetcher(relayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(relayRequest(signed)),
  });

  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (response.ok && typeof body.hash === "string") {
    return typeof body.deployHash === "string" ? { hash: body.hash, deployHash: body.deployHash } : { hash: body.hash };
  }

  const code = typeof body.error === "string" ? (body.error as RelayErrorCode) : "relay_failed";
  const detail = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? undefined : text.slice(0, 300);
  const retryAfter = Number(response.headers.get("retry-after"));
  const facts: RelayFacts = {
    ...(typeof body.sent === "boolean" ? { sent: body.sent } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
  };
  throw Object.assign(new RelayError(code, response.status, detail), facts);
}

function factsOf(error: unknown): RelayFacts {
  if (typeof error !== "object" || error === null) return {};
  const { sent, retryAfterSeconds } = error as { sent?: unknown; retryAfterSeconds?: unknown };
  return {
    ...(typeof sent === "boolean" ? { sent } : {}),
    ...(typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
  };
}

export interface ActionController {
  getState(): ActionState;
  subscribe(listener: Listener): () => void;
  /** Simulates the request and moves to the review. Ignored while the flow is busy. */
  prepare(request: ActionRequest): Promise<void>;
  /** Asks for the signature and relays the call. Ignored outside the review, so a double click submits once. */
  sign(signer: TypedDataSigner, options?: SignOptions): Promise<void>;
  /** After `expired`: prepares the same request again, then signs and relays it. */
  signAgain(signer: TypedDataSigner, options?: SignOptions): Promise<void>;
  /** From the review back to the form. */
  back(): void;
  reset(): void;
}

/** What is left of a signature's lifetime must cover the wallet prompt and the relay: with less, it is not asked for. */
const SIGNING_MARGIN_MS = 40_000;
/** How long past a signature's end the network may take to say that it has run out. */
const SETTLE_MARGIN_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_500;
const MAX_RETRY_DELAY_MS = 8_000;
const REFUSALS: readonly string[] = ["bad_signature", "simulation_failed", "bad_request"];
/**
 * Answers that judge nothing: the relayer could not be reached, could not
 * reach Stellar, has a transaction on its way, or answered something
 * unreadable. The same signed call is offered again.
 */
const NOT_AN_ANSWER: readonly string[] = ["unavailable", "network", "relay_failed", "rate_limited"];

/**
 * Why a prepared call must not be shown for signing on `network`, or `null`
 * when it is that network's. The wallet prompt names no network in words:
 * the network id sits in the domain as 32 bytes of salt. So the salt is
 * read here, and a call whose salt is another network's never reaches the
 * review, whatever the call says about itself.
 */
export function wrongNetwork(prepared: Pick<Prepared, "network" | "typedData">, network: NetworkConfig): ProblemError | null {
  const { salt } = prepared.typedData.domain;
  if (prepared.network === network.name && salt.toLowerCase() === networkId(network).toLowerCase()) return null;
  const actual = saltNetwork(salt) ?? "another network";
  return {
    kind: "error",
    code: "wrong_network",
    message: `This request was prepared for ${actual}, and the page is on ${network.name}. Nothing was signed.`,
    retryable: false,
  };
}

/** The message the account contract rebuilds from an authorisation entry: its account, its calls, its payload. */
export function messageOfEntry(entry: string, network: NetworkConfig): SignedMessage {
  const decoded = xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64");
  const { domain, message } = entryTypedData(decoded, network);
  return { salt: domain.salt, account: message.account, calls: message.calls, payload: message.payload };
}

/** About how long a prepared call's signature is accepted for, counted from its preparation. */
function lifetimeMs(prepared: Pick<Prepared, "validUntilLedger" | "preparedAtLedger">): number {
  const ledgers = prepared.preparedAtLedger === undefined ? DEFAULT_VALIDITY_LEDGERS : prepared.validUntilLedger - prepared.preparedAtLedger;
  return Math.max(0, ledgers) * LEDGER_SECONDS * 1000;
}

/**
 * The change shown by default: the first amount of the root call, ten times
 * over. For a transfer of 5 USDC the wallet showed `50000000` and the
 * submitted call says `500000000`.
 */
export function defaultTamper(signed: Pick<Signed, "entries">): Tamper {
  const [entry] = signed.entries;
  const root = entry ? xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64").rootInvocation.function : undefined;
  if (root?.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("This call cannot be altered: it is not a contract call");
  }
  const { args } = root.contractFn;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.type === "scvI128") {
      const amount = (arg.i128.hi << 64n) | arg.i128.lo;
      return { index, value: nativeToScVal(amount === 0n ? 1n : amount * 10n, { type: "i128" }) };
    }
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.type === "scvU32") return { index, value: xdr.ScVal.scvU32(arg.u32 + 1) };
  }
  throw new Error("This call has no amount to alter");
}

/**
 * The outbound flow of one owner: prepare a call, show it, have it signed,
 * hand it to the relayer, and report what the account contract made of it.
 */
export function createActionController(owner: Address, deps: ActionDeps): ActionController {
  const { network, relayUrl, resolveName } = deps;
  const now = deps.now ?? Date.now;
  const prepareCall = deps.prepare ?? prepare;
  const signCall = deps.sign ?? sign;
  const relayCall = deps.relay ?? postRelay;
  const alter = deps.withArgument ?? withArgument;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  /** When a prepared call is too old to be worth a wallet prompt. */
  const staleAt = (review: Review): number =>
    deps.staleAfterMs === undefined ? review.expiresAt - SIGNING_MARGIN_MS : review.preparedAt + deps.staleAfterMs;
  /** When no answer about a signed call can change what happened any more. */
  const giveUpAt = (review: Review): number =>
    deps.giveUpAfterMs === undefined ? review.expiresAt + SETTLE_MARGIN_MS : review.preparedAt + deps.giveUpAfterMs;

  const store = createStore<ActionState>(IDLE_ACTION);
  /** Set from the first synchronous line of an operation to its last: two clicks cannot both get in. */
  let busy = false;
  /** Grows on every reset, so an operation that outlives one keeps its hands off the state. */
  let generation = 0;

  const dispatch = (event: ActionEvent): void => store.set(actionReducer(store.get(), event));

  function record(
    review: Review,
    entry: Pick<LogEntry, "kind" | "status"> & Pick<Partial<LogEntry>, "stellarTxHash" | "note">,
  ): void {
    const { request, recipient, amount, prepared } = review;
    deps.log?.(prepared.account)?.put({
      id: entry.stellarTxHash ? `tx:${entry.stellarTxHash}` : `refused:${now()}`,
      amount: amount === null ? null : amount.toString(),
      counterparty:
        request.kind === "invoke" ? request.contract : ((request.kind === "exit" ? recipient?.evm : recipient?.stellar) ?? null),
      at: now(),
      ...(request.kind === "invoke" && entry.kind !== "refused" ? { note: request.fn } : {}),
      ...entry,
    });
  }

  async function prepareRequest(request: ActionRequest): Promise<boolean> {
    const ticket = generation;
    dispatch({ type: "PREPARE", request });
    try {
      const built = await buildAction(request, { network, resolveName });
      // Only a transfer pays the Stellar account of an Ethereum address, and only someone else's needs looking at.
      const payee = request.kind === "transfer" ? built.recipient?.evm : undefined;
      const inspect = payee && !isAddressEqual(payee, owner) ? deps.inspectRecipient : undefined;
      const [prepared, check] = await Promise.all([
        prepareCall(built.action, { owner, network }),
        inspect && payee ? inspect(payee).catch((): RecipientCheck => ({ kind: "unknown", deployed: null })) : null,
      ]);
      if (ticket !== generation) return false;
      const mismatch = wrongNetwork(prepared, network);
      if (mismatch) {
        dispatch({ type: "PREPARE_FAILED", error: mismatch });
        return false;
      }
      // A call typed in by hand can carry anything: its arguments are described, and what can mislead is flagged.
      const [entry] = prepared.entries;
      const described =
        request.kind === "invoke" && entry ? describeCalls(xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64")) : undefined;
      const cautions: Caution[] = [...cautionsFor(check), ...(described && hasConcerns(described) ? (["arguments"] as const) : [])];
      const preparedAt = now();
      dispatch({
        type: "PREPARED",
        review: {
          request,
          network: network.name,
          owner,
          prepared,
          calls: prepared.calls,
          message: {
            salt: prepared.typedData.domain.salt,
            account: prepared.typedData.message.account,
            calls: prepared.typedData.message.calls,
            payload: prepared.typedData.message.payload,
          },
          recipient: built.recipient,
          amount: built.amount,
          cautions,
          ...(described ? { described } : {}),
          preparedAt,
          validUntilLedger: prepared.validUntilLedger,
          expiresAt: preparedAt + lifetimeMs(prepared),
        },
      });
      return true;
    } catch (error) {
      if (ticket === generation) dispatch({ type: "PREPARE_FAILED", error: describeFailure(error) });
      return false;
    }
  }

  async function signAndRelay(review: Review, signer: TypedDataSigner, options: SignOptions): Promise<void> {
    const ticket = generation;
    const current = () => ticket === generation;

    if (now() > staleAt(review)) {
      dispatch({ type: "EXPIRED", detail: "This request was prepared too long ago to be signed." });
      return;
    }

    dispatch({ type: "SIGN", tamper: Boolean(options.tamper), at: now() });
    let submitted: Signed;
    try {
      const signed = await signCall(review.prepared, signer);
      if (!current()) return;
      if (options.tamper) {
        const change = options.tamper === true ? defaultTamper(signed) : options.tamper;
        submitted = alter(signed, change.index, change.value);
      } else {
        submitted = signed;
      }
    } catch (error) {
      if (!current()) return;
      const problem = describeError(error);
      dispatch(problem.kind === "rejected" ? { type: "SIGN_REJECTED" } : { type: "SIGN_FAILED", error: problem });
      return;
    }

    const [entry] = submitted.entries;
    dispatch({
      type: "SIGNED",
      attempted: entry ? messageOfEntry(entry, network) : review.message,
      tampered: Boolean(options.tamper),
      at: now(),
    });

    /** The call may have run without anyone here having seen it: nothing is claimed either way. */
    const unconfirmed = (detail?: string): ActionEvent => ({
      type: "RELAY_FAILED",
      error: { kind: "error", code: UNCONFIRMED, message: UNCONFIRMED_MESSAGE, retryable: false, ...(detail ? { detail } : {}) },
    });

    /**
     * Offers the signed call to the relayer until it gives an answer about
     * the call, or until no answer could change anything any more.
     *
     * It is always the same signed call, byte for byte, so the relayer
     * recognises it and reports what became of the first request instead of
     * judging a second one. Whether an earlier request may have reached the
     * network without its answer reaching this screen is kept track of: from
     * then on only the relayer's own word, `sent: false`, can establish that
     * nothing moved.
     */
    let uncertain = false;
    let delay = retryDelayMs;
    const lastAnswerAt = giveUpAt(review);
    let result: RelayResult | undefined;
    let failure: unknown;
    for (;;) {
      try {
        result = await relayCall(submitted, relayUrl);
        break;
      } catch (error) {
        failure = error;
        const { code } = describeFailure(error);
        if (!NOT_AN_ANSWER.includes(code)) break;

        const facts = factsOf(error);
        // A request the relayer turned away for being one too many was not looked at; any other may have got through.
        if (code !== "rate_limited" && facts.sent !== false) uncertain = true;
        if (!current()) return;
        const wait = facts.retryAfterSeconds === undefined ? delay : facts.retryAfterSeconds * 1000;
        if (now() + wait >= lastAnswerAt) break;
        dispatch({ type: "RELAY_RETRY" });
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        if (!current()) return;
        delay = Math.min(Math.max(delay, 1) * 2, MAX_RETRY_DELAY_MS);
      }
    }

    if (result) {
      const { hash, deployHash } = result;
      // On record even when the screen has moved on: the call did happen.
      record(review, {
        kind: review.request.kind === "transfer" ? "send" : review.request.kind === "exit" ? "exit" : "call",
        status: "done",
        stellarTxHash: hash,
      });
      if (current()) dispatch({ type: "RELAYED", hash, ...(deployHash ? { deployHash } : {}), at: now() });
      return;
    }

    const problem = describeFailure(failure);
    const { sent } = factsOf(failure);
    if (REFUSALS.includes(problem.code)) {
      // "Refused, nothing moved" is the relayer's claim to make, and it makes it by saying the call was not sent.
      if (sent !== false) {
        if (current()) dispatch(unconfirmed(problem.detail));
        return;
      }
      const reason = relayMessage(problem.code, problem.detail);
      record(review, { kind: "refused", status: "refused", note: refusalSummary(problem.code) });
      if (current()) {
        dispatch({
          type: "REFUSED",
          code: problem.code as RefusalCode,
          detail: problem.detail ?? problem.message,
          reason,
          // The relayer turns a call down before it submits anything: there is no transaction to point at.
          txHash: null,
        });
      }
      return;
    }
    if (!current()) return;
    if (problem.code === "transaction_failed") {
      // Sent, included and not applied: a known outcome, and nothing moved.
      dispatch({ type: "RELAY_FAILED", error: problem });
    } else if (uncertain && sent !== false) {
      // Out of time, or told the signature has expired, after a request that may have gone through.
      dispatch(unconfirmed(problem.detail));
    } else if (problem.code === "expired") {
      dispatch({ type: "EXPIRED", detail: problem.detail ?? problem.message });
    } else {
      dispatch({ type: "RELAY_FAILED", error: problem });
    }
  }

  /** Runs one operation at a time. A reset frees the lock for whatever comes next. */
  async function exclusive(operation: () => Promise<void>): Promise<void> {
    busy = true;
    const ticket = generation;
    try {
      await operation();
    } finally {
      if (ticket === generation) busy = false;
    }
  }

  return {
    getState: store.get,
    subscribe: store.subscribe,

    async prepare(request) {
      if (busy || isActionBusy(store.get())) return;
      await exclusive(async () => {
        await prepareRequest(request);
      });
    },

    async sign(signer, options = {}) {
      const state = store.get();
      if (busy || state.phase !== "review") return;
      if (options.tamper && network.name !== "testnet") return;
      const review = reviewOf(state)!;
      if (review.cautions.some((caution) => !options.confirmed?.includes(caution))) return;
      await exclusive(() => signAndRelay(review, signer, options));
    },

    async signAgain(signer, options = {}) {
      const state = store.get();
      if (busy || state.phase !== "expired") return;
      if (options.tamper && network.name !== "testnet") return;
      await exclusive(async () => {
        if (!(await prepareRequest(state.request))) return;
        const prepared = store.get();
        // What was confirmed belonged to the request that ran out. One with cautions waits in the review to be answered again.
        if (prepared.phase === "review" && prepared.cautions.length === 0) await signAndRelay(reviewOf(prepared)!, signer, options);
      });
    },

    back() {
      if (!busy) dispatch({ type: "BACK" });
    },

    reset() {
      generation += 1;
      busy = false;
      dispatch({ type: "RESET" });
    },
  };
}
