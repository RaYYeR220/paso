import type { NetworkName } from "paso-sdk";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { removeKey, type KeyValueStore } from "./storage";

/**
 * Where the demo key lives. It is a throwaway key made in this browser so the
 * app can be tried with no wallet installed: it holds test funds only, it is
 * stored unencrypted, and anyone with access to this browser profile can read
 * it. It must never be used for anything of value, which is why it exists on
 * testnet and nowhere else: every function here takes the network, and has
 * no key to give for any other.
 */
export const DEMO_KEY_STORAGE = "paso.demo.key.testnet";

export const DEMO_LABEL = "Demo key — made in this browser, for testnet only";

/** What asking for the demo key on a network with real funds is answered with. */
export const DEMO_TESTNET_ONLY = "The demo key works on testnet only. On mainnet, connect a wallet.";

const isPrivateKey = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Whether a network has a no-wallet demo at all. */
export function demoAvailable(network: NetworkName): boolean {
  return network === "testnet";
}

export function loadDemoKey(network: NetworkName, storage: KeyValueStore | null): Hex | null {
  if (!demoAvailable(network)) return null;
  try {
    const stored = storage?.getItem(DEMO_KEY_STORAGE);
    return isPrivateKey(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The demo key of this browser, made on first use. Without storage the key
 * lasts until the page is closed. Throws on any network but testnet: a key
 * kept in the open must never come to hold real funds.
 */
export function ensureDemoKey(network: NetworkName, storage: KeyValueStore | null, generate: () => Hex = generatePrivateKey): Hex {
  if (!demoAvailable(network)) throw new Error(DEMO_TESTNET_ONLY);
  const existing = loadDemoKey(network, storage);
  if (existing) return existing;
  const key = generate();
  try {
    storage?.setItem(DEMO_KEY_STORAGE, key);
  } catch {
    // Kept in memory only.
  }
  return key;
}

export function forgetDemoKey(storage: KeyValueStore | null): void {
  removeKey(storage, DEMO_KEY_STORAGE);
}
