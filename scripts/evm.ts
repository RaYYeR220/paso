/**
 * The EVM side of a run: which chain, how to reach it, what Circle's
 * contracts there say, and what a transaction there costs.
 */
import { StrKey } from "@stellar/stellar-sdk";
import {
  createPublicClient,
  encodeAbiParameters,
  fallback,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  toHex,
  type Address,
  type Hex,
  type StateOverride,
  type TransactionRequest,
} from "viem";
import { estimateL1Fee } from "viem/op-stack";
import {
  DEFAULT_EVM_CHAIN,
  EVM_CHAIN_NAMES,
  evmUnitsToNativeUsdc,
  isEvmChainName,
  type EvmChainConfig,
  type EvmChainName,
  type NetworkConfig,
} from "../packages/sdk/src/index";
import type { Report } from "./sender";

/** Reads `--chain <name>`: one of the chains the SDK lists, Base when absent. */
export function parseChain(value: string | undefined, usage: (message: string) => never): EvmChainName {
  if (value === undefined) return DEFAULT_EVM_CHAIN;
  if (!isEvmChainName(value)) usage(`--chain takes one of ${EVM_CHAIN_NAMES.join(", ")}, not ${value}`);
  return value;
}

/** The environment variable that overrides a chain's endpoints: `BASE_RPC_URL`, `ARC_RPC_URL`… */
export const rpcVariable = (chain: EvmChainConfig): string => `${chain.name.toUpperCase()}_RPC_URL`;

/** The chain's endpoint from the environment when set, its public ones otherwise, tried in order. */
export function evmTransport(chain: EvmChainConfig) {
  const override = process.env[rpcVariable(chain)]?.trim();
  if (override) return http(override);
  return fallback(chain.rpcUrls.map((url) => http(url)));
}

export function evmReader(chain: EvmChainConfig) {
  return createPublicClient({ chain: chain.chain, transport: evmTransport(chain) });
}

export type ChainReader = ReturnType<typeof evmReader>;

/** OP Stack chains (Base, OP Mainnet) charge a fee of their own for the data they post to Ethereum. */
export function chargesDataFee(chain: EvmChainConfig): boolean {
  return Boolean(chain.chain.contracts && "gasPriceOracle" in chain.chain.contracts);
}

/** What posting a transaction's data to Ethereum costs, in the gas token; zero where there is no such fee. */
export async function dataFee(
  client: ChainReader,
  chain: EvmChainConfig,
  request: Pick<TransactionRequest, "data" | "gas"> & { account: Address; to: Address },
): Promise<bigint> {
  if (!chargesDataFee(chain)) return 0n;
  return estimateL1Fee(client, request);
}

/** An amount of the chain's gas token as text with its symbol: "0.0001 ETH", "0.02 USDC". */
export function formatGas(amount: bigint, chain: EvmChainConfig): string {
  return `${formatUnits(amount, chain.gasToken.decimals)} ${chain.gasToken.symbol}`;
}

/** Stops the run when a chain does not say what the configuration says. */
export function expectSame(what: string, actual: string, expected: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${what}: the configuration says ${expected}, the chain says ${actual}`);
  }
}

const circleAbi = [
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "localMessageTransmitter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "localMinter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "remoteTokenMessengers", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "getLocalToken", stateMutability: "view", inputs: [{ type: "uint32" }, { type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** What Circle's contracts on an EVM chain said when they were checked. */
export interface EvmEvidence {
  chainId: number;
  block: string;
  localDomain: number;
  localMessageTransmitter: Address;
  tokenMinter: Address;
  remoteTokenMessenger: Hex;
  localTokenForStellarUsdc: Address;
  usdcDecimals: number;
  codeBytes: { tokenMessenger: number; messageTransmitter: number; usdc: number; tokenMinter: number };
}

/**
 * The endpoint has to serve the chain, and Circle's contracts there have to
 * exist, name each other, carry the chain's domain, and know Stellar: its
 * token messenger for domain 27, and its USDC paired with the chain's own.
 */
export async function checkEvmCircle(config: NetworkConfig, chain: EvmChainConfig, client: ChainReader): Promise<EvmEvidence> {
  const { tokenMessenger, messageTransmitter, usdc, cctpDomain, label } = chain;
  const chainId = await client.getChainId();
  if (chainId !== chain.chain.id) {
    throw new Error(`The ${label} endpoint serves chain ${chainId}, not ${chain.chain.id}; check ${rpcVariable(chain)}`);
  }
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ address, abi: circleAbi, functionName, args } as never) as Promise<T>;
  const codeBytes = async (address: Address) => {
    const code = (await client.getCode({ address })) ?? "0x";
    if (code === "0x") throw new Error(`${label} has no contract at ${address}`);
    return (code.length - 2) / 2;
  };

  const block = await client.getBlockNumber();
  const tokenMinter = await read<Address>(tokenMessenger, "localMinter");
  const evidence: EvmEvidence = {
    chainId,
    block: block.toString(),
    localDomain: await read<number>(messageTransmitter, "localDomain"),
    localMessageTransmitter: await read<Address>(tokenMessenger, "localMessageTransmitter"),
    tokenMinter,
    remoteTokenMessenger: await read<Hex>(tokenMessenger, "remoteTokenMessengers", [config.stellar.cctpDomain]),
    localTokenForStellarUsdc: await read<Address>(tokenMinter, "getLocalToken", [
      config.stellar.cctpDomain,
      toHex(StrKey.decodeContract(config.stellar.usdc)),
    ]),
    usdcDecimals: await read<number>(usdc, "decimals"),
    codeBytes: {
      tokenMessenger: await codeBytes(tokenMessenger),
      messageTransmitter: await codeBytes(messageTransmitter),
      usdc: await codeBytes(usdc),
      tokenMinter: await codeBytes(tokenMinter),
    },
  };

  expectSame(`The CCTP domain of Circle's message transmitter on ${label}`, String(evidence.localDomain), String(cctpDomain));
  expectSame(`The message transmitter of Circle's token messenger on ${label}`, evidence.localMessageTransmitter, messageTransmitter);
  expectSame(
    `The token messenger ${label} knows for Stellar`,
    evidence.remoteTokenMessenger,
    toHex(StrKey.decodeContract(config.stellar.tokenMessenger)),
  );
  expectSame(`The USDC ${label} mints for USDC from Stellar`, evidence.localTokenForStellarUsdc, usdc);
  expectSame(`The decimals of USDC on ${label}`, String(evidence.usdcDecimals), String(chain.usdcDecimals));
  return evidence;
}

export function reportEvmCircle(chain: EvmChainConfig, report: Report): void {
  report("evm", `token messenger and message transmitter name each other on ${chain.label} (chain ${chain.chain.id})`);
  report("", `domain ${chain.cctpDomain}; Stellar is registered as domain 27, and its USDC pairs with ${chain.usdc}`);
}

/** Storage slots of Circle's FiatToken, the USDC contract on every listed chain but Arc: balances, then allowances. */
const USDC_BALANCES_SLOT = 9n;
const USDC_ALLOWANCES_SLOT = 10n;

const slotOf = (key: Address, slot: Hex) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [key, slot]));

/**
 * Gives `holder` the USDC and the allowance of a burn of `amount`, for the
 * length of one simulation.
 *
 * Arc's USDC token reads the account's native balance, so there the native
 * balance is raised instead of a storage slot, on top of `native`, what the
 * holder has for gas.
 */
export function fundedForBurn(chain: EvmChainConfig, holder: Address, amount: bigint, native: bigint): StateOverride {
  const value = numberToHex(amount, { size: 32 });
  const allowance = slotOf(chain.tokenMessenger, slotOf(holder, numberToHex(USDC_ALLOWANCES_SLOT, { size: 32 })));
  if (chain.gasToken.isUsdc) {
    return [
      { address: holder, balance: native + evmUnitsToNativeUsdc(amount) },
      { address: chain.usdc, stateDiff: [{ slot: allowance, value }] },
    ];
  }
  const balance = slotOf(holder, numberToHex(USDC_BALANCES_SLOT, { size: 32 }));
  return [
    {
      address: chain.usdc,
      stateDiff: [
        { slot: balance, value },
        { slot: allowance, value },
      ],
    },
  ];
}
