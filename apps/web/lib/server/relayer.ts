import {
  assertOnlyAccountEntries,
  decodeBurnMessage,
  DEFAULT_EVM_CHAIN,
  deliverOperation,
  deployOperation,
  erc20Abi,
  evmChain,
  evmChainForDomain,
  fetchAttestation,
  fetchAttestations,
  formatAmount,
  formatEvmAmount,
  fundFromEvm,
  inboundRouteOf,
  isReceivedOnEvm,
  messageTransmitterAbi,
  isDeployed,
  isExpired,
  listEvmChains,
  MAX_VALIDITY_LEDGERS,
  readContract,
  receiveMessageOnEvm,
  recoverEntrySigner,
  signedFromRelayRequest,
  simulateSigned,
  SimulationError,
  TransactionRevertedError,
  twinAddress,
  type Attestation,
  type BurnMessage,
  type EvmChainConfig,
  type EvmChainName,
  type InboundRoute,
  type NetworkName,
  type RelayResult,
  type Signed,
} from "paso-sdk";
import { createHash } from "node:crypto";
import { Account, Operation, rpc, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  fallback,
  formatEther,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  isAddressEqual,
  pad,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { defaultNetwork, loadConfig, networkNames, serves, type ServerConfig, type SpendKind } from "./config";
import { ApiError, ConfigError } from "./errors";
import { createQueue, QueueFullError, QueueTimeoutError, type Queue } from "./queue";
import { createBudget, createLimiter, SHARED_IDENTITY, type Budget, type Limiter } from "./ratelimit";

/**
 * How long a transaction of the relayer account can still be applied after
 * it is built. Short enough that one request waits out the whole of it and
 * learns what became of the transaction; long enough for several ledgers.
 */
const TRANSACTION_TIMEOUT_SECONDS = 30;
/**
 * How often a sent transaction is asked about, a second apart. That reaches
 * past its time bound, to the ledger that closes after it: the one that says
 * for certain a transaction not yet applied never will be.
 */
const CONFIRMATION_ATTEMPTS = 30;
/**
 * How many transactions are sent for one thing before it is left alone for
 * a while. Each one after the first bids twice the last to be included, and
 * goes out only once the one before it can no longer be applied.
 */
const MAX_SUBMISSIONS = 3;
const RESEND_PAUSE_MS = 5 * 60 * 1000;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 2000;

/**
 * Bounds on waiting. No call to the network is waited for indefinitely, and
 * no transaction holds the queue of the relayer account for longer than
 * `SEND_TIMEOUT_MS`: one slow or hanging request cannot stall the others.
 */
const RPC_TIMEOUT_MS = 15_000;
const EVM_TIMEOUT_MS = 8_000;
const IRIS_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 50_000;
const BURN_TIMEOUT_MS = 55_000;

/** Bounds on work in progress. Past them a request is declined at once instead of piling up. */
const MAX_QUEUED_TRANSACTIONS = 8;
const MAX_QUEUED_BURNS = 4;
const MAX_IN_FLIGHT = 64;

/** One test USDC, in Base's 6-decimal units: what the demo faucet sends per request. */
export const DEMO_FUND_AMOUNT = BigInt(1_000_000);
/** Approved to Circle's TokenMessenger in one go, so a faucet request is a single transaction on Base. */
const STANDING_ALLOWANCE = BigInt(1_000) * DEMO_FUND_AMOUNT;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HEALTH_CACHE_MS = 5_000;

/** Bounds on input: what a request, or an answer from another service, may ask the server to decode and keep. */
const MAX_XDR_CHARS = 16_384;
const MAX_AUTH_ENTRIES = 2;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_ATTESTATION_BYTES = 2_048;
const MAX_DIAGNOSTIC_CHARS = 4_000;
const REMEMBERED_DELIVERIES = 1_000;
/** Changes whenever the shape of `RelayerState` does, so that state left by older code is never mistaken for this. */
export const STATE_VERSION = 3;

/**
 * Bounds on a mint the server pays for on Base. It is sent only after the
 * exact call has been simulated, with this much gas at most, and waited for
 * this many blocks deep before it is called done.
 */
const MINT_GAS_LIMIT = BigInt(400_000);
const MINT_CONFIRMATIONS = 2;
/** The smallest exit worth the server's gas, in 6-decimal units (0.01 USDC). */
const MIN_MINT_AMOUNT = BigInt(10_000);
/** How many attested exits one caller may have examined in an hour: each costs several requests to Base. */
const EXIT_CHECKS_PER_CALLER_PER_HOUR = 30;
/**
 * How much the server remembers at once. None of these tables ever drops an
 * entry to make room: an entry leaves when its own time is up, and while a
 * table is full of entries that still stand, new work is declined instead.
 */
const MAX_EXITS = 5_000;
const MAX_RELAYS = 5_000;
const MAX_PENDING_SENDS = 256;
/** How long the answer to a relayed call is kept, so that the same call asked again gets the same answer. */
const RELAYED_MEMORY_MS = 24 * 60 * 60 * 1000;
const REFUSED_MEMORY_MS = 15 * 60 * 1000;
/** How many pages of one ledger's transactions are read when looking for the one that carried a signed call. */
const LOOKUP_PAGES = 5;
const LOOKUP_PAGE_SIZE = 200;
/** What a caller is told to wait before asking again about a transaction that is on its way. */
const ON_ITS_WAY_RETRY_SECONDS = 3;
/** How long an answer that may yet change is remembered: a re-attested exit, a reverting simulation. */
const SHORT_MEMORY_MS = 5 * 60 * 1000;
/** How often an exit the server refused is looked up on Base again, in case someone else minted it since. */
const RECHECK_MS = 15_000;
/** How long after its time bound a Stellar transaction is still looked for before it is given up as never included. */
const SEND_DEADLINE_MARGIN_MS = 30_000;
/** How long new code waits for the transactions of code it replaced, when it cannot see them. */
const PREDECESSOR_GRACE_MS = 3 * 60 * 1000;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

/** The one key of a limit that applies to all callers together. */
const EVERYONE = "everyone";

/** Circle's MessageTransmitter: the message was delivered before. */
const NONCE_ALREADY_USED = "Error(Contract, #6908)";

const ACCOUNT_ERRORS: Record<string, { name: string; meaning: string }> = {
  "1": { name: "UnsupportedContext", meaning: "only contract calls can be authorised" },
  "2": { name: "BadSignature", meaning: "the call that would run is not the call the owner signed" },
  "3": { name: "BadRecoveryId", meaning: "the last byte of the signature is not a recovery id" },
};

export type DeliverResult =
  | {
      status: "pending";
      /** What Circle's attestation service said: not indexed yet, waiting for finality, or unreachable. */
      attestation: "not_found" | "pending" | "unreachable";
      delayReason?: string;
    }
  | {
      status: "delivered";
      /** The delivering transaction, when this relayer sent it. Absent when someone else delivered first. */
      hash?: string;
      route: InboundRoute;
    };

export type CompleteResult =
  | {
      status: "pending";
      /** What Circle's attestation service said: not indexed yet, or waiting for finality. */
      attestation: "not_found" | "pending";
    }
  | {
      status: "minted";
      /** The minting transaction on Base, when this server sent it. Absent when the message had been received before. */
      hash?: Hex;
    }
  | {
      /**
       * Attested, checked, and left to the caller: this server does not pay
       * for mints on Base here. Any wallet can hand these two to Circle's
       * MessageTransmitter there; the USDC goes to the recipient the message
       * names.
       */
      status: "attested";
      message: Hex;
      attestation: Hex;
    };

export interface DeployResult {
  address: string;
  hash?: string;
  alreadyDeployed: boolean;
}

export interface DemoFundResult {
  burnTxHash: Hex;
  /** CCTP domain of the chain the burn happened on: pass it to the delivery route with the hash. */
  sourceDomain: number;
  /** The Stellar account that receives the USDC. */
  twin: string;
  /** USDC burned, in Base's 6-decimal units. */
  amount: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimmed(diagnostic: string): string {
  return diagnostic.length > MAX_DIAGNOSTIC_CHARS ? `${diagnostic.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : diagnostic;
}

/** The first line of the network's explanation, with the message of its newest diagnostic event when there is one. */
function summary(diagnostic: string): string {
  const firstLine = diagnostic.split("\n", 1)[0]?.trim() || "the call failed";
  const message = /data:\[?"([^"]+)"/.exec(diagnostic)?.[1];
  return message ? `${firstLine}: ${message}` : firstLine;
}

/**
 * Turns the network's explanation of a failed simulation into a refusal.
 *
 * - `expired`: the signature's last valid ledger has passed.
 * - `bad_signature`: the account's `__check_auth` returned one of its errors,
 *   or the host found no authorisation that covers the call.
 * - `simulation_failed`: the call fails for a reason of its own.
 */
export function refusal(diagnostic: string, expired = false): ApiError {
  const extra = { diagnostic: trimmed(diagnostic) };
  if (expired || diagnostic.includes("signature has expired")) {
    return new ApiError("expired", "The signature is past its last valid ledger; prepare and sign again", extra);
  }
  const code = /failed account authentication[^\n]*Error\(Contract, #(\d+)\)/.exec(diagnostic)?.[1];
  if (code) {
    const known = ACCOUNT_ERRORS[code];
    return new ApiError(
      "bad_signature",
      known
        ? `The account refused the signature with ${known.name} (account error #${code}): ${known.meaning}`
        : `The account refused the signature with error #${code}`,
      extra,
    );
  }
  if (diagnostic.includes("Error(Auth, ")) {
    return new ApiError(
      "bad_signature",
      "The network refused the authorisation: the signed entry does not cover the call that would run",
      extra,
    );
  }
  return new ApiError("simulation_failed", summary(diagnostic), extra);
}

class SimulationFailure extends Error {
  constructor(
    readonly diagnostic: string,
    readonly latestLedger: number,
  ) {
    super(diagnostic);
  }
}

type Simulated = rpc.Api.SimulateTransactionSuccessResponse;

/**
 * A Stellar transaction that was handed to the network and has not been seen
 * to be applied or to fail.
 */
export interface PendingSend {
  hash: string;
  /** When the network stops accepting it, in milliseconds since the epoch. */
  deadline: number;
  /** How many transactions have been sent for the same thing, this one included. */
  submissions: number;
  /** What this one bids to be included, in stroops. */
  bid: bigint;
  /** What has been set aside from the day's budget for it, in stroops. */
  setAside: bigint;
  /**
   * Set once a ledger has closed after the deadline without the transaction:
   * it can never be applied. The next one sent for the same thing bids twice
   * as much.
   */
  expired?: true;
  /** After the last transaction allowed has expired too: nothing more is sent for it until this time. */
  pausedUntil?: number;
}

type Fate = "applied" | "failed" | "expired" | "unknown";

/**
 * What one look at a transaction says about it. A transaction that is in no
 * ledger is dead only when the network's own clock, the close time of its
 * latest ledger, is past the transaction's time bound. Short of that it may
 * still land, whatever the clock on this machine says.
 */
function fateOf(seen: { status: unknown; latestLedgerCloseTime?: unknown }, deadline: number): Fate {
  if (seen.status === rpc.Api.GetTransactionStatus.SUCCESS) return "applied";
  if (seen.status === rpc.Api.GetTransactionStatus.FAILED) return "failed";
  const closed = Number(seen.latestLedgerCloseTime);
  return Number.isFinite(closed) && closed * 1000 > deadline ? "expired" : "unknown";
}

/** The refusal for a transaction the network left out: sent again on the next request, or, after the last one, not for a while. */
function leftOut(pending: PendingSend): ApiError {
  if (pending.pausedUntil !== undefined) {
    return new ApiError(
      "unavailable",
      `The network left it out ${pending.submissions} times, each with a higher bid, and charged nothing; it is not sent again for a few minutes`,
      { sent: false, retryAfterSeconds: Math.max(1, Math.ceil((pending.pausedUntil - Date.now()) / 1000)) },
    );
  }
  return new ApiError(
    "unavailable",
    `Transaction ${pending.hash} was not included before its time ran out, and never will be; ask again and it is sent with a higher bid`,
    { hash: pending.hash, sent: false, retryAfterSeconds: 1 },
  );
}

/** What the relayer account pays for, in the words of a refusal. */
const SPEND_WORDS: Record<SpendKind, string> = { relay: "calls", deploy: "account deployments", deliver: "deliveries" };

/**
 * What the server knows about an exit, by its Stellar transaction.
 *
 * `sending` is a reservation: it is written before the mint is sent and
 * stays until the outcome is known, so a mint that may still land is never
 * sent twice. `failed` is a mint that was included and reverted, and is not
 * tried again. `attested` is an exit that was checked and handed back for a
 * wallet to mint. The other two are answers kept to save asking again.
 */
type Exit =
  | { kind: "minted"; until: number; result: CompleteResult }
  | { kind: "attested"; until: number; message: Hex; attestation: Hex; checkedAt: number }
  | { kind: "refused"; until: number; refusal: ApiError; message?: Hex; checkedAt: number }
  | { kind: "sending"; until: number; message: Hex; hash?: Hex }
  | { kind: "failed"; until: number; refusal: ApiError; message: Hex; checkedAt: number };

/**
 * Everything the relayer of one network keeps between requests: the queues
 * its two accounts send through, what it has spent and counted, and what it
 * has in flight. Each network has a state of its own, so nothing that
 * happens on one, a flood least of all, uses up what the other may do.
 *
 * It is kept apart from the code that uses it, so that replacing the code,
 * as a development server does on every edit, leaves the guards standing:
 * the same counts, the same budget, the same transactions on their way.
 */
export interface RelayerState {
  readonly version: number;
  readonly queue: Queue;
  readonly evmQueue: Queue;
  /** Fees of the relayer account over the last day, set aside before a transaction is signed. */
  readonly fees: Budget;
  /** Transactions paid for in the last hour, by kind: for each caller, and for everyone together. */
  readonly spending: Record<SpendKind, { perCaller: Limiter; overall: Limiter }>;
  readonly fundsPerCaller: Limiter;
  readonly fundsPerOwner: Limiter;
  readonly fundsOverall: Limiter;
  readonly exitChecksPerCaller: Limiter;
  readonly mintsPerCaller: Limiter;
  readonly mintsOverall: Limiter;
  readonly deployments: Map<string, Promise<string | undefined>>;
  readonly deliveries: Map<string, Promise<DeliverResult>>;
  readonly completions: Map<string, Promise<CompleteResult>>;
  readonly delivered: Map<string, { until: number; result: DeliverResult }>;
  readonly exits: Map<string, Exit>;
  readonly sends: Map<string, PendingSend>;
  /** Relayed calls being worked on, by what they are: the same call arriving again shares the work and its answer. */
  readonly relaying: Map<string, Promise<RelayResult>>;
  /** What became of a relayed call: the transaction that carried it, or the refusal it got before anything was sent. */
  readonly relays: Map<string, { until: number; result?: RelayResult; refusal?: ApiError }>;
  /** Transactions on Base that were started and have neither succeeded nor failed yet. */
  unsettled: number;
  /**
   * State of code this replaced without being able to take it over. Nothing
   * is paid for until its transactions have settled, or, when that cannot be
   * seen, until enough time has passed for them to have.
   */
  predecessor?: { inFlight?: () => number; until: number };
  /** How many transactions are queued, on their way, or of unknown outcome. */
  inFlight(): number;
}

export function createRelayerState(config: ServerConfig): RelayerState {
  const spending = (kind: SpendKind) => ({
    perCaller: createLimiter({ limit: config.spend[kind].perCallerPerHour, windowMs: HOUR_MS }),
    overall: createLimiter({ limit: config.spend[kind].perHour, windowMs: HOUR_MS, maxKeys: 1 }),
  });
  const state: RelayerState = {
    version: STATE_VERSION,
    queue: createQueue({ maxPending: MAX_QUEUED_TRANSACTIONS, timeoutMs: SEND_TIMEOUT_MS }),
    evmQueue: createQueue({ maxPending: MAX_QUEUED_BURNS, timeoutMs: BURN_TIMEOUT_MS }),
    fees: createBudget({ limit: config.maxDailyFees, windowMs: DAY_MS }),
    spending: { relay: spending("relay"), deploy: spending("deploy"), deliver: spending("deliver") },
    fundsPerCaller: createLimiter({ limit: config.demoFund.perIpPerHour, windowMs: HOUR_MS }),
    fundsPerOwner: createLimiter({ limit: config.demoFund.perOwnerPerDay, windowMs: DAY_MS }),
    fundsOverall: createLimiter({ limit: config.demoFund.perDay, windowMs: DAY_MS, maxKeys: 1 }),
    exitChecksPerCaller: createLimiter({ limit: EXIT_CHECKS_PER_CALLER_PER_HOUR, windowMs: HOUR_MS }),
    mintsPerCaller: createLimiter({ limit: config.baseMints.perCallerPerHour, windowMs: HOUR_MS }),
    mintsOverall: createLimiter({ limit: config.baseMints.perDay, windowMs: DAY_MS, maxKeys: 1 }),
    deployments: new Map(),
    deliveries: new Map(),
    completions: new Map(),
    delivered: new Map(),
    exits: new Map(),
    sends: new Map(),
    relaying: new Map(),
    relays: new Map(),
    unsettled: 0,
    inFlight() {
      const now = Date.now();
      let waiting = state.queue.pending() + state.evmQueue.pending() + state.unsettled;
      for (const send of state.sends.values()) if (!send.expired && send.deadline + SEND_DEADLINE_MARGIN_MS > now) waiting += 1;
      for (const exit of state.exits.values()) if (exit.kind === "sending" && exit.until > now) waiting += 1;
      return waiting;
    },
  };
  return state;
}

/**
 * The fee-paying side of Paso, on one network.
 *
 * It wraps calls signed by account owners in its own transactions, deploys
 * accounts, delivers attested CCTP messages and, on testnet, runs a small
 * USDC faucet. Its Stellar account pays fees and does nothing else: no
 * request can make it authorise a call, and it cannot change a signed one.
 * A server that works on two networks has two of these, each with its own
 * account, its own settings and its own state.
 *
 * What it pays for on mainnet, and on whose word: a relayed call, and the
 * deployment of the account before its first one, only once the owner's
 * signature over that call has been checked; the delivery of a message
 * Circle has attested (see `deliver`); nothing else. The deploy route and
 * the faucet are testnet's, and finishing a transfer back to Base costs no
 * XLM.
 */
export class Relayer {
  readonly address: string;
  private readonly server: rpc.Server;
  private readonly queue: Queue;
  private readonly evmQueue: Queue;
  private readonly deployments: RelayerState["deployments"];
  private readonly deliveries: RelayerState["deliveries"];
  private readonly delivered: RelayerState["delivered"];
  private readonly completions: RelayerState["completions"];
  private readonly exits: RelayerState["exits"];
  private readonly sends: RelayerState["sends"];
  private readonly relaying: RelayerState["relaying"];
  private readonly relays: RelayerState["relays"];
  private readonly exitChecksPerCaller: Limiter;
  private readonly mintsPerCaller: Limiter;
  private readonly mintsOverall: Limiter;
  private readonly fees: Budget;
  private readonly spending: RelayerState["spending"];
  private readonly fundsPerCaller: Limiter;
  private readonly fundsPerOwner: Limiter;
  private readonly fundsOverall: Limiter;
  private healthReport?: { until: number; report: ReturnType<Relayer["readHealth"]> };

  /**
   * `state` is what the relayer keeps between requests. A relayer made on
   * its own gets state of its own; the one a server process runs is handed
   * the state of that process, which outlives it.
   */
  constructor(
    readonly config: ServerConfig,
    readonly state: RelayerState = createRelayerState(config),
  ) {
    this.address = config.relayer.publicKey();
    this.server = new rpc.Server(config.network.stellar.rpcUrl, { timeout: RPC_TIMEOUT_MS });
    this.queue = state.queue;
    this.evmQueue = state.evmQueue;
    this.deployments = state.deployments;
    this.deliveries = state.deliveries;
    this.delivered = state.delivered;
    this.completions = state.completions;
    this.exits = state.exits;
    this.sends = state.sends;
    this.relaying = state.relaying;
    this.relays = state.relays;
    this.fees = state.fees;
    this.spending = state.spending;
    this.fundsPerCaller = state.fundsPerCaller;
    this.fundsPerOwner = state.fundsPerOwner;
    this.fundsOverall = state.fundsOverall;
    this.exitChecksPerCaller = state.exitChecksPerCaller;
    this.mintsPerCaller = state.mintsPerCaller;
    this.mintsOverall = state.mintsOverall;
  }

  /**
   * Relays one call signed by the owner of an account.
   *
   * The request is refused unless it is a contract call carrying exactly one
   * authorisation entry, for the account derived from `owner`, that the
   * account contract accepts for exactly this call. The owner's account is
   * deployed first when it does not exist yet.
   *
   * Relaying is idempotent. A signed call can run once, and a request for it
   * can arrive many times: a retry after a lost answer, a second tab, a
   * client that gave up waiting. Every request for the same call, known by
   * the hash of its signed entry and its function, gets the answer the first
   * one got. While its transaction is on its way they are told so; after it
   * was applied they get its hash; after a refusal that was decided before
   * anything was sent they get that refusal. Nothing is simulated again for
   * a call that is on its way or has run, because a call that has run always
   * simulates as refused: its nonce is spent.
   *
   * `caller` is who the request comes from, as far as that can be told. The
   * transactions paid for are counted against it.
   */
  async relay(body: unknown, caller: string = SHARED_IDENTITY): Promise<RelayResult> {
    let request: ReturnType<Relayer["readRelayRequest"]>;
    try {
      request = this.readRelayRequest(body);
    } catch (error) {
      // Not a call that could be relayed at all, so not one that ever was.
      throw error instanceof ApiError ? new ApiError(error.code, error.detail, { ...error.extra, sent: false }) : error;
    }
    const { signed, func, entry } = request;
    const key = relayKey(func, entry);

    const known = this.relays.get(key);
    if (known && known.until > Date.now()) {
      if (known.result) return known.result;
      if (known.refusal) throw known.refusal;
    }
    const running = this.relaying.get(key);
    if (running) return running;
    if (this.relaying.size >= MAX_IN_FLIGHT) {
      throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
    }

    const attempt = this.relayOnce(key, signed, func, entry, caller).finally(() => this.relaying.delete(key));
    this.relaying.set(key, attempt);
    return attempt;
  }

  private async relayOnce(
    key: string,
    signed: Signed,
    func: xdr.HostFunction,
    entry: xdr.SorobanAuthorizationEntry,
    caller: string,
  ): Promise<RelayResult> {
    // The same call, handed to the network before with an outcome that was never learned: that is settled first.
    const earlier = await this.settleSend(key);
    if (earlier && "hash" in earlier) return this.rememberRelayed(key, { hash: earlier.hash });

    let deployHash: string | undefined;
    try {
      const { sequence } = await this.server.getLatestLedger();
      if (isExpired(signed, sequence)) {
        throw new ApiError(
          "expired",
          `The signature was valid up to ledger ${signed.validUntilLedger} and the network is at ${sequence}; prepare and sign again`,
        );
      }
      // A signature stays usable by whoever holds it until its last ledger, whether or not its first transaction
      // went through. One made to last longer than the SDK allows is not passed on.
      const ahead = signed.validUntilLedger - sequence;
      if (ahead > MAX_VALIDITY_LEDGERS) {
        throw new ApiError(
          "bad_request",
          `The signature is valid for ${ahead} ledgers from now; the relayer passes on signatures valid for at most ${MAX_VALIDITY_LEDGERS}, about ten minutes`,
        );
      }
      // An account that exists judges the signature itself, in the simulation below, at no cost. One that does
      // not exist cannot, and creating it costs the relayer a transaction: nothing is spent on that until the
      // signature has been checked here to be the owner's, the way the account will check it.
      if (!(await isDeployed(signed.owner, this.config.network, this.server))) {
        await this.assertSignedByOwner(signed, entry);
        deployHash = await this.ensureDeployed(signed.owner, caller);
      }
      await this.assertAccepted(signed, func, entry);
    } catch (error) {
      return this.answerBeforeSending(key, func, entry, error);
    }

    const operation = Operation.invokeHostFunction({ func, auth: [entry] });
    let hash: string;
    try {
      hash = await this.send(key, { kind: "relay", caller }, operation, (simulation) => assertNothingElseAuthorised(simulation, entry));
    } catch (error) {
      if (error instanceof SimulationFailure) {
        return this.answerBeforeSending(key, func, entry, refusal(error.diagnostic, isExpired(signed, error.latestLedger)));
      }
      // The price check and the last look at the simulation both come before anything is signed.
      if (error instanceof ApiError && error.code === "simulation_failed") {
        return this.answerBeforeSending(key, func, entry, error);
      }
      if (error instanceof ApiError && error.code === "transaction_failed") {
        throw new ApiError(error.code, error.detail, { ...error.extra, sent: true });
      }
      throw error;
    }
    return this.rememberRelayed(key, deployHash ? { hash, deployHash } : { hash });
  }

  /**
   * The account contract's own check, made here: the typed data is rebuilt
   * from the entry, the signer recovered from its 65 bytes, and that signer
   * has to be the owner. An entry that fails it would be refused by the
   * account as `BadSignature`, so nothing is deployed or sent for it.
   */
  private async assertSignedByOwner(signed: Signed, entry: xdr.SorobanAuthorizationEntry): Promise<void> {
    const signer = await recoverEntrySigner(entry, this.config.network).catch(() => null);
    if (signer === null || !isAddressEqual(signer, signed.owner)) {
      throw new ApiError(
        "bad_signature",
        "The signature is not the owner's signature over this call (BadSignature): the account was not deployed and nothing was sent",
      );
    }
  }

  /** Keeps the transaction of a relayed call while there is room. Without the record the chain is asked instead. */
  private rememberRelayed(key: string, result: RelayResult): RelayResult {
    if (this.relayRoom(key)) this.relays.set(key, { until: Date.now() + RELAYED_MEMORY_MS, result });
    return result;
  }

  /** Whether the table of answers can take one more. Entries whose time is up are cleared first; none that stands is dropped. */
  private relayRoom(key: string): boolean {
    if (this.relays.has(key) || this.relays.size < MAX_RELAYS) return true;
    const now = Date.now();
    for (const [other, record] of this.relays) if (record.until <= now) this.relays.delete(other);
    return this.relays.size < MAX_RELAYS;
  }

  /**
   * The answer to a call that was turned down before this request sent
   * anything. Usually that is the refusal. But a call that has already run,
   * relayed by an earlier request whose answer was lost or by another server
   * instance, is turned down in just the same way, because its nonce is
   * spent. So the chain is asked first, and a call that did run is answered
   * with its transaction.
   *
   * Only when the chain says the call has not run does the refusal say
   * `sent: false`. When the chain cannot be asked, or the signature has
   * expired and its nonce may be gone with it, the refusal makes no claim.
   */
  private async answerBeforeSending(
    key: string,
    func: xdr.HostFunction,
    entry: xdr.SorobanAuthorizationEntry,
    error: unknown,
  ): Promise<RelayResult> {
    const refusals: readonly string[] = ["bad_signature", "simulation_failed", "bad_request", "expired"];
    if (!(error instanceof ApiError) || !refusals.includes(error.code)) throw error;

    let earlier: Awaited<ReturnType<Relayer["executedBefore"]>>;
    try {
      earlier = await this.executedBefore(func, entry);
    } catch {
      throw error;
    }
    if (earlier.state === "executed") return this.rememberRelayed(key, { hash: earlier.hash });
    if (earlier.state === "spent") {
      throw new ApiError("unavailable", "This call has run on Stellar and its transaction has not been found yet; ask again in a moment", {
        sent: true,
        retryAfterSeconds: ON_ITS_WAY_RETRY_SECONDS,
      });
    }

    const answer = error.code === "expired" ? error : new ApiError(error.code, error.detail, { ...error.extra, sent: false });
    if (this.relayRoom(key)) this.relays.set(key, { until: Date.now() + REFUSED_MEMORY_MS, refusal: answer });
    throw answer;
  }

  /**
   * Whether this signed call has already run, read off the chain. A signed
   * entry can be used once: using it writes its nonce under the account, in
   * the ledger of the transaction that did. So a nonce on the ledger means
   * the call ran, and the ledger it was written in holds the transaction.
   *
   * `unused`: the call has not run. `executed`: it ran, in this transaction.
   * `spent`: it ran, and the transaction could not be picked out.
   */
  private async executedBefore(
    func: xdr.HostFunction,
    entry: xdr.SorobanAuthorizationEntry,
  ): Promise<{ state: "unused" } | { state: "spent" } | { state: "executed"; hash: string }> {
    const { credentials } = entry;
    const authorised = entry.rootInvocation.function;
    const address =
      credentials.type === "sorobanCredentialsAddress"
        ? credentials.address
        : credentials.type === "sorobanCredentialsAddressV2"
          ? credentials.addressV2
          : undefined;
    // An entry can only have carried the call it authorises at its root. For any other call it is as good as unused.
    const isThisCall =
      func.type === "hostFunctionTypeInvokeContract" &&
      authorised.type === "sorobanAuthorizedFunctionTypeContractFn" &&
      authorised.contractFn.toXdr("base64") === func.invokeContract.toXdr("base64");
    if (!address || !isThisCall) return { state: "unused" };

    const nonce = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: address.address,
        key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: address.nonce })),
        durability: xdr.ContractDataDurability.temporary,
      }),
    );
    const { entries } = await this.server.getLedgerEntries(nonce);
    const [spent] = entries;
    if (!spent) return { state: "unused" };
    const ledger = spent.lastModifiedLedgerSeq;
    if (ledger === undefined) return { state: "spent" };

    const wanted = entry.toXdr("base64");
    let cursor: string | undefined;
    for (let page = 0; page < LOOKUP_PAGES; page += 1) {
      const answer = await this.server.getTransactions(
        cursor === undefined
          ? { startLedger: ledger, pagination: { limit: LOOKUP_PAGE_SIZE } }
          : { pagination: { cursor, limit: LOOKUP_PAGE_SIZE } },
      );
      for (const transaction of answer.transactions) {
        if (transaction.ledger > ledger) return { state: "spent" };
        if (transaction.status === rpc.Api.GetTransactionStatus.SUCCESS && carries(transaction.envelopeXdr, wanted)) {
          return { state: "executed", hash: transaction.txHash };
        }
      }
      if (answer.transactions.length < LOOKUP_PAGE_SIZE) break;
      cursor = answer.cursor;
    }
    return { state: "spent" };
  }

  /**
   * Deploys the account of an Ethereum address. Doing it twice changes nothing.
   *
   * Testnet only. A request here proves nothing about who sends it, and on
   * mainnet the relayer would pay real XLM for any address at all. There an
   * account is deployed only together with its owner's first signed call,
   * through `relay`, after the signature has been checked to be the owner's.
   * Anyone who wants an account deployed sooner can call `hub.deploy` from a
   * Stellar account of their own.
   */
  async deploy(body: unknown, caller: string = SHARED_IDENTITY): Promise<DeployResult> {
    if (this.config.network.name !== "testnet") {
      throw new ApiError(
        "not_found",
        "On mainnet an account is deployed only with its owner's first signed call, through /api/relay; this route deploys on testnet only",
      );
    }
    const owner = this.readOwner(body);
    const address = twinAddress(owner, this.config.network);
    const hash = await this.ensureDeployed(owner, caller);
    return hash ? { address, hash, alreadyDeployed: false } : { address, alreadyDeployed: true };
  }

  /**
   * Looks a burn up at Circle's attestation service, once, and delivers it on
   * Stellar when it is attested.
   *
   * Delivery is permissionless: Circle's contracts decide whether a message
   * is genuine and where its USDC goes, so any message addressed to Stellar
   * is delivered. A message someone else already delivered counts as
   * delivered.
   *
   * This is the one thing the relayer pays for, on mainnet too, without a
   * signature from an account's owner. That is acceptable because what it
   * pays for cannot be made up: the message has to be attested by Circle,
   * which happens only after someone burned USDC on another chain for a
   * Stellar recipient, at their own cost in USDC and gas. The transaction is
   * built from Circle's bytes alone and authorises nothing but that call;
   * Circle's contracts take each message once, so each burn is paid for at
   * most once. And it is bounded like every payment: it counts against the
   * caller's and the hour's deliveries, the per-transaction fee cap, the
   * day's fee budget and the account's floor. On mainnet, by default: 6 per
   * caller and 20 in all an hour, about 0.07 XLM each, under 2 XLM a day.
   */
  async deliver(body: unknown, caller: string = SHARED_IDENTITY): Promise<DeliverResult> {
    const { sourceDomain, txHash } = this.readBurn(body);
    const key = `${sourceDomain}:${txHash.toLowerCase()}`;

    const known = this.delivered.get(key);
    if (known && known.until > Date.now()) return known.result;
    const running = this.deliveries.get(key);
    if (running) return running;
    if (this.deliveries.size >= MAX_IN_FLIGHT) {
      throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
    }

    const delivery = this.deliverOnce(sourceDomain, txHash, caller).finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    const result = await delivery;
    if (result.status === "delivered") {
      // Kept to save asking again, and only while there is room: nothing rides on it, the chain is asked otherwise.
      const now = Date.now();
      if (this.delivered.size >= REMEMBERED_DELIVERIES) {
        for (const [burn, answer] of this.delivered) if (answer.until <= now) this.delivered.delete(burn);
      }
      if (this.delivered.size < REMEMBERED_DELIVERIES) this.delivered.set(key, { until: now + DAY_MS, result });
    }
    return result;
  }

  /**
   * Finishes a transfer back to an EVM chain: looks the exit up at Circle's
   * attestation service, once, and when it is attested for Base has the
   * server's account there hand the message to Circle's MessageTransmitter,
   * which mints the USDC to the recipient the message names.
   *
   * The server pays the gas and decides nothing else. The call is built from
   * what Circle returned for the transaction, never from bytes a caller
   * sent, and only for an exit made through the hub, from Stellar to Base.
   * Nothing is sent that has not just been simulated successfully, and a
   * mint that fails is never sent a second time.
   *
   * An exit to any other chain the network lists, and every exit where the
   * server does not pay for mints, which is mainnet unless it was told
   * otherwise by name, is looked up and checked in just the same way, on
   * the chain it is for, and then handed back: the answer is `attested`,
   * with the message and its attestation, for the owner's own wallet to
   * submit.
   *
   * An exit has one of four answers. `pending`: ask again. `minted`.
   * `attested`: checked, and the caller's to mint. Or a refusal that says
   * why it cannot be completed; that answer is final, or at least lasting,
   * and like `minted` it is remembered, so asking again costs neither the
   * networks nor anyone's allowance.
   */
  async complete(body: unknown, caller: string): Promise<CompleteResult> {
    const txHash = this.readExit(body);

    // One look per exit at a time: requests that arrive together share it, and its answer.
    const running = this.completions.get(txHash);
    if (running) return running;
    if (this.completions.size >= MAX_IN_FLIGHT) {
      throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
    }

    const completion = (async () => {
      const known = this.exits.get(txHash);
      if (known && known.until > Date.now()) return this.knownExit(txHash, known);
      if (known) this.exits.delete(txHash);
      const result = await this.completeOnce(txHash, caller);
      if (result.status === "minted" && this.exits.get(txHash)?.kind !== "minted") {
        this.rememberExit(txHash, { kind: "minted", until: Date.now() + DAY_MS, result });
      }
      return result;
    })().finally(() => this.completions.delete(txHash));
    this.completions.set(txHash, completion);
    return completion;
  }

  /**
   * Testnet only: the demo payer burns one test USDC on Base for the account
   * of `owner`.
   *
   * Three limits apply: per caller, per owner, and per day for everyone
   * together. All three are looked at before any is counted; once counted,
   * an attempt stays counted whatever becomes of it, because a burn that
   * fails half way may already have cost the payer gas, and a caller must
   * not be able to earn retries by making attempts fail. The counts are kept
   * in memory and start over when the server restarts or is redeployed.
   */
  async demoFund(body: unknown, caller: string): Promise<DemoFundResult> {
    const { network, payer } = this.config;
    if (network.name !== "testnet") {
      throw new ApiError("not_found", "The demo faucet exists on testnet only");
    }
    if (!payer) {
      throw new ApiError("unavailable", "The demo faucet has no payer configured");
    }
    const owner = this.readOwner(body);
    const ownerKey = owner.toLowerCase();

    this.assertPredecessorSettled();
    // Asked before anything is counted: an empty faucet costs nobody an attempt.
    await this.assertFaucetFunded(payer.address);

    const perCaller = this.fundsPerCaller.check(caller);
    if (!perCaller.ok) {
      throw new ApiError("rate_limited", "This address has used the demo faucet too often; try again later", {
        retryAfterSeconds: perCaller.retryAfterSeconds,
      });
    }
    const perOwner = this.fundsPerOwner.check(ownerKey);
    if (!perOwner.ok) {
      throw new ApiError("rate_limited", "This account has already been funded by the demo faucet; try again later", {
        retryAfterSeconds: perOwner.retryAfterSeconds,
      });
    }
    const overall = this.fundsOverall.check(EVERYONE);
    if (!overall.ok) {
      throw new ApiError("unavailable", "The demo faucet has given out all it gives in a day; try again later", {
        retryAfterSeconds: overall.retryAfterSeconds,
      });
    }
    const counted = [
      this.fundsPerCaller.take(caller),
      this.fundsPerOwner.take(ownerKey),
      this.fundsOverall.take(EVERYONE),
    ];
    if (!counted.every((allowance) => allowance.ok)) {
      throw new ApiError("unavailable", "The demo faucet is not available right now; try again later");
    }

    try {
      return await this.queued(this.evmQueue, (signal) => this.unsettled(this.burnForDemo(owner, payer.address, signal)));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The cause stays in the log: a transport error can quote the endpoint it failed to reach.
      console.error("Faucet burn failed:", error instanceof Error ? error.name : "unknown error");
      throw new ApiError("unavailable", `The demo faucet could not send USDC on ${network.evm.chain.name}; try again later`);
    }
  }

  /**
   * What the relayer works on, what its accounts hold, what it has left to
   * spend and where its caps are. Addresses, balances and limits only: all
   * of it is public on the chains or in the source. The answer is kept for
   * a few seconds, so asking often does not turn into as many requests to
   * the networks.
   */
  health(): ReturnType<Relayer["readHealth"]> {
    const now = Date.now();
    if (!this.healthReport || this.healthReport.until <= now) {
      this.healthReport = { until: now + HEALTH_CACHE_MS, report: this.readHealth() };
    }
    return this.healthReport.report;
  }

  private async readHealth() {
    const { network, payer, maxResourceFee, maxDailyFees, minBalance, inclusionFee, spend, baseMints } = this.config;
    const { usdc } = network.evm;
    const evm = this.evmClients();

    const [ledger, relayerEntry, payerUsdc, payerEth] = await Promise.allSettled([
      this.server.getLatestLedger(),
      this.server.getAccountEntry(this.address),
      payer
        ? evm.publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] })
        : Promise.resolve(null),
      payer ? evm.publicClient.getBalance({ address: payer.address }) : Promise.resolve(null),
    ]);
    const value = <T>(settled: PromiseSettledResult<T>): T | null =>
      settled.status === "fulfilled" ? settled.value : null;

    const entry = value(relayerEntry);
    const held = entry ? BigInt(entry.balance.toString()) : null;
    const usdcHeld = value(payerUsdc);
    const ethHeld = value(payerEth);
    const spent = this.fees.spent();
    const remaining = maxDailyFees > spent ? maxDailyFees - spent : BigInt(0);
    return {
      ok: [ledger, relayerEntry, payerUsdc, payerEth].every((settled) => settled.status === "fulfilled"),
      network: network.name,
      hub: network.stellar.hub,
      latestLedger: value(ledger)?.sequence ?? null,
      relayer: {
        address: this.address,
        xlm: held === null ? null : formatAmount(held, 7),
      },
      payer: payer
        ? {
            address: payer.address,
            chain: network.evm.chain.name,
            usdc: usdcHeld === null ? null : formatEvmAmount(usdcHeld),
            eth: ethHeld === null ? null : formatEther(ethHeld),
          }
        : null,
      /**
       * In stroops. A transaction may cost `maxResourceFee` in resources and
       * bids `inclusionFee` on top, twice that each time it is sent again.
       * `spentToday` and `remainingToday` are what this server instance has
       * set aside over the last 24 hours and what that leaves of
       * `maxDailyFees`. `minBalance` is what the account keeps.
       */
      fees: {
        maxResourceFee: maxResourceFee.toString(),
        inclusionFee: inclusionFee.toString(),
        maxDailyFees: maxDailyFees.toString(),
        spentToday: spent.toString(),
        remainingToday: remaining.toString(),
        minBalance: minBalance.toString(),
      },
      /** How many transactions of each kind are paid for in an hour: from one caller, and from everyone. */
      limits: spend,
      /** False while a fee would be declined: the day's budget is spent, or the account is down to what it keeps. */
      paysFees: remaining > BigInt(0) && held !== null && held > minBalance,
      /** Whether a transfer back to Base is minted by the server. Where it is not, the owner's wallet submits the mint. */
      paysBaseMints: baseMints.enabled && payer !== null,
      /** Whether the testnet faucet is there to be asked. */
      faucet: network.name === "testnet" && payer !== null,
    };
  }

  private readOwner(body: unknown): Address {
    if (!isRecord(body)) {
      throw new ApiError("bad_request", "Expected a JSON object");
    }
    this.assertNetwork(body.network, false);
    const { owner } = body;
    if (typeof owner !== "string" || !isAddress(owner, { strict: false })) {
      throw new ApiError("bad_request", "owner must be an Ethereum address (0x and 40 hex digits)");
    }
    return getAddress(owner);
  }

  /** Requests name the network they are meant for; one that names another network is refused. */
  private assertNetwork(network: unknown, required: boolean): void {
    const { name } = this.config.network;
    if (network === undefined && !required) return;
    if (network !== name) {
      throw new ApiError("bad_request", `This server works on ${name}; the request must say network: "${name}"`);
    }
  }

  private readRelayRequest(body: unknown): {
    signed: Signed;
    func: xdr.HostFunction;
    entry: xdr.SorobanAuthorizationEntry;
  } {
    if (!isRecord(body)) {
      throw new ApiError("bad_request", "Expected a JSON object with network, owner, func and auth");
    }
    const { network, owner, func, auth } = body;
    this.assertNetwork(network, true);
    const text = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_XDR_CHARS;
    const entries = Array.isArray(auth) && auth.length <= MAX_AUTH_ENTRIES && auth.every(text);
    if (typeof owner !== "string" || owner.length > 42 || !text(func) || !entries) {
      throw new ApiError(
        "bad_request",
        "owner must be an Ethereum address, func a base64 host function and auth a list with the account's base64 authorisation entry",
      );
    }

    try {
      const signed = signedFromRelayRequest(
        { network: this.config.network.name, owner: owner as Address, func, auth: auth as string[] },
        this.config.network,
      );
      // Decoded again from the validated request: the call, and the one entry
      // that passed the check for the account derived from the owner.
      return {
        signed,
        func: xdr.HostFunction.fromXdr(func, "base64"),
        entry: xdr.SorobanAuthorizationEntry.fromXdr(signed.entries[0]!, "base64"),
      };
    } catch (error) {
      throw new ApiError("bad_request", error instanceof Error ? error.message : "The request could not be read");
    }
  }

  /**
   * A burn to deliver: its transaction, and the CCTP domain of the chain it
   * was made on, which has to be one of the chains the SDK lists for this
   * network. A burn anywhere else is refused before Circle is asked.
   */
  private readBurn(body: unknown): { sourceDomain: number; txHash: Hex } {
    if (!isRecord(body)) {
      throw new ApiError("bad_request", "Expected a JSON object with network, sourceDomain and txHash");
    }
    this.assertNetwork(body.network, true);
    const { sourceDomain, txHash } = body;
    const { network } = this.config;
    const source = Number.isInteger(sourceDomain) ? evmChainForDomain(network, sourceDomain as number) : undefined;
    if (!source) {
      const listed = listEvmChains(network).map((chain) => `${chain.label} ${chain.cctpDomain}`).join(", ");
      throw new ApiError(
        "bad_request",
        `sourceDomain must be the CCTP domain of a chain USDC is brought from on ${network.name}: ${listed}`,
      );
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ApiError("bad_request", "txHash must be the hash of the burn transaction (0x and 64 hex digits)");
    }
    return { sourceDomain: source.cctpDomain, txHash: txHash as Hex };
  }

  /** The Stellar transaction of an exit: 64 hex digits, the form Circle indexes it under. */
  private readExit(body: unknown): string {
    if (!isRecord(body)) {
      throw new ApiError("bad_request", "Expected a JSON object with network and txHash");
    }
    this.assertNetwork(body.network, true);
    const { txHash } = body;
    if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ApiError("bad_request", "txHash must be the Stellar transaction of the exit (64 hex digits, no 0x)");
    }
    return txHash.toLowerCase();
  }

  /**
   * Checks, without submitting, that the account accepts the signature for
   * this call and that the call needs that authorisation and no other.
   *
   * The first simulation enforces the signed entry, so the account contract
   * verifies the signature as it would on chain. The second records what the
   * call asks for when nothing is supplied: it must be the same single
   * invocation by the same account. A call that also wants the relayer's own
   * authorisation, or that does not use the signed entry at all, stops here.
   */
  private async assertAccepted(signed: Signed, func: xdr.HostFunction, entry: xdr.SorobanAuthorizationEntry) {
    const { network } = this.config;
    const unsigned = this.transaction(new Account(this.address, "0"), Operation.invokeHostFunction({ func, auth: [] }));
    const [enforced, recorded] = await Promise.allSettled([
      simulateSigned(signed, { source: this.address, network, server: this.server }),
      this.server.simulateTransaction(unsigned, undefined, "record"),
    ]);

    if (enforced.status === "rejected") {
      const { reason } = enforced;
      if (reason instanceof SimulationError) throw refusal(reason.detail, reason.expired);
      throw reason;
    }
    if (recorded.status === "rejected") throw recorded.reason;
    if (rpc.Api.isSimulationError(recorded.value)) throw refusal(recorded.value.error);

    let needed: xdr.SorobanAuthorizationEntry;
    try {
      needed = assertOnlyAccountEntries(recorded.value.result?.auth ?? [], signed.account);
    } catch (error) {
      throw new ApiError("bad_request", error instanceof Error ? error.message : "The call needs other authorisations");
    }
    if (needed.rootInvocation.toXdr("base64") !== entry.rootInvocation.toXdr("base64")) {
      throw new ApiError("bad_request", "The signed authorisation is not the one this call asks the account for");
    }
  }

  /** Deploys the owner's account unless it exists. Requests for the same owner share one deployment. */
  private ensureDeployed(owner: Address, caller: string): Promise<string | undefined> {
    const key = owner.toLowerCase();
    const running = this.deployments.get(key);
    if (running) return running;
    if (this.deployments.size >= MAX_IN_FLIGHT) {
      return Promise.reject(new ApiError("unavailable", "The relayer is busy; try again in a moment"));
    }

    const { network } = this.config;
    const deployment = (async () => {
      if (await isDeployed(owner, network, this.server)) return undefined;
      try {
        return await this.send(`deploy:${key}`, { kind: "deploy", caller }, deployOperation(owner, network), assertNoAuthorisation);
      } catch (error) {
        if (error instanceof SimulationFailure) {
          throw new ApiError("unavailable", `The account could not be deployed: ${summary(error.diagnostic)}`);
        }
        throw error;
      }
    })().finally(() => this.deployments.delete(key));
    this.deployments.set(key, deployment);
    return deployment;
  }

  private async deliverOnce(sourceDomain: number, txHash: Hex, caller: string): Promise<DeliverResult> {
    const { network } = this.config;
    const { status, attestation } = await this.lookUp(sourceDomain, txHash);
    if (!attestation) {
      if (status.state === "pending" && status.delayReason) {
        return { status: "pending", attestation: "pending", delayReason: status.delayReason };
      }
      return { status: "pending", attestation: status.state === "complete" ? "pending" : status.state };
    }

    const { message, nonce } = attestation;
    if (size(message) > MAX_MESSAGE_BYTES || size(attestation.attestation) > MAX_ATTESTATION_BYTES) {
      throw new ApiError("bad_request", "That transaction carries a message too large to be a USDC transfer");
    }
    let burn: ReturnType<typeof decodeBurnMessage>;
    try {
      burn = decodeBurnMessage(message);
    } catch {
      throw new ApiError("bad_request", "That transaction does not carry a USDC transfer");
    }
    if (burn.destinationDomain !== network.stellar.cctpDomain) {
      throw new ApiError("bad_request", `That transfer goes to CCTP domain ${burn.destinationDomain}, not to Stellar`);
    }
    // The chain acted on is the one the attested message names, and it has to be the listed chain Circle was asked under.
    if (burn.sourceDomain !== sourceDomain) {
      const asked = evmChainForDomain(network, sourceDomain);
      throw new ApiError("bad_request", `That transfer comes from CCTP domain ${burn.sourceDomain}, not from ${asked?.label ?? `domain ${sourceDomain}`}`);
    }
    const route = inboundRouteOf(message, network);
    if (await this.isNonceUsed(nonce)) return { status: "delivered", route };

    // Built here from the attested bytes: the caller of the route supplies a hash, never a transaction.
    const operation = deliverOperation({ message, attestation: attestation.attestation, caller: this.address }, network);
    try {
      const hash = await this.send(`deliver:${nonce}`, { kind: "deliver", caller }, operation, (simulation) =>
        assertOnlyCalledByRelayer(simulation, operation),
      );
      return { status: "delivered", hash, route };
    } catch (error) {
      if (error instanceof SimulationFailure) {
        if (error.diagnostic.includes(NONCE_ALREADY_USED)) return { status: "delivered", route };
        throw new ApiError("simulation_failed", `The message cannot be delivered: ${summary(error.diagnostic)}`, {
          diagnostic: trimmed(error.diagnostic),
        });
      }
      // Lost a race: someone else's delivery landed between the simulation and this transaction.
      if (error instanceof ApiError && error.code === "transaction_failed" && (await this.isNonceUsed(nonce))) {
        return { status: "delivered", route };
      }
      throw error;
    }
  }

  /** Whether the table of exits can take one more. Entries whose time is up are cleared first; none that stands is dropped. */
  private exitRoom(txHash: string): boolean {
    if (this.exits.has(txHash) || this.exits.size < MAX_EXITS) return true;
    const now = Date.now();
    for (const [key, exit] of this.exits) if (exit.until <= now) this.exits.delete(key);
    return this.exits.size < MAX_EXITS;
  }

  /** Keeps an answer for an exit while there is room. An answer that is not kept is worked out again, nothing more. */
  private rememberExit(txHash: string, exit: Exit): void {
    if (this.exitRoom(txHash)) this.exits.set(txHash, exit);
  }

  /**
   * A refusal that holds for this exit however often it is asked about,
   * remembered so that it is not worked out again. With the message, it is
   * checked against Base now and then: someone else may mint what the
   * server would not.
   */
  private refuseExit(
    txHash: string,
    code: "bad_request" | "simulation_failed",
    detail: string,
    forMs: number = DAY_MS,
    message?: Hex,
  ): ApiError {
    const refusal = new ApiError(code, detail);
    const now = Date.now();
    this.rememberExit(txHash, { kind: "refused", until: now + forMs, refusal, message, checkedAt: now });
    return refusal;
  }

  /**
   * The answer for an exit the server already knows about. A mint that was
   * sent and not seen to land is looked for; a refusal, and an exit handed
   * back for a wallet to mint, are checked against Base again from time to
   * time; nothing here ever sends.
   */
  private async knownExit(txHash: string, exit: Exit): Promise<CompleteResult> {
    if (exit.kind === "minted") return exit.result;
    if (exit.kind === "sending") return this.settleMint(txHash, exit);

    const now = Date.now();
    if (exit.message && now - exit.checkedAt >= RECHECK_MS) {
      exit.checkedAt = now;
      const destination = this.destinationOf(exit.message);
      const { publicClient } = this.evmClients(destination.name);
      const received = await isReceivedOnEvm(publicClient, exit.message, this.config.network, destination.name).catch(() => false);
      if (received) {
        const result: CompleteResult = { status: "minted" };
        this.exits.set(txHash, { kind: "minted", until: now + DAY_MS, result });
        return result;
      }
    }
    if (exit.kind === "attested") return { status: "attested", message: exit.message, attestation: exit.attestation };
    throw exit.refusal;
  }

  /**
   * What became of a mint that was sent without its outcome being seen.
   * Base is asked for the transaction and for the message's nonce. Until one
   * of them says so, the mint counts as still on its way: it is not sent
   * again.
   */
  private async settleMint(txHash: string, exit: Extract<Exit, { kind: "sending" }>): Promise<CompleteResult> {
    const { network } = this.config;
    const destination = this.destinationOf(exit.message);
    const { publicClient } = this.evmClients(destination.name);
    const now = Date.now();
    try {
      const receipt = exit.hash
        ? await publicClient.getTransactionReceipt({ hash: exit.hash }).catch(() => undefined)
        : undefined;
      if (await isReceivedOnEvm(publicClient, exit.message, network, destination.name)) {
        const result: CompleteResult =
          receipt?.status === "success" && exit.hash ? { status: "minted", hash: exit.hash } : { status: "minted" };
        this.exits.set(txHash, { kind: "minted", until: now + DAY_MS, result });
        return result;
      }
      if (receipt?.status === "reverted") throw this.failExit(txHash, exit.message);
    } catch (error) {
      if (error instanceof ApiError) throw error;
    }
    throw new ApiError("unavailable", `The mint was sent and ${destination.label} has not confirmed it yet; ask again in a moment`);
  }

  /** Records a mint that was included and reverted. It is not sent again. */
  private failExit(txHash: string, message: Hex): ApiError {
    const refusal = new ApiError(
      "simulation_failed",
      `The mint was included on ${this.destinationOf(message).label} and reverted; the server will not send it again, submit it from your own wallet`,
    );
    const now = Date.now();
    this.exits.set(txHash, { kind: "failed", until: now + DAY_MS, refusal, message, checkedAt: now });
    return refusal;
  }

  /** Counts a transaction on Base as unsettled from now until it has succeeded or failed, however long that takes. */
  private unsettled<T>(transaction: Promise<T>): Promise<T> {
    this.state.unsettled += 1;
    const settle = () => {
      this.state.unsettled -= 1;
    };
    transaction.then(settle, settle);
    return transaction;
  }

  /**
   * Refuses to pay for anything while transactions sent by code this
   * replaced may still be on their way and cannot be accounted for here.
   */
  private assertPredecessorSettled(): void {
    const { predecessor } = this.state;
    if (!predecessor) return;
    let waiting = 1;
    try {
      if (typeof predecessor.inFlight === "function") waiting = predecessor.inFlight();
    } catch {
      waiting = 1;
    }
    if (waiting > 0 && Date.now() < predecessor.until) {
      throw new ApiError("unavailable", "The relayer was restarted with transactions on their way; try again in a moment");
    }
    delete this.state.predecessor;
  }

  /**
   * The one exit through the hub that a transaction carries. A transaction
   * can carry several messages, so the one to act on is chosen by what it
   * says: burned on Stellar, for one of the EVM chains the SDK lists for the
   * network, at the request of the hub.
   */
  private hubExit(
    txHash: string,
    attestations: Attestation[],
  ): { burn: BurnMessage; attestation: Attestation; destination: EvmChainConfig } {
    const { network } = this.config;
    const { stellar } = network;
    const hub = stellar.hub ? toHex(StrKey.decodeContract(stellar.hub)) : null;
    const transfers = attestations.flatMap((attestation) => {
      try {
        // Read in one letter case, so comparing fields never depends on how the hex was written.
        return [{ burn: decodeBurnMessage(attestation.message.toLowerCase() as Hex), attestation }];
      } catch {
        return [];
      }
    });
    const onRoute = transfers.flatMap(({ burn, attestation }) => {
      const destination = burn.sourceDomain === stellar.cctpDomain ? evmChainForDomain(network, burn.destinationDomain) : undefined;
      return destination ? [{ burn, attestation, destination }] : [];
    });
    const exits = onRoute.filter(({ burn }) => burn.messageSender === hub);

    const [exit] = exits;
    if (exit && exits.length === 1) return exit;
    const [only] = transfers;
    if (exits.length > 1) {
      throw this.refuseExit(txHash, "bad_request", "That transaction carries several exits; submit their mints from your own wallet");
    }
    if (transfers.length === 0) {
      throw this.refuseExit(txHash, "bad_request", "That transaction does not carry a USDC transfer");
    }
    if (onRoute.length === 0) {
      throw this.refuseExit(
        txHash,
        "bad_request",
        only && transfers.length === 1
          ? `That transfer goes from CCTP domain ${only.burn.sourceDomain} to ${only.burn.destinationDomain}, not from Stellar to a chain the server completes exits on`
          : "That transaction carries no transfer from Stellar to a chain the server completes exits on",
      );
    }
    throw this.refuseExit(
      txHash,
      "bad_request",
      "That transfer was not sent through the hub; the server completes exits from Paso accounts only",
    );
  }

  /**
   * Why `destination` would not accept this exit, read off the message
   * alone, or `null` when nothing in it stands in the way. `payer` is the
   * server's account when the server is to submit the mint, and `null` when
   * the mint is left to a wallet. None of this can change for the exit, so a
   * reason found here is final.
   */
  private unmintable(burn: BurnMessage, payer: Address | null, destination: EvmChainConfig): string | null {
    const { stellar } = this.config.network;
    if (burn.destinationCaller !== ZERO_BYTES32) {
      if (payer === null) return "it names the one address allowed to complete it, and only that address can submit the mint";
      if (burn.destinationCaller !== pad(payer).toLowerCase()) {
        return "it names the one address allowed to complete it, and that is not this server";
      }
    }
    if (!/^0x0{24}[0-9a-f]{40}$/.test(burn.mintRecipient) || burn.mintRecipient === ZERO_BYTES32) {
      return `its recipient is not an address on ${destination.label}`;
    }
    if (burn.burnToken !== toHex(StrKey.decodeContract(stellar.usdc))) {
      return `what it burned is not the USDC that Circle mints on ${destination.label}`;
    }
    if (payer !== null && burn.amount < MIN_MINT_AMOUNT) {
      return "it is too small for the server to pay its gas";
    }
    return null;
  }

  private async completeOnce(txHash: string, caller: string): Promise<CompleteResult> {
    const { network, baseMints } = this.config;
    const { stellar } = network;

    const lookup = await this.lookUpExit(stellar.cctpDomain, txHash);
    if (lookup.state === "not_found") return { status: "pending", attestation: "not_found" };
    if (lookup.state === "pending" || lookup.state === "unreachable") return { status: "pending", attestation: "pending" };
    if (lookup.state === "malformed") {
      // Not what an exit looks like. Remembered for a while only, in case the fault was Circle's.
      throw this.refuseExit(
        txHash,
        "bad_request",
        `That transaction does not carry a USDC transfer the server can complete: ${lookup.detail}`,
        SHORT_MEMORY_MS,
      );
    }

    // From here on an exit costs work, and requests to Base: a caller gets a bounded number of looks.
    const look = this.exitChecksPerCaller.take(caller);
    if (!look.ok) {
      throw new ApiError("rate_limited", "This address has asked about too many exits; try again later", {
        retryAfterSeconds: look.retryAfterSeconds,
      });
    }

    const { burn, attestation, destination } = this.hubExit(txHash, lookup.attestations);
    const { message } = attestation;
    const { publicClient, walletClient } = this.evmClients(destination.name);
    // The server submits the mint only on Base, where it was set up to pay for one and has an account to pay from.
    // Everywhere else the exit is checked in the same way and handed back for a wallet to submit.
    const pays = baseMints.enabled && walletClient !== null && destination.name === DEFAULT_EVM_CHAIN;
    const payer = pays ? walletClient.account.address : null;
    const unreachable = () => new ApiError("unavailable", `The server could not reach ${destination.label}; try again later`);

    // Whether it has been received comes first: if it has, there is nothing left to decide.
    let block: bigint;
    let held: bigint;
    try {
      if (await isReceivedOnEvm(publicClient, message, network, destination.name)) return { status: "minted" };
      [block, held] = await Promise.all([
        publicClient.getBlockNumber(),
        payer ? publicClient.getBalance({ address: payer }) : Promise.resolve(BigInt(0)),
      ]);
    } catch {
      throw unreachable();
    }

    const reason = this.unmintable(burn, payer, destination);
    if (reason) {
      throw this.refuseExit(txHash, "simulation_failed", `The server cannot complete this exit: ${reason}`, DAY_MS, message);
    }
    if (burn.expirationBlock !== BigInt(0) && burn.expirationBlock <= block) {
      // Circle can attest an expired exit anew, which makes it a different message: not remembered for long.
      throw this.refuseExit(
        txHash,
        "simulation_failed",
        `The server cannot complete this exit: its attestation expired at block ${burn.expirationBlock} of ${destination.label}`,
        SHORT_MEMORY_MS,
        message,
      );
    }
    if (payer && held < baseMints.payerEthFloor) {
      throw new ApiError("unavailable", `The server is out of gas on ${destination.label}; submit the mint from your own wallet`);
    }

    // The exact call, simulated. What does not succeed here is not sent, and not handed to a wallet either.
    // Anyone may submit it, so without an account of the server's it is simulated as its own recipient would send it.
    const call = {
      address: destination.messageTransmitter,
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [message, attestation.attestation],
    } as const;
    let gas: bigint;
    let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined;
    try {
      gas = await publicClient.estimateContractGas({ ...call, account: payer ?? getAddress(`0x${burn.mintRecipient.slice(-40)}`) });
      fees = payer ? await publicClient.estimateFeesPerGas() : undefined;
    } catch (error) {
      const reverted = revertReason(error);
      if (reverted === undefined) throw unreachable();
      throw this.refuseExit(
        txHash,
        "simulation_failed",
        `The server cannot complete this exit: the mint would revert on ${destination.label}${reverted ? ` (${reverted})` : ""}`,
        SHORT_MEMORY_MS,
        message,
      );
    }
    if (!pays || !walletClient || !payer || !fees) {
      const now = Date.now();
      this.rememberExit(txHash, { kind: "attested", until: now + SHORT_MEMORY_MS, message, attestation: attestation.attestation, checkedAt: now });
      return { status: "attested", message, attestation: attestation.attestation };
    }
    if (gas > MINT_GAS_LIMIT) {
      throw this.refuseExit(
        txHash,
        "simulation_failed",
        "The server cannot complete this exit: its mint needs more gas than the server pays for",
        DAY_MS,
        message,
      );
    }
    if (fees.maxFeePerGas > baseMints.maxFeePerGas) {
      throw new ApiError("unavailable", `Gas on ${destination.label} costs more right now than the server pays; try again later`);
    }
    const padded = (gas * BigInt(12)) / BigInt(10);
    const gasLimit = padded > MINT_GAS_LIMIT ? MINT_GAS_LIMIT : padded;
    const mintFees = fees;

    // Only the send itself goes through the queue the account's transactions share; looking does not hold it up.
    const busy = () => new ApiError("unavailable", "The relayer is busy; try again in a moment");
    const attempt = { submitted: false };
    try {
      const sent = await this.evmQueue(async (signal) => {
        assertStillWanted(signal);
        this.assertPredecessorSettled();
        if (await isReceivedOnEvm(publicClient, message, network, destination.name)) return { alreadyReceived: true, hash: undefined };
        // Without room to write the reservation down there is no send: a mint is never on its way unrecorded.
        if (!this.exitRoom(txHash)) throw busy();
        assertStillWanted(signal);
        // Counted against the caller and against the day, and reserved for this exit, before it is sent.
        this.countMint(caller);
        const reservation: Extract<Exit, { kind: "sending" }> = { kind: "sending", until: Date.now() + DAY_MS, message };
        this.exits.set(txHash, reservation);
        attempt.submitted = true;

        const mint = this.unsettled(
          receiveMessageOnEvm({
            walletClient,
            publicClient,
            message,
            attestation: attestation.attestation,
            network,
            chain: destination.name,
            gas: gasLimit,
            maxFeePerGas: mintFees.maxFeePerGas,
            maxPriorityFeePerGas:
              mintFees.maxPriorityFeePerGas < mintFees.maxFeePerGas ? mintFees.maxPriorityFeePerGas : mintFees.maxFeePerGas,
            confirmations: MINT_CONFIRMATIONS,
            onSubmitted: (hash) => {
              reservation.hash = hash;
            },
          }),
        );
        // The reservation is settled by the transaction's own outcome, whenever that comes, and not by whether
        // anyone is still waiting for it: a known success or a known revert ends it, anything else leaves it standing.
        mint.then(
          (done) => {
            const result: CompleteResult = done.hash ? { status: "minted", hash: done.hash } : { status: "minted" };
            this.exits.set(txHash, { kind: "minted", until: Date.now() + DAY_MS, result });
          },
          (error: unknown) => {
            if (error instanceof TransactionRevertedError) this.failExit(txHash, message);
          },
        );
        return mint;
      });
      return sent.hash ? { status: "minted", hash: sent.hash } : { status: "minted" };
    } catch (error) {
      if (!attempt.submitted) {
        if (error instanceof ApiError) throw error;
        if (error instanceof QueueFullError) throw busy();
        if (error instanceof QueueTimeoutError) {
          throw new ApiError("unavailable", "The network took too long to answer; try again in a moment");
        }
        throw unreachable();
      }
      const now = this.exits.get(txHash);
      if (now?.kind === "failed") throw now.refusal;
      // Sent, or possibly sent, with no outcome to show for it: it stays reserved, and is not sent again.
      if (!(error instanceof QueueTimeoutError)) {
        // The cause stays in the log: a transport error can quote the endpoint it failed to reach.
        console.error("Mint on Base unconfirmed:", error instanceof Error ? error.name : "unknown error");
      }
      throw new ApiError("unavailable", `The mint was sent and ${destination.label} has not confirmed it yet; ask again in a moment`);
    }
  }

  /** Counts one mint against its caller and against the day, or refuses when either has none left. Never given back. */
  private countMint(caller: string): void {
    const perCaller = this.mintsPerCaller.check(caller);
    if (!perCaller.ok) {
      throw new ApiError("rate_limited", "This address has had the server pay for too many mints; try again later", {
        retryAfterSeconds: perCaller.retryAfterSeconds,
      });
    }
    const overall = this.mintsOverall.check(EVERYONE);
    if (!overall.ok) {
      throw new ApiError("unavailable", "The server has paid for all the mints it pays for in a day; try again later", {
        retryAfterSeconds: overall.retryAfterSeconds,
      });
    }
    const counted = [this.mintsPerCaller.take(caller), this.mintsOverall.take(EVERYONE)];
    if (!counted.every((allowance) => allowance.ok)) {
      throw new ApiError("unavailable", "The server cannot pay for a mint right now; try again later");
    }
  }

  /**
   * Asks Circle's attestation service for everything a transaction carries,
   * once, within bounds on time and on the size and shape of the answer.
   */
  private async lookUpExit(sourceDomain: number, txHash: string) {
    const patience = new AbortController();
    const timer = setTimeout(() => patience.abort(), IRIS_TIMEOUT_MS);
    return fetchAttestations(sourceDomain, txHash, this.config.network, {
      signal: patience.signal,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      maxAttestationBytes: MAX_ATTESTATION_BYTES,
    })
      .catch(() => ({ state: "unreachable" as const, detail: "no answer in time" }))
      .finally(() => clearTimeout(timer));
  }

  /**
   * Asks Circle's attestation service about a burn, once, and gives it a
   * bounded time to answer. No answer in time reads as an outage: ask again.
   */
  private async lookUp(sourceDomain: number, txHash: string) {
    const patience = new AbortController();
    const timer = setTimeout(() => patience.abort(), IRIS_TIMEOUT_MS);
    return fetchAttestation(sourceDomain, txHash, this.config.network, { signal: patience.signal })
      .catch(() => ({ status: { state: "unreachable" as const }, attestation: undefined }))
      .finally(() => clearTimeout(timer));
  }

  private async isNonceUsed(nonce: Hex): Promise<boolean> {
    const { network } = this.config;
    const used = await readContract(
      network.stellar.messageTransmitter,
      "is_nonce_used",
      [xdr.ScVal.scvBytes(hexToBytes(nonce))],
      network,
      this.server,
    );
    return used.type === "scvBool" && used.b;
  }

  /**
   * Clients for one EVM chain of the network, Base unless another is named.
   * Base is reached through the configured endpoint, every other chain
   * through the public endpoints the SDK lists for it. The server's account
   * sends on Base and nowhere else, so only Base has a wallet client.
   */
  private evmClients(name: EvmChainName = DEFAULT_EVM_CHAIN) {
    const { network, payer, evmRpcUrl } = this.config;
    const { chain, rpcUrls } = evmChain(network, name);
    const options = { timeout: EVM_TIMEOUT_MS, retryCount: 1 };
    const base = name === DEFAULT_EVM_CHAIN;
    const transport = base ? http(evmRpcUrl, options) : fallback(rpcUrls.map((url) => http(url, options)));
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: payer && base ? createWalletClient({ account: payer, chain, transport }) : null,
    };
  }

  /** The chain an exit message is for. A message for a chain the network does not list is read as Base's, which refuses it. */
  private destinationOf(message: Hex): EvmChainConfig {
    const { network } = this.config;
    try {
      return evmChainForDomain(network, decodeBurnMessage(message).destinationDomain) ?? evmChain(network);
    } catch {
      return evmChain(network);
    }
  }

  /**
   * Refuses while the payer could not make a payout: it must hold the amount
   * on top of the reserve it keeps, and gas to send it. Reads only.
   */
  private async assertFaucetFunded(payer: Address): Promise<void> {
    const { network, demoFund } = this.config;
    const { chain, usdc } = network.evm;
    const { publicClient } = this.evmClients();

    let held: bigint;
    let gas: bigint;
    try {
      [held, gas] = await Promise.all([
        publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
        publicClient.getBalance({ address: payer }),
      ]);
    } catch {
      throw new ApiError("unavailable", `The demo faucet could not reach ${chain.name}; try again later`);
    }
    if (held < DEMO_FUND_AMOUNT + demoFund.payerFloor) {
      throw new ApiError("unavailable", `The demo faucet is out of test USDC on ${chain.name}`);
    }
    if (gas === BigInt(0)) {
      throw new ApiError("unavailable", `The demo faucet is out of gas on ${chain.name}`);
    }
  }

  private async burnForDemo(owner: Address, payer: Address, signal: AbortSignal): Promise<DemoFundResult> {
    const { network } = this.config;
    const { chain, usdc, tokenMessenger, cctpDomain } = network.evm;
    const { publicClient, walletClient } = this.evmClients();
    if (!walletClient) {
      throw new ApiError("unavailable", "The demo faucet has no payer configured");
    }
    // Asked again now that it is this request's turn: earlier payouts may have used what was there.
    await this.assertFaucetFunded(payer);

    const allowance = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [payer, tokenMessenger],
    });
    if (allowance < DEMO_FUND_AMOUNT) {
      assertStillWanted(signal);
      const approval = await walletClient.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [tokenMessenger, STANDING_ALLOWANCE],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approval, timeout: BURN_TIMEOUT_MS });
      if (receipt.status !== "success") {
        throw new ApiError("unavailable", `The demo faucet could not approve USDC on ${chain.name}`);
      }
    }

    assertStillWanted(signal);
    const { burnTxHash, twin } = await fundFromEvm({
      walletClient,
      publicClient,
      amount: DEMO_FUND_AMOUNT,
      owner,
      network,
    });
    return { burnTxHash, sourceDomain: cctpDomain, twin, amount: DEMO_FUND_AMOUNT.toString() };
  }

  /** A transaction of one operation that bids `bid` stroops to be included, on top of the resource fee simulation adds. */
  private transaction(source: Account, operation: xdr.Operation, bid: bigint = this.config.inclusionFee) {
    return new TransactionBuilder(source, {
      fee: bid.toString(),
      networkPassphrase: this.config.network.stellar.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
      .build();
  }

  /** Runs a task in a queue, turning a full queue or an abandoned task into a refusal the caller can act on. */
  private async queued<T>(queue: Queue, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await queue(task);
    } catch (error) {
      if (error instanceof QueueFullError) {
        throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
      }
      if (error instanceof QueueTimeoutError) {
        throw new ApiError("unavailable", "The network took too long to answer; try again in a moment");
      }
      throw error;
    }
  }

  /**
   * The one place a transaction of the relayer account is priced, whatever
   * it is for: a relayed call, a deployment, a delivery.
   *
   * Its resource fee must fit the cap per transaction, and its whole fee
   * must fit what is left of the day's budget, where it is set aside before
   * the transaction is signed. Both are read off the transaction about to be
   * signed, which is what the network will charge against, as well as off
   * the simulation. Nothing is given back when a transaction fails or is not
   * taken: the budget may overstate what was spent, never understate it.
   * Returns what this transaction has set aside so far, so a rebuilt
   * transaction, or one sent in place of one that can no longer be applied,
   * only adds the difference.
   */
  private setAsideFee(simulation: Simulated, fee: string, bid: bigint, setAside: bigint): bigint {
    const { maxResourceFee } = this.config;
    const total = BigInt(fee);
    const simulated = BigInt(simulation.minResourceFee);
    const carried = total - bid;
    const resourceFee = carried > simulated ? carried : simulated;
    if (resourceFee > maxResourceFee) {
      throw new ApiError(
        "simulation_failed",
        `This transaction would cost ${resourceFee} stroops in resource fees; the relayer pays for transactions up to ` +
          `${maxResourceFee} stroops (${formatAmount(maxResourceFee, 7)} XLM)`,
      );
    }
    if (total <= setAside) return setAside;
    if (!this.fees.spend(total - setAside)) {
      throw new ApiError("unavailable", "The relayer has used up what it spends on fees in a day; try again later", {
        reason: "daily_budget",
      });
    }
    return total;
  }

  /**
   * Counts one transaction against its caller and against the hour, or
   * refuses when either has none left. Both are looked at before either is
   * counted, and what is counted is never given back, whatever becomes of
   * the transaction: failing is not a way to earn another try.
   */
  private countSpend(kind: SpendKind, caller: string): void {
    const { perCaller, overall } = this.spending[kind];
    const { perCallerPerHour, perHour } = this.config.spend[kind];
    const { name } = this.config.network;
    const what = SPEND_WORDS[kind];

    const mine = perCaller.check(caller);
    if (!mine.ok) {
      throw new ApiError("rate_limited", `The relayer pays for ${perCallerPerHour} ${what} an hour from one address on ${name}; try again later`, {
        retryAfterSeconds: mine.retryAfterSeconds,
      });
    }
    const everyone = overall.check(EVERYONE);
    if (!everyone.ok) {
      throw new ApiError("unavailable", `The relayer has paid for the ${perHour} ${what} it pays for in an hour on ${name}; try again later`, {
        retryAfterSeconds: everyone.retryAfterSeconds,
        reason: "hourly_limit",
      });
    }
    const counted = [perCaller.take(caller), overall.take(EVERYONE)];
    if (!counted.every((allowance) => allowance.ok)) {
      throw new ApiError("unavailable", "The relayer cannot pay for this right now; try again later");
    }
  }

  /**
   * Refuses to sign anything that could take the relayer account below what
   * it keeps, so that it never runs down to the reserve the network holds
   * back. The balance is read right before the transaction is signed; one
   * that cannot be read counts as too low.
   */
  private async assertAboveFloor(fee: bigint): Promise<void> {
    const { minBalance } = this.config;
    if (minBalance === BigInt(0)) return;

    let held: bigint;
    try {
      held = BigInt((await this.server.getAccountEntry(this.address)).balance.toString());
    } catch {
      throw new ApiError("unavailable", "The relayer could not read what its account holds; try again in a moment");
    }
    if (held - fee < minBalance) {
      throw new ApiError(
        "unavailable",
        `The relayer's account is down to the ${formatAmount(minBalance, 7)} XLM it keeps in reserve; it pays no fees until it is topped up`,
        { reason: "low_balance" },
      );
    }
  }

  /**
   * What became of the transaction that was handed to the network under
   * `key`: its hash when it was applied, nothing when there is none on
   * record, and the record itself when the transaction can no longer be
   * applied, so that the next one bids higher. While it may still land, the
   * answer is a refusal: the same thing is not sent twice.
   *
   * A transaction that is in no ledger is given up only when the network
   * says its time has passed. Until then, however long this server has been
   * waiting, it counts as on its way.
   */
  private async settleSend(key: string): Promise<{ hash: string } | { expired: PendingSend } | undefined> {
    let pending = this.sends.get(key);
    if (!pending) return undefined;

    if (!pending.expired) {
      let seen: rpc.Api.GetTransactionResponse;
      try {
        seen = await this.server.getTransaction(pending.hash);
      } catch {
        throw new ApiError(
          "unavailable",
          `Transaction ${pending.hash} is on its way and the network cannot be asked about it; try again in a moment`,
          { hash: pending.hash, sent: true, retryAfterSeconds: ON_ITS_WAY_RETRY_SECONDS },
        );
      }
      const fate = fateOf(seen, pending.deadline);
      if (fate === "applied") {
        this.sends.delete(key);
        return { hash: pending.hash };
      }
      if (fate === "failed") {
        this.sends.delete(key);
        throw new ApiError("transaction_failed", `Transaction ${pending.hash} was included and failed`, { hash: pending.hash });
      }
      if (fate === "unknown") {
        throw new ApiError("unavailable", `Transaction ${pending.hash} is on its way; ask again in a moment`, {
          hash: pending.hash,
          sent: true,
          retryAfterSeconds: ON_ITS_WAY_RETRY_SECONDS,
        });
      }
      pending = this.expire(key, pending);
    }

    if (pending.pausedUntil === undefined) return { expired: pending };
    if (Date.now() < pending.pausedUntil) throw leftOut(pending);
    this.sends.delete(key);
    return undefined;
  }

  /**
   * Puts on record that a transaction can no longer be applied. What follows
   * is another one with a higher bid, or, when this was the last one
   * allowed, a pause.
   */
  private expire(key: string, pending: PendingSend): PendingSend {
    const expired: PendingSend = {
      ...pending,
      expired: true,
      ...(pending.submissions >= MAX_SUBMISSIONS ? { pausedUntil: Date.now() + RESEND_PAUSE_MS } : {}),
    };
    this.sends.set(key, expired);
    return expired;
  }

  /** Refuses new sends while the table of transactions on their way is full of ones that still stand. */
  private assertSendRoom(key: string): void {
    if (this.sends.has(key) || this.sends.size < MAX_PENDING_SENDS) return;
    const now = Date.now();
    for (const [other, send] of this.sends) {
      if (now > (send.pausedUntil ?? send.deadline + SEND_DEADLINE_MARGIN_MS)) this.sends.delete(other);
    }
    if (this.sends.size >= MAX_PENDING_SENDS) {
      throw new ApiError("unavailable", "The relayer is waiting on too many transactions; try again in a moment");
    }
  }

  /**
   * Sends one operation in a transaction of the relayer account and waits
   * for it to be applied.
   *
   * Everything from reading the sequence number to the confirmation happens
   * inside the queue, one transaction at a time. The operation is simulated
   * there with the ledger as it is at that moment, `inspect` gets a say on
   * that simulation, and before anything is signed the fee is checked
   * against the cap, against what the account must keep, and set aside from
   * the day's budget. A transaction refused for a stale sequence number,
   * which happens when another server instance used the account in between,
   * is rebuilt and sent once more.
   *
   * `key` names what is being sent, and `spend` whose allowance it counts
   * against. The transaction is recorded under the key before it goes out
   * and the record is cleared only by a known outcome: applied, failed, or
   * refused by the network. When the outcome is not learned, because the
   * network stopped answering or the wait ran out, the record stands, and
   * nothing is sent under the same key until the first transaction has been
   * seen or the network says it can no longer be applied.
   *
   * A transaction is valid for half a minute and is watched to the end of
   * it. One that no ledger took in that time is dead for certain; the next
   * request for the same thing sends another that bids twice as much, up to
   * a fixed number of times. It is the same payment made again, so it is
   * counted against its caller once.
   */
  private send(
    key: string,
    spend: { kind: SpendKind; caller: string },
    operation: xdr.Operation,
    inspect: (simulation: Simulated) => void,
  ): Promise<string> {
    return this.queued(this.queue, async (signal) => {
      assertStillWanted(signal);
      this.assertPredecessorSettled();
      const earlier = await this.settleSend(key);
      if (earlier && "hash" in earlier) return earlier.hash;
      const leftOutBefore = earlier?.expired;
      this.assertSendRoom(key);
      if (!leftOutBefore) this.countSpend(spend.kind, spend.caller);

      const bid = leftOutBefore ? leftOutBefore.bid * BigInt(2) : this.config.inclusionFee;
      const submissions = (leftOutBefore?.submissions ?? 0) + 1;
      let setAside = leftOutBefore?.setAside ?? BigInt(0);
      let staleSequences = 0;
      let busy = 0;
      for (;;) {
        assertStillWanted(signal);
        this.assertSendRoom(key);
        const account = await this.server.getAccount(this.address);
        const tx = this.transaction(account, operation, bid);

        const simulation = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simulation)) {
          throw new SimulationFailure(simulation.error, simulation.latestLedger);
        }
        if (rpc.Api.isSimulationRestore(simulation)) {
          throw new SimulationFailure(
            "ledger entries this call needs are archived and have to be restored first",
            simulation.latestLedger,
          );
        }
        inspect(simulation);

        const ready = rpc.assembleTransaction(tx, simulation).build();
        await this.assertAboveFloor(BigInt(ready.fee));
        // The queue may have given up on this transaction while the network was answering.
        assertStillWanted(signal);
        setAside = this.setAsideFee(simulation, ready.fee, bid, setAside);
        ready.sign(this.config.relayer);
        const hash = Buffer.from(ready.hash()).toString("hex");
        const maxTime = Number(ready.timeBounds?.maxTime ?? 0) * 1000;
        const pending: PendingSend = {
          hash,
          deadline: maxTime || Date.now() + TRANSACTION_TIMEOUT_SECONDS * 1000,
          submissions,
          bid,
          setAside,
        };
        this.sends.set(key, pending);

        let sent: rpc.Api.SendTransactionResponse;
        try {
          sent = await this.server.sendTransaction(ready);
        } catch {
          // No answer is not a no: the transaction may have been taken.
          throw new ApiError(
            "unavailable",
            `Transaction ${hash} was sent and the network did not say whether it took it; ask again in a moment`,
            { hash, sent: true, retryAfterSeconds: ON_ITS_WAY_RETRY_SECONDS },
          );
        }

        if (sent.status === "TRY_AGAIN_LATER" || sent.status === "ERROR") {
          // Not taken: nothing is on its way. One the network left out before stays on record, so the next bid keeps its place.
          if (leftOutBefore) this.sends.set(key, leftOutBefore);
          else this.sends.delete(key);
          if (sent.status === "TRY_AGAIN_LATER") {
            if (busy < BUSY_RETRIES) {
              busy += 1;
              await sleep(BUSY_WAIT_MS);
              continue;
            }
            throw new ApiError("unavailable", "The network is busy; try again in a moment");
          }
          const reason = sent.errorResult?.result.type ?? "unknown";
          if (reason === "txBadSeq" && staleSequences === 0) {
            staleSequences += 1;
            continue;
          }
          throw new ApiError("unavailable", `The network did not take the transaction (${reason})`);
        }

        let seen: rpc.Api.GetTransactionResponse | undefined;
        try {
          seen = await this.server.pollTransaction(hash, {
            attempts: CONFIRMATION_ATTEMPTS,
            sleepStrategy: rpc.BasicSleepStrategy,
          });
        } catch {
          seen = undefined;
        }
        const fate = seen ? fateOf(seen, pending.deadline) : "unknown";
        if (fate === "applied") {
          this.sends.delete(key);
          return hash;
        }
        if (fate === "failed") {
          this.sends.delete(key);
          throw new ApiError("transaction_failed", `Transaction ${hash} was included and failed`, { hash });
        }
        if (fate === "expired") throw leftOut(this.expire(key, pending));
        throw new ApiError("unavailable", `Transaction ${hash} was sent and has not been confirmed yet; ask again in a moment`, {
          hash,
          sent: true,
          retryAfterSeconds: ON_ITS_WAY_RETRY_SECONDS,
        });
      }
    });
  }
}

/**
 * Why a simulated call reverted: the contract's own words when it gave any,}

/**
 * Why a simulated call reverted: the contract's own words when it gave any,
 * `null` when it reverted without, and `undefined` when the failure was not a
 * revert at all but the network not answering. Only letters, digits and
 * plain punctuation of the reason are kept.
 */
function revertReason(error: unknown): string | null | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const reason = (revert.reason ?? "").replace(/[^A-Za-z0-9 _.,:'-]/g, "").trim().slice(0, 80);
    return reason || null;
  }
  return /execution reverted/i.test(error.shortMessage) ? null : undefined;
}

/**
 * What a relayed call is known by: the hash of its signed authorisation
 * entry, byte for byte, together with the function it is submitted with. Two
 * requests share a key exactly when they ask for the same thing.
 */
function relayKey(func: xdr.HostFunction, entry: xdr.SorobanAuthorizationEntry): string {
  const hash = createHash("sha256");
  hash.update(entry.toXdr());
  hash.update(func.toXdr());
  return `relay:${hash.digest("hex")}`;
}

/** Whether a transaction carries exactly this authorisation entry. */
function carries(envelope: xdr.TransactionEnvelope, entry: string): boolean {
  const operations =
    envelope.type === "envelopeTypeTx"
      ? envelope.v1.tx.operations
      : envelope.type === "envelopeTypeTxFeeBump"
        ? envelope.feeBump.tx.innerTx.v1.tx.operations
        : [];
  return operations.some(
    ({ body }) =>
      body.type === "invokeHostFunction" && body.invokeHostFunctionOp.auth.some((carried) => carried.toXdr("base64") === entry),
  );
}

/** Stops a queued task the queue has stopped waiting for, before it starts anything new. */
function assertStillWanted(signal: AbortSignal): void {
  if (signal.aborted) throw new QueueTimeoutError();
}

/** For a relayed call: the simulation must report no authorisation beyond the entry the owner signed. */
function assertNothingElseAuthorised(simulation: Simulated, entry: xdr.SorobanAuthorizationEntry): void {
  const supplied = entry.toXdr("base64");
  if ((simulation.result?.auth ?? []).some((reported) => reported.toXdr("base64") !== supplied)) {
    throw new ApiError("simulation_failed", "The call needs an authorisation the request does not carry");
  }
}

/** For operations the relayer builds itself and that nobody has to authorise, such as deploying an account. */
function assertNoAuthorisation(simulation: Simulated): void {
  if ((simulation.result?.auth ?? []).length > 0) {
    throw new ApiError("unavailable", "The operation unexpectedly asks for an authorisation; it was not sent");
  }
}

/**
 * For delivering a CCTP message. Circle's MessageTransmitter asks its caller
 * to authorise the call when the relayer calls it directly; that one
 * authorisation, for exactly the call being made and nothing nested under
 * it, is all the relayer account ever gives.
 */
function assertOnlyCalledByRelayer(simulation: Simulated, operation: xdr.Operation): void {
  const recorded = simulation.result?.auth ?? [];
  if (recorded.length === 0) return;

  const { body } = operation;
  const func = body.type === "invokeHostFunction" ? body.invokeHostFunctionOp.hostFunction : undefined;
  const call = func?.type === "hostFunctionTypeInvokeContract" ? func.invokeContract.toXdr("base64") : undefined;
  const [entry] = recorded;
  const authorised = entry?.rootInvocation.function;
  const isTheCallItself =
    recorded.length === 1 &&
    entry?.credentials.type === "sorobanCredentialsSourceAccount" &&
    entry.rootInvocation.subInvocations.length === 0 &&
    authorised?.type === "sorobanAuthorizedFunctionTypeContractFn" &&
    authorised.contractFn.toXdr("base64") === call;
  if (!isTheCallItself) {
    throw new ApiError("simulation_failed", "Delivering this message asks for more than a call to Circle's contracts");
  }
}

const globalForRelayer = globalThis as typeof globalThis & {
  pasoRelayers?: Partial<Record<NetworkName, Relayer>>;
  pasoRelayerStates?: Partial<Record<NetworkName, unknown>>;
  /** What code from before each network had a state of its own left behind: one state, for whichever network it worked on. */
  pasoRelayerState?: unknown;
};

/**
 * The state the relayer of a network works with in this process: the one
 * already there when it is of this code's making, a new one otherwise. A
 * state this code cannot read is not thrown away unseen. It becomes the
 * predecessor of the new one, which pays for nothing until the old one's
 * transactions are done.
 */
function processState(config: ServerConfig): RelayerState {
  const { name } = config.network;
  const states = (globalForRelayer.pasoRelayerStates ??= {});
  const own = states[name] as Partial<RelayerState> | undefined;
  if (own && own.version === STATE_VERSION) return own as RelayerState;
  const existing = own ?? (globalForRelayer.pasoRelayerState as Partial<RelayerState> | undefined);

  const state = createRelayerState(config);
  if (existing) {
    const inFlight = typeof existing.inFlight === "function" ? existing.inFlight.bind(existing) : undefined;
    state.predecessor = { inFlight, until: Date.now() + (inFlight ? HOUR_MS : PREDECESSOR_GRACE_MS) };
  }
  states[name] = state;
  return state;
}

/**
 * The relayer of this server process for a network, created from the
 * environment on first use. One instance per network and process keeps one
 * queue per account and one set of counts. Without a network it is the one
 * a request means when it names none.
 *
 * A network this server was not set up for has no relayer: asking for it is
 * declined in so many words, and nothing of it is loaded.
 *
 * While developing, an edit replaces this module, and an instance made from
 * the module it replaced would go on running the old code: it is recognised
 * by its class and made anew. Its state is not: the new instance takes over
 * the counts, the budget and the transactions on their way.
 */
export function getRelayer(network: NetworkName = defaultNetwork()): Relayer {
  if (!serves(network)) {
    throw new ApiError("unavailable", `This server is not serving ${network} right now`, { reason: "not_serving" });
  }
  const relayers = (globalForRelayer.pasoRelayers ??= {});
  const existing = relayers[network];
  const usable = process.env.NODE_ENV === "production" ? existing !== undefined : existing instanceof Relayer;
  if (existing && usable) return existing;

  const config = loadConfig(process.env, network);
  const relayer = new Relayer(config, processState(config));
  relayers[network] = relayer;
  return relayer;
}

/** What one network's relayer reports, or that this server does not work on that network. */
export type NetworkHealth = ({ enabled: true } & Awaited<ReturnType<Relayer["health"]>>) | { enabled: false };

export interface ServerHealth {
  /** True when every network this server works on answered in full. */
  ok: boolean;
  /** The network a request means when it names none. */
  default: NetworkName;
  networks: Record<NetworkName, NetworkHealth>;
}

/**
 * What the server reports about itself: each network on its own, served or
 * not. A network whose settings cannot be read is reported as not served,
 * and the reason goes to the log.
 */
export async function serverHealth(): Promise<ServerHealth> {
  const report = async (name: NetworkName): Promise<NetworkHealth> => {
    if (!serves(name)) return { enabled: false };
    try {
      return { enabled: true, ...(await getRelayer(name).health()) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      console.error("Configuration:", error.message);
      return { enabled: false };
    }
  };
  const [testnet, mainnet] = await Promise.all(networkNames().map(report));
  const networks = { testnet: testnet!, mainnet: mainnet! };
  const served = Object.values(networks).filter((network) => network.enabled);
  return {
    ok: served.length > 0 && served.every((network) => network.enabled && network.ok),
    default: defaultNetwork(),
    networks,
  };
}
