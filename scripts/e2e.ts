/**
 * Paso, end to end, on testnet or on mainnet.
 *
 *   pnpm e2e --stellar-only [--relayer <url>]
 *   pnpm e2e [--chain <name>] [--relayer <url>] [--fund demo|burn] [--to <address>]
 *   pnpm e2e --network mainnet [--chain <name>] [--burn 1] [--transfer 0.1] [--exit 0.5] [--to <address>]
 *   pnpm e2e --network mainnet --dry-run [--chain <name>] [--owner <0x…>] [--source <G…>]
 *   pnpm e2e [--resume-burn <evm tx>] [--skip-fund] [--skip-transfer] [--resume-exit <stellar tx>] [--skip-exit]
 *
 * `--chain` names the EVM side of the run: base (the default), ethereum,
 * arbitrum, optimism or arc; on testnet their test networks. On Arc the gas
 * is paid in USDC, out of the same balance the transfer leaves.
 *
 * `--stellar-only` needs no USDC. It takes a fresh Ethereum key, makes the
 * first call from its Stellar account (which deploys the account), and then
 * shows the refusal: a signature made for one amount, submitted with another,
 * recorded on chain as a failed transaction.
 *
 * Without the flag it runs the whole journey for the owner key: USDC leaves
 * the EVM chain, Circle attests the burn, it is delivered to the owner's
 * Stellar account, part of it is sent on to another account, part of it goes
 * back to the same chain, and the refusal closes the run. Every transaction is printed with its
 * explorer link. `--burn`, `--transfer` and `--exit` set the three amounts in
 * USDC; they default to 1, 0.1 and 0.5.
 *
 * With `--relayer <url>` the Stellar transactions go through that relayer's
 * API and it pays their fees. Without it, the account in
 * `PASO_E2E_SOURCE_SECRET` pays: nothing here depends on a particular relayer.
 *
 * `--network mainnet` runs the same journey between Stellar mainnet and the
 * chain with real funds, and pays for itself: the owner key pays the burn and
 * the final mint, `PASO_E2E_SOURCE_SECRET` pays on Stellar, and there is
 * no faucet and no relayer. Before anything is sent the run reads Circle's
 * contracts on both chains, prints what each account needs, and stops if
 * either is short. Each Stellar transaction prints its simulated fee first.
 *
 * A run that stops half way is picked up where it stopped, and says how when
 * it stops: `--resume-burn <tx>` starts from a burn on the chain that exists and
 * delivers it unless it has been delivered; `--skip-fund` starts from the
 * USDC the account holds, with no burn and no delivery; `--skip-transfer`
 * leaves the transfer out; `--resume-exit <tx>` starts from an exit on
 * Stellar that exists and mints on the chain unless that has been done;
 * `--skip-exit` leaves the way back out. What Circle's contracts have taken
 * once they are not offered again.
 *
 * Stellar transactions are sent with a bid above the minimum on mainnet,
 * watched until they are applied or can no longer be, and sent again with a
 * higher bid when no ledger took them.
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
 *                            On mainnet it also pays on the EVM chain.
 *   PASO_E2E_SOURCE_SECRET   Secret key of any funded Stellar account. Required without --relayer,
 *                            and for the refused transaction, which no relayer will send.
 *   PASO_E2E_PAYER_KEY       Testnet: Ethereum private key that pays the burn and the mint on the
 *                            EVM chain (--fund burn). Defaults to DEMO_PAYER_PRIVATE_KEY when that is
 *                            set, else to the owner key.
 *   <CHAIN>_RPC_URL          The chain's RPC endpoint: BASE_RPC_URL, ETHEREUM_RPC_URL, ARBITRUM_RPC_URL,
 *                            OPTIMISM_RPC_URL, ARC_RPC_URL. Defaults to the public endpoints the SDK
 *                            lists for the chain.
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
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  concat,
  createWalletClient,
  encodeFunctionData,
  formatGwei,
  getAddress,
  isAddress,
  keccak256,
  size,
  slice,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  buildOperation,
  decodeBurnMessage,
  defaultFinalityOf,
  deliverOperation,
  deployOperation,
  erc20Abi,
  evmAddressUrl,
  evmChain,
  evmTxUrl,
  evmUnitsToNativeUsdc,
  FAST_FINALITY,
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
  toStellarUnits,
  twinAddress,
  usdcBalance,
  waitForAttestation,
  withArgument,
  type Action,
  type Attestation,
  type Call,
  type EvmChainConfig,
  type EvmChainName,
  type EvmReader,
  type NetworkConfig,
  type NetworkName,
  type Signed,
} from "../packages/sdk/src/index";
import { checkStellarCircle, deliveredOnStellar, stellarRecipient } from "./cctp";
import {
  chargesDataFee,
  checkEvmCircle,
  dataFee,
  evmReader,
  evmTransport,
  formatGas,
  fundedForBurn,
  parseChain,
  reportEvmCircle,
  type ChainReader,
} from "./evm";
import { describe, formatXlm, MINIMUM_BALANCE, simulatedFee, STROOPS_PER_XLM, xlmBalance } from "./fees";
import { INCLUSION_BID, sendAndWait as sendFrom, simulated, VALIDITY_SECONDS, type Applied } from "./sender";

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
 * Gas counted for `receiveMessage` on the EVM chain, which mints the USDC
 * that came back. It cannot be simulated before Circle has attested the exit.
 */
const MINT_GAS_ALLOWANCE = 300_000n;
/** The size of a CCTP burn message without hook data, and of the two signatures that attest it. */
const BURN_MESSAGE_BYTES = 376;
const ATTESTATION_BYTES = 130;
/**
 * Until a hub exists there is no account address. The burn on the chain never
 * reads the address it carries, so a dry run simulates it with an address of
 * the same size derived from this placeholder.
 */
const PLACEHOLDER_HUB = StrKey.encodeContract(Buffer.alloc(32));

interface Options {
  network: NetworkName;
  /** The EVM side of the run. */
  chain: EvmChainName;
  dryRun: boolean;
  stellarOnly: boolean;
  relayerUrl?: string;
  fund: "demo" | "burn";
  to?: string;
  /** USDC that leaves the EVM chain, in 6-decimal units. */
  burn: bigint;
  /** USDC sent on to another Stellar address, in 7-decimal units. */
  transfer: bigint;
  /** USDC sent back to the EVM chain, in 7-decimal units. */
  exit: bigint;
  /** The two addresses of a dry run, when no key names them. */
  owner?: Address;
  source?: string;
  /** A burn on the EVM chain that has happened already: the run picks up at its attestation. */
  resumeBurn?: Hex;
  /** An exit on Stellar that has happened already: the run picks up at its attestation. */
  resumeExit?: string;
  /** The account holds its USDC already: no burn and no delivery. */
  skipFund: boolean;
  skipTransfer: boolean;
  /** No exit, and so no mint on the EVM chain either. */
  skipExit: boolean;
  /** The arguments that say what the run is, not where in it to start: the command that continues a run repeats them. */
  kept: string[];
}

interface Run {
  config: NetworkConfig;
  /** The EVM chain the USDC comes from and goes back to. */
  evm: EvmChainConfig;
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
    "Usage: pnpm e2e [--network testnet|mainnet] [--chain base|ethereum|arbitrum|optimism|arc] [--dry-run]\n" +
      "                [--stellar-only] [--relayer <url>] [--fund demo|burn]\n" +
      "                [--burn <usdc>] [--transfer <usdc>] [--exit <usdc>] [--to <G…|C…|0x…>]\n" +
      "                [--resume-burn <evm tx>] [--skip-fund] [--skip-transfer] [--resume-exit <stellar tx>] [--skip-exit]\n" +
      "                [--owner <0x…>] [--source <G…>]   (dry run only)",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    network: "testnet",
    chain: parseChain(undefined, usage),
    dryRun: false,
    stellarOnly: false,
    fund: "burn",
    burn: parseEvmAmount("1"),
    transfer: parseStellarAmount("0.1"),
    exit: parseStellarAmount("0.5"),
    skipFund: false,
    skipTransfer: false,
    skipExit: false,
    kept: [],
  };
  const stages = ["--resume-burn", "--skip-fund", "--skip-transfer", "--resume-exit", "--skip-exit"];
  let fund: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const start = i;
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    const hash = (prefixed: boolean): string => {
      const text = value();
      const pattern = prefixed ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-fA-F]{64}$/;
      return pattern.test(text) ? text.toLowerCase() : usage(`${arg} takes a transaction hash, not ${text}`);
    };
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
    else if (arg === "--chain") options.chain = parseChain(value(), usage);
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
    } else if (arg === "--resume-burn") options.resumeBurn = hash(true) as Hex;
    else if (arg === "--resume-exit") options.resumeExit = hash(false);
    else if (arg === "--skip-fund") options.skipFund = true;
    else if (arg === "--skip-transfer") options.skipTransfer = true;
    else if (arg === "--skip-exit") options.skipExit = true;
    else usage(`Unknown argument ${arg}`);
    if (!stages.includes(arg)) options.kept.push(...argv.slice(start, i + 1));
  }
  // An exit that exists has the funding and the transfer behind it.
  if (options.resumeExit) {
    if (options.skipExit) usage("--resume-exit finishes an exit; --skip-exit leaves it out. Pick one");
    options.skipFund = options.resumeBurn === undefined;
    options.skipTransfer = true;
  }
  if (options.resumeBurn && options.skipFund) usage("--resume-burn delivers a burn; --skip-fund leaves it out. Pick one");
  const staged = options.resumeBurn || options.resumeExit || options.skipFund || options.skipTransfer || options.skipExit;
  if (staged && options.stellarOnly) usage("--stellar-only has no burn, transfer or exit to skip or resume");
  if (fund !== undefined && fund !== "demo" && fund !== "burn") usage("--fund takes demo or burn");
  options.fund = (fund as Options["fund"] | undefined) ?? (options.relayerUrl ? "demo" : "burn");
  if (options.fund === "demo" && !options.relayerUrl) usage("--fund demo needs --relayer, whose faucet it uses");
  if (options.fund === "demo" && options.chain !== "base") usage("--fund demo burns on Base, from the relayer's faucet; pick --fund burn");
  if (options.exit % 10n !== 0n) usage("--exit takes at most six decimals: USDC on an EVM chain cannot hold a seventh");
  if ((options.owner || options.source) && !options.dryRun) {
    usage("--owner and --source name addresses for a dry run; a real run takes its keys from the environment");
  }
  if (options.dryRun && options.relayerUrl) usage("A dry run talks to the chains only; leave --relayer out");
  if (options.network === "mainnet" && options.relayerUrl) {
    usage("On mainnet the run pays for itself: PASO_E2E_SOURCE_SECRET on Stellar, the owner key on the EVM chain");
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

/** How to pick the run up again, should it stop after the step that has just finished. */
let continuation: string | undefined;

function reached(run: Run, ...flags: string[]): void {
  continuation = ["pnpm e2e", ...run.options.kept, ...flags].join(" ");
}

/** Sends a transaction from the fee payer and waits until the network has applied it; see `sendAndWait` in sender.ts. */
function sendAndWait(
  run: Run,
  what: string,
  build: (account: Account, bid: bigint) => Promise<Transaction>,
): Promise<Applied> {
  return sendFrom(run.server, requireSource(run), run.config.name, what, build, line);
}

/**
 * Sends one operation from the fee payer: simulates it, prints the most it
 * can cost, submits it and waits for it to succeed. Returns the transaction.
 */
async function execute(run: Run, what: string, operation: xdr.Operation): Promise<string> {
  const applied = await sendAndWait(run, what, async (account, bid) => {
    const { tx, fee } = await simulated(run.server, run.config.stellar.networkPassphrase, account, operation, bid);
    line("fee", `${formatXlm(fee)} at most ${what}, simulated`);
    return tx;
  });
  if (applied.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`The transaction ${what} failed on chain: ${applied.txHash}`);
  }
  return applied.txHash;
}

/** Sends a signed call: through the relayer when there is one, from the source account otherwise. */
async function submit(run: Run, signed: Signed): Promise<{ hash: string; deployHash?: string }> {
  if (run.relayerUrl) {
    return relay(signed, `${run.relayerUrl}/api/relay`);
  }
  // hub.deploy does nothing for an account that exists, so sending it twice is harmless.
  const deployHash = (await isDeployed(signed.owner, run.config, run.server))
    ? undefined
    : await execute(run, "to deploy the account", deployOperation(signed.owner, run.config));
  // The signed entry carries a nonce the account accepts once.
  const hash = await execute(run, "for the call", signedOperation(signed));
  return deployHash ? { hash, deployHash } : { hash };
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
  const { networkPassphrase } = run.config.stellar;
  const result = await sendAndWait(run, "that is meant to fail", async (account, bid) => {
    const build = (operation: xdr.Operation, fee: bigint, data?: xdr.SorobanTransactionData) => {
      const builder = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
        fee: fee.toString(),
        networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(VALIDITY_SECONDS);
      return (data ? builder.setSorobanData(data) : builder).build();
    };

    const simulation = await run.server.simulateTransaction(build(signedOperation(honest), bid));
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

    const fee = resourceFee + bid;
    line("fee", `${formatXlm(fee)} at most for a transaction sent to fail, twice what the honest call simulates at`);
    return build(signedOperation(tampered), fee, data);
  });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${result.txHash} succeeded: the account accepted a call that was never signed`);
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
  return {
    publicClient: evmReader(run.evm),
    walletClient: createWalletClient({ account: payer, chain: run.evm.chain, transport: evmTransport(run.evm) }),
  };
}

/** USDC leaves the EVM chain for the owner's Stellar account. Returns the burn transaction. */
async function fund(run: Run, options: Options, payer: PrivateKeyAccount): Promise<Hex> {
  const amount = run.options.burn;
  const { evm } = run;
  heading(`${formatEvmAmount(amount)} USDC leaves ${evm.label} for the account`);
  if (options.fund === "demo") {
    const { status, body } = await postJson(`${run.relayerUrl}/api/demo/fund`, { owner: run.owner.address });
    if (status !== 200 || typeof body.burnTxHash !== "string") {
      throw new Error(`The demo faucet declined (${status} ${String(body.error)}): ${String(body.detail)}`);
    }
    line("paid by", "the relayer's demo faucet");
    line("burned", body.burnTxHash);
    line("", evmTxUrl(body.burnTxHash, run.config, evm.name));
    return body.burnTxHash as Hex;
  }

  const clients = evmClients(run, payer);
  const [held, native] = await Promise.all([
    clients.publicClient.readContract({ address: evm.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] }),
    clients.publicClient.getBalance({ address: payer.address }),
  ]);
  // On Arc the gas comes out of the USDC itself: the native balance is the same USDC, in 18 decimals.
  const gasLeft = evm.gasToken.isUsdc ? native - evmUnitsToNativeUsdc(amount) : native;
  if (held < amount || gasLeft <= 0n) {
    const faucets = evm.faucets ? ` (USDC: ${evm.faucets.usdc}; ${evm.gasToken.symbol}: ${evm.faucets.gas})` : "";
    throw new Error(
      `${payer.address} holds ${formatEvmAmount(held)} USDC and ${formatGas(native, evm)} on ${evm.label}; it needs ` +
        `${formatEvmAmount(amount)} USDC and some ${evm.gasToken.symbol} for gas${evm.gasToken.isUsdc ? " on top" : ""}${faucets}`,
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
    chain: evm.name,
  });
  line("paid by", payer.address);
  if (approveTxHash) {
    line("approved", approveTxHash);
    line("", evmTxUrl(approveTxHash, run.config, evm.name));
  }
  const speed = defaultFinalityOf(evm) === FAST_FINALITY ? "fast transfer" : "standard transfer";
  line("burned", `${burnTxHash}  (route ${route}, ${speed}, fee cap ${formatEvmAmount(maxFee)} USDC)`);
  line("", evmTxUrl(burnTxHash, run.config, evm.name));
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
  const { cctpDomain } = run.evm;
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
    const caller = requireSource(run).publicKey();
    const delivery = { message: attestation.message, attestation: attestation.attestation, caller };
    // Circle's contracts take a message once: its nonce is the guard.
    hash = await execute(run, "for the delivery", deliverOperation(delivery, run.config));
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

const usedNoncesAbi = [
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Whoever pays on the EVM chain when it is not the owner: for the burn when
 * there is no faucet, and for the mint that ends the way back. On mainnet the
 * owner pays and no other key is looked at.
 */
function evmPayer(config: NetworkConfig): PrivateKeyAccount | undefined {
  if (config.name === "mainnet") return undefined;
  const key = privateKey("PASO_E2E_PAYER_KEY") ?? privateKey("DEMO_PAYER_PRIVATE_KEY");
  return key ? privateKeyToAccount(key) : undefined;
}

/** The EVM chain → the account → another account → back to the EVM chain. */
async function journey(run: Run, options: Options): Promise<void> {
  const { config, server, account, evm } = run;
  const payer = evmPayer(config) ?? run.owner;
  const context = { owner: run.owner.address, network: config, server };
  const before = await usdcBalance(account, config, server);

  if (options.skipFund) {
    heading("The USDC is in the account already");
    line("skipped", `the burn on ${evm.label} and the delivery on Stellar${options.resumeExit ? "" : "  (--skip-fund)"}`);
    line("balance", `${formatStellarAmount(before)} USDC in ${account}`);
    const needed =
      (options.skipTransfer ? 0n : options.transfer) + (options.skipExit || options.resumeExit ? 0n : options.exit);
    if (before < needed) {
      throw new Error(
        `The account holds ${formatStellarAmount(before)} USDC and the steps that are left take ` +
          `${formatStellarAmount(needed)}. Run without --skip-fund to burn on ${evm.label} first`,
      );
    }
  } else {
    let burnTxHash: Hex;
    if (options.resumeBurn) {
      burnTxHash = options.resumeBurn;
      heading(`A burn on ${evm.label} that has happened already`);
      line("resumed", `${burnTxHash}  (--resume-burn)`);
      line("", evmTxUrl(burnTxHash, config, evm.name));
    } else {
      burnTxHash = await fund(run, options, payer);
    }
    reached(run, "--resume-burn", burnTxHash);

    const inbound = await attested(run, evm.cctpDomain, burnTxHash);
    const burn = decodeBurnMessage(inbound.message);
    line("fee", `${formatEvmAmount(burn.feeExecuted)} USDC kept by Circle`);
    const destination = stellarRecipient(inbound.message, config);
    if (destination !== account) {
      throw new Error(`That burn pays ${destination}, which is not ${account}, the account of ${run.owner.address}`);
    }

    heading("The USDC is delivered on Stellar");
    const delivered = await deliveredOnStellar(config, server, inbound.nonce);
    if (delivered) line("delivered", "already: Circle's message transmitter on Stellar has taken this message");
    else await deliver(run, burnTxHash, inbound);
    reached(run, "--skip-fund");
    const balance = await usdcBalance(account, config, server);
    line("balance", `${formatStellarAmount(balance)} USDC in ${account} (was ${formatStellarAmount(before)})`);
    line("deployed", (await isDeployed(run.owner.address, config, server)) ? "yes" : "not yet: it holds USDC all the same");
    if (!delivered && balance - before <= 0n) {
      throw new Error("The account's balance did not grow");
    }
  }

  if (options.skipTransfer) {
    heading("The transfer to another Stellar address");
    line("skipped", options.resumeExit ? "it came before the exit that is resumed" : "(--skip-transfer)");
  } else {
    const { address: to, note } = recipient(config, options.to);
    heading(`${formatStellarAmount(options.transfer)} USDC to another Stellar address`);
    line("to", `${to}  (${note})`);
    const transfer = await sign(await prepare({ kind: "transfer", to, amount: options.transfer }, context), run.owner);
    showCalls("wallet", transfer.calls);
    const sent = await submit(run, transfer);
    if (sent.deployHash) {
      line("deployed", sent.deployHash);
      line("", stellarTxUrl(sent.deployHash, config));
    }
    line("executed", sent.hash);
    line("", stellarTxUrl(sent.hash, config));
    line("received", `${formatStellarAmount(await usdcBalance(to, config, server))} USDC in ${to}`);
  }
  reached(run, "--skip-fund", "--skip-transfer");

  if (options.skipExit) {
    heading(`The way back to ${evm.label}`);
    line("skipped", `the exit and the mint on ${evm.label}  (--skip-exit)`);
    return;
  }

  let exitTxHash: string;
  if (options.resumeExit) {
    exitTxHash = options.resumeExit;
    heading("An exit that has happened already");
    line("resumed", `${exitTxHash}  (--resume-exit)`);
    line("", stellarTxUrl(exitTxHash, config));
  } else {
    heading(`${formatStellarAmount(options.exit)} USDC back to ${evm.label}`);
    const exit = await sign(
      await prepare({ kind: "exit", amount: options.exit, recipient: run.owner.address, destinationChain: evm.name }, context),
      run.owner,
    );
    showCalls("wallet", exit.calls);
    const left = await submit(run, exit);
    if (left.deployHash) {
      line("deployed", left.deployHash);
      line("", stellarTxUrl(left.deployHash, config));
    }
    exitTxHash = left.hash;
    line("executed", exitTxHash);
    line("", stellarTxUrl(exitTxHash, config));
    line("balance", `${formatStellarAmount(await usdcBalance(account, config, server))} USDC left in the account`);
  }
  reached(run, "--resume-exit", exitTxHash);

  // Circle indexes a burn made on Stellar under the bare transaction hash.
  const outbound = await attested(run, config.stellar.cctpDomain, exitTxHash);
  const message = decodeBurnMessage(outbound.message);
  line("message", `${formatEvmAmount(message.amount)} USDC for 0x${message.mintRecipient.slice(-40)} on CCTP domain ${message.destinationDomain}`);
  if (message.destinationDomain !== evm.cctpDomain) {
    throw new Error(`That exit goes to CCTP domain ${message.destinationDomain}, not to ${evm.label} (${evm.cctpDomain}); run with the --chain it was made for`);
  }

  const clients = evmClients(run, payer);
  const used = await clients.publicClient.readContract({
    address: evm.messageTransmitter,
    abi: usedNoncesAbi,
    functionName: "usedNonces",
    args: [outbound.nonce],
  });
  if (used !== 0n) {
    line("minted", `already: Circle's message transmitter on ${evm.label} has taken this message`);
    reached(run, "--skip-fund", "--skip-transfer", "--skip-exit");
    return;
  }
  const gas = await clients.publicClient.getBalance({ address: payer.address });
  if (gas === 0n) {
    line("mint", `attested and ready: anyone can call receiveMessage on ${evm.messageTransmitter} on ${evm.label}`);
    return;
  }
  const mint = {
    address: evm.messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [outbound.message, outbound.attestation],
  } as const;
  const mintGas = await clients.publicClient.estimateContractGas({ ...mint, account: payer.address });
  const { maxFeePerGas } = await clients.publicClient.estimateFeesPerGas();
  line("fee", `${formatGas(mintGas * maxFeePerGas, evm)} at most for the mint, simulated, paid by ${payer.address}`);
  const mintTxHash = await clients.walletClient.writeContract(mint);
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: mintTxHash });
  if (receipt.status !== "success") {
    throw new Error(`The mint on ${evm.label} reverted: ${mintTxHash}`);
  }
  line("minted", mintTxHash);
  line("", evmTxUrl(mintTxHash, config, evm.name));
  const minted = await clients.publicClient.readContract({ address: evm.usdc, abi: erc20Abi, functionName: "balanceOf", args: [run.owner.address] });
  line("balance", `${formatEvmAmount(minted)} USDC in ${run.owner.address} on ${evm.label}`);
  reached(run, "--skip-fund", "--skip-transfer", "--skip-exit");
}

/** Who is involved in a run, by address: enough to read and simulate, not to sign. */
interface Parties {
  /** The Ethereum address whose Stellar account the run is about. */
  owner: Address;
  /** Pays on the EVM chain: the burn, and the mint that ends the way back. */
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
  evm: EvmChainConfig,
  reader: ChainReader,
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
    readContract: reader.readContract,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as EvmReader;
  const { maxFee } = await fundFromEvm({ walletClient, publicClient, amount, owner, network: config, chain: evm.name });
  return { calls, maxFee };
}

/**
 * What `payer` sends on the EVM chain for the account of `owner`, and what it
 * has to hold for it. Returns the USDC that reaches Stellar, in 7-decimal
 * units, once Circle has kept its fee.
 */
async function planEvm(
  config: NetworkConfig,
  evm: EvmChainConfig,
  reader: ChainReader,
  parties: Parties,
  options: Options,
  waiting: string[],
): Promise<bigint> {
  const { owner, payer } = parties;
  const { label, usdc, tokenMessenger, messageTransmitter, gasToken } = evm;
  const amount = options.burn;
  const [native, held, allowance] = await Promise.all([
    reader.getBalance({ address: payer }),
    reader.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    reader.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [payer, tokenMessenger] }),
  ]);
  const who = `${payer}${payer === owner ? ", the owner," : ""}`;
  line(
    "payer",
    gasToken.isUsdc
      ? `${who} holds ${formatEvmAmount(held)} USDC, which also pays the gas (${formatGas(native, evm)} natively)`
      : `${who} holds ${formatGas(native, evm)} and ${formatEvmAmount(held)} USDC`,
  );
  line("", evmAddressUrl(payer, config, evm.name));

  let gas = 0n;
  let posted = 0n;
  let arriving = 0n;
  const burning = !(options.skipFund || options.resumeBurn);
  if (!burning) {
    line("burn", options.resumeBurn ? `nothing to send: ${options.resumeBurn} is resumed` : "nothing to send  (--skip-fund)");
  } else {
    const hasHub = config.stellar.hub !== "";
    const planned = hasHub ? config : { ...config, stellar: { ...config.stellar, hub: PLACEHOLDER_HUB } };
    const { calls, maxFee } = await burnCalls(planned, evm, reader, parties, amount);
    const asIfFunded = held < amount || allowance < amount;
    arriving = toStellarUnits(amount - maxFee);
    for (const call of calls) {
      const isBurn = call.address === tokenMessenger;
      const step = isBurn ? "burn" : "approve";
      const what = `${isBurn ? `TokenMessenger ${tokenMessenger}` : `USDC ${usdc}`}.${call.functionName}`;
      try {
        const callGas = await reader.estimateContractGas({
          ...call,
          account: payer,
          stateOverride: isBurn && asIfFunded ? fundedForBurn(evm, payer, amount, native) : undefined,
        });
        gas += callGas;
        posted += await dataFee(reader, evm, { account: payer, to: call.address, data: encodeFunctionData(call), gas: callGas });
        line(step, `${what}  ${callGas} gas, simulated`);
      } catch (error) {
        const reason = describe(error).split("\n", 1)[0]!;
        line(step, `${what}  does not simulate: ${reason}`);
        waiting.push(`the ${step} on ${label} does not simulate: ${reason}`);
      }
      if (isBurn) {
        const speed = defaultFinalityOf(evm) === FAST_FINALITY ? "fast transfer" : "standard transfer, attested within seconds";
        line("", `${formatEvmAmount(amount)} USDC to Stellar by ${speed}, fee cap ${formatEvmAmount(maxFee)} USDC`);
        if (asIfFunded) line("", "simulated as if the payer already held the USDC and had approved it");
        if (!hasHub) line("", "simulated towards a placeholder: the account address follows from the hub");
      }
    }
  }

  if (options.skipExit) {
    line("mint", "nothing to send  (--skip-exit)");
  } else {
    // The message does not exist yet: the data it posts is priced with bytes of its size that compress as badly.
    const data = encodeFunctionData({
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [incompressible(BURN_MESSAGE_BYTES), incompressible(ATTESTATION_BYTES)],
    });
    gas += MINT_GAS_ALLOWANCE;
    posted += await dataFee(reader, evm, { account: payer, to: messageTransmitter, data, gas: MINT_GAS_ALLOWANCE });
    line("mint", `MessageTransmitter ${messageTransmitter}.receiveMessage  ${MINT_GAS_ALLOWANCE} gas allowed`);
    line("", "not simulated: it needs Circle's attestation of the exit");
  }

  const { maxFeePerGas } = await reader.estimateFeesPerGas();
  const needsGas = 2n * (gas * maxFeePerGas + posted);
  const usdcNeeded = burning ? amount : 0n;
  line(
    "gas",
    `${formatGwei(maxFeePerGas)} gwei at most` + (chargesDataFee(evm) ? `, and ${formatGas(posted, evm)} for the data posted to Ethereum` : ""),
  );
  const faucet = (what: "usdc" | "gas") => (evm.faucets ? ` (${evm.faucets[what]})` : "");
  if (gasToken.isUsdc) {
    // One balance pays both: the USDC that leaves and the gas, counted natively in 18 decimals.
    const needs = evmUnitsToNativeUsdc(usdcNeeded) + needsGas;
    line("needs", `${formatGas(needs, evm)}: ${formatEvmAmount(usdcNeeded)} USDC to send and ${formatGas(needsGas, evm)} for gas, twice what it comes to`);
    if (native < needs) {
      waiting.push(`${payer} holds ${formatGas(native, evm)} on ${label} and needs ${formatGas(needs, evm)}${faucet("usdc")}`);
    }
  } else {
    line("needs", `${formatGas(needsGas, evm)}, twice what these transactions come to${usdcNeeded > 0n ? `, and ${formatEvmAmount(usdcNeeded)} USDC` : ""}`);
    if (held < usdcNeeded) {
      waiting.push(`${payer} holds ${formatEvmAmount(held)} USDC on ${label} and needs ${formatEvmAmount(usdcNeeded)}${faucet("usdc")}`);
    }
    if (native < needsGas) {
      waiting.push(`${payer} holds ${formatGas(native, evm)} on ${label} and needs ${formatGas(needsGas, evm)}${faucet("gas")}`);
    }
  }
  return arriving;
}

/** Bytes that do not compress, as many as asked for. */
function incompressible(length: number): Hex {
  let bytes: Hex = "0x";
  for (let word = keccak256("0x"); size(bytes) < length; word = keccak256(word)) {
    bytes = concat([bytes, word]);
  }
  return slice(bytes, 0, length);
}

/** What the fee payer sends on Stellar and what it has to hold for it. */
async function planStellar(
  config: NetworkConfig,
  evm: EvmChainConfig,
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
      const fee = await simulatedFee(server, stellar.networkPassphrase, source, operation, INCLUSION_BID[config.name]);
      simulated += fee;
      line(label, `${what}  ${formatXlm(fee)} at most, simulated`);
    };

    if (await isDeployed(owner, config, server)) line("deploy", "nothing to send: the account exists");
    else await estimate("deploy", "hub.deploy", deployOperation(owner, config));

    if (!options.stellarOnly) {
      if (options.skipFund) line("deliver", "nothing to send  (--skip-fund)");
      else line("deliver", "CctpForwarder.mint_and_forward  not simulated: it needs Circle's attestation of the burn");

      const transfers = !options.skipTransfer;
      const exits = !options.skipExit && !options.resumeExit;
      const held = await usdcBalance(account, config, server);
      const leaving = (transfers ? options.transfer : 0n) + (exits ? options.exit : 0n);
      line("account", `${account} holds ${formatStellarAmount(held)} USDC`);
      const unfunded = `not simulated: the account holds ${formatStellarAmount(held)} USDC until the delivery`;
      if (!transfers) line("transfer", "nothing to send");
      else if (held < leaving) line("transfer", `USDC.transfer  ${unfunded}`);
      else {
        const { address: to, note } = recipient(config, options.to);
        const transfer: Action = { kind: "transfer", to, amount: options.transfer };
        await estimate("transfer", `USDC.transfer of ${formatStellarAmount(options.transfer)} USDC`, await buildOperation(transfer, context));
        line("", `to ${to}  (${note})`);
      }
      if (!exits) line("exit", "nothing to send");
      else if (held < leaving) line("exit", `hub.exit  ${unfunded}`);
      else {
        const exit: Action = { kind: "exit", amount: options.exit, recipient: owner, destinationChain: evm.name };
        await estimate("exit", `hub.exit of ${formatStellarAmount(options.exit)} USDC`, await buildOperation(exit, context));
        line("", `to ${owner} on ${evm.label}, CCTP domain ${evm.cctpDomain}`);
      }
      // What a resumed burn delivers is known once Circle's attestation has been read, which the run does.
      if (!options.resumeBurn && held + arriving < leaving) {
        waiting.push(
          `the account would hold ${formatStellarAmount(held + arriving)} USDC, less than the ` +
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
  evm: EvmChainConfig,
  server: rpc.Server,
  options: Options,
  parties: Parties,
): Promise<string[]> {
  const waiting: string[] = [];
  const { stellar } = config;

  heading("Circle's contracts, read from both chains");
  await checkStellarCircle(config, server, evm, line);
  let arriving = 0n;
  if (!options.stellarOnly) {
    const reader = evmReader(evm);
    await checkEvmCircle(config, evm, reader);
    reportEvmCircle(evm, line);
    const inboundFinality = defaultFinalityOf(evm);
    const inbound = await fetchBurnFee(evm.cctpDomain, stellar.cctpDomain, config, { finalityThreshold: inboundFinality });
    const outbound = await fetchBurnFee(stellar.cctpDomain, evm.cctpDomain, config, { finalityThreshold: FAST_FINALITY });
    const towards = inboundFinality === FAST_FINALITY ? "a fast transfer" : `a standard transfer (${evm.label} has no fast transfer)`;
    line("circle", `${towards} costs ${inbound} bps towards Stellar; a fast transfer back costs ${outbound} bps (${config.irisUrl})`);

    heading(`${evm.label}: what the payer sends`);
    arriving = await planEvm(config, evm, reader, parties, options, waiting);
  }

  heading("Stellar: what the fee payer sends");
  await planStellar(config, evm, server, parties, options, arriving, waiting);
  return waiting;
}

/** The EVM side of a run and Circle's contracts on it. */
function showChain(evm: EvmChainConfig): void {
  const gas = evm.gasToken.isUsdc ? "gas paid in USDC, out of the same balance" : `gas paid in ${evm.gasToken.symbol}`;
  console.log(`    chain      ${evm.label}, chain id ${evm.chain.id}, CCTP domain ${evm.cctpDomain}, ${gas}`);
  console.log(`    contracts  USDC ${evm.usdc} (${evm.usdcDecimals} decimals)`);
  console.log(`               TokenMessengerV2 ${evm.tokenMessenger}`);
  console.log(`               MessageTransmitterV2 ${evm.messageTransmitter}`);
}

function report(waiting: string[]): void {
  console.log("\nA run cannot start yet:");
  for (const reason of waiting) console.log(`    - ${reason}`);
}

/** Every read and simulation of a run, and nothing else. */
async function dryRun(config: NetworkConfig, evm: EvmChainConfig, server: rpc.Server, options: Options): Promise<void> {
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
  showChain(evm);

  const payer = evmPayer(config)?.address ?? owner;
  const waiting = await plan(config, evm, server, options, { owner, payer, source });
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
  const evm = evmChain(config, options.chain);
  const server = new rpc.Server(config.stellar.rpcUrl);
  if (options.dryRun) {
    await dryRun(config, evm, server, options);
    return;
  }

  const ownerKey = options.stellarOnly ? undefined : privateKey("PASO_E2E_OWNER_KEY");
  if (!options.stellarOnly && !ownerKey && options.fund === "burn") {
    usage(
      mainnet
        ? `Set PASO_E2E_OWNER_KEY to the key that owns the account and pays on ${evm.label}`
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
    evm,
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
  if (!options.stellarOnly) showChain(evm);

  // Real funds: nothing is sent until both chains and both accounts have been looked at.
  if (mainnet) {
    const parties = { owner: owner.address, payer: owner.address, source: source!.publicKey() };
    const waiting = await plan(config, evm, server, options, parties);
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
    console.error(`\n${describe(error)}`);
    if (continuation) {
      console.error(`\nEverything printed above has happened and stands. To continue from there:\n\n    ${continuation}`);
    }
    process.exit(1);
  },
);
