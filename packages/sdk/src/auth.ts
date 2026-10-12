import { Address, buildAuthorizationEntryPreimage, hash, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, size, toHex, type Hex } from "viem";
import { resolveNetwork, type Network } from "./networks";
import { renderCalls } from "./render";
import { typedData, type AuthorizationTypedData } from "./typedData";

/** Anything that signs EIP-712 typed data: a viem account, or a wallet client with its account set. */
export interface TypedDataSigner {
  signTypedData(data: AuthorizationTypedData): Promise<Hex>;
}

const SIGNATURE_BYTES = 65;
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ACCEPTED_RECOVERY_BYTES = [0, 1, 27, 28];

/**
 * The address credentials of an entry, whichever of the two encodings it uses.
 * Both carry the same fields; they differ in the payload that gets signed.
 */
function addressCredentials(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const { credentials } = entry;
  switch (credentials.type) {
    case "sorobanCredentialsAddress":
      return credentials.address;
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2;
    default:
      throw new Error(`Expected an entry with address credentials, got ${credentials.type}`);
  }
}

function withAddressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
  change: Partial<{ signatureExpirationLedger: number; signature: xdr.ScVal }>,
): xdr.SorobanAuthorizationEntry {
  const current = addressCredentials(entry);
  const updated = new xdr.SorobanAddressCredentials({
    address: current.address,
    nonce: current.nonce,
    signatureExpirationLedger: change.signatureExpirationLedger ?? current.signatureExpirationLedger,
    signature: change.signature ?? current.signature,
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      entry.credentials.type === "sorobanCredentialsAddress"
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(updated)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(updated),
    rootInvocation: entry.rootInvocation,
  });
}

/** Strkey of the address an entry asks to authorise, or `null` when the transaction source covers it. */
export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const { credentials } = entry;
  switch (credentials.type) {
    case "sorobanCredentialsSourceAccount":
      return null;
    case "sorobanCredentialsAddressWithDelegates":
      return Address.fromScAddress(credentials.addressWithDelegates.addressCredentials.address).toString();
    default:
      return Address.fromScAddress(addressCredentials(entry).address).toString();
  }
}

/**
 * Position of the one entry `account` has to sign.
 *
 * An account signs one request per transaction, so anything else is an error:
 * no entry means there is nothing to approve, several would need several
 * wallet prompts.
 */
export function accountEntryIndex(entries: xdr.SorobanAuthorizationEntry[], account: string): number {
  const matches = entries.flatMap((entry, index) => (entryAddress(entry) === account ? [index] : []));
  const [index] = matches;
  if (index === undefined) {
    throw new Error(`This call does not need ${account} to authorise anything`);
  }
  if (matches.length > 1) {
    throw new Error(`This call needs ${matches.length} separate authorisations from ${account}; only one is supported`);
  }
  return index;
}

/** Returns the entry with its signature expiration ledger set. */
export function setExpiration(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
): xdr.SorobanAuthorizationEntry {
  return withAddressCredentials(entry, { signatureExpirationLedger: validUntilLedger });
}

/**
 * The 32 bytes the host hands to the account contract as `signature_payload`:
 * sha256 of the authorisation preimage. The preimage binds the network, the
 * nonce, the expiration ledger and the whole invocation tree; for v2
 * credentials it binds the account address as well.
 */
export function authPayload(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number, network: Network): Hex {
  addressCredentials(entry);
  const preimage = buildAuthorizationEntryPreimage(
    entry,
    validUntilLedger,
    resolveNetwork(network).stellar.networkPassphrase,
  );
  return toHex(hash(preimage.toXdr()));
}

/** The typed data to sign for an entry whose expiration ledger is already set. */
export function entryTypedData(entry: xdr.SorobanAuthorizationEntry, network: Network): AuthorizationTypedData {
  const credentials = addressCredentials(entry);
  const validUntilLedger = credentials.signatureExpirationLedger;
  if (validUntilLedger === 0) {
    throw new Error("Set the signature expiration ledger before building the typed data");
  }
  return typedData({
    account: Address.fromScAddress(credentials.address).toString(),
    calls: renderCalls(entry),
    payload: authPayload(entry, validUntilLedger, network),
    network,
  });
}

function assertUsableSignature(signature: Hex): void {
  if (size(signature) !== SIGNATURE_BYTES) {
    throw new Error(
      `Expected a signature of 65 bytes (r, s, v) and got ${size(signature)}; ` +
        "smart-contract wallets cannot sign for a Paso account",
    );
  }
  const bytes = hexToBytes(signature);
  if (BigInt(toHex(bytes.subarray(32, 64))) > SECP256K1_HALF_ORDER) {
    throw new Error("The signature is not in low-s form, which the account requires");
  }
  const recovery = bytes[64] ?? -1;
  if (!ACCEPTED_RECOVERY_BYTES.includes(recovery)) {
    throw new Error(`The signature has recovery byte ${recovery}; the account accepts 0, 1, 27 or 28`);
  }
}

/**
 * Returns the entry carrying `signature` (`r ‖ s ‖ v`) in the form the account
 * contract reads it: 65 raw bytes.
 */
export function attachSignature(entry: xdr.SorobanAuthorizationEntry, signature: Hex): xdr.SorobanAuthorizationEntry {
  if (addressCredentials(entry).signatureExpirationLedger === 0) {
    throw new Error("Set the signature expiration ledger before attaching a signature");
  }
  assertUsableSignature(signature);
  return withAddressCredentials(entry, { signature: xdr.ScVal.scvBytes(hexToBytes(signature)) });
}

/** Sets the expiration, asks the wallet to sign the typed data and attaches the signature. */
export async function signEntry(
  signer: TypedDataSigner,
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  network: Network,
): Promise<xdr.SorobanAuthorizationEntry> {
  const expiring = setExpiration(entry, validUntilLedger);
  const signature = await signer.signTypedData(entryTypedData(expiring, network));
  return attachSignature(expiring, signature);
}
