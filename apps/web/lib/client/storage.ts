/** The part of `localStorage` the app uses, so tests can hand in their own. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * What was stored before each network had keys of its own, and where it
 * belongs now. All of it was made on testnet: there was no other network.
 */
const LEGACY_KEYS: readonly (readonly [from: string, to: string])[] = [
  ["paso.signer", "paso.signer.testnet"],
  ["paso.demo.key", "paso.demo.key.testnet"],
];

/**
 * Moves what an earlier version stored under keys that named no network to
 * the testnet keys. A value stored since under the new key is left as it
 * is; the old key goes either way, so this happens once.
 */
export function migrateStorage(storage: KeyValueStore | null): void {
  if (!storage) return;
  for (const [from, to] of LEGACY_KEYS) {
    try {
      const value = storage.getItem(from);
      if (value === null) continue;
      if (storage.getItem(to) === null) storage.setItem(to, value);
      storage.removeItem(from);
    } catch {
      // A storage that cannot be written keeps the old key; nothing reads it any more.
    }
  }
}

let migrated = false;

/** `localStorage`, or `null` on the server and in browsers that block it. */
export function browserStorage(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    const probe = "paso.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    if (!migrated) {
      migrated = true;
      migrateStorage(storage);
    }
    return storage;
  } catch {
    return null;
  }
}

export function memoryStorage(initial: Record<string, string> = {}): KeyValueStore {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

export function readJson<T>(storage: KeyValueStore | null, key: string): T | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(key);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

/** Writes a value; a full or blocked storage loses the write without breaking the flow it belongs to. */
export function writeJson(storage: KeyValueStore | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the app works without persistence, it only forgets on reload.
  }
}

export function removeKey(storage: KeyValueStore | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // See writeJson.
  }
}
