/**
 * What an Ethereum wallet signs for the Paso EVM verifier.
 *
 * The verifier checks a signature over two things: the smart account the
 * signer was registered for, and 32 bytes that account wants approved. They
 * go into one EIP-712 message, `Authorization(string account,bytes32
 * payload)`, under a domain that names the verifier and the Stellar network.
 * A wallet therefore shows which account it is signing for, and a hash:
 * nothing in the message says which calls the hash stands for.
 */
import { Address as StellarAddress, hash, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  concat,
  hashTypedData,
  hexToBytes,
  isAddress,
  isAddressEqual,
  recoverTypedDataAddress,
  sha256,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";

export const DOMAIN_NAME = "Paso verifier";
export const DOMAIN_VERSION = "2";

export const TYPES = {
  Authorization: [
    { name: "account", type: "string" },
    { name: "payload", type: "bytes32" },
  ],
} as const;

export const NETWORK_PASSPHRASES = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
} as const;

export type NetworkName = keyof typeof NETWORK_PASSPHRASES;

/** A network by name, or any Stellar network by its passphrase. */
export type Network = NetworkName | { networkPassphrase: string };

export function networkPassphrase(network: Network): string {
  return typeof network === "string" ? NETWORK_PASSPHRASES[network] : network.networkPassphrase;
}

/** The Stellar network id: sha256 of the passphrase. On chain it is `env.ledger().network_id()`. */
export function networkId(network: Network): Hex {
  return sha256(toHex(networkPassphrase(network)));
}

function assertAccount(account: string): void {
  if (!StrKey.isValidContract(account)) {
    throw new Error(`"${account}" is not the address of a contract (C…)`);
  }
}

function assertPayload(payload: Hex): void {
  if (size(payload) !== 32) {
    throw new Error(`Expected a payload of 32 bytes and got ${size(payload)}`);
  }
}

/**
 * The id of the contract that `deployer` creates with `salt`, as a strkey.
 *
 * A signer's key data names the account it belongs to, so the id of an
 * account that is created with its signers has to be known before it exists.
 * It depends only on the network, the deployer and the salt.
 */
export function contractId(deployer: string, salt: Uint8Array | Hex, network: Network): string {
  const saltBytes = typeof salt === "string" ? hexToBytes(salt) : salt;
  if (saltBytes.length !== 32) {
    throw new Error(`Expected a salt of 32 bytes and got ${saltBytes.length}`);
  }
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hexToBytes(networkId(network)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: StellarAddress.fromString(deployer).toScAddress(),
          salt: saltBytes,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/**
 * The key data of a signer, as the verifier reads it: the 20-byte Ethereum
 * address followed by the 32-byte contract id of the smart account the
 * signer is registered for.
 */
export function keyData(address: Address, account: string): Hex {
  if (!isAddress(address, { strict: false })) {
    throw new Error(`"${address}" is not an Ethereum address`);
  }
  assertAccount(account);
  return concat([address.toLowerCase() as Hex, toHex(StrKey.decodeContract(account))]);
}

/** What the wallet is asked to sign. Accepted as is by viem's `signTypedData` and `hashTypedData`. */
export interface VerifierTypedData {
  /** No chain id and no verifying contract: the network id in `salt` separates networks. */
  domain: { name: typeof DOMAIN_NAME; version: typeof DOMAIN_VERSION; salt: Hex };
  types: typeof TYPES;
  primaryType: "Authorization";
  message: {
    /** Strkey (`C…`) of the smart account the signature is for. */
    account: string;
    /** The 32 bytes that account hands to the verifier. */
    payload: Hex;
  };
}

/**
 * The typed data for `payload`, the 32 bytes the smart account `account`
 * asks the verifier to check.
 */
export function typedData(account: string, payload: Hex, network: Network): VerifierTypedData {
  assertAccount(account);
  assertPayload(payload);
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, salt: networkId(network) },
    types: TYPES,
    primaryType: "Authorization",
    message: { account, payload },
  };
}

/** The EIP-712 digest the wallet signs and the verifier recomputes. */
export function digest(account: string, payload: Hex, network: Network): Hex {
  return hashTypedData(typedData(account, payload, network));
}

/**
 * Anything that signs EIP-712 typed data: a viem account, or a wallet client
 * with its account set. When `address` is present the signature is checked
 * against it before it is returned.
 */
export interface TypedDataSigner {
  address?: Address;
  signTypedData(data: VerifierTypedData): Promise<Hex>;
}

const SIGNATURE_BYTES = 65;
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ACCEPTED_RECOVERY_BYTES = [0, 1, 27, 28];

/** Throws unless `signature` has the form the verifier accepts: 65 bytes, low `s`, `v` in 0, 1, 27, 28. */
export function assertUsableSignature(signature: Hex): void {
  if (size(signature) !== SIGNATURE_BYTES) {
    throw new Error(
      `Expected a signature of 65 bytes (r, s, v) and got ${size(signature)}; ` +
        "smart-contract wallets cannot sign for the verifier",
    );
  }
  const bytes = hexToBytes(signature);
  if (BigInt(toHex(bytes.subarray(32, 64))) > SECP256K1_HALF_ORDER) {
    throw new Error("The signature is not in low-s form, which the verifier requires");
  }
  const recovery = bytes[64] ?? -1;
  if (!ACCEPTED_RECOVERY_BYTES.includes(recovery)) {
    throw new Error(`The signature has recovery byte ${recovery}; the verifier accepts 0, 1, 27 or 28`);
  }
}

/** The Ethereum address whose key made `signature` over `payload` for `account` on `network`. */
export function recoverSigner(account: string, payload: Hex, network: Network, signature: Hex): Promise<Address> {
  assertUsableSignature(signature);
  return recoverTypedDataAddress({ ...typedData(account, payload, network), signature });
}

/**
 * Asks `signer` to sign `payload` for the smart account `account` on
 * `network` and returns the signature as the verifier reads it:
 * `r ‖ s ‖ v`, 65 bytes.
 */
export async function signPayload(
  signer: TypedDataSigner,
  account: string,
  payload: Hex,
  network: Network,
): Promise<Hex> {
  const signature = await signer.signTypedData(typedData(account, payload, network));
  const recovered = await recoverSigner(account, payload, network, signature);
  if (signer.address && !isAddressEqual(recovered, signer.address)) {
    throw new Error(`The signature was made by ${recovered}, not by ${signer.address}`);
  }
  return signature;
}
