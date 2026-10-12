import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { removeKey, type KeyValueStore } from "./storage";

/**
 * Where the demo key lives. It is a throwaway key made in this browser so the
 * app can be tried with no wallet installed: it holds test funds only, it is
 * stored unencrypted, and anyone with access to this browser profile can read
 * it. It must never be used for anything of value.
 */
export const DEMO_KEY_STORAGE = "paso.demo.key";

export const DEMO_LABEL = "Demo key — made in this browser, for testnet only";

const isPrivateKey = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

export function loadDemoKey(storage: KeyValueStore | null): Hex | null {
  try {
    const stored = storage?.getItem(DEMO_KEY_STORAGE);
    return isPrivateKey(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The demo key of this browser, made on first use. Without storage the key lasts until the page is closed. */
export function ensureDemoKey(storage: KeyValueStore | null, generate: () => Hex = generatePrivateKey): Hex {
  const existing = loadDemoKey(storage);
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
