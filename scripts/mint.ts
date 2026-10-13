/**
 * Completes a transfer from Stellar on Base. Anyone can.
 *
 *   pnpm mint <stellar exit tx hash> [--network testnet|mainnet] [--dry-run] [--from <0x…>]
 *
 * It looks the exit up in Circle's attestation service, checks that the
 * message is addressed to Base and has not been received there, simulates
 * `receiveMessage` on Circle's MessageTransmitter and sends it. Circle's
 * contract checks the attestation and mints to the recipient the message
 * names; whoever sends the transaction only pays the gas, and does not have
 * to be the recipient.
 *
 * A message that has been received already is reported as it stands, and
 * that is a success.
 *
 * Environment (on testnet also read from apps/web/.env.local when that file
 * exists; on mainnet from the environment alone):
 *
 *   PASO_EVM_KEY           Private key of any Base account with a little ETH: it pays the gas.
 *                          On testnet PASO_E2E_PAYER_KEY or DEMO_PAYER_PRIVATE_KEY stand in
 *                          when it is not set.
 *   PASO_CONFIRM_MAINNET   Mainnet only: 1, once the simulated fee has been read. Without it
 *                          the fee is printed and nothing is sent.
 *   BASE_RPC_URL           Base RPC endpoint. Defaults to the chain's public one.
 *
 * `--dry-run` does every read and the simulation and sends nothing. It needs
 * no key; `--from` names the account to simulate for when no key does.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatGwei,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  isAddressEqual,
  slice,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { publicActionsL2 } from "viem/op-stack";
import {
  decodeBurnMessage,
  erc20Abi,
  evmAddressUrl,
  evmTxUrl,
  formatEvmAmount,
  isReceivedOnEvm,
  messageTransmitterAbi,
  receiveMessageOnEvm,
  resolveNetwork,
  stellarAddressUrl,
  stellarTxUrl,
  type Attestation,
  type NetworkConfig,
  type NetworkName,
} from "../packages/sdk/src/index";
import { attestedMessages, evmRecipient } from "./cctp";
import { describe } from "./fees";

/** Gas headroom over the estimate, in percent: the estimate is for the state it was made in. */
const GAS_HEADROOM_PERCENT = 20n;

interface Options {
  exit: string;
  network: NetworkName;
  dryRun: boolean;
  from?: Address;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error("Usage: pnpm mint <stellar exit tx hash> [--network testnet|mainnet] [--dry-run] [--from <0x…>]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  let exit: string | undefined;
  let network: NetworkName = "testnet";
  let dryRun = false;
  let from: Address | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--dry-run") dryRun = true;
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
  return { exit, network, dryRun, from };
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

function baseClients(config: NetworkConfig, payer: PrivateKeyAccount | undefined) {
  const { chain } = config.evm;
  const transport = http(process.env.BASE_RPC_URL?.trim() || undefined);
  return {
    base: createPublicClient({ chain, transport }).extend(publicActionsL2()),
    wallet: payer ? createWalletClient({ account: payer, chain, transport }) : undefined,
  };
}

type Clients = ReturnType<typeof baseClients>;

async function showBalance(config: NetworkConfig, { base }: Clients, recipient: Address): Promise<void> {
  const held = await base.readContract({ address: config.evm.usdc, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
  line("balance", `${formatEvmAmount(held)} USDC in ${recipient} on ${config.evm.chain.name}`);
}

/** Mints one attested message on Base, or reports it minted. Returns whether it is minted at the end. */
async function mintOne(
  config: NetworkConfig,
  clients: Clients,
  options: Options,
  payer: PrivateKeyAccount | undefined,
  { message, attestation, nonce }: Attestation,
): Promise<boolean> {
  const { chain, messageTransmitter } = config.evm;
  const { base, wallet } = clients;
  const burn = decodeBurnMessage(message);
  const recipient = evmRecipient(message);
  const sender = StrKey.encodeContract(Buffer.from(hexToBytes(burn.messageSender)));

  line("amount", `${formatEvmAmount(burn.amount)} USDC burned, ${formatEvmAmount(burn.feeExecuted)} kept by Circle, ` +
    `${formatEvmAmount(burn.amount - burn.feeExecuted)} to mint`);
  line("to", recipient);
  line("", evmAddressUrl(recipient, config));
  line("sent by", `${sender}${sender === config.stellar.hub ? ", the Paso hub" : ""}`);
  line("", stellarAddressUrl(sender, config));
  line("nonce", nonce);

  if (await isReceivedOnEvm(base, message, config)) {
    line("minted", `already: Circle's message transmitter on ${chain.name} has taken this message, and takes it once`);
    await showBalance(config, clients, recipient);
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
    const latest = await base.getBlockNumber();
    line("expires", `at block ${burn.expirationBlock}; ${chain.name} is at ${latest}`);
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
    await base.simulateContract({ ...call, account: caller });
    gas = await base.estimateContractGas({ ...call, account: caller });
  } catch (error) {
    throw new Error(`The mint does not simulate: ${describe(error).split("\n", 1)[0]}`);
  }
  const limit = gas + (gas * GAS_HEADROOM_PERCENT) / 100n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await base.estimateFeesPerGas();
  const dataFee = await base.estimateL1Fee({ account: caller, to: messageTransmitter, data: encodeFunctionData(call), gas: limit });
  const cost = limit * maxFeePerGas + dataFee;
  const held = await base.getBalance({ address: caller });
  line(
    "fee",
    `${formatEther(cost)} ETH at most, simulated: ${gas} gas (${limit} allowed) at ≤ ${formatGwei(maxFeePerGas)} gwei, ` +
      `and ${formatEther(dataFee)} ETH for the data posted to Ethereum`,
  );
  line("payer", `${caller} holds ${formatEther(held)} ETH${payer || options.from ? "" : "  (the recipient, standing in for a payer)"}`);
  line("", evmAddressUrl(caller, config));

  if (options.dryRun) {
    line("would", `send MessageTransmitter.receiveMessage on ${chain.name}`);
    if (held < cost) line("", `but ${caller} does not hold that much ETH`);
    return false;
  }

  if (!payer || !wallet) throw new Error("Set PASO_EVM_KEY to the private key of any Base account with a little ETH: it pays the gas");
  if (held < cost) throw new Error(`${payer.address} holds ${formatEther(held)} ETH and needs ${formatEther(cost)}. Nothing was sent`);
  if (config.name === "mainnet" && process.env.PASO_CONFIRM_MAINNET?.trim() !== "1") {
    console.log("\nNothing was sent. This spends real ETH: to go ahead, run\n");
    console.log(`    PASO_CONFIRM_MAINNET=1 pnpm mint ${options.exit} --network mainnet`);
    process.exit(3);
  }

  const result = await receiveMessageOnEvm({
    walletClient: wallet,
    publicClient: base,
    message,
    attestation,
    network: config,
    gas: limit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    // Behind a public endpoint the node asked next can be a block behind the one that saw the receipt.
    confirmations: 2,
    onSubmitted: (hash) => {
      line("sent", hash);
      line("", evmTxUrl(hash, config));
    },
  });
  if (result.alreadyReceived) line("minted", "by someone else while this was on its way");
  else line("minted", `${result.hash}, confirmed`);
  await showBalance(config, clients, recipient);
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // That file holds the web app's testnet keys: a mainnet mint takes nothing from it.
  const envFile = resolve(process.cwd(), "apps/web/.env.local");
  if (options.network === "testnet" && existsSync(envFile)) process.loadEnvFile(envFile);

  const config = resolveNetwork(options.network);
  const { evm, stellar } = config;
  // Only a mint that is still to be made needs a key: one made already is reported without it.
  const payer = payerKey(config.name);
  const clients = baseClients(config, payer);
  const chainId = await clients.base.getChainId();
  if (chainId !== evm.chain.id) {
    throw new Error(`The Base endpoint serves chain ${chainId}, not ${evm.chain.name} (${evm.chain.id}); check BASE_RPC_URL`);
  }

  console.log(`Completing a transfer from Stellar ${config.name} on ${evm.chain.name}${options.dryRun ? ", dry run: nothing is sent" : ""}`);
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

  const outbound = attestations.filter(({ message }) => {
    const { sourceDomain, destinationDomain } = decodeBurnMessage(message);
    return sourceDomain === stellar.cctpDomain && destinationDomain === evm.cctpDomain;
  });
  if (outbound.length === 0) {
    const domains = attestations.map(({ message }) => decodeBurnMessage(message).destinationDomain).join(", ");
    throw new Error(`That exit is addressed to CCTP domain ${domains}, not to ${evm.chain.name} (${evm.cctpDomain})`);
  }
  line("attested", `${outbound.length === 1 ? "one message" : `${outbound.length} messages`} for ${evm.chain.name} (CCTP domain ${evm.cctpDomain})`);

  let minted = 0;
  for (const [index, attestation] of outbound.entries()) {
    console.log(outbound.length > 1 ? `\n[message ${index + 1} of ${outbound.length}]` : "");
    if (await mintOne(config, clients, options, payer, attestation)) minted += 1;
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
