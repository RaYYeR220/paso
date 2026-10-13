/**
 * Completes a transfer from Stellar on an EVM chain. Anyone can.
 *
 *   pnpm mint <stellar exit tx hash> [--chain <name>] [--network testnet|mainnet] [--dry-run] [--from <0x…>]
 *
 * It looks the exit up in Circle's attestation service and mints on the
 * chain the message names: Base, Ethereum, Arbitrum, OP Mainnet or Arc, or
 * their testnets. `--chain` only checks that the message is for that chain.
 * It checks that the message has not been received there, simulates
 * `receiveMessage` on Circle's MessageTransmitter and sends it. Circle's
 * contract checks the attestation and mints to the recipient the message
 * names; whoever sends the transaction only pays the gas, and does not have
 * to be the recipient. On Arc the gas is paid in USDC.
 *
 * A message that has been received already is reported as it stands, and
 * that is a success.
 *
 * Environment (on testnet also read from apps/web/.env.local when that file
 * exists; on mainnet from the environment alone):
 *
 *   PASO_EVM_KEY           Private key of any account with a little gas on the chain: it pays
 *                          for the mint. On testnet PASO_E2E_PAYER_KEY or DEMO_PAYER_PRIVATE_KEY
 *                          stand in when it is not set.
 *   PASO_CONFIRM_MAINNET   Mainnet only: 1, once the simulated fee has been read. Without it
 *                          the fee is printed and nothing is sent.
 *   <CHAIN>_RPC_URL        The chain's RPC endpoint: BASE_RPC_URL, ETHEREUM_RPC_URL,
 *                          ARBITRUM_RPC_URL, OPTIMISM_RPC_URL, ARC_RPC_URL. Defaults to the
 *                          public endpoints the SDK lists for the chain.
 *
 * `--dry-run` does every read and the simulation and sends nothing. It needs
 * no key; `--from` names the account to simulate for when no key does.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import {
  createWalletClient,
  encodeFunctionData,
  formatGwei,
  getAddress,
  hexToBytes,
  isAddress,
  isAddressEqual,
  slice,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  decodeBurnMessage,
  erc20Abi,
  evmAddressUrl,
  evmChain,
  evmChainForDomain,
  evmTxUrl,
  formatEvmAmount,
  isReceivedOnEvm,
  listEvmChains,
  messageTransmitterAbi,
  receiveMessageOnEvm,
  resolveNetwork,
  stellarAddressUrl,
  stellarTxUrl,
  type Attestation,
  type EvmChainConfig,
  type EvmChainName,
  type NetworkConfig,
  type NetworkName,
} from "../packages/sdk/src/index";
import { attestedMessages, evmRecipient } from "./cctp";
import { chargesDataFee, dataFee, evmReader, evmTransport, formatGas, parseChain, rpcVariable } from "./evm";
import { describe } from "./fees";

/** Gas headroom over the estimate, in percent: the estimate is for the state it was made in. */
const GAS_HEADROOM_PERCENT = 20n;

interface Options {
  exit: string;
  network: NetworkName;
  /** The chain the message has to be for; any chain Paso lists when not given. */
  chain?: EvmChainName;
  dryRun: boolean;
  from?: Address;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error(
    "Usage: pnpm mint <stellar exit tx hash> [--chain base|ethereum|arbitrum|optimism|arc] [--network testnet|mainnet]\n" +
      "                 [--dry-run] [--from <0x…>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  let exit: string | undefined;
  let network: NetworkName = "testnet";
  let chain: EvmChainName | undefined;
  let dryRun = false;
  let from: Address | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--chain") chain = parseChain(value(), usage);
    else if (arg === "--network") {
      const name = value();
      if (name !== "testnet" && name !== "mainnet") usage("--network takes testnet or mainnet");
      network = name;
    } else if (arg === "--from") {
      const address = value();
      if (!isAddress(address, { strict: false })) usage(`--from takes an Ethereum address, not ${address}`);
      from = getAddress(address);
    } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(arg) && exit === undefined) {
      // Iris indexes a burn made on Stellar under the bare transaction hash.
      exit = arg.replace(/^0x/, "").toLowerCase();
    } else usage(`${arg} is neither an option nor the hash of a Stellar transaction (64 hex digits)`);
  }
  if (!exit) usage();
  if (from && !dryRun) usage("--from names the account a dry run simulates for; a mint is paid by PASO_EVM_KEY");
  return { exit, network, chain, dryRun, from };
}

function line(label: string, value: string): void {
  console.log(`    ${label.padEnd(10)} ${value}`);
}

function payerKey(network: NetworkName): PrivateKeyAccount | undefined {
  const names = network === "testnet" ? ["PASO_EVM_KEY", "PASO_E2E_PAYER_KEY", "DEMO_PAYER_PRIVATE_KEY"] : ["PASO_EVM_KEY"];
  const name = names.find((candidate) => process.env[candidate]?.trim());
  if (!name) return undefined;
  const key = process.env[name]!.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${name} is not a 32-byte hex private key`);
  return privateKeyToAccount(key as Hex);
}

/** A reader and, when there is a key, a wallet on the chain a message is for. Its endpoint has to serve that chain. */
async function clientsFor(chain: EvmChainConfig, payer: PrivateKeyAccount | undefined) {
  const reader = evmReader(chain);
  const chainId = await reader.getChainId();
  if (chainId !== chain.chain.id) {
    throw new Error(`The ${chain.label} endpoint serves chain ${chainId}, not ${chain.chain.id}; check ${rpcVariable(chain)}`);
  }
  return {
    reader,
    wallet: payer ? createWalletClient({ account: payer, chain: chain.chain, transport: evmTransport(chain) }) : undefined,
  };
}

type Clients = Awaited<ReturnType<typeof clientsFor>>;

async function showBalance(chain: EvmChainConfig, { reader }: Clients, recipient: Address): Promise<void> {
  const held = await reader.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  line("balance", `${formatEvmAmount(held)} USDC in ${recipient} on ${chain.label}`);
}

/** Mints one attested message on the chain it is for, or reports it minted. Returns whether it is minted at the end. */
async function mintOne(
  config: NetworkConfig,
  target: EvmChainConfig,
  clients: Clients,
  options: Options,
  payer: PrivateKeyAccount | undefined,
  { message, attestation, nonce }: Attestation,
): Promise<boolean> {
  const { messageTransmitter, label } = target;
  const { reader, wallet } = clients;
  const burn = decodeBurnMessage(message);
  const recipient = evmRecipient(message);
  const sender = StrKey.encodeContract(Buffer.from(hexToBytes(burn.messageSender)));

  line("amount", `${formatEvmAmount(burn.amount)} USDC burned, ${formatEvmAmount(burn.feeExecuted)} kept by Circle, ` +
    `${formatEvmAmount(burn.amount - burn.feeExecuted)} to mint`);
  line("chain", `${label}, CCTP domain ${target.cctpDomain}: Circle's MessageTransmitter ${messageTransmitter}`);
  line("to", recipient);
  line("", evmAddressUrl(recipient, config, target.name));
  line("sent by", `${sender}${sender === config.stellar.hub ? ", the Paso hub" : ""}`);
  line("", stellarAddressUrl(sender, config));
  line("nonce", nonce);

  if (await isReceivedOnEvm(reader, message, config, target.name)) {
    line("minted", `already: Circle's message transmitter on ${label} has taken this message, and takes it once`);
    await showBalance(target, clients, recipient);
    return true;
  }

  // Anyone may mint unless the message names the one address that may.
  const caller = payer?.address ?? options.from ?? recipient;
  if (burn.destinationCaller !== zeroHash) {
    const only = getAddress(slice(burn.destinationCaller, 12));
    line("caller", `only ${only} may mint this message`);
    if (!isAddressEqual(only, caller)) {
      throw new Error(`Only ${only} may mint this message, and ${caller} is not it`);
    }
  }
  if (burn.expirationBlock !== 0n) {
    const latest = await reader.getBlockNumber();
    line("expires", `at block ${burn.expirationBlock}; ${label} is at ${latest}`);
    if (latest >= burn.expirationBlock) throw new Error("The message has expired: Circle's contract no longer takes it");
  }

  const call = {
    address: messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [message, attestation],
  } as const;
  let gas: bigint;
  try {
    await reader.simulateContract({ ...call, account: caller });
    gas = await reader.estimateContractGas({ ...call, account: caller });
  } catch (error) {
    throw new Error(`The mint does not simulate: ${describe(error).split("\n", 1)[0]}`);
  }
  const limit = gas + (gas * GAS_HEADROOM_PERCENT) / 100n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await reader.estimateFeesPerGas();
  const posted = await dataFee(reader, target, { account: caller, to: messageTransmitter, data: encodeFunctionData(call), gas: limit });
  const cost = limit * maxFeePerGas + posted;
  const held = await reader.getBalance({ address: caller });
  const symbol = target.gasToken.symbol;
  line(
    "fee",
    `${formatGas(cost, target)} at most, simulated: ${gas} gas (${limit} allowed) at ≤ ${formatGwei(maxFeePerGas)} gwei` +
      (chargesDataFee(target) ? `, and ${formatGas(posted, target)} for the data posted to Ethereum` : ""),
  );
  line("payer", `${caller} holds ${formatGas(held, target)}${payer || options.from ? "" : "  (the recipient, standing in for a payer)"}`);
  line("", evmAddressUrl(caller, config, target.name));

  if (options.dryRun) {
    line("would", `send MessageTransmitter.receiveMessage on ${label}`);
    if (held < cost) line("", `but ${caller} does not hold that much ${symbol}`);
    return false;
  }

  if (!payer || !wallet) {
    throw new Error(`Set PASO_EVM_KEY to the private key of any account with a little ${symbol} on ${label}: it pays the gas`);
  }
  if (held < cost) {
    throw new Error(`${payer.address} holds ${formatGas(held, target)} on ${label} and needs ${formatGas(cost, target)}. Nothing was sent`);
  }
  if (config.name === "mainnet" && process.env.PASO_CONFIRM_MAINNET?.trim() !== "1") {
    console.log(`\nNothing was sent. This spends real ${symbol}: to go ahead, run\n`);
    console.log(`    PASO_CONFIRM_MAINNET=1 pnpm mint ${options.exit} --chain ${target.name} --network mainnet`);
    process.exit(3);
  }

  const result = await receiveMessageOnEvm({
    walletClient: wallet,
    publicClient: reader,
    message,
    attestation,
    network: config,
    chain: target.name,
    gas: limit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    // Behind a public endpoint the node asked next can be a block behind the one that saw the receipt.
    confirmations: 2,
    onSubmitted: (hash) => {
      line("sent", hash);
      line("", evmTxUrl(hash, config, target.name));
    },
  });
  if (result.alreadyReceived) line("minted", "by someone else while this was on its way");
  else line("minted", `${result.hash}, confirmed`);
  await showBalance(target, clients, recipient);
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // That file holds the web app's testnet keys: a mainnet mint takes nothing from it.
  const envFile = resolve(process.cwd(), "apps/web/.env.local");
  if (options.network === "testnet" && existsSync(envFile)) process.loadEnvFile(envFile);

  const config = resolveNetwork(options.network);
  const { stellar } = config;
  const wanted = options.chain ? evmChain(config, options.chain) : undefined;
  // Only a mint that is still to be made needs a key: one made already is reported without it.
  const payer = payerKey(config.name);

  const where = wanted ? wanted.label : "the EVM chain it names";
  console.log(`Completing a transfer from Stellar ${config.name} on ${where}${options.dryRun ? ", dry run: nothing is sent" : ""}`);
  console.log("");
  line("exit", options.exit);
  line("", stellarTxUrl(options.exit, config));

  const attestations = await attestedMessages(stellar.cctpDomain, options.exit, config, {
    wait: !options.dryRun,
    report: line,
  });
  if (!attestations) {
    line("attested", "not yet: a mint waits for Circle's attestation, and the dry run stops here");
    console.log("\nNothing was sent.");
    return;
  }

  // Each message names the chain it is for; it is minted there and nowhere else.
  const outbound = attestations.flatMap((attestation) => {
    const { sourceDomain, destinationDomain } = decodeBurnMessage(attestation.message);
    const target = evmChainForDomain(config, destinationDomain);
    if (sourceDomain !== stellar.cctpDomain || !target) return [];
    if (wanted && target.name !== wanted.name) return [];
    return [{ attestation, target }];
  });
  if (outbound.length === 0) {
    const domains = attestations.map(({ message }) => decodeBurnMessage(message).destinationDomain).join(", ");
    const offered = wanted
      ? `${wanted.label} (${wanted.cctpDomain})`
      : `any chain Paso lists (${listEvmChains(config).map((chain) => `${chain.label} ${chain.cctpDomain}`).join(", ")})`;
    throw new Error(`That exit is addressed to CCTP domain ${domains}, not to ${offered}`);
  }
  const chains = [...new Set(outbound.map(({ target }) => target.label))].join(" and ");
  line("attested", `${outbound.length === 1 ? "one message" : `${outbound.length} messages`} for ${chains}`);

  const clients = new Map<EvmChainName, Clients>();
  let minted = 0;
  for (const [index, { attestation, target }] of outbound.entries()) {
    console.log(outbound.length > 1 ? `\n[message ${index + 1} of ${outbound.length}]` : "");
    let onChain = clients.get(target.name);
    if (!onChain) {
      onChain = await clientsFor(target, payer);
      clients.set(target.name, onChain);
    }
    if (await mintOne(config, target, onChain, options, payer, attestation)) minted += 1;
  }
  console.log(options.dryRun ? "\nNothing was sent." : minted === outbound.length ? "\nMinted." : "");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n${describe(error)}`);
    process.exit(1);
  },
);
