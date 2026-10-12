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
  isDeployed,
  isExpired,
  readContract,
  signedFromRelayRequest,
  simulateSigned,
  SimulationError,
  twinAddress,
  type InboundRoute,
  type RelayResult,
  type Signed,
} from "@paso/sdk";
import { Account, Operation, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { loadConfig, type ServerConfig } from "./config";
import { ApiError } from "./errors";
import { createQueue } from "./queue";
import { createLimiter, type Limiter } from "./ratelimit";

/** What the network offers above the resource fee to be included in a ledger, in stroops. */
const INCLUSION_FEE = "1000";
const TRANSACTION_TIMEOUT_SECONDS = 60;
const CONFIRMATION_ATTEMPTS = 45;
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 2000;

/** One test USDC, in Base's 6-decimal units: what the demo faucet sends per request. */
export const DEMO_FUND_AMOUNT = BigInt(1_000_000);
/** Approved to Circle's TokenMessenger in one go, so a faucet request is a single transaction on Base. */
const STANDING_ALLOWANCE = BigInt(1_000) * DEMO_FUND_AMOUNT;

const HOUR_MS = 60 * 60 * 1000;
const MAX_XDR_CHARS = 16_384;
const MAX_DIAGNOSTIC_CHARS = 4_000;
const REMEMBERED_DELIVERIES = 1_000;

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
  private readonly queue = createQueue();
  private readonly evmQueue = createQueue();
  private readonly deployments = new Map<string, Promise<string | undefined>>();
  private readonly deliveries = new Map<string, Promise<DeliverResult>>();
  private readonly delivered = new Map<string, DeliverResult>();
  private readonly fundsPerIp: Limiter;
  private readonly fundsPerOwner: Limiter;

  constructor(readonly config: ServerConfig) {
    this.address = config.relayer.publicKey();
    this.server = new rpc.Server(config.network.stellar.rpcUrl);
    this.fundsPerIp = createLimiter({ limit: config.demoFund.perIpPerHour, windowMs: HOUR_MS });
    this.fundsPerOwner = createLimiter({ limit: config.demoFund.perOwnerPerDay, windowMs: 24 * HOUR_MS });
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
      const hash = await this.send(operation, (simulation) => this.assertWorthRelaying(simulation, entry));
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
   * Testnet only: the demo payer burns one test USDC on Base for the account
   * of `owner`. Limited per caller address and per owner; the counts are kept
   * in memory and start over when the server restarts or is redeployed.
   */
  async demoFund(body: unknown, ip: string): Promise<DemoFundResult> {
    const { network, payer } = this.config;
    if (network.name !== "testnet") {
      throw new ApiError("not_found", "The demo faucet exists on testnet only");
    }
    if (!payer) {
      throw new ApiError("unavailable", "The demo faucet has no payer configured");
    }
    const owner = this.readOwner(body);
    const ownerKey = owner.toLowerCase();

    const perIp = this.fundsPerIp.take(ip);
    if (!perIp.ok) {
      throw new ApiError("rate_limited", "This address has used the demo faucet too often; try again later", {
        retryAfterSeconds: perIp.retryAfterSeconds,
      });
    }
    const perOwner = this.fundsPerOwner.take(ownerKey);
    if (!perOwner.ok) {
      this.fundsPerIp.refund(ip);
      throw new ApiError("rate_limited", "This account has already been funded by the demo faucet; try again later", {
        retryAfterSeconds: perOwner.retryAfterSeconds,
      });
    }

    try {
      return await this.evmQueue(() => this.burnForDemo(owner, payer.address));
    } catch (error) {
      this.fundsPerIp.refund(ip);
      this.fundsPerOwner.refund(ownerKey);
      if (error instanceof ApiError) throw error;
      const reason = isRecord(error) && typeof error.shortMessage === "string" ? error.shortMessage : "the burn failed";
      throw new ApiError("unavailable", `The demo faucet could not send USDC on Base: ${reason}`);
    }
  }

  /** What the server runs on and what its accounts hold. Addresses and balances only. */
  async health() {
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
    if (typeof owner !== "string" || !text(func) || !Array.isArray(auth) || !auth.every(text)) {
      throw new ApiError(
        "bad_request",
        "owner must be an Ethereum address, func a base64 host function and auth a list of base64 authorisation entries",
      );
    }

    try {
      const signed = signedFromRelayRequest(
        { network: this.config.network.name, owner: owner as Address, func, auth },
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
    if (!Number.isInteger(sourceDomain) || (sourceDomain as number) < 0 || sourceDomain === cctpDomain) {
      throw new ApiError("bad_request", "sourceDomain must be the CCTP domain of the chain the USDC was burned on");
    }
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new ApiError("bad_request", "txHash must be the hash of the burn transaction (0x and 64 hex digits)");
    }
    return { sourceDomain: sourceDomain as number, txHash: txHash as Hex };
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

  /** Last look at the simulation the transaction is built from: its cost, and that it needs nothing beyond the entry. */
  private assertWorthRelaying(simulation: Simulated, entry: xdr.SorobanAuthorizationEntry): void {
    const { maxResourceFee } = this.config;
    const fee = BigInt(simulation.minResourceFee);
    if (fee > maxResourceFee) {
      throw new ApiError(
        "simulation_failed",
        `This call would cost ${fee} stroops in resource fees; the relayer pays for calls up to ` +
          `${maxResourceFee} stroops (${formatAmount(maxResourceFee, 7)} XLM)`,
      );
    }
    const supplied = entry.toXdr("base64");
    if ((simulation.result?.auth ?? []).some((reported) => reported.toXdr("base64") !== supplied)) {
      throw new ApiError("simulation_failed", "The call needs an authorisation the request does not carry");
    }
  }

  /** Deploys the owner's account unless it exists. Requests for the same owner share one deployment. */
  private ensureDeployed(owner: Address): Promise<string | undefined> {
    const key = owner.toLowerCase();
    const running = this.deployments.get(key);
    if (running) return running;

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
    const { status, attestation } = await fetchAttestation(sourceDomain, txHash, network);
    if (!attestation) {
      if (status.state === "pending" && status.delayReason) {
        return { status: "pending", attestation: "pending", delayReason: status.delayReason };
      }
      return { status: "pending", attestation: status.state === "complete" ? "pending" : status.state };
    }

    const { message, nonce } = attestation;
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
    const transport = http(evmRpcUrl);
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: payer ? createWalletClient({ account: payer, chain, transport }) : null,
    };
  }

  private async burnForDemo(owner: Address, payer: Address): Promise<DemoFundResult> {
    const { network } = this.config;
    const { chain, usdc, tokenMessenger, cctpDomain } = network.evm;
    const { publicClient, walletClient } = this.evmClients();
    if (!walletClient) {
      throw new ApiError("unavailable", "The demo faucet has no payer configured");
    }

    const balance = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer],
    });
    if (balance < DEMO_FUND_AMOUNT) {
      throw new ApiError("unavailable", `The demo faucet is out of test USDC on ${chain.name}`);
    }

    const allowance = await publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [payer, tokenMessenger],
    });
    if (allowance < DEMO_FUND_AMOUNT) {
      const approval = await walletClient.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [tokenMessenger, STANDING_ALLOWANCE],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: approval });
      if (receipt.status !== "success") {
        throw new ApiError("unavailable", `The demo faucet could not approve USDC on ${chain.name}`);
      }
    }

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

  /**
   * Sends one operation in a transaction of the relayer account and waits
   * for it to be applied.
   *
   * Everything from reading the sequence number to the confirmation happens
   * inside the queue, one transaction at a time. The operation is simulated
   * there with the ledger as it is at that moment, and `inspect` gets the
   * last word on that simulation before anything is signed. A transaction
   * refused for a stale sequence number, which happens when another server
   * instance used the account in between, is rebuilt and sent once more.
   */
  private send(operation: xdr.Operation, inspect: (simulation: Simulated) => void): Promise<string> {
    return this.queue(async () => {
      let staleSequences = 0;
      let busy = 0;
      for (;;) {
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
 * use. One instance per process keeps one queue per account.
 */
export function getRelayer(): Relayer {
  globalForRelayer.pasoRelayer ??= new Relayer(loadConfig());
  return globalForRelayer.pasoRelayer;
}
