import type { NetworkName } from "@paso/sdk";
import { readJson, removeKey, writeJson, type KeyValueStore } from "./storage";
import { createStore, type Listener } from "./store";

/** USDC that left a Stellar account for Base: burned on Stellar, on its way to being minted on Base. */
export interface ExitTransfer {
  /** The Stellar transaction that burned the USDC. */
  stellarTxHash: string;
  /** When the burn was confirmed, in milliseconds. */
  startedAt: number;
}

/** What Circle's attestation service last said about the burn. */
export type ExitAttestation = "not_found" | "pending" | "unreachable";

export type ExitState =
  | { phase: "idle" }
  | { phase: "attesting"; transfer: ExitTransfer; attestation: ExitAttestation }
  | { phase: "minted"; transfer: ExitTransfer; baseTxHash?: string; finishedAt: number }
  /**
   * The server cannot follow the transfer. The USDC still arrives: the burn
   * is attested by Circle and the mint on Base needs no help from Paso.
   */
  | { phase: "untracked"; transfer: ExitTransfer };

export type ExitAnswer =
  | { status: "pending"; attestation: ExitAttestation }
  | { status: "minted"; hash?: string }
  | { status: "unsupported" };

export type StageStatus = "waiting" | "active" | "done" | "failed";

/** One of the three steps of a transfer back to Base, in Circle's words. */
export interface ExitStage {
  id: "burned" | "attested" | "minted";
  label: "Burned on Stellar" | "Attested by Circle" | "Minted on Base";
  status: StageStatus;
}

export const IDLE_EXIT: ExitState = { phase: "idle" };

const ATTESTATIONS: readonly string[] = ["not_found", "pending", "unreachable"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AskExitOptions {
  url: string;
  network: NetworkName;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Asks the server once how far a transfer back to Base has come. A server
 * without the route answers 404, which is reported as `unsupported` rather
 * than as a failure.
 */
export async function askExit(txHash: string, options: AskExitOptions): Promise<ExitAnswer> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(options.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: options.network, txHash }),
    signal: options.signal,
  });
  if (response.status === 404 || response.status === 405) return { status: "unsupported" };

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  if (!response.ok || !isRecord(body)) throw new Error(`The server answered ${response.status}`);

  if (body.status === "minted") {
    return { status: "minted", ...(typeof body.hash === "string" ? { hash: body.hash } : {}) };
  }
  const attestation = typeof body.attestation === "string" && ATTESTATIONS.includes(body.attestation) ? body.attestation : "pending";
  return { status: "pending", attestation: attestation as ExitAttestation };
}

export interface ExitWatcherDeps {
  ask: (txHash: string, signal: AbortSignal) => Promise<ExitAnswer>;
  /** Where the transfer in flight is kept, so a reload carries on following it. */
  storage: KeyValueStore | null;
  storageKey: string;
  now?: () => number;
  /** Time between two questions, in milliseconds. */
  intervalMs?: number;
  setTimeout?: (run: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The burn being followed, and whether a reload will still know about it. */
export interface TrackedExit {
  transfer: ExitTransfer;
  /** False when the browser keeps no storage: the tracker lives in this tab only. The USDC is unaffected. */
  saved: boolean;
}

export interface ExitWatcher {
  getState(): ExitState;
  subscribe(listener: Listener): () => void;
  /**
   * Follows a burn until it is minted on Base. Returns false, and changes
   * nothing, while another burn is on record: one in flight is never written
   * over.
   */
  watch(transfer: ExitTransfer): boolean;
  /** Picks up the burn on record: the one in flight when the page was last open. */
  restore(): boolean;
  /**
   * Stops following and forgets the transfer. The only way a burn leaves the
   * record short of being minted: the USDC still arrives on Base.
   */
  stopTracking(): void;
  /** The burn on record, if any. */
  tracked(): TrackedExit | null;
}

const DEFAULT_INTERVAL_MS = 2_000;
const MAX_BACKOFF_STEPS = 5;

export function exitStorageKey(network: NetworkName, owner: string): string {
  return `paso.exit.${network}.${owner.toLowerCase()}`;
}

function isExitTransfer(value: unknown): value is ExitTransfer {
  return (
    isRecord(value) &&
    typeof value.stellarTxHash === "string" &&
    /^[0-9a-fA-F]{64}$/.test(value.stellarTxHash) &&
    typeof value.startedAt === "number"
  );
}

/**
 * Follows USDC on its way back to Base. Like a burn on Base, a burn on
 * Stellar is money in transit: it goes on record when it is first watched
 * and stays there until it is minted or the owner says to stop tracking it.
 */
export function createExitWatcher(deps: ExitWatcherDeps): ExitWatcher {
  const { storage, storageKey } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const schedule = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const store = createStore<ExitState>(IDLE_EXIT);

  let timer: unknown;
  let abort: AbortController | undefined;
  let inFlight: ExitTransfer | null = null;
  let saved = true;

  function stored(): ExitTransfer | null {
    const value = readJson<unknown>(storage, storageKey);
    return isExitTransfer(value) ? value : null;
  }

  const onRecord = (): ExitTransfer | null => inFlight ?? stored();

  function remember(transfer: ExitTransfer): void {
    inFlight = transfer;
    writeJson(storage, storageKey, transfer);
    saved = stored()?.stellarTxHash === transfer.stellarTxHash;
  }

  function forget(): void {
    inFlight = null;
    saved = true;
    removeKey(storage, storageKey);
  }

  function halt(): void {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    abort?.abort();
    abort = undefined;
  }

  async function poll(transfer: ExitTransfer, errors: number): Promise<void> {
    const controller = new AbortController();
    abort = controller;
    let answer: ExitAnswer | null;
    try {
      answer = await deps.ask(transfer.stellarTxHash, controller.signal);
    } catch {
      answer = null;
    }
    if (controller.signal.aborted) return;

    if (answer === null) {
      // A missed answer says nothing about the transfer: keep waiting, more patiently each time.
      const missed = errors + 1;
      store.set({ phase: "attesting", transfer, attestation: "unreachable" });
      timer = schedule(() => void poll(transfer, missed), intervalMs * Math.min(missed, MAX_BACKOFF_STEPS));
      return;
    }

    switch (answer.status) {
      case "minted":
        forget();
        store.set({
          phase: "minted",
          transfer,
          ...(answer.hash ? { baseTxHash: answer.hash } : {}),
          finishedAt: now(),
        });
        return;
      case "unsupported":
        store.set({ phase: "untracked", transfer });
        return;
      default:
        store.set({ phase: "attesting", transfer, attestation: answer.attestation });
        timer = schedule(() => void poll(transfer, 0), intervalMs);
    }
  }

  function follow(transfer: ExitTransfer): void {
    halt();
    remember(transfer);
    store.set({ phase: "attesting", transfer, attestation: "not_found" });
    void poll(transfer, 0);
  }

  return {
    getState: store.get,
    subscribe: store.subscribe,

    watch(transfer) {
      const known = onRecord();
      if (known) return known.stellarTxHash === transfer.stellarTxHash;
      const current = store.get();
      if (current.phase === "minted" && current.transfer.stellarTxHash === transfer.stellarTxHash) return true;
      follow(transfer);
      return true;
    },

    restore() {
      const known = onRecord();
      const current = store.get();
      if (!known || (current.phase !== "idle" && current.phase !== "minted")) return false;
      follow(known);
      return true;
    },

    stopTracking() {
      halt();
      forget();
      store.set(IDLE_EXIT);
    },

    tracked() {
      const transfer = onRecord();
      return transfer ? { transfer, saved: inFlight !== null ? saved : true } : null;
    },
  };
}

function stages(burned: StageStatus, attested: StageStatus, minted: StageStatus): ExitStage[] {
  return [
    { id: "burned", label: "Burned on Stellar", status: burned },
    { id: "attested", label: "Attested by Circle", status: attested },
    { id: "minted", label: "Minted on Base", status: minted },
  ];
}

/** The three-step tracker of a transfer back to Base. */
export function exitStages(state: ExitState): ExitStage[] {
  switch (state.phase) {
    case "idle":
      return stages("waiting", "waiting", "waiting");
    case "attesting":
    case "untracked":
      return stages("done", "active", "waiting");
    case "minted":
      return stages("done", "done", "done");
  }
}
