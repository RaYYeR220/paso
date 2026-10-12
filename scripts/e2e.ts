/**
 * Paso, end to end, on testnet.
 *
 *   pnpm e2e --stellar-only [--relayer <url>]
 *   pnpm e2e [--relayer <url>] [--fund demo|burn] [--to <address>]
 *
 * `--stellar-only` needs no USDC. It takes a fresh Ethereum key, makes the
 * first call from its Stellar account (which deploys the account), and then
 * shows the refusal: a signature made for one amount, submitted with another,
 * recorded on chain as a failed transaction.
 *
 * Without the flag it runs the whole journey for the owner key: USDC leaves
 * Base Sepolia, Circle attests the burn, it is delivered to the owner's
 * Stellar account, 0.1 USDC is sent on to another account, 0.5 USDC goes back
 * to Base, and the refusal closes the run. Every transaction is printed with
 * its explorer link.
 *
 * With `--relayer <url>` the Stellar transactions go through that relayer's
 * API and it pays their fees. Without it, the account in
 * `PASO_E2E_SOURCE_SECRET` pays: nothing here depends on a particular relayer.
 *
 * Environment (also read from apps/web/.env.local when that file exists):
 *
 *   PASO_E2E_OWNER_KEY       Ethereum private key that owns the account. A fresh one when unset.
 *   PASO_E2E_SOURCE_SECRET   Secret key of any funded Stellar account. Required without --relayer,
 *                            and for the refused transaction, which no relayer will send.
 *   PASO_E2E_PAYER_KEY       Ethereum private key that pays the burn on Base (--fund burn).
 *                            Defaults to DEMO_PAYER_PRIVATE_KEY when that is set, else to the owner key.
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
import { createPublicClient, createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  decodeBurnMessage,
  deliverWith,
  ensureDeployed,
  erc20Abi,
  evmTxUrl,
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
  twinAddress,
  usdcBalance,
  waitForAttestation,
  withArgument,
  type Attestation,
  type Call,
  type NetworkConfig,
  type Signed,
} from "../packages/sdk/src/index";

const FUND_AMOUNT = parseEvmAmount("1");
const TRANSFER_AMOUNT = parseStellarAmount("0.1");
const EXIT_AMOUNT = parseStellarAmount("0.5");
const HONEST_AMOUNT = 1n;
const TAMPERED_AMOUNT = parseStellarAmount("1000000");
const ATTESTATION_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_MS = 2000;

interface Options {
  stellarOnly: boolean;
  relayerUrl?: string;
  fund: "demo" | "burn";
  to?: string;
}

interface Run {
  config: NetworkConfig;
  server: rpc.Server;
  owner: PrivateKeyAccount;
  /** The owner's Stellar account. */
  account: string;
  /** Pays fees when there is no relayer, and sends the refused transaction. */
  source?: Keypair;
  relayerUrl?: string;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error("Usage: pnpm e2e [--stellar-only] [--relayer <url>] [--fund demo|burn] [--to <G…|C…|0x…>]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { stellarOnly: false, fund: "burn" };
  let fund: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--stellar-only") options.stellarOnly = true;
    else if (arg === "--relayer") options.relayerUrl = value().replace(/\/+$/, "");
    else if (arg === "--fund") fund = value();
    else if (arg === "--to") options.to = value();
    else usage(`Unknown argument ${arg}`);
  }
  if (fund !== undefined && fund !== "demo" && fund !== "burn") usage("--fund takes demo or burn");
  options.fund = (fund as Options["fund"] | undefined) ?? (options.relayerUrl ? "demo" : "burn");
  if (options.fund === "demo" && !options.relayerUrl) usage("--fund demo needs --relayer, whose faucet it uses");
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
  const deployed = await ensureDeployed(signed.owner, source, run.config, run.server);
  const { hash } = await submitWith(signed, source, { network: run.config, server: run.server });
  return deployed ? { hash, deployHash: deployed.hash } : { hash };
}

async function approval(run: Run, amount: bigint): Promise<Signed> {
  const { usdc, hub } = run.config.stellar;
  const { sequence } = await run.server.getLatestLedger();
  const prepared = await prepare(
    {
      kind: "invoke",
      contract: usdc,
      fn: "approve",
      args: [
        new StellarAddress(run.account).toScVal(),
        new StellarAddress(hub).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(sequence + 1000, { type: "u32" }),
      ],
    },
    { owner: run.owner.address, network: run.config, server: run.server },
  );
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

  const tx = build(signedOperation(tampered), (resourceFee + 1000n).toString(), data);
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
  const transport = http(process.env.BASE_RPC_URL?.trim() || undefined);
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ account: payer, chain, transport }),
  };
}

/** USDC leaves Base for the owner's Stellar account. Returns the burn transaction. */
async function fund(run: Run, options: Options, payer: PrivateKeyAccount): Promise<Hex> {
  heading(`${formatEvmAmount(FUND_AMOUNT)} USDC leaves ${run.config.evm.chain.name} for the account`);
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
  if (held < FUND_AMOUNT) {
    throw new Error(
      `${payer.address} holds ${formatEvmAmount(held)} USDC on ${run.config.evm.chain.name}; it needs ` +
        `${formatEvmAmount(FUND_AMOUNT)} and some ETH for gas (https://faucet.circle.com)`,
    );
  }
  const { burnTxHash, approveTxHash, route, maxFee } = await fundFromEvm({
    ...clients,
    amount: FUND_AMOUNT,
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
    ({ hash } = await deliverWith(attestation, requireSource(run), run.config, run.server));
  }

  if (hash) {
    line("delivered", `${hash}  (route ${route})`);
    line("", stellarTxUrl(hash, run.config));
  } else {
    line("delivered", `by someone else first (route ${route})`);
  }
}

function recipient(run: Run, to: string | undefined): { address: string; note: string } {
  if (to === undefined) {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    return {
      address: twinAddress(stranger, run.config),
      note: `the account of ${stranger}, an Ethereum address with no Stellar account yet`,
    };
  }
  if (isAddress(to, { strict: false })) {
    return { address: twinAddress(to, run.config), note: `the account of ${to}` };
  }
  if (StrKey.isValidContract(to) || StrKey.isValidEd25519PublicKey(to)) {
    return { address: to, note: "as given" };
  }
  return usage(`--to must be a Stellar address (G… or C…) or an Ethereum address (0x…), not ${to}`);
}

/** Base Sepolia → the account → another account → back to Base Sepolia. */
async function journey(run: Run, options: Options): Promise<void> {
  // Whoever pays on Base: for the burn when there is no faucet, and for the mint that ends the way back.
  const payerKey = privateKey("PASO_E2E_PAYER_KEY") ?? privateKey("DEMO_PAYER_PRIVATE_KEY");
  const payer = payerKey ? privateKeyToAccount(payerKey) : run.owner;
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

  const { address: to, note } = recipient(run, options.to);
  heading(`${formatStellarAmount(TRANSFER_AMOUNT)} USDC to another Stellar address`);
  line("to", `${to}  (${note})`);
  const transfer = await sign(
    await prepare(
      { kind: "transfer", to, amount: TRANSFER_AMOUNT },
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

  heading(`${formatStellarAmount(EXIT_AMOUNT)} USDC back to ${run.config.evm.chain.name}`);
  const exit = await sign(
    await prepare(
      { kind: "exit", amount: EXIT_AMOUNT, recipient: run.owner.address },
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
  const mintTxHash = await clients.walletClient.writeContract({
    address: run.config.evm.messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [outbound.message, outbound.attestation],
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: mintTxHash });
  if (receipt.status !== "success") {
    throw new Error(`The mint on ${run.config.evm.chain.name} reverted: ${mintTxHash}`);
  }
  line("minted", mintTxHash);
  line("", evmTxUrl(mintTxHash, run.config));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const envFile = resolve(process.cwd(), "apps/web/.env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = resolveNetwork("testnet");
  const server = new rpc.Server(config.stellar.rpcUrl);
  const ownerKey = options.stellarOnly ? undefined : privateKey("PASO_E2E_OWNER_KEY");
  if (!options.stellarOnly && !ownerKey && options.fund === "burn") {
    usage("Set PASO_E2E_OWNER_KEY, or use --relayer <url> --fund demo to start from a fresh key");
  }
  const owner = privateKeyToAccount(ownerKey ?? generatePrivateKey());
  const secret = process.env.PASO_E2E_SOURCE_SECRET?.trim();
  const source = secret ? Keypair.fromSecret(secret) : undefined;
  if (!source && !options.relayerUrl) {
    usage("Set PASO_E2E_SOURCE_SECRET to a funded Stellar account, or pass --relayer <url>");
  }

  const run: Run = {
    config,
    server,
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

  if (!options.stellarOnly) {
    await journey(run, options);
  }
  await firstCall(run);
  await refusal(run);
  console.log("\nDone.");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
