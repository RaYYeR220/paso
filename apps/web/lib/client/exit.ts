import { decodeBurnMessage, type NetworkConfig, type NetworkName } from "@paso/sdk";
import { StrKey } from "@stellar/stellar-sdk";
import { isHex, size, toHex, type Hex } from "viem";
import { declineReason, type DeclineReason } from "./api";
import { describeError } from "./errors";
import { readJson, removeKey, writeJson, type KeyValueStore } from "./storage";
import { createStore, type Listener } from "./store";

/** USDC that left a Stellar account for Base: burned on Stellar, on its way to being minted on Base. */
export interface ExitTransfer {
  /** The network the burn was made on. A transfer is never followed on another. */
  network: NetworkName;
  /** The Stellar transaction that burned the USDC. */
  stellarTxHash: string;
  /** When the burn was confirmed, in milliseconds. */
  startedAt: number;
}

/** What is kept while a transfer is in flight: the burn, and the mint once the wallet has sent one. */
interface ExitRecord extends ExitTransfer {
  mintTxHash?: Hex;
}

/** What Circle's attestation service last said about the burn. */
export type ExitAttestation = "not_found" | "pending" | "unreachable";

export type ExitState =
  | { phase: "idle" }
  | {
      phase: "attesting";
      transfer: ExitTransfer;
      attestation: ExitAttestation;
      /** Why the server is not answering about the transfer for now, when it says. */
      held?: DeclineReason;
    }
  /**
   * Attested, and the last step is the owner's: the server does not pay for
   * mints on this network, so the wallet submits the message on Base.
   */
  | {
      phase: "attested";
      transfer: ExitTransfer;
      message: Hex;
      attestation: Hex;
      /** The owner just said no in the wallet. Nothing is wrong; the step is still open. */
      notice?: "declined";
      /** Why the last attempt did not go through. The step is still open. */
      problem?: string;
    }
  /** The wallet has been asked for the mint, or has sent it and Base has not confirmed it yet. */
  | { phase: "minting"; transfer: ExitTransfer; message: Hex; attestation: Hex; baseTxHash?: Hex }
  | { phase: "minted"; transfer: ExitTransfer; baseTxHash?: string; finishedAt: number }
  /**
   * The server cannot follow the transfer. The USDC still arrives: the burn
   * is attested by Circle and the mint on Base needs no help from Paso.
   */
  | { phase: "untracked"; transfer: ExitTransfer };

export type ExitAnswer =
  | { status: "pending"; attestation: ExitAttestation }
  | { status: "minted"; hash?: string }
  /** Checked by the server and handed back: the wallet submits these two on Base. */
  | { status: "attested"; message: Hex; attestation: Hex }
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

const isBytes = (value: unknown): value is Hex => isHex(value) && size(value) > 0;

export interface AskExitOptions {
  url: string;
  network: NetworkName;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /**
   * A second look at a message the server hands back for the wallet to
   * mint. One that fails it is not offered to the wallet: the transfer goes
   * on waiting.
   */
  accepts?: (message: Hex) => boolean;
}

/**
 * Whether a CCTP message is what an exit from a Paso account looks like on
 * `network`: burned on its Stellar, for its Base, at the request of its hub.
 * The server checks the same before it hands a message back; the wallet is
 * asked to pay for nothing that does not also pass here.
 */
export function isHubExit(message: Hex, network: NetworkConfig): boolean {
  try {
    const burn = decodeBurnMessage(message.toLowerCase() as Hex);
    return (
      burn.sourceDomain === network.stellar.cctpDomain &&
      burn.destinationDomain === network.evm.cctpDomain &&
      burn.messageSender === toHex(StrKey.decodeContract(network.stellar.hub))
    );
  } catch {
    return false;
  }
}

/**
 * Asks the server once how far a transfer back to Base has come. A server
 * without the route answers 404, which is reported as `unsupported` rather
 * than as a failure. A refusal is thrown, with the server's reason for
 * declining when it gave one.
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
  if (!response.ok || !isRecord(body)) {
    const reason = isRecord(body) ? declineReason(body.reason) : undefined;
    throw Object.assign(new Error(`The server answered ${response.status}`), reason ? { reason } : {});
  }

  if (body.status === "minted") {
    return { status: "minted", ...(typeof body.hash === "string" ? { hash: body.hash } : {}) };
  }
  if (body.status === "attested" && isBytes(body.message) && isBytes(body.attestation) && (options.accepts?.(body.message) ?? true)) {
    return { status: "attested", message: body.message, attestation: body.attestation };
  }
  const attestation = typeof body.attestation === "string" && ATTESTATIONS.includes(body.attestation) ? body.attestation : "pending";
  return { status: "pending", attestation: attestation as ExitAttestation };
}

/** What the watcher reads from Base itself, with no wallet and no server. */
export interface BaseReader {
  /** Whether Circle's MessageTransmitter on Base has taken the message: the USDC is minted, by whoever. */
  isReceived(message: Hex): Promise<boolean>;
  /** What became of a mint that was sent: `null` while Base has not included it. */
  receipt(hash: Hex): Promise<"success" | "reverted" | null>;
}

/**
 * Has the wallet submit the mint. Resolves when Base has confirmed it, or
 * when the message turns out to have been received already; `onSubmitted`
 * is called with the transaction as soon as the wallet has sent it.
 */
export type SubmitMint = (mint: {
  message: Hex;
  attestation: Hex;
  onSubmitted: (hash: Hex) => void;
}) => Promise<{ hash?: Hex; alreadyReceived: boolean }>;

export interface ExitWatcherDeps {
  /** The network the watcher follows transfers on. One from any other is refused. */
  network: NetworkName;
  ask: (txHash: string, signal: AbortSignal) => Promise<ExitAnswer>;
  /** Reads of Base, for a transfer whose mint is left to the wallet. Without it only the wallet's own answer is known. */
  base?: BaseReader;
  /** Where the transfer in flight is kept, so a reload carries on following it. */
  storage: KeyValueStore | null;
  storageKey: string;
  now?: () => number;
  /** Time between two questions to the server, in milliseconds. */
  intervalMs?: number;
  /** Time between two looks at Base while the mint is the wallet's to make or on its way. */
  receivedCheckMs?: number;
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
   * nothing, while another burn is on record, or when the burn is another
   * network's: one in flight is never written over.
   */
  watch(transfer: ExitTransfer): boolean;
  /** Picks up the burn on record: the one in flight when the page was last open. */
  restore(): boolean;
  /**
   * The last step where the server does not mint: has the wallet submit the
   * attested message on Base. Does nothing unless the transfer is waiting
   * for exactly that, so two clicks ask the wallet once, and a mint already
   * on its way is never sent a second time.
   */
  mint(submit: SubmitMint): Promise<void>;
  /**
   * Stops following and forgets the transfer. The only way a burn leaves the
   * record short of being minted: the USDC still arrives on Base.
   */
  stopTracking(): void;
  /** The burn on record, if any. */
  tracked(): TrackedExit | null;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_RECEIVED_CHECK_MS = 10_000;
const MAX_BACKOFF_STEPS = 5;

const MINT_REVERTED = "The mint reverted on Base. Nothing was minted, and it can be tried again.";

export function exitStorageKey(network: NetworkName, owner: string): string {
  return `paso.exit.${network}.${owner.toLowerCase()}`;
}

/**
 * A stored transfer of this network. A record that names another network is
 * not one. A record that names none was made before networks were named,
 * when there was only testnet: it is testnet's and nobody else's.
 */
function recordOf(value: unknown, network: NetworkName): ExitRecord | null {
  if (!isRecord(value)) return null;
  const { stellarTxHash, startedAt, mintTxHash } = value;
  if (typeof stellarTxHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(stellarTxHash) || typeof startedAt !== "number") return null;
  const named = value.network === undefined ? "testnet" : value.network;
  if (named !== network) return null;
  return {
    network,
    stellarTxHash,
    startedAt,
    ...(typeof mintTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(mintTxHash) ? { mintTxHash: mintTxHash as Hex } : {}),
  };
}

const transferOf = ({ network, stellarTxHash, startedAt }: ExitRecord): ExitTransfer => ({ network, stellarTxHash, startedAt });

/**
 * Follows USDC on its way back to Base. Like a burn on Base, a burn on
 * Stellar is money in transit: it goes on record when it is first watched
 * and stays there until it is minted or the owner says to stop tracking it.
 *
 * Where the server mints, the watcher only asks it how far things are. Where
 * it does not, the server hands back the attested message and the watcher
 * takes over: it looks at Base for the message, offers the mint to the
 * wallet, remembers a mint the wallet sent, and never asks for a second one
 * while the first may still land.
 */
export function createExitWatcher(deps: ExitWatcherDeps): ExitWatcher {
  const { storage, storageKey, network, base } = deps;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const receivedCheckMs = deps.receivedCheckMs ?? DEFAULT_RECEIVED_CHECK_MS;
  const schedule = deps.setTimeout ?? ((run, ms) => setTimeout(run, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const store = createStore<ExitState>(IDLE_EXIT);

  let timer: unknown;
  let abort: AbortController | undefined;
  let inFlight: ExitRecord | null = null;
  let saved = true;
  /** Grows whenever what is being waited for changes hands, so an answer that arrives late keeps its hands off the state. */
  let epoch = 0;

  function stored(): ExitRecord | null {
    return recordOf(readJson<unknown>(storage, storageKey), network);
  }

  const onRecord = (): ExitRecord | null => inFlight ?? stored();

  function remember(record: ExitRecord): void {
    inFlight = record;
    writeJson(storage, storageKey, record);
    const kept = stored();
    saved = kept?.stellarTxHash === record.stellarTxHash && kept.mintTxHash === record.mintTxHash;
  }

  function forget(): void {
    inFlight = null;
    saved = true;
    removeKey(storage, storageKey);
  }

  function halt(): void {
    epoch += 1;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    abort?.abort();
    abort = undefined;
  }

  function minted(transfer: ExitTransfer, baseTxHash?: string): void {
    halt();
    forget();
    store.set({ phase: "minted", transfer, ...(baseTxHash ? { baseTxHash } : {}), finishedAt: now() });
  }

  const received = async (message: Hex): Promise<boolean> => (base ? base.isReceived(message).catch(() => false) : false);

  /** The last step is open: looks at Base now and then, in case someone else makes the mint. */
  function awaitWallet(transfer: ExitTransfer, message: Hex, attestation: Hex, extra: { notice?: "declined"; problem?: string } = {}): void {
    halt();
    const mine = epoch;
    store.set({ phase: "attested", transfer, message, attestation, ...extra });
    if (!base) return;
    const look = async (): Promise<void> => {
      const done = await received(message);
      if (epoch !== mine) return;
      if (done) minted(transfer);
      else timer = schedule(() => void look(), receivedCheckMs);
    };
    timer = schedule(() => void look(), receivedCheckMs);
  }

  /** A mint was sent and its outcome is not known: Base is asked until it says, and the wallet is not asked again. */
  function awaitMint(transfer: ExitTransfer, message: Hex, attestation: Hex, hash: Hex): void {
    halt();
    const mine = epoch;
    store.set({ phase: "minting", transfer, message, attestation, baseTxHash: hash });
    if (!base) return;
    const look = async (): Promise<void> => {
      const receipt = await base.receipt(hash).catch(() => null);
      const done = await received(message);
      if (epoch !== mine) return;
      if (done) {
        minted(transfer, receipt === "success" ? hash : undefined);
      } else if (receipt === "reverted") {
        remember(transfer);
        awaitWallet(transfer, message, attestation, { problem: MINT_REVERTED });
      } else {
        timer = schedule(() => void look(), receivedCheckMs);
      }
    };
    timer = schedule(() => void look(), receivedCheckMs);
  }

  async function handOver(record: ExitRecord, message: Hex, attestation: Hex, mine: number): Promise<void> {
    const transfer = transferOf(record);
    const done = await received(message);
    if (epoch !== mine) return;
    if (done) minted(transfer);
    else if (record.mintTxHash) awaitMint(transfer, message, attestation, record.mintTxHash);
    else awaitWallet(transfer, message, attestation);
  }

  async function poll(record: ExitRecord, errors: number): Promise<void> {
    const transfer = transferOf(record);
    const mine = epoch;
    const controller = new AbortController();
    abort = controller;
    let answer: ExitAnswer | null;
    let held: DeclineReason | undefined;
    try {
      answer = await deps.ask(transfer.stellarTxHash, controller.signal);
    } catch (error) {
      answer = null;
      held = declineReason((error as { reason?: unknown } | null)?.reason);
    }
    if (controller.signal.aborted || epoch !== mine) return;

    if (answer === null) {
      // A missed answer says nothing about the transfer: keep waiting, more patiently each time.
      const missed = errors + 1;
      store.set({ phase: "attesting", transfer, attestation: "unreachable", ...(held ? { held } : {}) });
      timer = schedule(() => void poll(record, missed), intervalMs * Math.min(missed, MAX_BACKOFF_STEPS));
      return;
    }

    switch (answer.status) {
      case "minted":
        minted(transfer, answer.hash);
        return;
      case "attested":
        await handOver(record, answer.message, answer.attestation, mine);
        return;
      case "unsupported":
        store.set({ phase: "untracked", transfer });
        return;
      default:
        store.set({ phase: "attesting", transfer, attestation: answer.attestation });
        timer = schedule(() => void poll(record, 0), intervalMs);
    }
  }

  function follow(record: ExitRecord): void {
    halt();
    remember(record);
    store.set({ phase: "attesting", transfer: transferOf(record), attestation: "not_found" });
    void poll(record, 0);
  }

  return {
    getState: store.get,
    subscribe: store.subscribe,

    watch(transfer) {
      if (transfer.network !== network) return false;
      const known = onRecord();
      if (known) return known.stellarTxHash === transfer.stellarTxHash;
      const current = store.get();
      if (current.phase === "minted" && current.transfer.stellarTxHash === transfer.stellarTxHash) return true;
      follow(transferOf(transfer));
      return true;
    },

    restore() {
      const known = onRecord();
      const current = store.get();
      if (!known || (current.phase !== "idle" && current.phase !== "minted")) return false;
      follow(known);
      return true;
    },

    async mint(submit) {
      const state = store.get();
      if (state.phase !== "attested") return;
      const { transfer, message, attestation } = state;
      halt();
      const mine = epoch;
      const live = () => epoch === mine;
      store.set({ phase: "minting", transfer, message, attestation });

      let sent: Hex | undefined;
      try {
        const result = await submit({
          message,
          attestation,
          onSubmitted(hash) {
            if (!live()) return;
            sent = hash;
            // On record from the moment Base has the mint: a reload while it confirms does not ask for another.
            remember({ ...transfer, mintTxHash: hash });
            store.set({ phase: "minting", transfer, message, attestation, baseTxHash: hash });
          },
        });
        if (live()) minted(transfer, result.alreadyReceived ? undefined : (result.hash ?? sent));
      } catch (error) {
        if (!live()) return;
        const problem = describeError(error);
        if (sent && !(problem.kind === "error" && problem.code === "reverted")) {
          // Base has the transaction and nobody here saw what became of it: it is waited for, not sent again.
          awaitMint(transfer, message, attestation, sent);
        } else if (sent) {
          remember(transfer);
          awaitWallet(transfer, message, attestation, { problem: MINT_REVERTED });
        } else if (problem.kind === "rejected") {
          awaitWallet(transfer, message, attestation, { notice: "declined" });
        } else {
          awaitWallet(transfer, message, attestation, { problem: problem.message });
        }
      }
    },

    stopTracking() {
      halt();
      forget();
      store.set(IDLE_EXIT);
    },

    tracked() {
      const record = onRecord();
      return record ? { transfer: transferOf(record), saved: inFlight !== null ? saved : true } : null;
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
    case "attested":
    case "minting":
      return stages("done", "done", "active");
    case "minted":
      return stages("done", "done", "done");
  }
}
