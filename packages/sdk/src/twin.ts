import { Address as StellarAddress, hash, StrKey, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, isAddress, toHex, type Address, type Hex } from "viem";
import { requireHub, resolveNetwork, type Network } from "./networks";

/** The hub's deployment salt for an owner: 12 zero bytes, then the 20 address bytes. */
export function twinSalt(owner: Address): Uint8Array {
  if (!isAddress(owner, { strict: false })) {
    throw new Error(`"${owner}" is not an Ethereum address`);
  }
  const salt = new Uint8Array(32);
  salt.set(hexToBytes(owner), 12);
  return salt;
}

function twinId(owner: Address, network: Network): Uint8Array {
  const config = resolveNetwork(network);
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(config.stellar.networkPassphrase),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new StellarAddress(requireHub(config)).toScAddress(),
          salt: twinSalt(owner),
        }),
      ),
    }),
  );
  return hash(preimage.toXdr());
}

/**
 * The Stellar account (`C…`) that belongs to an Ethereum address.
 *
 * Pure: it is the id of the contract the hub deploys with that owner as salt,
 * so it is known before the account exists and needs no network call.
 */
export function twinAddress(owner: Address, network: Network): string {
  return StrKey.encodeContract(twinId(owner, network));
}

/** The same account as 32 bytes of hex, the form CCTP uses for a mint recipient. */
export function twinContractId(owner: Address, network: Network): Hex {
  return toHex(twinId(owner, network));
}
