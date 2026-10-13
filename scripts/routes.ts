/**
 * Checks every route Paso offers, from public chain data alone.
 *
 *   pnpm routes [--network testnet|mainnet] [--chain <name>] [--json]
 *
 * For each EVM chain the SDK lists it reads, without a key and without
 * sending anything:
 *
 *   1. on the chain: that its endpoint serves the chain id listed; that
 *      Circle's TokenMessengerV2, MessageTransmitterV2, token minter and USDC
 *      have code; that the transmitter's `localDomain()` is the domain listed;
 *      that the messenger names that transmitter, and Stellar's token
 *      messenger for domain 27; that the minter pairs Stellar's USDC with the
 *      USDC listed; and that USDC has the decimals listed;
 *   2. on Stellar: that Circle's TokenMessengerMinter names the chain's
 *      messenger for its domain, and pairs the chain's USDC with Stellar's;
 *   3. at Circle's attestation service: the fee of a transfer each way.
 *
 * Exits with 0 when every route checks out and with 1 otherwise. `--json`
 * prints what was read, in the shape of the SDK's
 * `test/fixtures/cctp-routes.json`.
 */
import { rpc, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, pad } from "viem";
import {
  defaultFinalityOf,
  evmChain,
  FAST_FINALITY,
  fetchBurnFee,
  listEvmChains,
  readContract,
  renderArg,
  resolveNetwork,
  type EvmChainConfig,
  type EvmChainName,
  type NetworkConfig,
  type NetworkName,
} from "../packages/sdk/src/index";
import { checkEvmCircle, evmReader, expectSame, parseChain, type EvmEvidence } from "./evm";
import { describe } from "./fees";

interface Options {
  network: NetworkName;
  chain?: EvmChainName;
  json: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`${message}\n`);
  console.error("Usage: pnpm routes [--network testnet|mainnet] [--chain base|ethereum|arbitrum|optimism|arc] [--json]");
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = { network: "testnet", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--json") options.json = true;
    else if (arg === "--chain") options.chain = parseChain(value(), usage);
    else if (arg === "--network") {
      const name = value();
      if (name !== "testnet" && name !== "mainnet") usage("--network takes testnet or mainnet");
      options.network = name;
    } else usage(`Unknown argument ${arg}`);
  }
  return options;
}

interface Route {
  network: NetworkName;
  chain: EvmChainName;
  label: string;
  chainId: number;
  cctpDomain: number;
  usdc: string;
  tokenMessenger: string;
  messageTransmitter: string;
  evm: EvmEvidence;
  stellar: { remoteTokenMessenger: string; localToken: string };
  /** Circle's fee in basis points, per finality threshold, for each direction. */
  fees: { toStellar: Record<string, number>; fromStellar: Record<string, number> };
  /** The finality a burn towards Stellar asks for by default. */
  inboundFinality: number;
}

async function stellarSide(config: NetworkConfig, server: rpc.Server, chain: EvmChainConfig) {
  const { tokenMessenger, usdc } = config.stellar;
  const read = async (fn: string, ...args: xdr.ScVal[]) => renderArg(await readContract(tokenMessenger, fn, args, config, server));
  const remoteTokenMessenger = await read("get_remote_token_messenger", xdr.ScVal.scvU32(chain.cctpDomain));
  const localToken = await read(
    "get_local_token",
    xdr.ScVal.scvU32(chain.cctpDomain),
    xdr.ScVal.scvBytes(Buffer.from(hexToBytes(pad(chain.usdc)))),
  );
  expectSame(`The token messenger Stellar knows for ${chain.label}`, remoteTokenMessenger, pad(chain.tokenMessenger));
  expectSame(`The Stellar USDC minted for USDC from ${chain.label}`, localToken, usdc);
  return { remoteTokenMessenger, localToken };
}

async function fees(config: NetworkConfig, chain: EvmChainConfig) {
  const both = async (source: number, destination: number) => {
    const out: Record<string, number> = {};
    for (const finalityThreshold of [FAST_FINALITY, 2000]) {
      out[finalityThreshold] = await fetchBurnFee(source, destination, config, { finalityThreshold });
    }
    return out;
  };
  return {
    toStellar: await both(chain.cctpDomain, config.stellar.cctpDomain),
    fromStellar: await both(config.stellar.cctpDomain, chain.cctpDomain),
  };
}

async function check(config: NetworkConfig, server: rpc.Server, chain: EvmChainConfig): Promise<Route> {
  const evidence = await checkEvmCircle(config, chain, evmReader(chain));
  return {
    network: config.name,
    chain: chain.name,
    label: chain.label,
    chainId: chain.chain.id,
    cctpDomain: chain.cctpDomain,
    usdc: chain.usdc,
    tokenMessenger: chain.tokenMessenger,
    messageTransmitter: chain.messageTransmitter,
    evm: evidence,
    stellar: await stellarSide(config, server, chain),
    fees: await fees(config, chain),
    inboundFinality: defaultFinalityOf(chain),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveNetwork(options.network);
  const server = new rpc.Server(config.stellar.rpcUrl);
  const chains = options.chain ? [evmChain(config, options.chain)] : listEvmChains(config);
  const log = options.json ? () => undefined : (text: string) => console.log(text);

  log(`Routes between Stellar ${config.name} (CCTP domain ${config.stellar.cctpDomain}) and ${chains.length} EVM chains\n`);
  const routes: Route[] = [];
  let failed = 0;
  for (const chain of chains) {
    try {
      const route = await check(config, server, chain);
      routes.push(route);
      const { toStellar, fromStellar } = route.fees;
      log(`  ok    ${chain.label.padEnd(18)} chain ${chain.chain.id}, domain ${chain.cctpDomain}, block ${route.evm.block}`);
      log(`        USDC ${chain.usdc} (${route.evm.usdcDecimals} decimals), messenger ${chain.tokenMessenger}, transmitter ${chain.messageTransmitter}`);
      log(
        `        fees to Stellar ${toStellar[FAST_FINALITY]} bps fast, ${toStellar[2000]} bps standard; ` +
          `back ${fromStellar[FAST_FINALITY]} bps fast, ${fromStellar[2000]} bps standard; burns towards Stellar ask for ${route.inboundFinality}`,
      );
    } catch (error) {
      failed += 1;
      log(`  FAIL  ${chain.label.padEnd(18)} ${describe(error)}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), stellar: config.stellar.tokenMessenger, routes }, null, 2));
  } else {
    log(failed === 0 ? `\nEvery route checks out.` : `\n${failed} of ${chains.length} routes do not check out.`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exit(1);
});
