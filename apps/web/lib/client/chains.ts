import {
  DEFAULT_EVM_CHAIN,
  evmChain,
  isEvmChainName,
  listEvmChains,
  type EvmChainConfig,
  type EvmChainName,
  type Network,
} from "@paso/sdk";

/**
 * The EVM chains USDC comes from and goes back to. Each network lists its
 * own: Base first, then Ethereum, Arbitrum, OP Mainnet and Arc, or their test
 * networks. Everything here is read from the SDK, which checked each chain's
 * contracts before listing it.
 */

/** Every chain a network lists, Base first. */
export function chainsOf(network: Network): EvmChainConfig[] {
  return listEvmChains(network);
}

/** One chain of a network: Base unless another is named. */
export function chainOf(network: Network, name: EvmChainName = DEFAULT_EVM_CHAIN): EvmChainConfig {
  return evmChain(network, name);
}

/** The only chain the testnet faucet, and so the demo key, brings USDC from. */
export const FAUCET_CHAIN: EvmChainName = DEFAULT_EVM_CHAIN;

/**
 * The chain a record kept in the browser names. A record written before
 * there was a choice names none, and every such record was about Base. A
 * name the network does not list makes the record unreadable: `null`.
 */
export function storedChain(value: unknown, network: Network): EvmChainName | null {
  if (value === undefined) return DEFAULT_EVM_CHAIN;
  if (!isEvmChainName(value)) return null;
  return chainsOf(network).some((chain) => chain.name === value) ? value : null;
}

/** The gas a chain charges in, as the app writes it: "ETH", or "USDC" on Arc. */
export function gasSymbol(chain: Pick<EvmChainConfig, "gasToken">): string {
  return chain.gasToken.symbol;
}

/**
 * Whether the hosted server submits the mint that ends a transfer back to
 * this chain. It does so on Base Sepolia only, and only when it is set up
 * to; on every other chain, and on mainnet, the owner's wallet submits it.
 */
export function serverMintsOn(chain: EvmChainName, paysBaseMints: boolean): boolean {
  return paysBaseMints && chain === DEFAULT_EVM_CHAIN;
}
