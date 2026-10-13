import { isEvmChainName, type EvmChainName, type NetworkName } from "@paso/sdk";
import { readJson, writeJson, type KeyValueStore } from "../storage";
import { createStore, type Listener } from "../store";

export type LogKind =
  /** USDC on its way in from an EVM chain, or arrived. */
  | "receive"
  /** A transfer out of the account. */
  | "send"
  /** USDC sent back to an EVM chain. */
  | "exit"
  /** Any other contract call the account authorised. */
  | "call"
  /** A call the account contract or the relayer refused. Nothing moved. */
  | "refused";

export type LogStatus = "pending" | "done" | "refused" | "failed";

/** One thing this browser did with the account. Plain JSON: it is kept in `localStorage`. */
export interface LogEntry {
  id: string;
  kind: LogKind;
  status: LogStatus;
  /** USDC in Stellar's 7-decimal units, as text; `null` when the entry is not about an amount. */
  amount: string | null;
  /** The other side: a Stellar or Ethereum address, or `null`. */
  counterparty: string | null;
  /** Milliseconds since the epoch. */
  at: number;
  stellarTxHash?: string;
  /** The EVM chain the USDC came from or went to. An entry written before there was a choice names none: it was Base. */
  chain?: EvmChainName;
  /** The transaction on that chain: the burn of a transfer in. */
  evmTxHash?: string;
  /** A short remark: the function called, or why a call was refused. */
  note?: string;
}

export interface ActivityLog {
  list(): LogEntry[];
  /** Adds an entry, or replaces the one with the same id. */
  put(entry: LogEntry): void;
  subscribe(listener: Listener): () => void;
}

const DEFAULT_LIMIT = 50;

export function activityLogKey(network: NetworkName, account: string): string {
  return `paso.activity.${network}.${account}`;
}

function isEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.kind === "string" && typeof entry.at === "number";
}

/** An entry as it is read back: one written before there was a choice of chain kept its burn under `baseTxHash`. */
function current(entry: LogEntry): LogEntry {
  const { baseTxHash, chain, evmTxHash, ...plain } = entry as LogEntry & { baseTxHash?: unknown };
  const hash = typeof evmTxHash === "string" ? evmTxHash : typeof baseTxHash === "string" ? baseTxHash : undefined;
  return { ...plain, ...(isEvmChainName(chain) ? { chain } : {}), ...(hash ? { evmTxHash: hash } : {}) };
}

/** The session log of one account: newest first, capped, and written through to storage. */
export function createActivityLog(storage: KeyValueStore | null, key: string, limit = DEFAULT_LIMIT): ActivityLog {
  const stored = readJson<unknown>(storage, key);
  const store = createStore<LogEntry[]>(Array.isArray(stored) ? stored.filter(isEntry).slice(0, limit).map(current) : []);
  return {
    list: store.get,
    put(entry) {
      const others = store.get().filter((existing) => existing.id !== entry.id);
      const next = [entry, ...others].sort((a, b) => b.at - a.at).slice(0, limit);
      store.set(next);
      writeJson(storage, key, next);
    },
    subscribe: store.subscribe,
  };
}
