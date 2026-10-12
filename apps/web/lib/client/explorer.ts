import { evmAddressUrl, evmTxUrl, stellarAddressUrl, stellarTxUrl, type Network } from "@paso/sdk";
import { NETWORK } from "./config";

/** A Stellar transaction on the explorer. Stellar hashes are written without `0x`. */
export function stellarTx(hash: string, network: Network = NETWORK): string {
  return stellarTxUrl(hash.replace(/^0x/i, ""), network);
}

/** A Stellar account (`G…`) or contract (`C…`) on the explorer. */
export function stellarAddress(address: string, network: Network = NETWORK): string {
  return stellarAddressUrl(address, network);
}

/** A transaction on Base. */
export function baseTx(hash: string, network: Network = NETWORK): string {
  return evmTxUrl(hash, network);
}

/** An address on Base. */
export function baseAddress(address: string, network: Network = NETWORK): string {
  return evmAddressUrl(address, network);
}
