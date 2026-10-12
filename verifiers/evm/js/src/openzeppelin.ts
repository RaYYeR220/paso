/**
 * The values an OpenZeppelin smart account exchanges with a verifier, for
 * accounts built from `stellar-accounts` 0.7.2 (the account wasm published on
 * testnet and mainnet is one of them).
 *
 * Such an account does not hand the Soroban authorisation payload to its
 * verifiers. It hands them `sha256(payload ‖ XDR(context rule ids))`, so that
 * a signature is also tied to the rules it was collected for. Later versions
 * of the library derive that digest differently; `authDigest` here follows
 * 0.7.2.
 */
import { Address, buildAuthorizationEntryPreimage, hash, xdr } from "@stellar/stellar-sdk";
import { concat, hexToBytes, isAddress, sha256, toHex, type Address as EvmAddress, type Hex } from "viem";

import { networkPassphrase, type Network } from "./index";

/** The rule the example account's constructor creates. */
export const DEFAULT_CONTEXT_RULE = 0;

const ruleIdsValue = (contextRuleIds: number[]): xdr.ScVal =>
  xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)));

/** `Signer::External(verifier, address)`: an Ethereum address as a signer of the account. */
export function ethereumSigner(verifier: string, address: EvmAddress): xdr.ScVal {
  if (!isAddress(address, { strict: false })) {
    throw new Error(`"${address}" is not an Ethereum address`);
  }
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(verifier).toScVal(),
    xdr.ScVal.scvBytes(hexToBytes(address)),
  ]);
}

/**
 * The 32 bytes the account asks its verifiers to check: sha256 of the
 * Soroban payload followed by the XDR of the rule ids, one per context.
 */
export function authDigest(signaturePayload: Hex, contextRuleIds: number[]): Hex {
  return sha256(concat([signaturePayload, toHex(ruleIdsValue(contextRuleIds).toXDR())]));
}

/**
 * The account's signature value, `AuthPayload`, carrying the signature of
 * one signer. An account whose rule needs several signatures takes a map
 * with one entry per signer, in the key order Soroban requires; that case is
 * not built here.
 */
export function authPayload(signer: xdr.ScVal, signature: Hex, contextRuleIds: number[]): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: ruleIdsValue(contextRuleIds) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signer, val: xdr.ScVal.scvBytes(hexToBytes(signature)) })]),
    }),
  ]);
}

/** The address credentials of an entry, whichever of the two encodings it uses. */
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

/** Strkey of the address an entry with address credentials asks to authorise. */
export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string {
  return Address.fromScAddress(addressCredentials(entry).address).toString();
}

/**
 * The 32 bytes the host passes to the account as `signature_payload` for an
 * entry that expires at `validUntilLedger`.
 */
export function signaturePayload(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  network: Network,
): Hex {
  addressCredentials(entry);
  return toHex(hash(buildAuthorizationEntryPreimage(entry, validUntilLedger, networkPassphrase(network)).toXdr()));
}

export interface EntrySigner {
  /** Contract id of the Paso EVM verifier the account lists for this signer. */
  verifier: string;
  /** The Ethereum address the account lists. */
  address: EvmAddress;
  /** One rule id per call the entry authorises, root first. Defaults to the default rule for a single call. */
  contextRuleIds?: number[];
}

/**
 * The 32 bytes an Ethereum signer of the account signs, through
 * `typedData`, to approve `entry` until `validUntilLedger`.
 *
 * Only for entries with address-bound credentials, whose Soroban payload
 * names the account. The legacy encoding leaves the account out, and a 0.7.2
 * account adds nothing in its place: the signature would also be good for
 * any other account that lists the same signer and is asked for the same
 * call under the same nonce. Such an entry is refused here; `authDigest` and
 * `signaturePayload` remain for whoever needs one signed regardless.
 */
export function entryPayload(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  network: Network,
  contextRuleIds: number[] = [DEFAULT_CONTEXT_RULE],
): Hex {
  if (entry.credentials.type !== "sorobanCredentialsAddressV2") {
    throw new Error(
      `Expected an entry with address-bound credentials, got ${entry.credentials.type}: ` +
        "its payload would not tie the signature to this account",
    );
  }
  return authDigest(signaturePayload(entry, validUntilLedger, network), contextRuleIds);
}

/**
 * Returns `entry` carrying `signature` as the account's only signature and
 * expiring at `validUntilLedger`, the ledger the signature was made for.
 */
export function attachSignature(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  signature: Hex,
  { verifier, address, contextRuleIds = [DEFAULT_CONTEXT_RULE] }: EntrySigner,
): xdr.SorobanAuthorizationEntry {
  const current = addressCredentials(entry);
  const signed = new xdr.SorobanAddressCredentials({
    address: current.address,
    nonce: current.nonce,
    signatureExpirationLedger: validUntilLedger,
    signature: authPayload(ethereumSigner(verifier, address), signature, contextRuleIds),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      entry.credentials.type === "sorobanCredentialsAddress"
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(signed)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(signed),
    rootInvocation: entry.rootInvocation,
  });
}
