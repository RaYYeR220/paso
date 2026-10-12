import {
  assertOnlyAccountEntries,
  decodeBurnMessage,
  deliverOperation,
  deployOperation,
  erc20Abi,
  fetchAttestation,
  formatAmount,
  formatEvmAmount,
  fundFromEvm,
  inboundRouteOf,
  isReceivedOnEvm,
  isDeployed,
  isExpired,
  readContract,
  receiveMessageOnEvm,
  signedFromRelayRequest,
  simulateSigned,
  SimulationError,
  twinAddress,
  type InboundRoute,
  type RelayResult,
  type Signed,
} from "@paso/sdk";
import { Account, Operation, rpc, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { loadConfig, type ServerConfig } from "./config";
import { ApiError } from "./errors";
import { createQueue, QueueFullError, QueueTimeoutError, type Queue } from "./queue";
import { createBudget, createLimiter, type Budget, type Limiter } from "./ratelimit";

/** What the network offers above the resource fee to be included in a ledger, in stroops. */
const INCLUSION_FEE = "1000";
const TRANSACTION_TIMEOUT_SECONDS = 60;
const CONFIRMATION_ATTEMPTS = 30;
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
const MAX_DOMAIN = 0xffff_ffff;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_ATTESTATION_BYTES = 2_048;
const MAX_DIAGNOSTIC_CHARS = 4_000;
const REMEMBERED_DELIVERIES = 1_000;

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
 * The fee-paying side of Paso.
 *
 * It wraps calls signed by account owners in its own transactions, deploys
 * accounts, delivers attested CCTP messages and, on testnet, runs a small
 * USDC faucet. Its Stellar account pays fees and does nothing else: no
 * request can make it authorise a call, and it cannot change a signed one.
 */
export class Relayer {
  readonly address: string;
  private readonly server: rpc.Server;
  private readonly queue: Queue = createQueue({ maxPending: MAX_QUEUED_TRANSACTIONS, timeoutMs: SEND_TIMEOUT_MS });
  private readonly evmQueue: Queue = createQueue({ maxPending: MAX_QUEUED_BURNS, timeoutMs: BURN_TIMEOUT_MS });
  private readonly deployments = new Map<string, Promise<string | undefined>>();
  private readonly deliveries = new Map<string, Promise<DeliverResult>>();
  private readonly delivered = new Map<string, DeliverResult>();
  private readonly completions = new Map<string, Promise<CompleteResult>>();
  private readonly completed = new Map<string, CompleteResult>();
  private readonly mintsPerCaller: Limiter;
  private readonly mintsOverall: Limiter;
  /** Fees of the relayer account over the last day, counted when a transaction is signed. */
  private readonly fees: Budget;
  private readonly fundsPerCaller: Limiter;
  private readonly fundsPerOwner: Limiter;
  private readonly fundsOverall: Limiter;
  private healthReport?: { until: number; report: ReturnType<Relayer["readHealth"]> };

  constructor(readonly config: ServerConfig) {
    this.address = config.relayer.publicKey();
    this.server = new rpc.Server(config.network.stellar.rpcUrl, { timeout: RPC_TIMEOUT_MS });
    this.fees = createBudget({ limit: config.maxDailyFees, windowMs: DAY_MS });
    this.fundsPerCaller = createLimiter({ limit: config.demoFund.perIpPerHour, windowMs: HOUR_MS });
    this.fundsPerOwner = createLimiter({ limit: config.demoFund.perOwnerPerDay, windowMs: DAY_MS });
    this.fundsOverall = createLimiter({ limit: config.demoFund.perDay, windowMs: DAY_MS, maxKeys: 1 });
    this.mintsPerCaller = createLimiter({ limit: config.baseMints.perCallerPerHour, windowMs: HOUR_MS });
    this.mintsOverall = createLimiter({ limit: config.baseMints.perDay, windowMs: DAY_MS, maxKeys: 1 });
  }

  /**
   * Relays one call signed by the owner of an account.
   *
   * The request is refused unless it is a contract call carrying exactly one
   * authorisation entry, for the account derived from `owner`, that the
   * account contract accepts for exactly this call. The owner's account is
   * deployed first when it does not exist yet.
   */
  async relay(body: unknown): Promise<RelayResult> {
    const { signed, func, entry } = this.readRelayRequest(body);

    const { sequence } = await this.server.getLatestLedger();
    if (isExpired(signed, sequence)) {
      throw new ApiError(
        "expired",
        `The signature was valid up to ledger ${signed.validUntilLedger} and the network is at ${sequence}; prepare and sign again`,
      );
    }

    const deployHash = await this.ensureDeployed(signed.owner);
    await this.assertAccepted(signed, func, entry);

    const operation = Operation.invokeHostFunction({ func, auth: [entry] });
    try {
      const hash = await this.send(operation, (simulation) => assertNothingElseAuthorised(simulation, entry));
      return deployHash ? { hash, deployHash } : { hash };
    } catch (error) {
      if (error instanceof SimulationFailure) {
        throw refusal(error.diagnostic, isExpired(signed, error.latestLedger));
      }
      throw error;
    }
  }

  /** Deploys the account of an Ethereum address. Doing it twice changes nothing. */
  async deploy(body: unknown): Promise<DeployResult> {
    const owner = this.readOwner(body);
    const address = twinAddress(owner, this.config.network);
    const hash = await this.ensureDeployed(owner);
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
   */
  async deliver(body: unknown): Promise<DeliverResult> {
    const { sourceDomain, txHash } = this.readBurn(body);
    const key = `${sourceDomain}:${txHash.toLowerCase()}`;

    const known = this.delivered.get(key);
    if (known) return known;
    const running = this.deliveries.get(key);
    if (running) return running;
    if (this.deliveries.size >= MAX_IN_FLIGHT) {
      throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
    }

    const delivery = this.deliverOnce(sourceDomain, txHash).finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    const result = await delivery;
    if (result.status === "delivered") {
      if (this.delivered.size >= REMEMBERED_DELIVERIES) {
        const oldest = this.delivered.keys().next();
        if (!oldest.done) this.delivered.delete(oldest.value);
      }
      this.delivered.set(key, result);
    }
    return result;
  }

  /**
   * Finishes a transfer back to Base: looks the exit up at Circle's
   * attestation service, once, and when it is attested has the server's
   * account on Base hand the message to Circle's MessageTransmitter, which
   * mints the USDC to the recipient the message names.
   *
   * The server pays the gas and decides nothing else. The call is built from
   * what Circle returned for the transaction, never from bytes a caller
   * sent, and only for an exit made through the hub, from Stellar to Base. A
   * message that has been received already counts as minted. How many mints
   * the server pays for is limited per caller and per day; an attempt counts
   * once it starts, whatever becomes of it.
   */
  async complete(body: unknown, caller: string): Promise<CompleteResult> {
    const txHash = this.readExit(body);
    const { baseMints, payer } = this.config;
    if (!baseMints.enabled) {
      throw new ApiError(
        "not_found",
        "This server does not pay for mints on Base on this network; submit the mint from your own wallet",
      );
    }
    if (!payer) {
      throw new ApiError("unavailable", "The server has no account on Base to submit the mint from");
    }

    const known = this.completed.get(txHash);
    if (known) return known;
    const running = this.completions.get(txHash);
    if (running) return running;
    if (this.completions.size >= MAX_IN_FLIGHT) {
      throw new ApiError("unavailable", "The relayer is busy; try again in a moment");
    }

    const completion = this.completeOnce(txHash, caller).finally(() => this.completions.delete(txHash));
    this.completions.set(txHash, completion);
    const result = await completion;
    if (result.status === "minted") {
      if (this.completed.size >= REMEMBERED_DELIVERIES) {
        const oldest = this.completed.keys().next();
        if (!oldest.done) this.completed.delete(oldest.value);
      }
      this.completed.set(txHash, result);
    }
    return result;
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
      return await this.queued(this.evmQueue, (signal) => this.burnForDemo(owner, payer.address, signal));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The cause stays in the log: a transport error can quote the endpoint it failed to reach.
      console.error("Faucet burn failed:", error instanceof Error ? error.name : "unknown error");
      throw new ApiError("unavailable", `The demo faucet could not send USDC on ${network.evm.chain.name}; try again later`);
    }
  }

  /**
   * What the server runs on and what its accounts hold. Addresses and
   * balances only, all of them public on their chains. The answer is kept
   * for a few seconds, so asking often does not turn into as many requests
   * to the networks.
   */
  health(): ReturnType<Relayer["readHealth"]> {
    const now = Date.now();
    if (!this.healthReport || this.healthReport.until <= now) {
      this.healthReport = { until: now + HEALTH_CACHE_MS, report: this.readHealth() };
    }
    return this.healthReport.report;
  }

  private async readHealth() {
    const { network, payer, maxResourceFee } = this.config;
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

    const xlm = value(relayerEntry);
    const usdcHeld = value(payerUsdc);
    const ethHeld = value(payerEth);
    return {
      ok: [ledger, relayerEntry, payerUsdc, payerEth].every((settled) => settled.status === "fulfilled"),
      network: network.name,
      hub: network.stellar.hub,
      latestLedger: value(ledger)?.sequence ?? null,
      relayer: {
        address: this.address,
        xlm: xlm ? formatAmount(BigInt(xlm.balance.toString()), 7) : null,
      },
      payer: payer
        ? {
            address: payer.address,
            chain: network.evm.chain.name,
            usdc: usdcHeld === null ? null : formatEvmAmount(usdcHeld),
            eth: ethHeld === null ? null : formatEther(ethHeld),
          }
        : null,
      /** The most a relayed call may cost in resource fees, in stroops. */
      maxResourceFee: maxResourceFee.toString(),
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

  private readBurn(body: unknown): { sourceDomain: number; txHash: Hex } {
    if (!isRecord(body)) {
      throw new ApiError("bad_request", "Expected a JSON object with network, sourceDomain and txHash");
    }
    this.assertNetwork(body.network, true);
    const { sourceDomain, txHash } = body;
    const { cctpDomain } = this.config.network.stellar;
    const domain = Number.isInteger(sourceDomain) ? (sourceDomain as number) : -1;
    if (domain < 0 || domain > MAX_DOMAIN || domain === cctpDomain) {
      throw new ApiError("bad_request", "sourceDomain must be the CCTP domain of the chain the USDC was burned on");
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ApiError("bad_request", "txHash must be the hash of the burn transaction (0x and 64 hex digits)");
    }
    return { sourceDomain: domain, txHash: txHash as Hex };
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
  private ensureDeployed(owner: Address): Promise<string | undefined> {
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
        return await this.send(deployOperation(owner, network), assertNoAuthorisation);
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

  private async deliverOnce(sourceDomain: number, txHash: Hex): Promise<DeliverResult> {
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
    const route = inboundRouteOf(message, network);
    if (await this.isNonceUsed(nonce)) return { status: "delivered", route };

    // Built here from the attested bytes: the caller of the route supplies a hash, never a transaction.
    const operation = deliverOperation({ message, attestation: attestation.attestation, caller: this.address }, network);
    try {
      const hash = await this.send(operation, (simulation) => assertOnlyCalledByRelayer(simulation, operation));
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

  private async completeOnce(txHash: string, caller: string): Promise<CompleteResult> {
    const { network, baseMints } = this.config;
    const { stellar, evm } = network;
    const { status, attestation } = await this.lookUp(stellar.cctpDomain, txHash);
    if (!attestation) {
      return { status: "pending", attestation: status.state === "not_found" ? "not_found" : "pending" };
    }

    const { message } = attestation;
    if (size(message) > MAX_MESSAGE_BYTES || size(attestation.attestation) > MAX_ATTESTATION_BYTES) {
      throw new ApiError("bad_request", "That transaction carries a message too large to be a USDC transfer");
    }
    let burn: ReturnType<typeof decodeBurnMessage>;
    try {
      burn = decodeBurnMessage(message);
    } catch {
      throw new ApiError("bad_request", "That transaction does not carry a USDC transfer");
    }
    if (burn.sourceDomain !== stellar.cctpDomain || burn.destinationDomain !== evm.cctpDomain) {
      throw new ApiError(
        "bad_request",
        `That transfer goes from CCTP domain ${burn.sourceDomain} to ${burn.destinationDomain}, not from Stellar to ${evm.chain.name}`,
      );
    }
    if (!stellar.hub || burn.messageSender !== toHex(StrKey.decodeContract(stellar.hub))) {
      throw new ApiError("bad_request", "That transfer was not sent through the hub; the server completes exits from Paso accounts only");
    }

    const { publicClient, walletClient } = this.evmClients();
    if (!walletClient) {
      throw new ApiError("unavailable", "The server has no account on Base to submit the mint from");
    }
    const payer = walletClient.account.address;
    let received: boolean;
    let gas: bigint;
    try {
      [received, gas] = await Promise.all([
        isReceivedOnEvm(publicClient, message, network),
        publicClient.getBalance({ address: payer }),
      ]);
    } catch {
      throw new ApiError("unavailable", `The server could not reach ${evm.chain.name}; try again later`);
    }
    if (received) return { status: "minted" };
    if (gas < baseMints.payerEthFloor) {
      throw new ApiError("unavailable", `The server is out of gas on ${evm.chain.name}; submit the mint from your own wallet`);
    }

    // Nothing has been counted so far; from here on the attempt counts, whatever becomes of it.
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

    try {
      // The same queue as the faucet's burns: one account on Base, one transaction at a time.
      const { hash } = await this.queued(this.evmQueue, (signal) => {
        assertStillWanted(signal);
        return receiveMessageOnEvm({ walletClient, publicClient, message, attestation: attestation.attestation, network });
      });
      return hash ? { status: "minted", hash } : { status: "minted" };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The cause stays in the log: a transport error can quote the endpoint it failed to reach.
      console.error("Mint on Base failed:", error instanceof Error ? error.name : "unknown error");
      throw new ApiError("unavailable", `The server could not submit the mint on ${evm.chain.name}; try again later`);
    }
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

  private evmClients() {
    const { network, payer, evmRpcUrl } = this.config;
    const { chain } = network.evm;
    const transport = http(evmRpcUrl, { timeout: EVM_TIMEOUT_MS, retryCount: 1 });
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: payer ? createWalletClient({ account: payer, chain, transport }) : null,
    };
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

  private transaction(source: Account, operation: xdr.Operation) {
    return new TransactionBuilder(source, {
      fee: INCLUSION_FEE,
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
   * transaction only adds the difference.
   */
  private setAsideFee(simulation: Simulated, fee: string, setAside: bigint): bigint {
    const { maxResourceFee } = this.config;
    const total = BigInt(fee);
    const simulated = BigInt(simulation.minResourceFee);
    const carried = total - BigInt(INCLUSION_FEE);
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
      throw new ApiError("unavailable", "The relayer has used up what it spends on fees in a day; try again later");
    }
    return total;
  }

  /**
   * Sends one operation in a transaction of the relayer account and waits
   * for it to be applied.
   *
   * Everything from reading the sequence number to the confirmation happens
   * inside the queue, one transaction at a time. The operation is simulated
   * there with the ledger as it is at that moment, `inspect` gets a say on
   * that simulation, and the fee is checked against the cap and the day's
   * budget before anything is signed. A transaction refused for a stale
   * sequence number, which happens when another server instance used the
   * account in between, is rebuilt and sent once more.
   */
  private send(operation: xdr.Operation, inspect: (simulation: Simulated) => void): Promise<string> {
    return this.queued(this.queue, async (signal) => {
      let staleSequences = 0;
      let busy = 0;
      let setAside = BigInt(0);
      for (;;) {
        assertStillWanted(signal);
        const account = await this.server.getAccount(this.address);
        const tx = this.transaction(account, operation);

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
        setAside = this.setAsideFee(simulation, ready.fee, setAside);
        // The queue may have given up on this transaction while the network was answering.
        assertStillWanted(signal);
        ready.sign(this.config.relayer);
        const sent = await this.server.sendTransaction(ready);

        if (sent.status === "TRY_AGAIN_LATER" && busy < BUSY_RETRIES) {
          busy += 1;
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        if (sent.status === "ERROR") {
          const reason = sent.errorResult?.result.type ?? "unknown";
          if (reason === "txBadSeq" && staleSequences === 0) {
            staleSequences += 1;
            continue;
          }
          throw new ApiError("unavailable", `The network did not take the transaction (${reason})`);
        }
        if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
          throw new ApiError("unavailable", "The network is busy; try again in a moment");
        }

        const result = await this.server.pollTransaction(sent.hash, {
          attempts: CONFIRMATION_ATTEMPTS,
          sleepStrategy: rpc.BasicSleepStrategy,
        });
        if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new ApiError("transaction_failed", `Transaction ${sent.hash} was included and failed`, {
            hash: sent.hash,
          });
        }
        throw new ApiError("unavailable", `Transaction ${sent.hash} was sent and has not been confirmed yet`, {
          hash: sent.hash,
        });
      }
    });
  }
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

const globalForRelayer = globalThis as typeof globalThis & { pasoRelayer?: Relayer };

/**
 * The relayer of this server process, created from the environment on first
 * use. One instance per process keeps one queue per account and one set of
 * counts.
 *
 * While developing, an edit replaces this module, and an instance made from
 * the module it replaced would go on running the old code: it is recognised
 * by its class and made anew.
 */
export function getRelayer(): Relayer {
  const existing = globalForRelayer.pasoRelayer;
  const usable = process.env.NODE_ENV === "production" ? existing !== undefined : existing instanceof Relayer;
  if (existing && usable) return existing;

  const relayer = new Relayer(loadConfig());
  globalForRelayer.pasoRelayer = relayer;
  return relayer;
}
