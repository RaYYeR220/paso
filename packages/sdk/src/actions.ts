import {
  Account,
  Address as StellarAddress,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  StrKey,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  getAddress,
  hexToBytes,
  isAddress,
  isAddressEqual,
  pad,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  assertOnlyAccountEntries,
  attachSignature,
  entryExpiration,
  entrySignature,
  entryTypedData,
  setExpiration,
  type TypedDataSigner,
} from "./auth";
import { deliverOperation, FAST_FINALITY, fetchBurnFee, maxFeeFor, type Attestation } from "./iris";
import { requireHub, resolveNetwork, type Network, type NetworkConfig, type NetworkName } from "./networks";
import { renderCalls, type Call } from "./render";
import { twinAddress } from "./twin";
import type { AuthorizationTypedData } from "./typedData";
import { toEvmUnits, toStellarUnits } from "./units";

/** Send USDC from the account to a Stellar address, or to the account of an Ethereum address. */
export interface TransferAction {
  kind: "transfer";
  /** `G…`, `C…`, or `0x…` for the Stellar account of that Ethereum address. */
  to: string;
  /** USDC in 7-decimal units. */
  amount: bigint;
}

/** Send USDC from the account back to an EVM chain over CCTP. */
export interface ExitAction {
  kind: "exit";
  /** USDC in 7-decimal units. The seventh decimal must be zero. */
  amount: bigint;
  /** Who receives the USDC on the destination chain. */
  recipient: Address;
  /** CCTP domain to mint on. Defaults to Base. */
  destinationDomain?: number;
  /** Fee cap in 7-decimal units, seventh decimal zero. Defaults to Circle's current fee plus headroom. */
  maxFee?: bigint;
  /** Defaults to a fast transfer. */
  minFinalityThreshold?: number;
}

/** Call any contract function that asks the account for authorisation. */
export interface InvokeAction {
  kind: "invoke";
  contract: string;
  fn: string;
  args: xdr.ScVal[];
}

export type Action = TransferAction | ExitAction | InvokeAction;

export interface ActionContext {
  /** The Ethereum address that owns the account. */
  owner: Address;
  network: Network;
}

export interface PrepareOptions extends ActionContext {
  /**
   * Source account to simulate with. Simulation needs one but does not check
   * it, so any address works; the default is the all-zero account.
   */
  source?: string;
  /** How many ledgers (about 5 seconds each) the signature stays valid. Defaults to 120. */
  validForLedgers?: number;
  server?: rpc.Server;
}

/** A simulated call waiting for the owner's signature. Plain JSON. */
export interface Prepared {
  network: NetworkName;
  owner: Address;
  /** The owner's Stellar account. */
  account: string;
  /** The simulated transaction envelope, base64. Its source is the placeholder, never the final payer. */
  txXdr: string;
  /** The one authorisation entry the call needs, base64: the account's, with its expiration set. */
  entries: string[];
  /** What the wallet signs. */
  typedData: AuthorizationTypedData;
  /** The calls inside `typedData`, for display. */
  calls: Call[];
  /** Last ledger at which the signature is accepted. */
  validUntilLedger: number;
}

/** A prepared call whose account entry carries the owner's signature. Plain JSON. */
export interface Signed extends Prepared {
  /** `r ‖ s ‖ v`, 65 bytes. */
  signature: Hex;
}

/** Body of a `POST` to a relayer. */
export interface RelayRequest {
  network: NetworkName;
  /** Owner of the account, so the relayer can deploy the account before its first call. */
  owner: Address;
  /** The host function to run: base64 `HostFunction` XDR. */
  func: string;
  /** The account's signed authorisation entry, as a one-element list: base64 `SorobanAuthorizationEntry` XDR. */
  auth: string[];
}

/**
 * Why a relayer declined.
 *
 * - `expired`: the signature's last valid ledger has passed; prepare and sign again.
 * - `bad_signature`: the account refused the signature for this call.
 * - `simulation_failed`: the call itself would fail, or costs more than the relayer pays for.
 * - `bad_request`: the request is not one signed call from the owner's account.
 * - `rate_limited`: too many requests; try again later.
 * - `transaction_failed`: the transaction was submitted and did not apply.
 * - `unavailable`: the relayer could not reach the network.
 */
export type RelayErrorCode =
  | "expired"
  | "bad_signature"
  | "simulation_failed"
  | "bad_request"
  | "rate_limited"
  | "transaction_failed"
  | "unavailable";

/** A relayed call: its transaction, and the one that deployed the account when this was its first call. */
export interface RelayResult {
  hash: string;
  deployHash?: string;
}

/** What a relayer answers: the hash of the submitted transaction, or why it declined. */
export type RelayResponse = RelayResult | { error: RelayErrorCode; detail?: string; hash?: string };

export class RelayError extends Error {
  constructor(
    /** The relayer's reason, or `relay_failed` when it did not give one. */
    readonly code: RelayErrorCode | "relay_failed",
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ? `Relay declined (${code}): ${detail}` : `Relay declined (${code})`);
    this.name = "RelayError";
  }
}

export class SimulationError extends Error {
  constructor(
    /** The network's explanation, diagnostics included. */
    readonly detail: string,
    /** True when the failure comes after the signature's last valid ledger: sign again. */
    readonly expired = false,
  ) {
    super(expired ? "The signature has expired; prepare and sign again" : `Simulation failed: ${detail}`);
    this.name = "SimulationError";
  }
}

export class TransactionError extends Error {
  constructor(
    readonly hash: string,
    readonly status: string,
  ) {
    super(`Transaction ${hash} was not applied (${status})`);
    this.name = "TransactionError";
  }
}

const NULL_ACCOUNT = StrKey.encodeEd25519PublicKey(new Uint8Array(32));
const DEFAULT_VALIDITY_LEDGERS = 120;
const TRANSACTION_TIMEOUT_SECONDS = 60;
const CONFIRMATION_ATTEMPTS = 60;

const address = (strkey: string): xdr.ScVal => new StellarAddress(strkey).toScVal();
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });
const u32 = (value: number): xdr.ScVal => xdr.ScVal.scvU32(value);

function assertPositive(amount: bigint): void {
  if (amount <= 0n) {
    throw new Error("The amount must be positive");
  }
}

function transferRecipient(to: string, config: NetworkConfig): string {
  if (isAddress(to, { strict: false })) return twinAddress(to, config);
  if (StrKey.isValidContract(to) || StrKey.isValidEd25519PublicKey(to)) return to;
  throw new Error(`"${to}" is not a Stellar address (G… or C…) or an Ethereum address (0x…)`);
}

async function exitOperation(action: ExitAction, account: string, config: NetworkConfig): Promise<xdr.Operation> {
  const { amount, recipient } = action;
  assertPositive(amount);
  const burned = toEvmUnits(amount);
  if (!isAddress(recipient, { strict: false })) {
    throw new Error(`"${recipient}" is not an Ethereum address`);
  }
  const destinationDomain = action.destinationDomain ?? config.evm.cctpDomain;
  const minFinalityThreshold = action.minFinalityThreshold ?? FAST_FINALITY;
  const maxFee =
    action.maxFee ??
    toStellarUnits(
      maxFeeFor(
        burned,
        await fetchBurnFee(config.stellar.cctpDomain, destinationDomain, config, {
          finalityThreshold: minFinalityThreshold,
        }),
      ),
    );
  if (maxFee < 0n || maxFee >= amount) {
    throw new Error(`The fee cap (${maxFee}) must be zero or more and less than the amount (${amount})`);
  }
  // Like the amount, the fee cap is carried in 6 decimals: this throws on a seventh.
  toEvmUnits(maxFee);

  return new Contract(requireHub(config)).call(
    "exit",
    address(account),
    i128(amount),
    u32(destinationDomain),
    xdr.ScVal.scvBytes(hexToBytes(pad(recipient, { size: 32 }))),
    i128(maxFee),
    u32(minFinalityThreshold),
  );
}

/** The contract call an action stands for, made from the owner's account. */
export async function buildOperation(action: Action, context: ActionContext): Promise<xdr.Operation> {
  const config = resolveNetwork(context.network);
  const account = twinAddress(context.owner, config);

  switch (action.kind) {
    case "transfer":
      assertPositive(action.amount);
      return new Contract(config.stellar.usdc).call(
        "transfer",
        address(account),
        address(transferRecipient(action.to, config)),
        i128(action.amount),
      );
    case "exit":
      return exitOperation(action, account, config);
    case "invoke":
      return new Contract(action.contract).call(action.fn, ...action.args);
  }
}

function serverFor(config: NetworkConfig, server?: rpc.Server): rpc.Server {
  return server ?? new rpc.Server(config.stellar.rpcUrl);
}

function decodeEntries(entries: string[]): xdr.SorobanAuthorizationEntry[] {
  return entries.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64"));
}

/**
 * Simulates an action and returns what the owner has to sign.
 *
 * Nothing here needs the owner's wallet or a funded Stellar account. Invalid
 * input (a recipient that is not an address, an exit amount Base cannot
 * represent) is rejected before the network is contacted.
 */
export async function prepare(action: Action, options: PrepareOptions): Promise<Prepared> {
  const config = resolveNetwork(options.network);
  const account = twinAddress(options.owner, config);
  const operation = await buildOperation(action, options);

  const source = new Account(options.source ?? NULL_ACCOUNT, "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();

  const simulation = await serverFor(config, options.server).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new SimulationError(simulation.error);
  }

  // A call that needs anyone else's authorisation, the fee payer's included,
  // is not something the owner's signature can cover: it stops here.
  const recorded = assertOnlyAccountEntries(simulation.result?.auth ?? [], account);
  const validUntilLedger = simulation.latestLedger + (options.validForLedgers ?? DEFAULT_VALIDITY_LEDGERS);
  const entry = setExpiration(recorded, validUntilLedger);

  return {
    network: config.name,
    owner: getAddress(options.owner),
    account,
    txXdr: tx.toEnvelope().toXdr("base64"),
    entries: [entry.toXdr("base64")],
    typedData: entryTypedData(entry, config),
    calls: renderCalls(entry),
    validUntilLedger,
  };
}

/**
 * Asks the wallet to sign a prepared call and attaches the signature.
 *
 * `signer` is a viem account, or a wallet client with its account set. A
 * signature from any key other than the owner's is refused here, before it
 * can reach the network.
 */
export async function sign(prepared: Prepared, signer: TypedDataSigner): Promise<Signed> {
  const signature = await signer.signTypedData(prepared.typedData);

  const entry = assertOnlyAccountEntries(decodeEntries(prepared.entries), prepared.account);
  const signedEntry = attachSignature(entry, signature);

  const signedBy = await recoverTypedDataAddress({ ...prepared.typedData, signature });
  if (!isAddressEqual(signedBy, prepared.owner)) {
    throw new Error(`This request was signed by ${signedBy}, but the account belongs to ${prepared.owner}`);
  }

  return {
    ...prepared,
    entries: [signedEntry.toXdr("base64")],
    signature,
  };
}

function hostFunction(txXdr: string) {
  const envelope = xdr.TransactionEnvelope.fromXdr(txXdr, "base64");
  const body = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations[0]?.body : undefined;
  if (body?.type !== "invokeHostFunction") {
    throw new Error("Expected a transaction with a single contract invocation");
  }
  const { hostFunction: func } = body.invokeHostFunctionOp;
  if (func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("Only contract calls can be made from an account; this transaction uploads or creates a contract");
  }
  return func;
}

/**
 * The relayer request for a signed call.
 *
 * Throws when the signed call carries anything but the account's own entry.
 */
export function relayRequest(signed: Signed): RelayRequest {
  assertOnlyAccountEntries(decodeEntries(signed.entries), signed.account);
  return {
    network: signed.network,
    owner: signed.owner,
    func: hostFunction(signed.txXdr).toXdr("base64"),
    auth: signed.entries,
  };
}

/**
 * Reads a relayer request back into the signed call it stands for.
 *
 * This is the relayer's side of `relayRequest`, and the place where it is
 * decided what a fee payer will wrap in its own transaction: a contract call
 * with exactly one authorisation entry, signed, for the account derived from
 * `owner`. Anything else throws, so a request can never borrow the fee
 * payer's authority or make it upload code.
 */
export function signedFromRelayRequest(request: RelayRequest, network: Network = request.network): Signed {
  const config = resolveNetwork(network);
  if (request.network !== config.name) {
    throw new Error(`This request is for ${String(request.network)}, not for ${config.name}`);
  }
  if (typeof request.owner !== "string" || !isAddress(request.owner, { strict: false })) {
    throw new Error("The request does not name the Ethereum address that owns the account");
  }
  if (typeof request.func !== "string" || !Array.isArray(request.auth)) {
    throw new Error("The request needs a host function and a list of authorisation entries");
  }

  let func: xdr.HostFunction;
  let entries: xdr.SorobanAuthorizationEntry[];
  try {
    func = xdr.HostFunction.fromXdr(request.func, "base64");
    entries = decodeEntries(request.auth);
  } catch {
    throw new Error("The host function or an authorisation entry is not valid XDR");
  }
  if (func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("Only contract calls can be relayed; this request uploads or creates a contract");
  }

  const account = twinAddress(request.owner, config);
  const entry = assertOnlyAccountEntries(entries, account);
  const validUntilLedger = entryExpiration(entry);
  const signature = entrySignature(entry);
  if (validUntilLedger === 0 || signature === null) {
    throw new Error("The authorisation entry is not signed");
  }

  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();

  return {
    network: config.name,
    owner: getAddress(request.owner),
    account,
    txXdr: tx.toEnvelope().toXdr("base64"),
    entries: [entry.toXdr("base64")],
    typedData: entryTypedData(entry, config),
    calls: renderCalls(entry),
    validUntilLedger,
    signature,
  };
}

/**
 * Returns the signed call with one argument of its root call replaced, in the
 * call itself and in the signed authorisation entry alike, while the
 * signature and everything the wallet showed stay as they were.
 *
 * This is the change a dishonest relayer or front end would have to make to
 * alter a call after the owner approved it. The account contract rebuilds the
 * signed text from what is about to run, so it refuses the result with
 * `BadSignature`. It exists to demonstrate that refusal.
 */
export function withArgument(signed: Signed, index: number, value: xdr.ScVal): Signed {
  const config = resolveNetwork(signed.network);
  const call = hostFunction(signed.txXdr).invokeContract;
  const entry = assertOnlyAccountEntries(decodeEntries(signed.entries), signed.account);

  const authorised = entry.rootInvocation.function;
  const sameCall =
    authorised.type === "sorobanAuthorizedFunctionTypeContractFn" &&
    authorised.contractFn.toXdr("base64") === call.toXdr("base64");
  if (!sameCall) {
    throw new Error("The account authorises this call through a nested invocation, not as the call itself");
  }
  if (!Number.isInteger(index) || index < 0 || index >= call.args.length) {
    throw new Error(`The call has ${call.args.length} arguments; there is no argument ${index}`);
  }

  const changed = new xdr.InvokeContractArgs({
    contractAddress: call.contractAddress,
    functionName: call.functionName,
    args: call.args.map((arg, i) => (i === index ? value : arg)),
  });
  const { source } = TransactionBuilder.fromXdr(signed.txXdr, config.stellar.networkPassphrase) as Transaction;
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: xdr.HostFunction.hostFunctionTypeInvokeContract(changed), auth: [] }))
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();
  const changedEntry = new xdr.SorobanAuthorizationEntry({
    credentials: entry.credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(changed),
      subInvocations: entry.rootInvocation.subInvocations,
    }),
  });

  return { ...signed, txXdr: tx.toEnvelope().toXdr("base64"), entries: [changedEntry.toXdr("base64")] };
}

/**
 * Whether a signature can still be used, given the latest closed ledger. The
 * network accepts it up to and including `validUntilLedger`, and a
 * transaction sent now lands in a later ledger than the latest one.
 */
export function isExpired(prepared: Pick<Prepared, "validUntilLedger">, latestLedger: number): boolean {
  return latestLedger >= prepared.validUntilLedger;
}

/**
 * Hands a signed call to a relayer, which pays the fee and submits it.
 *
 * Throws a `RelayError` when the relayer declines; its `code` is `expired`
 * when the owner has to sign again.
 */
export async function relay(
  signed: Signed,
  relayerUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<RelayResult> {
  const response = await fetch(relayerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(relayRequest(signed)),
    signal: options.signal,
  });

  const text = await response.text();
  let body: Partial<{ hash: string; deployHash: string; error: RelayErrorCode; detail: string }> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }

  if (response.ok && typeof body.hash === "string") {
    return typeof body.deployHash === "string"
      ? { hash: body.hash, deployHash: body.deployHash }
      : { hash: body.hash };
  }
  throw new RelayError(body.error ?? "relay_failed", response.status, body.detail ?? (body.error ? undefined : text));
}

export interface SubmitOptions {
  /** Overrides the network recorded in the signed call, for a custom RPC endpoint. */
  network?: Network;
  server?: rpc.Server;
}

/**
 * The operation a fee payer wraps in its own transaction: the call, and the
 * one entry signed by the owner's account. The account is derived from the
 * owner again here, so nothing else in `signed` decides whose entry is let
 * through.
 */
function signedOperation(signed: Signed, config: NetworkConfig): xdr.Operation {
  const entry = assertOnlyAccountEntries(decodeEntries(signed.entries), twinAddress(signed.owner, config));
  return Operation.invokeHostFunction({ func: hostFunction(signed.txXdr), auth: [entry] });
}

/**
 * Simulates an operation as `source` would send it. With signed entries
 * attached the network enforces them, so this is where a signature is
 * accepted or refused.
 */
async function simulateOperation(
  operation: xdr.Operation,
  source: Account,
  config: NetworkConfig,
  server: rpc.Server,
  validUntilLedger?: number,
) {
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const expired = validUntilLedger !== undefined && isExpired({ validUntilLedger }, simulation.latestLedger);
    throw new SimulationError(simulation.error, expired);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new SimulationError("ledger entries this call needs are archived and have to be restored first");
  }
  return { tx, simulation };
}

/**
 * Checks a signed call against the network without submitting it.
 *
 * The account contract verifies the signature exactly as it would on
 * submission, so this resolves only for a call the network would accept. A
 * wrong signer, a call that differs from what was signed, or an expired
 * signature throws a `SimulationError`. The account has to be deployed.
 */
export async function simulateSigned(
  signed: Signed,
  options: SubmitOptions & { source?: string } = {},
): Promise<void> {
  const config = resolveNetwork(options.network ?? signed.network);
  const source = new Account(options.source ?? NULL_ACCOUNT, "0");
  await simulateOperation(
    signedOperation(signed, config),
    source,
    config,
    serverFor(config, options.server),
    signed.validUntilLedger,
  );
}

async function submitOperation(
  operation: xdr.Operation,
  source: Keypair,
  config: NetworkConfig,
  server: rpc.Server,
  validUntilLedger?: number,
): Promise<string> {
  const account = await server.getAccount(source.publicKey());
  const { tx, simulation } = await simulateOperation(operation, account, config, server, validUntilLedger);

  const ready = rpc.assembleTransaction(tx, simulation).build();
  ready.sign(source);

  const sent = await server.sendTransaction(ready);
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw new TransactionError(sent.hash, sent.status);
  }
  const result = await server.pollTransaction(sent.hash, {
    attempts: CONFIRMATION_ATTEMPTS,
    sleepStrategy: rpc.BasicSleepStrategy,
  });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new TransactionError(sent.hash, result.status);
  }
  return sent.hash;
}

/** `hub.deploy(owner)`: creates the owner's account. Anyone can submit it, and repeating it is harmless. */
export function deployOperation(owner: Address, network: Network): xdr.Operation {
  if (!isAddress(owner, { strict: false })) {
    throw new Error(`"${owner}" is not an Ethereum address`);
  }
  return new Contract(requireHub(network)).call("deploy", xdr.ScVal.scvBytes(hexToBytes(owner)));
}

/** Whether the owner's account contract exists yet. It can hold USDC before it does. */
export async function isDeployed(owner: Address, network: Network, server?: rpc.Server): Promise<boolean> {
  const config = resolveNetwork(network);
  const instance = new Contract(twinAddress(owner, config)).getFootprint();
  const { entries } = await serverFor(config, server).getLedgerEntries(instance);
  return entries.length > 0;
}

/** Deploys the owner's account when it does not exist. Returns the deployment hash, or `null` if there was nothing to do. */
export async function ensureDeployed(
  owner: Address,
  source: Keypair,
  network: Network,
  server?: rpc.Server,
): Promise<{ hash: string } | null> {
  const config = resolveNetwork(network);
  const rpcServer = serverFor(config, server);
  if (await isDeployed(owner, config, rpcServer)) return null;
  return { hash: await submitOperation(deployOperation(owner, config), source, config, rpcServer) };
}

/**
 * Submits a signed call from any funded Stellar account, with no relayer.
 *
 * Deploys the owner's account first when it does not exist yet, then
 * simulates again with the signed entry in place, so the transaction pays for
 * the account contract's signature check, and waits for the result.
 *
 * `source` only pays: a signed call that carries anything but the entry of
 * the owner's account is refused before the network is contacted, so the
 * source's own authority is never lent to the call.
 */
export async function submitWith(
  signed: Signed,
  source: Keypair,
  options: SubmitOptions = {},
): Promise<{ hash: string }> {
  const config = resolveNetwork(options.network ?? signed.network);
  const server = serverFor(config, options.server);
  const operation = signedOperation(signed, config);

  await ensureDeployed(signed.owner, source, config, server);

  const hash = await submitOperation(operation, source, config, server, signed.validUntilLedger);
  return { hash };
}

/**
 * Delivers an attested burn on Stellar from any funded account, with no
 * relayer. Anyone may do this: Circle's contracts check the attestation and
 * decide where the USDC goes, and `source` only pays the fee.
 *
 * Throws a `SimulationError` when the message cannot be delivered, which
 * includes a message that has been delivered before.
 */
export async function deliverWith(
  attestation: Pick<Attestation, "message" | "attestation">,
  source: Keypair,
  network: Network,
  server?: rpc.Server,
): Promise<{ hash: string }> {
  const config = resolveNetwork(network);
  const operation = deliverOperation(
    { message: attestation.message, attestation: attestation.attestation, caller: source.publicKey() },
    config,
  );
  return { hash: await submitOperation(operation, source, config, serverFor(config, server)) };
}
