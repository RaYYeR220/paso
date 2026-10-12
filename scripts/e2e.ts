/**
 * Paso, end to end, on testnet or on mainnet.
 *
 *   pnpm e2e --stellar-only [--relayer <url>]
 *   pnpm e2e [--relayer <url>] [--fund demo|burn] [--to <address>]
 *   pnpm e2e --network mainnet [--burn 1] [--transfer 0.1] [--exit 0.5] [--to <address>]
 *   pnpm e2e --network mainnet --dry-run [--owner <0x…>] [--source <G…>]
 *
 * `--stellar-only` needs no USDC. It takes a fresh Ethereum key, makes the
 * first call from its Stellar account (which deploys the account), and then
 * shows the refusal: a signature made for one amount, submitted with another,
 * recorded on chain as a failed transaction.
 *
 * Without the flag it runs the whole journey for the owner key: USDC leaves
 * Base, Circle attests the burn, it is delivered to the owner's Stellar
 * account, part of it is sent on to another account, part of it goes back to
 * Base, and the refusal closes the run. Every transaction is printed with its
 * explorer link. `--burn`, `--transfer` and `--exit` set the three amounts in
 * USDC; they default to 1, 0.1 and 0.5.
 *
 * With `--relayer <url>` the Stellar transactions go through that relayer's
 * API and it pays their fees. Without it, the account in
 * `PASO_E2E_SOURCE_SECRET` pays: nothing here depends on a particular relayer.
 *
 * `--network mainnet` runs the same journey between Stellar mainnet and Base
 * with real funds, and pays for itself: the owner key pays the burn and the
 * final mint on Base, `PASO_E2E_SOURCE_SECRET` pays on Stellar, and there is
 * no faucet and no relayer. Before anything is sent the run reads Circle's
 * contracts on both chains, prints what each account needs, and stops if
 * either is short. Each Stellar transaction prints its simulated fee first.
 *
 * `--dry-run` does every read and every simulation of a run, prints what the
 * run would send and what that would cost, and sends nothing. It signs
 * nothing either, so `--owner` and `--source` can name the two addresses
 * when the keys are not at hand.
 *
 * Environment (on testnet also read from apps/web/.env.local when that file
 * exists; on mainnet from the environment alone):
 *
 *   PASO_E2E_OWNER_KEY       Ethereum private key that owns the account. A fresh one when unset.
 *                            On mainnet it also pays on Base.
 *   PASO_E2E_SOURCE_SECRET   Secret key of any funded Stellar account. Required without --relayer,
 *                            and for the refused transaction, which no relayer will send.
 *   PASO_E2E_PAYER_KEY       Testnet: Ethereum private key that pays the burn on Base (--fund burn).
 *                            Defaults to DEMO_PAYER_PRIVATE_KEY when that is set, else to the owner key.
 *   BASE_RPC_URL             Base RPC endpoint. Defaults to the chain's public one.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  Account,
  Address as StellarAddress,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  isAddress,
  keccak256,
  numberToHex,
  pad,
  toHex,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type StateOverride,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { publicActionsL2 } from "viem/op-stack";
import {
  buildOperation,
  decodeBurnMessage,
  deliverOperation,
  deliverWith,
  deployOperation,
  ensureDeployed,
  erc20Abi,
  evmAddressUrl,
  evmTxUrl,
  fetchBurnFee,
  formatEvmAmount,
  formatStellarAmount,
  fundFromEvm,
  inboundRouteOf,
  isDeployed,
  messageTransmitterAbi,
  ownerOf,
  parseEvmAmount,
  parseStellarAmount,
  prepare,
  readContract,
  relay,
  RelayError,
  relayRequest,
  renderArg,
  resolveNetwork,
  sign,
  simulateSigned,
  SimulationError,
  stellarAddressUrl,
  stellarTxUrl,
  submitWith,
  toStellarUnits,
  twinAddress,
  usdcBalance,
  waitForAttestation,
  withArgument,
  type Action,
  type Attestation,
  type Call,
  type EvmReader,
  type NetworkConfig,
  type NetworkName,
  type Signed,
} from "../packages/sdk/src/index";
import { formatXlm, MINIMUM_BALANCE, simulatedFee, STROOPS_PER_XLM, xlmBalance } from "./fees";

const HONEST_AMOUNT = 1n;
const TAMPERED_AMOUNT = parseStellarAmount("1000000");
const ATTESTATION_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 2000;
/** How long the approval of the first call stays usable, in ledgers. */
const APPROVAL_LEDGERS = 1000;
/**
 * What the fee payer has to hold for a run on top of its minimum balance. A
 * whole journey is seven Stellar transactions; each one is simulated right
 * before it is sent and its fee printed.
 */
const STELLAR_FEE_ALLOWANCE = 1n * STROOPS_PER_XLM;
/**
 * Gas counted for `receiveMessage` on Base, which mints the USDC that came
 * back. It cannot be simulated before Circle has attested the exit.
 */
const MINT_GAS_ALLOWANCE = 300_000n;
/** Storage slots of Circle's FiatToken, the USDC contract on Base: balances, then allowances. */
const USDC_BALANCES_SLOT = 9n;
const USDC_ALLOWANCES_SLOT = 10n;
/**
 * Until a hub exists there is no account address. The burn on Base never
 * reads the address it carries, so a dry run simulates it with an address of
 * the same size derived from this placeholder.
 */
const PLACEHOLDER_HUB = StrKey.encodeContract(Buffer.alloc(32));

interface Options {
  network: NetworkName;
  dryRun: boolean;
  stellarOnly: boolean;
  relayerUrl?: string;
  fund: "demo" | "burn";
  to?: string;
  /** USDC that leaves Base, in 6-decimal units. */
  burn: bigint;
  /** USDC sent on to another Stellar address, in 7-decimal units. */
  transfer: bigint;
  /** USDC sent back to Base, in 7-decimal units. */
  exit: bigint;
  /** The two addresses of a dry run, when no key names them. */
  owner?: Address;
  source?: string;
}

interface Run {
  config: NetworkConfig;
  server: rpc.Server;
  options: Options;
  owner: PrivateKeyAccount;
  /** The owner's Stellar account. */
  account: string;
  /** Pays fees when there is no relayer, and sends the refused transaction. */
  source?: Keypair;
  relayerUrl?: string;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(
    "Usage: pnpm e2e [--network testnet|mainnet] [--dry-run] [--stellar-only] [--relayer <url>] [--fund demo|burn]\n" +
      "                [--burn <usdc>] [--transfer <usdc>] [--exit <usdc>] [--to <G…|C…|0x…>]\n" +
      "                [--owner <0x…>] [--source <G…>]   (dry run only)",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    network: "testnet",
    dryRun: false,
    stellarOnly: false,
    fund: "burn",
    burn: parseEvmAmount("1"),
    transfer: parseStellarAmount("0.1"),
    exit: parseStellarAmount("0.5"),
  };
  let fund: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    const amount = (parse: (text: string) => bigint): bigint => {
      const text = value();
      try {
        const units = parse(text);
        if (units > 0n) return units;
      } catch {
        // Reported below, with the flag it came from.
      }
      return usage(`${arg} takes a positive amount of USDC, not ${text}`);
    };
    if (arg === "--stellar-only") options.stellarOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--network") {
      const name = value();
      if (name !== "testnet" && name !== "mainnet") usage("--network takes testnet or mainnet");
      options.network = name;
    } else if (arg === "--relayer") options.relayerUrl = value().replace(/\/+$/, "");
    else if (arg === "--fund") fund = value();
    else if (arg === "--to") options.to = value();
    else if (arg === "--burn") options.burn = amount(parseEvmAmount);
    else if (arg === "--transfer") options.transfer = amount(parseStellarAmount);
    else if (arg === "--exit") options.exit = amount(parseStellarAmount);
    else if (arg === "--owner") {
      const owner = value();
      if (!isAddress(owner, { strict: false })) usage(`--owner takes an Ethereum address, not ${owner}`);
      options.owner = getAddress(owner);
    } else if (arg === "--source") {
      const source = value();
      if (!StrKey.isValidEd25519PublicKey(source)) usage(`--source takes a Stellar account (G…), not ${source}`);
      options.source = source;
    } else usage(`Unknown argument ${arg}`);
  }
  if (fund !== undefined && fund !== "demo" && fund !== "burn") usage("--fund takes demo or burn");
  options.fund = (fund as Options["fund"] | undefined) ?? (options.relayerUrl ? "demo" : "burn");
  if (options.fund === "demo" && !options.relayerUrl) usage("--fund demo needs --relayer, whose faucet it uses");
  if (options.exit % 10n !== 0n) usage("--exit takes at most six decimals: Base cannot hold a seventh");
  if ((options.owner || options.source) && !options.dryRun) {
    usage("--owner and --source name addresses for a dry run; a real run takes its keys from the environment");
  }
  if (options.dryRun && options.relayerUrl) usage("A dry run talks to the chains only; leave --relayer out");
  if (options.network === "mainnet" && options.relayerUrl) {
    usage("On mainnet the run pays for itself: PASO_E2E_SOURCE_SECRET on Stellar, the owner key on Base");
  }
  return options;
}

function privateKey(name: string): Hex | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is not a 32-byte hex private key`);
  }
  return value as Hex;
}

let step = 0;
function heading(title: string): void {
  step += 1;
  console.log(`\n[${step}] ${title}`);
}

function line(label: string, value: string): void {
  console.log(`    ${label.padEnd(10)} ${value}`);
}

function showCalls(label: string, calls: Call[]): void {
  calls.forEach((call, index) => {
    line(index === 0 ? label : "", `${call.contract}.${call.fn}(${call.args.join(", ")})`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { error: "relay_failed", detail: text.slice(0, 300) } };
  }
}

function requireSource(run: Run): Keypair {
  if (!run.source) {
    throw new Error("Set PASO_E2E_SOURCE_SECRET to the secret key of a funded Stellar account");
  }
  return run.source;
}

/** Sends a signed call: through the relayer when there is one, from the source account otherwise. */
async function submit(run: Run, signed: Signed): Promise<{ hash: string; deployHash?: string }> {
  if (run.relayerUrl) {
    return relay(signed, `${run.relayerUrl}/api/relay`);
  }
  const source = requireSource(run);
  if (!(await isDeployed(signed.owner, run.config, run.server))) {
    await quote(run, "to deploy the account", deployOperation(signed.owner, run.config));
  }
  const deployed = await ensureDeployed(signed.owner, source, run.config, run.server);
  await quote(run, "for the call", signedOperation(signed));
  const { hash } = await submitWith(signed, source, { network: run.config, server: run.server });
  return deployed ? { hash, deployHash: deployed.hash } : { hash };
}

/** Prints what the fee payer would be charged for an operation, before it is sent. */
async function quote(run: Run, what: string, operation: xdr.Operation): Promise<void> {
  const fee = await simulatedFee(
    run.server,
    run.config.stellar.networkPassphrase,
    requireSource(run).publicKey(),
    operation,
  );
  line("fee", `${formatXlm(fee)} at most ${what}, simulated`);
}

/** The first call of an account: it lets the hub move `amount` of the account's USDC. */
function approvalAction(config: NetworkConfig, account: string, amount: bigint, latestLedger: number): Action {
  const { usdc, hub } = config.stellar;
  return {
    kind: "invoke",
    contract: usdc,
    fn: "approve",
    args: [
      new StellarAddress(account).toScVal(),
      new StellarAddress(hub).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
      nativeToScVal(latestLedger + APPROVAL_LEDGERS, { type: "u32" }),
    ],
  };
}

async function approval(run: Run, amount: bigint): Promise<Signed> {
  const { sequence } = await run.server.getLatestLedger();
  const prepared = await prepare(approvalAction(run.config, run.account, amount, sequence), {
    owner: run.owner.address,
    network: run.config,
    server: run.server,
  });
  return sign(prepared, run.owner);
}

async function allowance(run: Run): Promise<string> {
  const { usdc, hub } = run.config.stellar;
  const value = await readContract(
    usdc,
    "allowance",
    [new StellarAddress(run.account).toScVal(), new StellarAddress(hub).toScVal()],
    run.config,
    run.server,
  );
  return renderArg(value);
}

/** The first call from an account: the account is deployed on the way. */
async function firstCall(run: Run): Promise<void> {
  heading("A call from the account, signed with the Ethereum key");
  const signed = await approval(run, HONEST_AMOUNT);
  showCalls("wallet", signed.calls);
  line("signed by", run.owner.address);

  const { hash, deployHash } = await submit(run, signed);
  if (deployHash) {
    line("deployed", deployHash);
    line("", stellarTxUrl(deployHash, run.config));
  }
  line("executed", hash);
  line("", stellarTxUrl(hash, run.config));

  const owner = await ownerOf(run.account, run.config, run.server);
  if (owner !== run.owner.address) {
    throw new Error(`The account names ${owner} as its owner, not ${run.owner.address}`);
  }
  line("owner()", `${owner}, as stored in the account contract`);
  line("allowance", `${await allowance(run)}, read back from USDC`);
}

function rendered(value: xdr.ScVal): string {
  switch (value.type) {
    case "scvError":
      return value.error.type === "sceContract"
        ? `Error(Contract, #${value.error.contractCode})`
        : `Error(${value.error.type.slice(3)}, ${value.error.code.name})`;
    case "scvVec":
      return `[${(value.vec ?? []).map(rendered).join(", ")}]`;
    case "scvString":
      return JSON.stringify(renderArg(value));
    default:
      return renderArg(value);
  }
}

interface HostEvent {
  contract: string | null;
  topics: xdr.ScVal[];
  data: xdr.ScVal;
}

function hostEvents(events: xdr.DiagnosticEvent[] | undefined): HostEvent[] {
  return (events ?? []).map(({ event }) => ({
    contract: event.contractId ? StrKey.encodeContract(event.contractId.toBytes()) : null,
    topics: event.body.v0.topics,
    data: event.body.v0.data,
  }));
}

/**
 * Finds, in the network's record of a failed transaction, the account
 * contract refusing the signature: the host reporting that `__check_auth`
 * of `account` failed, and the contract error it failed with.
 */
function accountRefusal(events: HostEvent[], account: string): { code: number; log: string } | undefined {
  for (const { topics, data } of events) {
    const isError = topics[0]?.type === "scvSymbol" && renderArg(topics[0]) === "error";
    if (!isError || data.type !== "scvVec") continue;
    const [message, who, cause] = data.vec ?? [];
    const failedAuthentication =
      message?.type === "scvString" && renderArg(message) === "failed account authentication with error";
    if (
      failedAuthentication &&
      who?.type === "scvAddress" &&
      renderArg(who) === account &&
      cause?.type === "scvError" &&
      cause.error.type === "sceContract"
    ) {
      return { code: cause.error.contractCode, log: rendered(data) };
    }
  }
  return undefined;
}

const ACCOUNT_ERRORS: Record<number, string> = { 1: "UnsupportedContext", 2: "BadSignature", 3: "BadRecoveryId" };

function signedOperation(signed: Signed): xdr.Operation {
  const { func, auth } = relayRequest(signed);
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.fromXdr(func, "base64"),
    auth: auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64")),
  });
}

/**
 * Sends a transaction the network is known to refuse, so that the refusal is
 * on record.
 *
 * A transaction needs its footprint and fees declared up front, and those
 * normally come from simulating it, which fails for a call the account will
 * refuse. The honest call touches the same ledger entries and does strictly
 * more work, so its simulation supplies them, with headroom.
 */
async function submitRefused(run: Run, honest: Signed, tampered: Signed): Promise<rpc.Api.GetFailedTransactionResponse> {
  const source = requireSource(run);
  const { networkPassphrase } = run.config.stellar;
  const account = await run.server.getAccount(source.publicKey());
  const build = (operation: xdr.Operation, fee: string, data?: xdr.SorobanTransactionData) => {
    const builder = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
      fee,
      networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(120);
    return (data ? builder.setSorobanData(data) : builder).build();
  };

  const simulation = await run.server.simulateTransaction(build(signedOperation(honest), "1000"));
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error("The honest call did not simulate, so there is no footprint to submit the changed one with");
  }
  const measured = simulation.transactionData.build();
  const { instructions, diskReadBytes, writeBytes } = measured.resources;
  const resourceFee = BigInt(simulation.minResourceFee) * 2n;
  const data = new SorobanDataBuilder(measured)
    .setResources(Math.ceil(instructions * 1.25), diskReadBytes, writeBytes)
    .setResourceFee(resourceFee.toString())
    .build();

  const fee = resourceFee + 1000n;
  line("fee", `${formatXlm(fee)} at most for a transaction sent to fail, twice what the honest call simulates at`);
  const tx = build(signedOperation(tampered), fee.toString(), data);
  tx.sign(source);
  const sent = await run.server.sendTransaction(tx);
  if (sent.status !== "PENDING") {
    throw new Error(`The network did not take the transaction (${sent.status} ${sent.errorResult?.result.type ?? ""})`);
  }
  const result = await run.server.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: rpc.BasicSleepStrategy });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} succeeded: the account accepted a call that was never signed`);
  }
  if (result.status !== rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(`Transaction ${sent.hash} was sent and its result is not known yet`);
  }
  return result;
}

/** One signature, a different amount: refused by simulation, by the relayer, and on chain. */
async function refusal(run: Run): Promise<void> {
  heading("The same signature over a different amount");
  const honest = await approval(run, HONEST_AMOUNT);
  const tampered = withArgument(honest, 2, nativeToScVal(TAMPERED_AMOUNT, { type: "i128" }));
  const [tamperedEntry] = tampered.entries;
  const call = xdr.SorobanAuthorizationEntry.fromXdr(tamperedEntry!, "base64").rootInvocation.function;
  if (call.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("The changed call is not a contract call");
  }
  showCalls("signed", honest.calls);
  showCalls("submitted", [{ ...honest.calls[0]!, args: call.contractFn.args.map(renderArg) }]);

  const simulated = await simulateSigned(tampered, { network: run.config, server: run.server }).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(simulated instanceof SimulationError)) {
    throw new Error("The network would accept a call that was never signed");
  }
  const refusedBy = /failed account authentication[^\n]*(Error\(Contract, #\d+\))/.exec(simulated.detail)?.[1];
  line("simulation", `refused, ${refusedBy ? `account answered ${refusedBy}` : simulated.detail.split("\n", 1)[0]}`);

  if (run.relayerUrl) {
    const declined = await relay(tampered, `${run.relayerUrl}/api/relay`).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(declined instanceof RelayError)) {
      throw new Error("The relayer sent a call that was never signed");
    }
    line("relayer", `${declined.status} ${declined.code}: ${declined.detail ?? ""}`);
  }

  if (!run.source) {
    line("on chain", "skipped: set PASO_E2E_SOURCE_SECRET to submit the refused transaction from your own account");
    return;
  }
  const failed = await submitRefused(run, honest, tampered);
  const hash = failed.txHash;
  line("on chain", `${hash}  ${failed.status}`);
  line("", stellarTxUrl(hash, run.config));

  const { result } = failed.resultXdr;
  const operationResult = result.type === "txFailed" ? result.results[0] : undefined;
  const invoke = operationResult?.type === "opInner" ? operationResult.tr : undefined;
  const outcome = invoke?.type === "invokeHostFunction" ? invoke.invokeHostFunctionResult.type : "unknown";
  line("result", `${result.type}, ${outcome}`);

  const refused = accountRefusal(hostEvents(failed.diagnosticEventsXdr), run.account);
  if (!refused) {
    throw new Error(`Transaction ${hash} failed, but not because the account refused the signature`);
  }
  line("cause", `__check_auth of ${run.account} returned Error(Contract, #${refused.code})`);
  line("", `${ACCOUNT_ERRORS[refused.code] ?? "an unknown error"}: the call that ran is not the call that was signed`);
  line("host log", refused.log);
  if (refused.code !== 2) {
    throw new Error(`Expected BadSignature (#2) and the account answered #${refused.code}`);
  }
}

function evmClients(run: Run, payer: PrivateKeyAccount) {
  const { chain } = run.config.evm;
  const transport = baseTransport();
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: payer, chain, transport }),
  };
}

/** USDC leaves Base for the owner's Stellar account. Returns the burn transaction. */
async function fund(run: Run, options: Options, payer: PrivateKeyAccount): Promise<Hex> {
  const amount = run.options.burn;
  heading(`${formatEvmAmount(amount)} USDC leaves ${run.config.evm.chain.name} for the account`);
  if (options.fund === "demo") {
    const { status, body } = await postJson(`${run.relayerUrl}/api/demo/fund`, { owner: run.owner.address });
    if (status !== 200 || typeof body.burnTxHash !== "string") {
      throw new Error(`The demo faucet declined (${status} ${String(body.error)}): ${String(body.detail)}`);
    }
    line("paid by", "the relayer's demo faucet");
    line("burned", body.burnTxHash);
    line("", evmTxUrl(body.burnTxHash, run.config));
    return body.burnTxHash as Hex;
  }

  const clients = evmClients(run, payer);
  const held = await clients.publicClient.readContract({
    address: run.config.evm.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payer.address],
  });
  if (held < amount) {
    const faucet = run.config.name === "testnet" ? " (https://faucet.circle.com)" : "";
    throw new Error(
      `${payer.address} holds ${formatEvmAmount(held)} USDC on ${run.config.evm.chain.name}; it needs ` +
        `${formatEvmAmount(amount)} and some ETH for gas${faucet}`,
    );
  }
  // The burn is estimated as soon as the approval is mined. Behind a public
  // endpoint the node that answers may still be a block behind and see no
  // allowance yet, so each receipt is given a second confirmation.
  const publicClient: EvmReader = {
    readContract: clients.publicClient.readContract,
    waitForTransactionReceipt: (args) => clients.publicClient.waitForTransactionReceipt({ ...args, confirmations: 2 }),
  };
  const { burnTxHash, approveTxHash, route, maxFee } = await fundFromEvm({
    walletClient: clients.walletClient,
    publicClient,
    amount,
    owner: run.owner.address,
    network: run.config,
  });
  line("paid by", payer.address);
  if (approveTxHash) {
    line("approved", approveTxHash);
    line("", evmTxUrl(approveTxHash, run.config));
  }
  line("burned", `${burnTxHash}  (route ${route}, fee cap ${formatEvmAmount(maxFee)} USDC)`);
  line("", evmTxUrl(burnTxHash, run.config));
  return burnTxHash;
}

/** Waits for Circle to attest a burn, printing each change of state. */
async function attested(run: Run, sourceDomain: number, txHash: string): Promise<Attestation> {
  const started = Date.now();
  let last = "";
  const attestation = await waitForAttestation(sourceDomain, txHash, run.config, {
    signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
    onStatus: (status) => {
      const text = status.state === "pending" && status.delayReason ? `pending (${status.delayReason})` : status.state;
      if (text !== last) {
        line("circle", `${text} after ${Math.round((Date.now() - started) / 1000)} s`);
        last = text;
      }
    },
  });
  line("attested", `in ${Math.round((Date.now() - started) / 1000)} s`);
  return attestation;
}

async function deliver(run: Run, burnTxHash: Hex, attestation: Attestation): Promise<void> {
  const { cctpDomain } = run.config.evm;
  const route = inboundRouteOf(attestation.message, run.config);

  let hash: string | undefined;
  if (run.relayerUrl) {
    for (;;) {
      const { status, body } = await postJson(`${run.relayerUrl}/api/cctp/deliver`, {
        network: run.config.name,
        sourceDomain: cctpDomain,
        txHash: burnTxHash,
      });
      if (status !== 200) {
        throw new Error(`The relayer could not deliver (${status} ${String(body.error)}): ${String(body.detail)}`);
      }
      if (body.status === "delivered") {
        hash = typeof body.hash === "string" ? body.hash : undefined;
        break;
      }
      await sleep(POLL_MS);
    }
  } else {
    const source = requireSource(run);
    const delivery = { message: attestation.message, attestation: attestation.attestation, caller: source.publicKey() };
    await quote(run, "for the delivery", deliverOperation(delivery, run.config));
    ({ hash } = await deliverWith(attestation, source, run.config, run.server));
  }

  if (hash) {
    line("delivered", `${hash}  (route ${route})`);
    line("", stellarTxUrl(hash, run.config));
  } else {
    line("delivered", `by someone else first (route ${route})`);
  }
}

function recipient(config: NetworkConfig, to: string | undefined): { address: string; note: string } {
  if (to === undefined) {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    return {
      address: twinAddress(stranger, config),
      note: `the account of ${stranger}, an Ethereum address with no Stellar account yet`,
    };
  }
  if (isAddress(to, { strict: false })) {
    return { address: twinAddress(to, config), note: `the account of ${to}` };
  }
  if (StrKey.isValidContract(to) || StrKey.isValidEd25519PublicKey(to)) {
    return { address: to, note: "as given" };
  }
  return usage(`--to must be a Stellar address (G… or C…) or an Ethereum address (0x…), not ${to}`);
}

/**
 * Whoever pays on Base when it is not the owner: for the burn when there is
 * no faucet, and for the mint that ends the way back. On mainnet the owner
 * pays and no other key is looked at.
 */
function basePayer(config: NetworkConfig): PrivateKeyAccount | undefined {
  if (config.name === "mainnet") return undefined;
  const key = privateKey("PASO_E2E_PAYER_KEY") ?? privateKey("DEMO_PAYER_PRIVATE_KEY");
  return key ? privateKeyToAccount(key) : undefined;
}

/** Base → the account → another account → back to Base. */
async function journey(run: Run, options: Options): Promise<void> {
  const payer = basePayer(run.config) ?? run.owner;
  const before = await usdcBalance(run.account, run.config, run.server);

  const burnTxHash = await fund(run, options, payer);
  const inbound = await attested(run, run.config.evm.cctpDomain, burnTxHash);
  const burn = decodeBurnMessage(inbound.message);
  line("fee", `${formatEvmAmount(burn.feeExecuted)} USDC kept by Circle`);

  heading("The USDC is delivered on Stellar");
  await deliver(run, burnTxHash, inbound);
  const balance = await usdcBalance(run.account, run.config, run.server);
  line("balance", `${formatStellarAmount(balance)} USDC in ${run.account} (was ${formatStellarAmount(before)})`);
  line("deployed", (await isDeployed(run.owner.address, run.config, run.server)) ? "yes" : "not yet: it holds USDC all the same");
  if (balance - before <= 0n) {
    throw new Error("The account's balance did not grow");
  }

  const { address: to, note } = recipient(run.config, options.to);
  heading(`${formatStellarAmount(options.transfer)} USDC to another Stellar address`);
  line("to", `${to}  (${note})`);
  const transfer = await sign(
    await prepare(
      { kind: "transfer", to, amount: options.transfer },
      { owner: run.owner.address, network: run.config, server: run.server },
    ),
    run.owner,
  );
  showCalls("wallet", transfer.calls);
  const sent = await submit(run, transfer);
  if (sent.deployHash) {
    line("deployed", sent.deployHash);
    line("", stellarTxUrl(sent.deployHash, run.config));
  }
  line("executed", sent.hash);
  line("", stellarTxUrl(sent.hash, run.config));
  line("received", `${formatStellarAmount(await usdcBalance(to, run.config, run.server))} USDC in ${to}`);

  heading(`${formatStellarAmount(options.exit)} USDC back to ${run.config.evm.chain.name}`);
  const exit = await sign(
    await prepare(
      { kind: "exit", amount: options.exit, recipient: run.owner.address },
      { owner: run.owner.address, network: run.config, server: run.server },
    ),
    run.owner,
  );
  showCalls("wallet", exit.calls);
  const left = await submit(run, exit);
  line("executed", left.hash);
  line("", stellarTxUrl(left.hash, run.config));
  line("balance", `${formatStellarAmount(await usdcBalance(run.account, run.config, run.server))} USDC left in the account`);

  // Circle indexes a burn made on Stellar under the bare transaction hash.
  const outbound = await attested(run, run.config.stellar.cctpDomain, left.hash);
  const message = decodeBurnMessage(outbound.message);
  line("message", `${formatEvmAmount(message.amount)} USDC for 0x${message.mintRecipient.slice(-40)} on CCTP domain ${message.destinationDomain}`);

  const clients = evmClients(run, payer);
  const gas = await clients.publicClient.getBalance({ address: payer.address });
  if (gas === 0n) {
    line("mint", `attested and ready: anyone can call receiveMessage on ${run.config.evm.messageTransmitter}`);
    return;
  }
  const mint = {
    address: run.config.evm.messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [outbound.message, outbound.attestation],
  } as const;
  const mintGas = await clients.publicClient.estimateContractGas({ ...mint, account: payer.address });
  const { maxFeePerGas } = await clients.publicClient.estimateFeesPerGas();
  line("fee", `${formatEther(mintGas * maxFeePerGas)} ETH at most for the mint, simulated, paid by ${payer.address}`);
  const mintTxHash = await clients.walletClient.writeContract(mint);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: mintTxHash });
  if (receipt.status !== "success") {
    throw new Error(`The mint on ${run.config.evm.chain.name} reverted: ${mintTxHash}`);
  }
  line("minted", mintTxHash);
  line("", evmTxUrl(mintTxHash, run.config));
}

/** Stops the run when a chain does not say what the configuration says. */
function expectSame(what: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${what}: the configuration says ${expected}, the chain says ${actual}`);
  }
}

/** Circle's three contracts on Stellar have to name each other, name Base, and be running. */
async function checkStellarCircle(config: NetworkConfig, server: rpc.Server): Promise<void> {
  const { tokenMessenger, messageTransmitter, forwarder, cctpDomain } = config.stellar;
  const { chain, cctpDomain: evmDomain } = config.evm;
  const read = async (contract: string, fn: string, ...args: xdr.ScVal[]) =>
    renderArg(await readContract(contract, fn, args, config, server));

  expectSame("The message transmitter of Circle's forwarder", await read(forwarder, "get_message_transmitter"), messageTransmitter);
  expectSame("The token messenger of Circle's forwarder", await read(forwarder, "get_token_messenger_minter"), tokenMessenger);
  expectSame(
    "The message transmitter of Circle's token messenger",
    await read(tokenMessenger, "get_local_message_transmitter"),
    messageTransmitter,
  );
  expectSame("Stellar's CCTP domain", await read(messageTransmitter, "get_local_domain"), String(cctpDomain));
  expectSame(
    `The token messenger Stellar knows for ${chain.name}`,
    await read(tokenMessenger, "get_remote_token_messenger", xdr.ScVal.scvU32(evmDomain)),
    pad(config.evm.tokenMessenger),
  );
  for (const contract of [forwarder, tokenMessenger, messageTransmitter]) {
    expectSame(`Whether ${contract} is paused`, await read(contract, "paused"), "false");
  }
  line("stellar", `forwarder, token messenger and message transmitter name each other; none is paused`);
  line("", `domain ${cctpDomain}, with ${chain.name} registered as domain ${evmDomain}`);
}

const tokenMessengerRoutingAbi = [
  {
    type: "function",
    name: "localMessageTransmitter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "remoteTokenMessengers",
    stateMutability: "view",
    inputs: [{ name: "domain", type: "uint32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const baseTransport = () => http(process.env.BASE_RPC_URL?.trim() || undefined);

/** Reads Base, including what it charges for posting a transaction's data to Ethereum. */
function baseReader(config: NetworkConfig) {
  return createPublicClient({ chain: config.evm.chain, transport: baseTransport() }).extend(publicActionsL2());
}

type BaseReader = ReturnType<typeof baseReader>;

/** The endpoint has to serve the right chain, and Circle's contracts there have to name each other and Stellar. */
async function checkBaseCircle(config: NetworkConfig, base: BaseReader): Promise<void> {
  const { chain, tokenMessenger, messageTransmitter } = config.evm;
  const chainId = await base.getChainId();
  if (chainId !== chain.id) {
    throw new Error(`The Base endpoint serves chain ${chainId}, not ${chain.name} (${chain.id}); check BASE_RPC_URL`);
  }
  const routing = { address: tokenMessenger, abi: tokenMessengerRoutingAbi } as const;
  expectSame(
    `The message transmitter of Circle's token messenger on ${chain.name}`,
    await base.readContract({ ...routing, functionName: "localMessageTransmitter" }),
    messageTransmitter,
  );
  expectSame(
    `The token messenger ${chain.name} knows for Stellar`,
    await base.readContract({ ...routing, functionName: "remoteTokenMessengers", args: [config.stellar.cctpDomain] }),
    toHex(StrKey.decodeContract(config.stellar.tokenMessenger)),
  );
  line("base", `token messenger and message transmitter name each other on ${chain.name} (chain ${chain.id})`);
  line("", `Stellar is registered as domain ${config.stellar.cctpDomain}`);
}

/** Who is involved in a run, by address: enough to read and simulate, not to sign. */
interface Parties {
  /** The Ethereum address whose Stellar account the run is about. */
  owner: Address;
  /** Pays on Base: the burn, and the mint that ends the way back. */
  payer: Address;
  /** Pays the fees on Stellar. */
  source: string;
}

interface EvmCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * The calls `fundFromEvm` makes for a burn, in order. It runs here against a
 * wallet that records each call instead of sending it, so what is simulated
 * is what a run sends.
 */
async function burnCalls(
  config: NetworkConfig,
  base: BaseReader,
  { owner, payer }: Parties,
  amount: bigint,
): Promise<{ calls: EvmCall[]; maxFee: bigint }> {
  const calls: EvmCall[] = [];
  const walletClient = {
    account: { address: payer, type: "json-rpc" },
    writeContract: async (call: EvmCall) => {
      calls.push(call);
      return zeroHash;
    },
  } as unknown as WalletClient;
  const publicClient = {
    readContract: base.readContract,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as EvmReader;
  const { maxFee } = await fundFromEvm({ walletClient, publicClient, amount, owner, network: config });
  return { calls, maxFee };
}

/** Gives `holder` the USDC and the allowance of a burn, for the length of one simulation. */
function fundedForBurn(config: NetworkConfig, holder: Address, amount: bigint): StateOverride {
  const slotOf = (key: Address, slot: Hex) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [key, slot]));
  const balance = slotOf(holder, numberToHex(USDC_BALANCES_SLOT, { size: 32 }));
  const allowance = slotOf(config.evm.tokenMessenger, slotOf(holder, numberToHex(USDC_ALLOWANCES_SLOT, { size: 32 })));
  const value = numberToHex(amount, { size: 32 });
  return [
    {
      address: config.evm.usdc,
      stateDiff: [
        { slot: balance, value },
        { slot: allowance, value },
      ],
    },
  ];
}

/**
 * What `payer` sends on Base for the account of `owner`, and what it has to
 * hold for it. Returns the USDC that reaches Stellar, in 7-decimal units,
 * once Circle has kept its fee.
 */
async function planBase(
  config: NetworkConfig,
  base: BaseReader,
  parties: Parties,
  options: Options,
  waiting: string[],
): Promise<bigint> {
  const { owner, payer } = parties;
  const { chain, usdc, tokenMessenger } = config.evm;
  const amount = options.burn;
  const [eth, held, allowance] = await Promise.all([
    base.getBalance({ address: payer }),
    base.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    base.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [payer, tokenMessenger] }),
  ]);
  line("payer", `${payer}${payer === owner ? ", the owner," : ""} holds ${formatEther(eth)} ETH and ${formatEvmAmount(held)} USDC`);
  line("", evmAddressUrl(payer, config));

  const hasHub = config.stellar.hub !== "";
  const planned = hasHub ? config : { ...config, stellar: { ...config.stellar, hub: PLACEHOLDER_HUB } };
  const { calls, maxFee } = await burnCalls(planned, base, parties, amount);
  const asIfFunded = held < amount || allowance < amount;

  let gas = MINT_GAS_ALLOWANCE;
  let dataFee = 0n;
  for (const call of calls) {
    const isBurn = call.address === tokenMessenger;
    const label = isBurn ? "burn" : "approve";
    const what = `${isBurn ? "TokenMessenger" : "USDC"}.${call.functionName}`;
    try {
      const callGas = await base.estimateContractGas({
        ...call,
        account: payer,
        stateOverride: isBurn && asIfFunded ? fundedForBurn(config, payer, amount) : undefined,
      });
      const callDataFee = await base.estimateL1Fee({
        account: payer,
        to: call.address,
        data: encodeFunctionData(call),
        gas: callGas,
      });
      gas += callGas;
      // The mint that ends the journey posts about as much data as the burn.
      dataFee += isBurn ? callDataFee * 2n : callDataFee;
      line(label, `${what}  ${callGas} gas, simulated`);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0]!;
      line(label, `${what}  does not simulate: ${reason}`);
      waiting.push(`the ${label} on ${chain.name} does not simulate: ${reason}`);
    }
    if (isBurn) {
      line("", `${formatEvmAmount(amount)} USDC to Stellar by fast transfer, fee cap ${formatEvmAmount(maxFee)} USDC`);
      if (asIfFunded) line("", "simulated as if the payer already held the USDC and had approved it");
      if (!hasHub) line("", "simulated towards a placeholder: the account address follows from the hub");
    }
  }
  line("mint", `MessageTransmitter.receiveMessage  ${MINT_GAS_ALLOWANCE} gas allowed`);
  line("", "not simulated: it needs Circle's attestation of the exit");

  const { maxFeePerGas } = await base.estimateFeesPerGas();
  const needsEth = 2n * (gas * maxFeePerGas + dataFee);
  line("gas", `${formatGwei(maxFeePerGas)} gwei at most, and ${formatEther(dataFee)} ETH for the data posted to Ethereum`);
  line("needs", `${formatEvmAmount(amount)} USDC and ${formatEther(needsEth)} ETH, twice what these transactions come to`);
  if (held < amount) {
    waiting.push(`${payer} holds ${formatEvmAmount(held)} USDC on ${chain.name} and needs ${formatEvmAmount(amount)}`);
  }
  if (eth < needsEth) {
    waiting.push(`${payer} holds ${formatEther(eth)} ETH on ${chain.name} and needs ${formatEther(needsEth)}`);
  }
  return toStellarUnits(amount - maxFee);
}

/** What the fee payer sends on Stellar and what it has to hold for it. */
async function planStellar(
  config: NetworkConfig,
  server: rpc.Server,
  { owner, source }: Parties,
  options: Options,
  arriving: bigint,
  waiting: string[],
): Promise<void> {
  const { stellar } = config;
  const balance = await xlmBalance(server, source);
  line("payer", `${source} ${balance === null ? "does not exist on chain yet" : `holds ${formatXlm(balance)}`}`);
  line("", stellarAddressUrl(source, config));

  if (stellar.hub === "") {
    line("stops", `Paso has no hub on ${config.name} yet, so there is no account to simulate a call from`);
    waiting.push(`Paso has no hub on ${config.name}: scripts/deploy.sh ${config.name} deploys it`);
  } else {
    const account = twinAddress(owner, config);
    const context = { owner, network: config };
    let simulated = 0n;
    const estimate = async (label: string, what: string, operation: xdr.Operation): Promise<void> => {
      const fee = await simulatedFee(server, stellar.networkPassphrase, source, operation);
      simulated += fee;
      line(label, `${what}  ${formatXlm(fee)} at most, simulated`);
    };

    if (await isDeployed(owner, config, server)) line("deploy", "nothing to send: the account exists");
    else await estimate("deploy", "hub.deploy", deployOperation(owner, config));

    if (!options.stellarOnly) {
      line("deliver", "CctpForwarder.mint_and_forward  not simulated: it needs Circle's attestation of the burn");
      const held = await usdcBalance(account, config, server);
      const leaving = options.transfer + options.exit;
      if (held < leaving) {
        line("transfer", `USDC.transfer  not simulated: the account holds ${formatStellarAmount(held)} USDC until the delivery`);
        line("exit", "hub.exit  not simulated, for the same reason");
      } else {
        const { address: to } = recipient(config, options.to);
        const transfer: Action = { kind: "transfer", to, amount: options.transfer };
        const exit: Action = { kind: "exit", amount: options.exit, recipient: owner };
        await estimate("transfer", "USDC.transfer", await buildOperation(transfer, context));
        await estimate("exit", "hub.exit", await buildOperation(exit, context));
      }
      if (held + arriving < leaving) {
        waiting.push(
          `the account would hold ${formatStellarAmount(held + arriving)} USDC after the delivery, less than the ` +
            `${formatStellarAmount(leaving)} the transfer and the exit take: burn more or send less`,
        );
      }
    }

    const { sequence } = await server.getLatestLedger();
    const approve = approvalAction(config, account, HONEST_AMOUNT, sequence);
    await estimate("approve", "USDC.approve", await buildOperation(approve, context));
    line("refusal", "the same call with another amount, sent to fail: at most twice the approval");
    line("so far", `${formatXlm(simulated)}, simulated unsigned; a run simulates each call again once it is signed`);
  }

  const needs = MINIMUM_BALANCE + STELLAR_FEE_ALLOWANCE;
  line("needs", `${formatXlm(needs)}: the ${formatXlm(MINIMUM_BALANCE)} every account keeps, and ${formatXlm(STELLAR_FEE_ALLOWANCE)} for fees`);
  if ((balance ?? 0n) < needs) {
    waiting.push(`${source} holds ${formatXlm(balance ?? 0n)} on Stellar and needs ${formatXlm(needs)}`);
  }
}

/**
 * Everything a run reads before it spends: Circle's contracts on both chains,
 * what the two accounts hold, and what the run would send. Returns what the
 * run is still waiting for; with nothing in the list it can start.
 */
async function plan(
  config: NetworkConfig,
  server: rpc.Server,
  options: Options,
  parties: Parties,
): Promise<string[]> {
  const waiting: string[] = [];
  const { evm, stellar } = config;

  heading("Circle's contracts, read from both chains");
  await checkStellarCircle(config, server);
  let arriving = 0n;
  if (!options.stellarOnly) {
    const base = baseReader(config);
    await checkBaseCircle(config, base);
    const inbound = await fetchBurnFee(evm.cctpDomain, stellar.cctpDomain, config);
    const outbound = await fetchBurnFee(stellar.cctpDomain, evm.cctpDomain, config);
    line("circle", `fast transfers cost ${inbound} bps towards Stellar and ${outbound} bps back (${config.irisUrl})`);

    heading(`${evm.chain.name}: what the payer sends`);
    arriving = await planBase(config, base, parties, options, waiting);
  }

  heading("Stellar: what the fee payer sends");
  await planStellar(config, server, parties, options, arriving, waiting);
  return waiting;
}

function report(waiting: string[]): void {
  console.log("\nA run cannot start yet:");
  for (const reason of waiting) console.log(`    - ${reason}`);
}

/** Every read and simulation of a run, and nothing else. */
async function dryRun(config: NetworkConfig, server: rpc.Server, options: Options): Promise<void> {
  const ownerKey = privateKey("PASO_E2E_OWNER_KEY");
  const secret = process.env.PASO_E2E_SOURCE_SECRET?.trim();
  const owner =
    options.owner ??
    (ownerKey ? privateKeyToAccount(ownerKey).address : undefined) ??
    (options.stellarOnly ? privateKeyToAccount(generatePrivateKey()).address : undefined) ??
    usage("A dry run needs the owner: set PASO_E2E_OWNER_KEY or pass --owner <0x…>");
  const source =
    options.source ??
    (secret ? Keypair.fromSecret(secret).publicKey() : undefined) ??
    usage("A dry run needs the Stellar fee payer: set PASO_E2E_SOURCE_SECRET or pass --source <G…>");

  const hasHub = config.stellar.hub !== "";
  const account = hasHub ? twinAddress(owner, config) : undefined;
  console.log(`Paso on ${config.name}, dry run${options.stellarOnly ? ", Stellar side only" : ""}: nothing is signed, nothing is sent`);
  console.log(`\n    owner      ${owner}`);
  console.log(`    account    ${account ?? "not known until the hub is deployed"}`);
  if (account) {
    console.log(`               ${stellarAddressUrl(account, config)}`);
    console.log(`    deployed   ${(await isDeployed(owner, config, server)) ? "yes" : "no"}`);
  }
  console.log(`    fees       paid by ${source}`);

  const payer = basePayer(config)?.address ?? owner;
  const waiting = await plan(config, server, options, { owner, payer, source });
  if (waiting.length > 0) report(waiting);
  else console.log("\nA run can start: both accounts hold what it needs.");
  console.log("\nNothing was sent.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mainnet = options.network === "mainnet";
  // That file holds the web app's testnet keys and endpoints: a mainnet run takes nothing from it.
  const envFile = resolve(process.cwd(), "apps/web/.env.local");
  if (!mainnet && existsSync(envFile)) process.loadEnvFile(envFile);

  const config = resolveNetwork(options.network);
  const server = new rpc.Server(config.stellar.rpcUrl);
  if (options.dryRun) {
    await dryRun(config, server, options);
    return;
  }

  const ownerKey = options.stellarOnly ? undefined : privateKey("PASO_E2E_OWNER_KEY");
  if (!options.stellarOnly && !ownerKey && options.fund === "burn") {
    usage(
      mainnet
        ? "Set PASO_E2E_OWNER_KEY to the key that owns the account and pays on Base"
        : "Set PASO_E2E_OWNER_KEY, or use --relayer <url> --fund demo to start from a fresh key",
    );
  }
  const owner = privateKeyToAccount(ownerKey ?? generatePrivateKey());
  const secret = process.env.PASO_E2E_SOURCE_SECRET?.trim();
  const source = secret ? Keypair.fromSecret(secret) : undefined;
  if (!source && !options.relayerUrl) {
    usage(
      mainnet
        ? "Set PASO_E2E_SOURCE_SECRET to the Stellar account that pays the fees"
        : "Set PASO_E2E_SOURCE_SECRET to a funded Stellar account, or pass --relayer <url>",
    );
  }

  const run: Run = {
    config,
    server,
    options,
    owner,
    account: twinAddress(owner.address, config),
    source,
    relayerUrl: options.relayerUrl,
  };

  console.log(`Paso on ${config.name}${options.stellarOnly ? ", Stellar side only" : ""}`);
  console.log(`\n    owner      ${owner.address}${ownerKey ? "" : "  (a fresh key)"}`);
  console.log(`    account    ${run.account}`);
  console.log(`               ${stellarAddressUrl(run.account, config)}`);
  console.log(`    deployed   ${(await isDeployed(owner.address, config, server)) ? "yes" : "no"}`);
  console.log(`    fees       ${run.relayerUrl ? `paid by the relayer at ${run.relayerUrl}` : `paid by ${source!.publicKey()}`}`);

  // Real funds: nothing is sent until both chains and both accounts have been looked at.
  if (mainnet) {
    const parties = { owner: owner.address, payer: owner.address, source: source!.publicKey() };
    const waiting = await plan(config, server, options, parties);
    if (waiting.length > 0) {
      report(waiting);
      throw new Error("Nothing was sent.");
    }
    console.log("\n    Both accounts hold what the run needs. From here on it sends.");
  }

  const held = source ? await xlmBalance(server, source.publicKey()) : null;
  if (!options.stellarOnly) {
    await journey(run, options);
  }
  await firstCall(run);
  await refusal(run);
  if (source && held !== null) {
    const left = (await xlmBalance(server, source.publicKey())) ?? 0n;
    console.log(`\n    fees       ${formatXlm(held - left)} paid on Stellar by ${source.publicKey()}, ${formatXlm(left)} left`);
  }
  console.log("\nDone.");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
