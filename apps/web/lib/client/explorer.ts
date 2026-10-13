import { evmAddressUrl, evmTxUrl, stellarAddressUrl, stellarTxUrl, type Network } from "@paso/sdk";

/**
 * Links to the block explorers. Each takes the network: the same hash or
 * address is a different page, or no page at all, on the other one.
 */

/** A Stellar transaction on the explorer. Stellar hashes are written without `0x`. */
export function stellarTx(hash: string, network: Network): string {
  return stellarTxUrl(hash.replace(/^0x/i, ""), network);
}

/** A Stellar account (`G…`) or contract (`C…`) on the explorer. */
export function stellarAddress(address: string, network: Network): string {
  return stellarAddressUrl(address, network);
}

/** A transaction on Base. */
export function baseTx(hash: string, network: Network): string {
  return evmTxUrl(hash, network);
}

/** An address on Base. */
export function baseAddress(address: string, network: Network): string {
  return evmAddressUrl(address, network);
}
