import { Address, buildAuthorizationEntryPreimage, hash, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, recoverTypedDataAddress, size, toHex, type Address as EvmAddress, type Hex } from "viem";
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

/** Last ledger at which the signature of an entry is accepted, or 0 when none has been set. */
export function entryExpiration(entry: xdr.SorobanAuthorizationEntry): number {
  return addressCredentials(entry).signatureExpirationLedger;
}

/** The signature an entry carries (`r ‖ s ‖ v`), or `null` when it has not been signed. */
export function entrySignature(entry: xdr.SorobanAuthorizationEntry): Hex | null {
  const { signature } = addressCredentials(entry);
  return signature.type === "scvBytes" ? toHex(signature.bytes.toBytes()) : null;
}

/** Raised when a set of authorisation entries is not exactly the one entry an account signs. */
export class AuthorizationEntriesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationEntriesError";
  }
}

/**
 * Checks that `entries` is exactly one entry, with plain address credentials,
 * for `account`, and returns it.
 *
 * Whoever pays the fee signs the transaction envelope, and that signature
 * also satisfies any entry with source-account credentials. Entries that come
 * from someone else must therefore never be passed along unchecked: an entry
 * with source-account credentials would spend the fee payer's own authority.
 * Everything except the account's single entry is refused, whatever it
 * claims to authorise.
 */
export function assertOnlyAccountEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  account: string,
): xdr.SorobanAuthorizationEntry {
  for (const entry of entries) {
    const { credentials } = entry;
    switch (credentials.type) {
      case "sorobanCredentialsAddress":
      case "sorobanCredentialsAddressV2":
        break;
      case "sorobanCredentialsSourceAccount":
        throw new AuthorizationEntriesError(
          "This call asks the transaction's source account to authorise something; " +
            "only the authorisation of the owner's account can be passed along",
        );
      default:
        throw new AuthorizationEntriesError(
          `Authorisation entries with ${credentials.type} are not supported; expected plain address credentials`,
        );
    }
    const address = entryAddress(entry);
    if (address !== account) {
      throw new AuthorizationEntriesError(
        `This call needs an authorisation from ${address}, which is not the owner's account ${account}`,
      );
    }
  }

  const [entry] = entries;
  if (!entry) {
    throw new AuthorizationEntriesError(`This call does not need ${account} to authorise anything`);
  }
  if (entries.length > 1) {
    throw new AuthorizationEntriesError(
      `This call needs ${entries.length} separate authorisations from ${account}; only one is supported`,
    );
  }
  return entry;
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

/**
 * The Ethereum address whose key signed an authorisation entry.
 *
 * The typed data is rebuilt from the entry itself, under its own credential
 * type and expiration ledger, exactly as the wallet was shown it and as the
 * account contract rebuilds it, and the signer is recovered from the 65 bytes
 * the entry carries. This is the account contract's check, made off chain:
 * the entry authorises its calls on chain only if the address returned here
 * is the owner the account was created for.
 *
 * It is what a fee payer asks before it spends anything on a request, and
 * what tells a signature apart from 65 arbitrary bytes while the account does
 * not exist yet. Throws when the entry is not signed, or carries a signature
 * the account would not even look at.
 */
export async function recoverEntrySigner(entry: xdr.SorobanAuthorizationEntry, network: Network): Promise<EvmAddress> {
  const signature = entrySignature(entry);
  if (signature === null) {
    throw new Error("The authorisation entry is not signed");
  }
  assertUsableSignature(signature);
  return recoverTypedDataAddress({ ...entryTypedData(entry, network), signature });
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
