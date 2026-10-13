import { evmAddressUrl, evmTxUrl, stellarAddressUrl, stellarTxUrl, type EvmChainName, type Network } from "paso-sdk";

/**
 * Links to the block explorers. Each takes the network: the same hash or
 * address is a different page, or no page at all, on the other one. An EVM
 * link takes the chain as well, Base when none is named.
 */

/** A Stellar transaction on the explorer. Stellar hashes are written without `0x`. */
export function stellarTx(hash: string, network: Network): string {
  return stellarTxUrl(hash.replace(/^0x/i, ""), network);
}

/** A Stellar account (`G…`) or contract (`C…`) on the explorer. */
export function stellarAddress(address: string, network: Network): string {
  return stellarAddressUrl(address, network);
}

/** A transaction on an EVM chain. */
export function evmTx(hash: string, network: Network, chain?: EvmChainName): string {
  return evmTxUrl(hash, network, chain);
}

/** An address on an EVM chain. */
export function evmAddress(address: string, network: Network, chain?: EvmChainName): string {
  return evmAddressUrl(address, network, chain);
}
