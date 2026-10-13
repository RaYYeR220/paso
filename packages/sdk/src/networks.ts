import { hash, StrKey } from "@stellar/stellar-sdk";
import { toHex, type Address, type Chain, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
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

/** The EVM side of a network: Base, with Circle's contracts. */
export interface EvmConfig {
  chain: Chain;
  usdc: Address;
  tokenMessenger: Address;
  messageTransmitter: Address;
  cctpDomain: number;
}

export interface NetworkConfig {
  name: NetworkName;
  stellar: StellarConfig;
  evm: EvmConfig;
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

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    name: "testnet",
    stellar: stellarConfig(testnetDeployment, "https://stellar.expert/explorer/testnet"),
    evm: {
      chain: baseSepolia,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
      cctpDomain: BASE_CCTP_DOMAIN,
    },
    irisUrl: "https://iris-api-sandbox.circle.com",
  },
  mainnet: {
    name: "mainnet",
    stellar: stellarConfig(mainnetDeployment, "https://stellar.expert/explorer/public"),
    evm: {
      chain: base,
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      cctpDomain: BASE_CCTP_DOMAIN,
    },
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

function evmExplorerUrl(network: Network): string {
  const { chain } = resolveNetwork(network).evm;
  const explorer = chain.blockExplorers?.default.url;
  if (!explorer) {
    throw new Error(`${chain.name} has no block explorer configured`);
  }
  return explorer.replace(/\/$/, "");
}

export function evmTxUrl(txHash: string, network: Network): string {
  return `${evmExplorerUrl(network)}/tx/${txHash}`;
}

export function evmAddressUrl(address: string, network: Network): string {
  return `${evmExplorerUrl(network)}/address/${address}`;
}
