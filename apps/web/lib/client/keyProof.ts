import type { NetworkName } from "@paso/sdk";
import { isAddressEqual, recoverTypedDataAddress, size, type Address, type Hex } from "viem";
import type { KeyValueStore } from "./storage";

/**
 * A Paso account answers to one thing: a 65-byte signature made by the
 * private key behind its Ethereum address. A smart-contract wallet has an
 * address and no such key, so the account derived from it can receive USDC
 * and never move it. Before a wallet is offered a way to bring USDC over, it
 * is asked to sign one message that moves nothing, and the signature is
 * checked to be that address's own.
 *
 * The message has a signing domain and a type of its own. It is not an
 * authorisation, and no account would take it for one.
 */
const KEY_PROOF_DOMAIN = { name: "Paso key check", version: "1" } as const;

const KEY_PROOF_TYPES = {
  KeyCheck: [
    { name: "statement", type: "string" },
    { name: "wallet", type: "address" },
  ],
} as const;

export const KEY_PROOF_STATEMENT = "This wallet signs with its own private key. Signing this moves nothing and approves nothing.";

const SIGNATURE_BYTES = 65;

export function keyProofTypedData(wallet: Address) {
  return {
    domain: KEY_PROOF_DOMAIN,
    types: KEY_PROOF_TYPES,
    primaryType: "KeyCheck",
    message: { statement: KEY_PROOF_STATEMENT, wallet },
  } as const;
}

export type KeyProofTypedData = ReturnType<typeof keyProofTypedData>;

/**
 * Asks the wallet for the key check and verifies it. Resolves when the
 * signature is 65 bytes and recovers to `wallet`. Throws what the wallet
 * threw when it declined, and otherwise an error that says the wallet cannot
 * sign for a Paso account, in the words `describeError` knows.
 */
export async function proveKey(wallet: Address, sign: (data: KeyProofTypedData) => Promise<Hex>): Promise<void> {
  const data = keyProofTypedData(wallet);
  const signature = await sign(data);
  if (size(signature) !== SIGNATURE_BYTES) {
    throw new Error(
      `Expected a signature of 65 bytes (r, s, v) and got ${size(signature)}; smart-contract wallets cannot sign for a Paso account`,
    );
  }
  const signedBy = await recoverTypedDataAddress({ ...data, signature });
  if (!isAddressEqual(signedBy, wallet)) {
    throw new Error(`This request was signed by ${signedBy}, but the account belongs to ${wallet}`);
  }
}

export function keyProofStorageKey(network: NetworkName, wallet: Address): string {
  return `paso.keyproof.${network}.${wallet.toLowerCase()}`;
}

/** Whether this browser has seen `wallet` sign with its key on `network`. */
export function isKeyProven(storage: KeyValueStore | null, network: NetworkName, wallet: Address): boolean {
  try {
    return storage?.getItem(keyProofStorageKey(network, wallet)) === "1";
  } catch {
    return false;
  }
}

export function markKeyProven(storage: KeyValueStore | null, network: NetworkName, wallet: Address): void {
  try {
    storage?.setItem(keyProofStorageKey(network, wallet), "1");
  } catch {
    // Then the wallet is asked again after a reload.
  }
}
