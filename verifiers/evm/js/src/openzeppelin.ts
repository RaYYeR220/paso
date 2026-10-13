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
import { concat, hexToBytes, sha256, toHex, type Address as EvmAddress, type Hex } from "viem";

import { assertUsableSignature, keyData, networkPassphrase, type Network } from "./index";

/** The rule the example account's constructor creates. */
export const DEFAULT_CONTEXT_RULE = 0;

const ruleIdsValue = (contextRuleIds: number[]): xdr.ScVal =>
  xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)));

/**
 * `Signer::External(verifier, key data)`: the Ethereum address `address` as
 * a signer of the smart account `account`.
 *
 * The key data names the account, so the value is only good for that
 * account. For an account that does not exist yet, compute its address
 * first with `contractId`.
 */
export function ethereumSigner(verifier: string, address: EvmAddress, account: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(verifier).toScVal(),
    xdr.ScVal.scvBytes(hexToBytes(keyData(address, account))),
  ]);
}

/**
 * The 32 bytes the account asks its verifiers to check: sha256 of the
 * Soroban payload followed by the XDR of the rule ids, one per context.
 */
export function authDigest(signaturePayload: Hex, contextRuleIds: number[]): Hex {
  return sha256(concat([signaturePayload, toHex(ruleIdsValue(contextRuleIds).toXDR())]));
}

/** The signature of one Ethereum signer of an account. */
export interface EthereumSignature {
  address: EvmAddress;
  /** `r ‖ s ‖ v`, as `signPayload` returns it. */
  signature: Hex;
}

/**
 * The account's signature value, `AuthPayload`, carrying the signatures of
 * Ethereum signers of `account` that `verifier` checks.
 *
 * Soroban reads a map only when its keys are in order. For signers of one
 * verifier that is the order of their key data, which is applied here.
 * Signers checked by other verifiers are not covered.
 */
export function authPayload(
  verifier: string,
  account: string,
  signatures: EthereumSignature[],
  contextRuleIds: number[],
): xdr.ScVal {
  const entries = signatures
    .map(({ address, signature }) => {
      assertUsableSignature(signature);
      return { key: Buffer.from(hexToBytes(keyData(address, account))), signature };
    })
    .sort((left, right) => Buffer.compare(left.key, right.key));
  entries.forEach(({ key }, index) => {
    if (index > 0 && key.equals(entries[index - 1]!.key)) {
      throw new Error(`Two signatures for the signer 0x${key.subarray(0, 20).toString("hex")}`);
    }
  });

  const verifierValue = Address.fromString(verifier).toScVal();
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: ruleIdsValue(contextRuleIds) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(
        entries.map(
          ({ key, signature }) =>
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), verifierValue, xdr.ScVal.scvBytes(key)]),
              val: xdr.ScVal.scvBytes(hexToBytes(signature)),
            }),
        ),
      ),
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

/**
 * The 32 bytes the Ethereum signers of the account sign, through
 * `typedData(entryAddress(entry), …)`, to approve `entry` until
 * `validUntilLedger`. `contextRuleIds` holds one rule id per call the entry
 * authorises, root first; it defaults to the default rule for a single call.
 */
export function entryPayload(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  network: Network,
  contextRuleIds: number[] = [DEFAULT_CONTEXT_RULE],
): Hex {
  return authDigest(signaturePayload(entry, validUntilLedger, network), contextRuleIds);
}

/**
 * Returns `entry` carrying the signatures of Ethereum signers that
 * `verifier` checks, and expiring at `validUntilLedger`, the ledger the
 * signatures were made for. The signers are those of the account the entry
 * is for.
 */
export function attachSignatures(
  entry: xdr.SorobanAuthorizationEntry,
  validUntilLedger: number,
  verifier: string,
  signatures: EthereumSignature[],
  contextRuleIds: number[] = [DEFAULT_CONTEXT_RULE],
): xdr.SorobanAuthorizationEntry {
  const current = addressCredentials(entry);
  const signed = new xdr.SorobanAddressCredentials({
    address: current.address,
    nonce: current.nonce,
    signatureExpirationLedger: validUntilLedger,
    signature: authPayload(verifier, entryAddress(entry), signatures, contextRuleIds),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      entry.credentials.type === "sorobanCredentialsAddress"
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(signed)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(signed),
    rootInvocation: entry.rootInvocation,
  });
}
