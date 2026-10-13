/**
 * Delivers a transfer from Base on Stellar. Anyone can.
 *
 *   pnpm deliver <base burn tx hash> [--network testnet|mainnet] [--dry-run] [--source <G…>]
 *
 * It looks the burn up in Circle's attestation service, checks that the
 * message is addressed to Stellar and has not been delivered, and delivers it
 * by the route the message itself names: through Circle's CctpForwarder,
 * which passes the USDC on to the address in the hook data, or straight to the
 * recipient in the message. Circle's contracts check the attestation and
 * decide where the USDC goes; whoever sends the transaction only pays its fee.
 * No owner key and no wallet take part.
 *
 * A message that has been delivered already is reported as it stands, and
 * that is a success.
 *
 * Environment (on testnet also read from apps/web/.env.local when that file
 * exists; on mainnet from the environment alone):
 *
 *   PASO_SOURCE_SECRET     Secret key of any funded Stellar account: it pays the fee.
 *                          On testnet PASO_E2E_SOURCE_SECRET stands in when it is not set.
 *   PASO_CONFIRM_MAINNET   Mainnet only: 1, once the simulated fee has been read. Without
 *                          it the fee is printed and nothing is sent.
 *
 * `--dry-run` does every read and the simulation and sends nothing. It needs
 * no key; `--source` names the account to simulate for when no key does.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Account, Keypair, rpc, StrKey } from "@stellar/stellar-sdk";
import { toHex, type Hex } from "viem";
import {
  decodeBurnMessage,
  deliverOperation,
  evmTxUrl,
  formatEvmAmount,
  formatStellarAmount,
  inboundRouteOf,
  resolveNetwork,
  SimulationError,
  stellarAddressUrl,
  stellarTxUrl,
  usdcBalance,
  type Attestation,
  type NetworkConfig,
  type NetworkName,
} from "../packages/sdk/src/index";
import { attestedMessages, deliveredOnStellar, stellarRecipient } from "./cctp";
import { describe, formatXlm, MINIMUM_BALANCE, xlmBalance } from "./fees";
import { INCLUSION_BID, sendAndWait, simulated } from "./sender";

/** Stands in for the fee payer of a dry run when no account is named: simulation needs an address, not an account. */
const NOBODY = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

interface Options {
  burn: Hex;
  network: NetworkName;
  dryRun: boolean;
  source?: string;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error("Usage: pnpm deliver <base burn tx hash> [--network testnet|mainnet] [--dry-run] [--source <G…>]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  let burn: Hex | undefined;
  let network: NetworkName = "testnet";
  let dryRun = false;
  let source: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--network") {
      const name = value();
      if (name !== "testnet" && name !== "mainnet") usage("--network takes testnet or mainnet");
      network = name;
    } else if (arg === "--source") {
      source = value();
      if (!StrKey.isValidEd25519PublicKey(source)) usage(`--source takes a Stellar account (G…), not ${source}`);
    } else if (/^0x[0-9a-fA-F]{64}$/.test(arg) && burn === undefined) burn = arg.toLowerCase() as Hex;
    else usage(`${arg} is neither an option nor the hash of a transaction on Base (0x and 64 hex digits)`);
  }
  if (!burn) usage();
  if (source && !dryRun) usage("--source names the account a dry run simulates for; a delivery is paid by PASO_SOURCE_SECRET");
  return { burn, network, dryRun, source };
}

function line(label: string, value: string): void {
  console.log(`    ${label.padEnd(10)} ${value}`);
}

function secretKey(network: NetworkName): Keypair | undefined {
  const fallback = network === "testnet" ? process.env.PASO_E2E_SOURCE_SECRET : undefined;
  const secret = (process.env.PASO_SOURCE_SECRET ?? fallback)?.trim();
  if (!secret) return undefined;
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new Error("PASO_SOURCE_SECRET is not a Stellar secret key (S…)");
  return Keypair.fromSecret(secret);
}

async function showBalance(config: NetworkConfig, server: rpc.Server, recipient: string): Promise<void> {
  line("balance", `${formatStellarAmount(await usdcBalance(recipient, config, server))} USDC in ${recipient}`);
}

/** Delivers one attested message, or reports it delivered. Returns whether it is delivered at the end. */
async function deliverOne(
  config: NetworkConfig,
  server: rpc.Server,
  options: Options,
  payer: Keypair | undefined,
  { message, attestation, nonce }: Attestation,
): Promise<boolean> {
  const { stellar } = config;
  const burn = decodeBurnMessage(message);
  const route = inboundRouteOf(message, config);
  const recipient = stellarRecipient(message, config);

  line("amount", `${formatEvmAmount(burn.amount)} USDC burned, ${formatEvmAmount(burn.feeExecuted)} kept by Circle, ` +
    `${formatEvmAmount(burn.amount - burn.feeExecuted)} to deliver`);
  line("to", recipient);
  line("", stellarAddressUrl(recipient, config));
  line(
    "route",
    route === "forwarder"
      ? `Circle's forwarder ${stellar.forwarder}, which passes the USDC on to the address in the hook data`
      : `straight to the recipient, through Circle's message transmitter ${stellar.messageTransmitter}`,
  );
  line("nonce", nonce);

  if (await deliveredOnStellar(config, server, nonce)) {
    line("delivered", "already: Circle's message transmitter on Stellar has taken this message, and takes it once");
    await showBalance(config, server, recipient);
    return true;
  }

  // A message can name the one address allowed to deliver it. Through the forwarder that is the forwarder itself.
  const payerAddress = payer?.publicKey() ?? options.source ?? NOBODY;
  const zero = toHex(new Uint8Array(32));
  if (route === "direct" && burn.destinationCaller !== zero) {
    const caller = StrKey.isValidEd25519PublicKey(payerAddress) ? toHex(StrKey.decodeEd25519PublicKey(payerAddress)) : zero;
    if (caller !== burn.destinationCaller) {
      throw new Error(`Only the address ${burn.destinationCaller} may deliver this message, and ${payerAddress} is not it`);
    }
  }

  const operation = deliverOperation({ message, attestation, caller: payerAddress }, config);
  const bid = INCLUSION_BID[config.name];
  const { fee } = await simulated(server, stellar.networkPassphrase, new Account(payerAddress, "0"), operation, bid).catch(
    (error: unknown) => {
      throw new Error(`The delivery does not simulate: ${describe(error).split("\n", 1)[0]}`);
    },
  );
  const held = payerAddress === NOBODY ? null : await xlmBalance(server, payerAddress);
  line("fee", `${formatXlm(fee)} at most, simulated${payerAddress === NOBODY ? "" : `, paid by ${payerAddress}`}`);
  if (payerAddress !== NOBODY) {
    line("payer", `${payerAddress} ${held === null ? "does not exist on chain" : `holds ${formatXlm(held)}`}`);
    line("", stellarAddressUrl(payerAddress, config));
  }

  if (options.dryRun) {
    line("would", `send ${route === "forwarder" ? "CctpForwarder.mint_and_forward" : "MessageTransmitter.receive_message"}`);
    if (payerAddress === NOBODY) line("", "simulated without a payer: set PASO_SOURCE_SECRET or pass --source to simulate for one");
    else if ((held ?? 0n) < fee + MINIMUM_BALANCE) line("", `but ${payerAddress} does not hold the fee and its minimum balance`);
    return false;
  }

  if (!payer) throw new Error("Set PASO_SOURCE_SECRET to the secret key of any funded Stellar account: it pays the fee");
  if ((held ?? 0n) < fee + MINIMUM_BALANCE) {
    throw new Error(`${payer.publicKey()} needs ${formatXlm(fee + MINIMUM_BALANCE)}: the fee, and the minimum balance it has to keep. Nothing was sent`);
  }
  if (config.name === "mainnet" && process.env.PASO_CONFIRM_MAINNET?.trim() !== "1") {
    console.log("\nNothing was sent. This spends real XLM: to go ahead, run\n");
    console.log(`    PASO_CONFIRM_MAINNET=1 pnpm deliver ${options.burn} --network mainnet`);
    process.exit(3);
  }

  let applied;
  try {
    applied = await sendAndWait(server, payer, config.name, "for the delivery", async (account, offer) => {
      const built = await simulated(server, stellar.networkPassphrase, account, operation, offer);
      line("sending", `bidding ${formatXlm(offer)}, ${formatXlm(built.fee)} at most`);
      return built.tx;
    }, line);
  } catch (error) {
    // Someone else may have delivered it in the meantime: the message is taken once, and the chain says by whom.
    if (error instanceof SimulationError && (await deliveredOnStellar(config, server, nonce))) {
      line("delivered", "by someone else while this was on its way");
      await showBalance(config, server, recipient);
      return true;
    }
    throw error;
  }

  if (applied.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    line("delivered", applied.txHash);
    line("", stellarTxUrl(applied.txHash, config));
    await showBalance(config, server, recipient);
    return true;
  }
  if (await deliveredOnStellar(config, server, nonce)) {
    line("delivered", `by someone else first; ${applied.txHash} failed and paid its fee`);
    line("", stellarTxUrl(applied.txHash, config));
    await showBalance(config, server, recipient);
    return true;
  }
  throw new Error(`The delivery failed on chain: ${stellarTxUrl(applied.txHash, config)}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // That file holds the web app's testnet keys: a mainnet delivery takes nothing from it.
  const envFile = resolve(process.cwd(), "apps/web/.env.local");
  if (options.network === "testnet" && existsSync(envFile)) process.loadEnvFile(envFile);

  const config = resolveNetwork(options.network);
  const { evm, stellar } = config;
  const server = new rpc.Server(stellar.rpcUrl);
  // Only a delivery that is still to be made needs a payer: one made already is reported without a key.
  const payer = secretKey(config.name);

  console.log(`Delivering a transfer from ${evm.chain.name} on Stellar ${config.name}${options.dryRun ? ", dry run: nothing is sent" : ""}`);
  console.log("");
  line("burn", options.burn);
  line("", evmTxUrl(options.burn, config));

  const attestations = await attestedMessages(evm.cctpDomain, options.burn, config, {
    wait: !options.dryRun,
    report: line,
  });
  if (!attestations) {
    line("attested", "not yet: a delivery waits for Circle's attestation, and the dry run stops here");
    console.log("\nNothing was sent.");
    return;
  }

  const inbound = attestations.filter(({ message }) => {
    const { sourceDomain, destinationDomain } = decodeBurnMessage(message);
    return sourceDomain === evm.cctpDomain && destinationDomain === stellar.cctpDomain;
  });
  if (inbound.length === 0) {
    const domains = attestations.map(({ message }) => decodeBurnMessage(message).destinationDomain).join(", ");
    throw new Error(`That burn is addressed to CCTP domain ${domains}, not to Stellar (${stellar.cctpDomain})`);
  }
  line("attested", `${inbound.length === 1 ? "one message" : `${inbound.length} messages`} for Stellar (CCTP domain ${stellar.cctpDomain})`);

  let delivered = 0;
  for (const [index, attestation] of inbound.entries()) {
    console.log(inbound.length > 1 ? `\n[message ${index + 1} of ${inbound.length}]` : "");
    if (await deliverOne(config, server, options, payer, attestation)) delivered += 1;
  }
  console.log(options.dryRun ? "\nNothing was sent." : delivered === inbound.length ? "\nDelivered." : "");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n${describe(error)}`);
    process.exit(1);
  },
);
