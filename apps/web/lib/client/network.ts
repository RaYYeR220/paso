import type { NetworkName } from "@paso/sdk";
import { removeKey, type KeyValueStore } from "./storage";
import { createStore, type Listener } from "./store";

/** The query parameter that names the network: `?network=mainnet`. Absent means testnet. */
export const NETWORK_PARAM = "network";
/** The link that starts the no-wallet demo: `?demo=1`. */
export const DEMO_PARAM = "demo";

const REMEMBERED_STORAGE = "paso.network";
const ACKNOWLEDGED_STORAGE = "paso.mainnet.acknowledged";

export function parseNetworkName(value: unknown): NetworkName | null {
  return value === "testnet" || value === "mainnet" ? value : null;
}

export interface ChoiceInputs {
  /** The `network` parameter of the address bar, as written. */
  param: string | null;
  /** The network this browser was last on. */
  remembered: NetworkName | null;
  /** Whether working with real funds has been confirmed in this browser. */
  acknowledged: boolean;
  /** True when the address is the no-wallet demo's link. */
  demo: boolean;
}

export interface Choice {
  /** The network everything on the page works on. */
  network: NetworkName;
  /** True when mainnet was asked for and has not been confirmed in this browser: the page stays on testnet and asks. */
  confirming: boolean;
}

/**
 * The network a page is on. The address bar decides, then what the browser
 * remembers, then testnet. The no-wallet demo exists on testnet only, so its
 * link means testnet unless the address names a network in so many words.
 *
 * Asking for mainnet is not enough to be on it: until real funds have been
 * confirmed in this browser the page stays on testnet, and `confirming` says
 * that the question is open.
 */
export function resolveChoice({ param, remembered, acknowledged, demo }: ChoiceInputs): Choice {
  const wanted = parseNetworkName(param) ?? (demo ? "testnet" : (remembered ?? "testnet"));
  if (wanted === "mainnet" && !acknowledged) return { network: "testnet", confirming: true };
  return { network: wanted, confirming: false };
}

/** A query string with the network set and everything else as it was. Testnet is the absence of the parameter. */
export function withNetworkParam(search: string, network: NetworkName): string {
  const params = new URLSearchParams(search);
  params.delete(NETWORK_PARAM);
  if (network === "mainnet") params.append(NETWORK_PARAM, network);
  return params.toString();
}

/** A link to one of the app's own pages that stays on the given network. */
export function networkHref(href: string, network: NetworkName): string {
  const [beforeHash = "", hash] = href.split("#", 2);
  const [path = "", search = ""] = beforeHash.split("?", 2);
  const query = withNetworkParam(search, network);
  return `${path}${query ? `?${query}` : ""}${hash === undefined ? "" : `#${hash}`}`;
}

/** What a browser remembers about the network: the one last chosen, and whether real funds were confirmed. */
export interface Remembered {
  remembered: NetworkName | null;
  acknowledged: boolean;
}

export interface ChoiceStore {
  get(): Remembered;
  subscribe(listener: Listener): () => void;
  remember(network: NetworkName): void;
  /** Records that working with real funds was confirmed. It is asked once per browser. */
  acknowledge(): void;
}

export const NOTHING_REMEMBERED: Remembered = { remembered: null, acknowledged: false };

function read(storage: KeyValueStore | null): Remembered {
  try {
    return {
      remembered: parseNetworkName(storage?.getItem(REMEMBERED_STORAGE)),
      acknowledged: storage?.getItem(ACKNOWLEDGED_STORAGE) === "true",
    };
  } catch {
    return NOTHING_REMEMBERED;
  }
}

/** The remembered choice, written through to storage. Without storage it lasts until the page is closed. */
export function createChoiceStore(storage: KeyValueStore | null): ChoiceStore {
  const store = createStore<Remembered>(read(storage));
  const write = (key: string, value: string | null): void => {
    try {
      if (value === null) removeKey(storage, key);
      else storage?.setItem(key, value);
    } catch {
      // Kept in memory only.
    }
  };
  return {
    get: store.get,
    subscribe: store.subscribe,
    remember(network) {
      if (store.get().remembered === network) return;
      write(REMEMBERED_STORAGE, network);
      store.set({ ...store.get(), remembered: network });
    },
    acknowledge() {
      if (store.get().acknowledged) return;
      write(ACKNOWLEDGED_STORAGE, "true");
      store.set({ ...store.get(), acknowledged: true });
    },
  };
}
