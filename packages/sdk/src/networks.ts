import { hash, StrKey } from "@stellar/stellar-sdk";
import { toHex, type Address, type Chain, type Hex } from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  arc,
  arcTestnet,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from "viem/chains";
import mainnetDeployment from "../../../deployments/mainnet.json";
import testnetDeployment from "../../../deployments/testnet.json";

export type NetworkName = "testnet" | "mainnet";

/** The Stellar side of a network: where to talk to it and which contracts matter. */
export interface StellarConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** Paso hub contract id. Empty until Paso is deployed on the network. */
  hub: string;
  /** Hash of the account contract the hub deploys. Empty until Paso is deployed. */
  accountWasmHash: string;
  usdc: string;
  tokenMessenger: string;
  messageTransmitter: string;
  forwarder: string;
  cctpDomain: number;
  explorerUrl: string;
}

/** An EVM chain USDC moves to and from, with Circle's contracts there. */
export interface EvmConfig {
  chain: Chain;
  /** The USDC token: 6 decimals on every chain listed, Arc included. */
  usdc: Address;
  /** Circle's TokenMessengerV2. */
  tokenMessenger: Address;
  /** Circle's MessageTransmitterV2. */
  messageTransmitter: Address;
  cctpDomain: number;
}

/** The EVM chains Paso moves USDC between and Stellar. */
export type EvmChainName = "base" | "ethereum" | "arbitrum" | "optimism" | "arc";

/** Every EVM chain, in the order they are listed. */
export const EVM_CHAIN_NAMES: readonly EvmChainName[] = ["base", "ethereum", "arbitrum", "optimism", "arc"];

/** The chain used when none is named: Base on mainnet, Base Sepolia on testnet. */
export const DEFAULT_EVM_CHAIN: EvmChainName = "base";

/** What a chain charges gas in. */
export interface GasToken {
  symbol: string;
  decimals: number;
  /**
   * True on Arc, where gas is paid in USDC. The native balance and the USDC
   * token there are one balance: 18 decimals natively, 6 through the token.
   * A transfer and its gas come out of the same USDC.
   */
  isUsdc: boolean;
}

/** Where test funds come from. Mainnet chains have none. */
export interface Faucets {
  usdc: string;
  /** Where the gas token comes from; on Arc that is USDC, from the same faucet. */
  gas: string;
}

/** An EVM chain of a network, everything a wallet, a script or a page needs to use it. */
export interface EvmChainConfig extends EvmConfig {
  name: EvmChainName;
  /** The chain's name on this network: "Base Sepolia", "Arc Testnet", "OP Mainnet". */
  label: string;
  /** The same name on every network: "Base", "Arc", "OP Mainnet". */
  shortLabel: string;
  /** Decimals of the USDC token, the interface CCTP burns and mints through. */
  usdcDecimals: number;
  gasToken: GasToken;
  /** Public endpoints that need no key, in the order to try them. */
  rpcUrls: readonly string[];
  /** Block explorer, without a trailing slash. */
  explorerUrl: string;
  /**
   * Whether Circle offers Fast Transfer from this chain. Where it does not,
   * a standard transfer is attested within seconds already, and costs nothing.
   */
  fastTransfer: boolean;
  faucets?: Faucets;
}

export interface NetworkConfig {
  name: NetworkName;
  stellar: StellarConfig;
  /** The default EVM chain: Base. Every function that is not told a chain uses this one. */
  evm: EvmConfig;
  /**
   * Every EVM chain of the network, by name. A config without it offers its
   * `evm` chain alone.
   */
  evmChains?: Readonly<Record<EvmChainName, EvmChainConfig>>;
  /** Circle's attestation service. */
  irisUrl: string;
}

/** Every function that needs a network takes its name or a full config. */
export type Network = NetworkName | NetworkConfig;

/**
 * What `deployments/<network>.json` holds. `hub` and `accountWasmHash` are
 * empty until Paso is deployed on the network; `scripts/deploy.sh` fills them.
 */
interface Deployment {
  rpcUrl: string;
  networkPassphrase: string;
  hub: string;
  accountWasmHash: string;
  usdc: string;
  tokenMessenger: string;
  messageTransmitter: string;
  forwarder: string;
}

export const STELLAR_CCTP_DOMAIN = 27;
export const BASE_CCTP_DOMAIN = 6;

function stellarConfig(deployment: Deployment, explorerUrl: string): StellarConfig {
  return {
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: deployment.networkPassphrase,
    hub: deployment.hub,
    accountWasmHash: deployment.accountWasmHash,
    usdc: deployment.usdc,
    tokenMessenger: deployment.tokenMessenger,
    messageTransmitter: deployment.messageTransmitter,
    forwarder: deployment.forwarder,
    cctpDomain: STELLAR_CCTP_DOMAIN,
    explorerUrl,
  };
}

/** Circle's domain numbers, the same on mainnet and testnet. */
export const CCTP_DOMAINS: Readonly<Record<EvmChainName, number>> = {
  ethereum: 0,
  optimism: 2,
  arbitrum: 3,
  base: BASE_CCTP_DOMAIN,
  arc: 26,
};

/** Circle's CCTP V2 contracts: one address on every testnet listed here, another on every mainnet chain. */
const CIRCLE = {
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
  mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
} as const satisfies Record<NetworkName, Record<string, Address>>;

const ETH: GasToken = { symbol: "ETH", decimals: 18, isUsdc: false };
const USDC_GAS: GasToken = { symbol: "USDC", decimals: 18, isUsdc: true };
const CIRCLE_FAUCET = "https://faucet.circle.com";

interface ChainEntry {
  chain: Chain;
  label: string;
  shortLabel: string;
  usdc: Address;
  gasToken: GasToken;
  rpcUrls: readonly string[];
  explorerUrl: string;
  fastTransfer: boolean;
  gasFaucet?: string;
}

function chainsOf(network: NetworkName, entries: Record<EvmChainName, ChainEntry>): Record<EvmChainName, EvmChainConfig> {
  const chains = {} as Record<EvmChainName, EvmChainConfig>;
  for (const name of EVM_CHAIN_NAMES) {
    const { gasFaucet, ...entry } = entries[name];
    chains[name] = {
      name,
      ...entry,
      ...CIRCLE[network],
      cctpDomain: CCTP_DOMAINS[name],
      usdcDecimals: 6,
      ...(gasFaucet ? { faucets: { usdc: CIRCLE_FAUCET, gas: gasFaucet } } : {}),
    };
  }
  return chains;
}

/*
 * Every address below was read back from its chain before it was listed:
 * the transmitter's `localDomain()` is the domain, the token messenger names
 * the transmitter and Stellar's token messenger for domain 27, its minter
 * pairs Stellar's USDC with the USDC listed, and Stellar's token messenger
 * names this chain's messenger and USDC in return. The evidence is in
 * `test/fixtures/cctp-routes.json`.
 */
const TESTNET_CHAINS = chainsOf("testnet", {
  base: {
    chain: baseSepolia,
    label: "Base Sepolia",
    shortLabel: "Base",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gasToken: ETH,
    rpcUrls: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    explorerUrl: "https://sepolia.basescan.org",
    fastTransfer: true,
    gasFaucet: "https://portal.cdp.coinbase.com/products/faucet",
  },
  ethereum: {
    chain: sepolia,
    label: "Ethereum Sepolia",
    shortLabel: "Ethereum",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    gasToken: ETH,
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
    explorerUrl: "https://sepolia.etherscan.io",
    fastTransfer: true,
    gasFaucet: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
  },
  arbitrum: {
    chain: arbitrumSepolia,
    label: "Arbitrum Sepolia",
    shortLabel: "Arbitrum",
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    gasToken: ETH,
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"],
    explorerUrl: "https://sepolia.arbiscan.io",
    fastTransfer: true,
    gasFaucet: "https://www.alchemy.com/faucets/arbitrum-sepolia",
  },
  optimism: {
    chain: optimismSepolia,
    label: "OP Sepolia",
    shortLabel: "OP Mainnet",
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    gasToken: ETH,
    rpcUrls: ["https://sepolia.optimism.io", "https://optimism-sepolia-rpc.publicnode.com"],
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    fastTransfer: true,
    gasFaucet: "https://console.optimism.io/faucet",
  },
  arc: {
    chain: arcTestnet,
    label: "Arc Testnet",
    shortLabel: "Arc",
    usdc: "0x3600000000000000000000000000000000000000",
    gasToken: USDC_GAS,
    rpcUrls: ["https://rpc.testnet.arc.network", "https://rpc.blockdaemon.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"],
    explorerUrl: "https://explorer.testnet.arc.io",
    fastTransfer: false,
    gasFaucet: CIRCLE_FAUCET,
  },
});

const MAINNET_CHAINS = chainsOf("mainnet", {
  base: {
    chain: base,
    label: "Base",
    shortLabel: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    gasToken: ETH,
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    explorerUrl: "https://basescan.org",
    fastTransfer: true,
  },
  ethereum: {
    chain: mainnet,
    label: "Ethereum",
    shortLabel: "Ethereum",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    gasToken: ETH,
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    explorerUrl: "https://etherscan.io",
    fastTransfer: true,
  },
  arbitrum: {
    chain: arbitrum,
    label: "Arbitrum",
    shortLabel: "Arbitrum",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    gasToken: ETH,
    rpcUrls: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    explorerUrl: "https://arbiscan.io",
    fastTransfer: true,
  },
  optimism: {
    chain: optimism,
    label: "OP Mainnet",
    shortLabel: "OP Mainnet",
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    gasToken: ETH,
    rpcUrls: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    explorerUrl: "https://optimistic.etherscan.io",
    fastTransfer: true,
  },
  arc: {
    chain: arc,
    label: "Arc",
    shortLabel: "Arc",
    usdc: "0x3600000000000000000000000000000000000000",
    gasToken: USDC_GAS,
    rpcUrls: ["https://rpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"],
    explorerUrl: "https://explorer.arc.io",
    fastTransfer: false,
  },
});

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    stellar: stellarConfig(testnetDeployment, "https://stellar.expert/explorer/testnet"),
    evm: TESTNET_CHAINS[DEFAULT_EVM_CHAIN],
    evmChains: TESTNET_CHAINS,
    irisUrl: "https://iris-api-sandbox.circle.com",
  },
  mainnet: {
    name: "mainnet",
    stellar: stellarConfig(mainnetDeployment, "https://stellar.expert/explorer/public"),
    evm: MAINNET_CHAINS[DEFAULT_EVM_CHAIN],
    evmChains: MAINNET_CHAINS,
    irisUrl: "https://iris-api.circle.com",
  },
};

export function resolveNetwork(network: Network): NetworkConfig {
  if (typeof network !== "string") return network;
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(`Unknown network "${network}"; expected one of ${Object.keys(NETWORKS).join(", ")}`);
  }
  return config;
}

export function isEvmChainName(value: unknown): value is EvmChainName {
  return typeof value === "string" && (EVM_CHAIN_NAMES as readonly string[]).includes(value);
}

const sameContracts = (a: EvmConfig, b: EvmConfig): boolean =>
  a.chain === b.chain &&
  a.usdc === b.usdc &&
  a.tokenMessenger === b.tokenMessenger &&
  a.messageTransmitter === b.messageTransmitter &&
  a.cctpDomain === b.cctpDomain;

/** The `evm` of a config that lists no chains, with what its viem chain says about it. */
function describedEvm(evm: EvmConfig): EvmChainConfig {
  const { nativeCurrency } = evm.chain;
  return {
    name: DEFAULT_EVM_CHAIN,
    label: evm.chain.name,
    shortLabel: evm.chain.name,
    usdcDecimals: 6,
    gasToken: { symbol: nativeCurrency.symbol, decimals: nativeCurrency.decimals, isUsdc: nativeCurrency.symbol === "USDC" },
    rpcUrls: evm.chain.rpcUrls.default.http,
    explorerUrl: evm.chain.blockExplorers?.default.url.replace(/\/$/, "") ?? "",
    fastTransfer: true,
    ...evm,
  };
}

/**
 * One EVM chain of a network, `base` when none is named. A name outside
 * `EVM_CHAIN_NAMES`, or a chain the network does not list, throws.
 *
 * The default chain is the config's `evm`: a config that replaces `evm`
 * replaces Base with it.
 */
export function evmChain(network: Network, name: EvmChainName = DEFAULT_EVM_CHAIN): EvmChainConfig {
  const config = resolveNetwork(network);
  if (!isEvmChainName(name)) {
    throw new Error(`Unknown EVM chain "${String(name)}"; expected one of ${EVM_CHAIN_NAMES.join(", ")}`);
  }
  const listed = config.evmChains?.[name];
  if (name === DEFAULT_EVM_CHAIN) {
    if (listed && sameContracts(listed, config.evm)) return listed;
    return listed ? { ...listed, ...config.evm } : describedEvm(config.evm);
  }
  if (!listed) {
    const offered = listEvmChains(config).map((chain) => chain.name).join(", ");
    throw new Error(`Paso on ${config.name} offers no EVM chain "${name}"; it offers ${offered}`);
  }
  return listed;
}

/** Every EVM chain of a network, the default first. */
export function listEvmChains(network: Network): EvmChainConfig[] {
  const config = resolveNetwork(network);
  const listed = EVM_CHAIN_NAMES.filter((name) => name === DEFAULT_EVM_CHAIN || config.evmChains?.[name] !== undefined);
  return listed.map((name) => evmChain(config, name));
}

/** The chain of a network that has this CCTP domain, or `undefined` when it lists none. */
export function evmChainForDomain(network: Network, domain: number): EvmChainConfig | undefined {
  return listEvmChains(network).find((chain) => chain.cctpDomain === domain);
}

/** The chain of a network that has this chain id, or `undefined` when it lists none. */
export function evmChainForId(network: Network, chainId: number): EvmChainConfig | undefined {
  return listEvmChains(network).find((chain) => chain.chain.id === chainId);
}

/** The 32-byte network id: sha256 of the passphrase. It salts the signing domain. */
export function networkId(network: Network): Hex {
  return toHex(hash(resolveNetwork(network).stellar.networkPassphrase));
}

/**
 * The network a signing domain's salt stands for: the name of the network
 * whose network id equals it, hex compared in any case, or `null` when it is
 * the id of no network listed here.
 *
 * The salt is the only readable field of a signing request that says which
 * network it is for.
 */
export function saltNetwork(salt: Hex): NetworkName | null {
  if (typeof salt !== "string") return null;
  const wanted = salt.toLowerCase();
  const names = Object.keys(NETWORKS) as NetworkName[];
  return names.find((name) => networkId(name) === wanted) ?? null;
}

/** The hub contract id, or a clear error when Paso is not deployed on the network. */
export function requireHub(network: Network): string {
  const { name, stellar } = resolveNetwork(network);
  if (!stellar.hub) {
    throw new Error(`Paso has no hub on ${name} yet, so accounts cannot be derived there`);
  }
  return stellar.hub;
}

export function stellarTxUrl(txHash: string, network: Network): string {
  return `${resolveNetwork(network).stellar.explorerUrl}/tx/${txHash}`;
}

/** Explorer page for a contract (`C…`) or a classic account (`G…`). */
export function stellarAddressUrl(address: string, network: Network): string {
  const kind = StrKey.isValidContract(address) ? "contract" : "account";
  return `${resolveNetwork(network).stellar.explorerUrl}/${kind}/${address}`;
}

function evmExplorerUrl(network: Network, chainName?: EvmChainName): string {
  const { explorerUrl, label } = evmChain(network, chainName);
  if (!explorerUrl) {
    throw new Error(`${label} has no block explorer configured`);
  }
  return explorerUrl.replace(/\/$/, "");
}

/** A transaction on an EVM chain's explorer: the default chain unless one is named. */
export function evmTxUrl(txHash: string, network: Network, chain?: EvmChainName): string {
  return `${evmExplorerUrl(network, chain)}/tx/${txHash}`;
}

/** An address on an EVM chain's explorer: the default chain unless one is named. */
export function evmAddressUrl(address: string, network: Network, chain?: EvmChainName): string {
  return `${evmExplorerUrl(network, chain)}/address/${address}`;
}
