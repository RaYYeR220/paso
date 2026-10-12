import {
  erc20Abi,
  fundFromEvm,
  formatEvmAmount,
  toStellarUnits,
  twinAddress,
  type EvmReader,
  type FundFromEvmArgs,
  type FundFromEvmResult,
  type NetworkConfig,
  type NetworkName,
} from "@paso/sdk";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { ActivityLog, LogStatus } from "../activity/log";
import type { DeliverResponse, PasoApi } from "../api";
import { describeError, describeFailure, type ProblemError } from "../errors";
import { readJson, removeKey, writeJson, type KeyValueStore } from "../storage";
import { after, createStore, sleep, type Listener } from "../store";
import {
  fundingReducer,
  IDLE_FUNDING,
  isFundingActive,
  type FundingEvent,
  type FundingFailure,
  type FundingFailureCode,
  type FundingState,
  type RequestStep,
  type Transfer,
} from "./machine";

/** The clients a burn from the owner's wallet needs: the wallet on Base, and a reader for Base. */
export interface EvmClients {
  walletClient: WalletClient;
  publicClient: EvmReader & Pick<PublicClient, "readContract">;
}

export type FundingRequest =
  /** The testnet faucet pays: nothing to sign, nothing to hold. */
  | { via: "demo" }
  /** The connected wallet pays. `amount` is USDC in Base's 6-decimal units. */
  | { via: "wallet"; amount: bigint; clients: () => Promise<EvmClients> };

export interface FundingDeps {
  network: NetworkConfig;
  api: Pick<PasoApi, "demoFund" | "deliver">;
  storage: KeyValueStore | null;
  /** The session log of an account, so a transfer shows up in its activity. */
  log?: (twin: string) => Pick<ActivityLog, "put"> | null;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  after?: (ms: number, callback: () => void) => () => void;
  fund?: (args: FundFromEvmArgs) => Promise<FundFromEvmResult>;
  /** How long to wait between two questions to the delivery route. */
  pollIntervalMs?: number;
  /**
   * A question to the delivery route that stays open this long means the
   * burn is attested and the route is busy minting: the route answers within
   * a second while Circle is still waiting.
   */
  deliveringAfterMs?: number;
  /** How long Circle may go on not knowing the burn before it is asked less often. */
  burnNotFoundAfterMs?: number;
}

/** The burn being followed, and whether a reload will still know about it. */
export interface TrackedBurn {
  transfer: Transfer;
  /** False when the browser keeps no storage: the tracker lives in this tab only. The USDC is unaffected. */
  saved: boolean;
}

export interface FundingController {
  getState(): FundingState;
  subscribe(listener: Listener): () => void;
  /**
   * Starts a transfer. Ignored while one is in flight or on record, so a
   * double click burns once and a burn already made is never written over.
   */
  start(request: FundingRequest): Promise<void>;
  /**
   * Follows a burn that already happened. Returns false when the hash is not
   * one, a transfer is in flight, or another burn is on record.
   */
  resume(burnTxHash: Hex): boolean;
  /** Picks up the burn on record: the one in flight when the page was last open. */
  restore(): boolean;
  /** After a failure: follows the burn on record again. */
  retry(): boolean;
  /** Back to idle. Refused, with `false`, while a burn is on record: that takes `stopTracking`. */
  reset(): boolean;
  /**
   * Forgets the burn on record and goes back to idle. The only way a burn
   * leaves the record short of being delivered: the USDC is not affected,
   * it is only no longer followed here.
   */
  stopTracking(): boolean;
  /** The burn on record, if any. */
  tracked(): TrackedBurn | null;
}

const DEFAULTS = {
  pollIntervalMs: 2_000,
  deliveringAfterMs: 3_000,
  burnNotFoundAfterMs: 10 * 60_000,
};

const MAX_BACKOFF_STEPS = 5;

export function fundingStorageKey(network: NetworkName, owner: Address): string {
  return `paso.funding.${network}.${owner.toLowerCase()}`;
}

const isTxHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

function isTransfer(value: unknown, network: NetworkName, owner: Address): value is Transfer {
  if (typeof value !== "object" || value === null) return false;
  const transfer = value as Record<string, unknown>;
  return (
    transfer.network === network &&
    isTxHash(transfer.burnTxHash) &&
    Number.isInteger(transfer.sourceDomain) &&
    typeof transfer.owner === "string" &&
    transfer.owner.toLowerCase() === owner.toLowerCase() &&
    typeof transfer.twin === "string" &&
    (transfer.amount === null || (typeof transfer.amount === "string" && /^\d+$/.test(transfer.amount))) &&
    (transfer.via === "wallet" || transfer.via === "demo") &&
    typeof transfer.startedAt === "number"
  );
}

function failure(
  code: FundingFailureCode,
  message: string,
  retryable: boolean,
  from?: ProblemError,
): FundingFailure {
  const detail = from?.detail ?? (from && from.message !== message ? from.message : undefined);
  return {
    code,
    message,
    retryable,
    ...(detail ? { detail } : {}),
    ...(from?.retryAfterSeconds ? { retryAfterSeconds: from.retryAfterSeconds } : {}),
  };
}

/** Why the faucet did not pay, told apart by what the route answered. */
export function faucetFailure(error: unknown, chainName: string): FundingFailure {
  const problem = describeFailure(error);
  const said = problem.detail ?? problem.message;

  if (problem.code === "rate_limited") {
    return /already been funded/i.test(said)
      ? failure("rate_limited", "This account has already had test USDC from the faucet. It can ask again later.", true, problem)
      : failure("rate_limited", "The faucet has been asked too often from here. Try again later.", true, problem);
  }
  if (problem.code === "not_found") {
    return failure("faucet_off", "The faucet exists on testnet only.", false, problem);
  }
  if (/no payer configured/i.test(said)) {
    return failure("faucet_off", `The faucet is switched off. Connect a wallet that holds USDC on ${chainName} instead.`, false, problem);
  }
  if (/out of test USDC|out of gas/i.test(said)) {
    return failure(
      "faucet_empty",
      `The faucet has run dry. Connect a wallet that holds USDC on ${chainName}, or try again later.`,
      true,
      problem,
    );
  }
  if (/all it gives in a day/i.test(said)) {
    return failure("faucet_daily_limit", "The faucet has given out all it gives in a day. Try again later.", true, problem);
  }
  return failure("unavailable", problem.message, true, problem);
}

const WALLET_FAILURE_CODES: readonly string[] = ["insufficient_usdc", "insufficient_gas", "wrong_network"];

function walletFailure(problem: ProblemError): FundingFailure {
  const code = WALLET_FAILURE_CODES.includes(problem.code) ? (problem.code as FundingFailureCode) : "unknown";
  return failure(code, problem.message, problem.retryable, problem);
}

/** What a failed question to the delivery route means for the transfer. */
function deliveryFailure(error: unknown): { permanent: boolean; reason: FundingFailure; retryAfterMs?: number } {
  const problem = describeFailure(error);
  const said = problem.detail ?? problem.message;
  if (problem.code === "bad_request") {
    return { permanent: true, reason: failure("burn_not_found", said, false, problem) };
  }
  if (problem.code === "simulation_failed") {
    return {
      permanent: true,
      reason: failure("undeliverable", "Circle attested the burn, and Stellar did not accept the delivery.", false, problem),
    };
  }
  return {
    permanent: false,
    reason: failure("unavailable", "The delivery service is not answering. The burn is safe on Base.", true, problem),
    ...(problem.retryAfterSeconds ? { retryAfterMs: problem.retryAfterSeconds * 1000 } : {}),
  };
}

/** Errors that say nothing about whether a transaction left the wallet. */
const INCONCLUSIVE_CODES: readonly string[] = ["unknown", "network"];

/** The wallet client with its contract writes reported: which prompt is open, and the hash once it is sent. */
function observeWrites(walletClient: WalletClient, report: (step: RequestStep, hash?: Hex) => void): WalletClient {
  const writeContract = async (args: { functionName?: string }): Promise<Hex> => {
    const approval = args.functionName === "approve";
    report(approval ? "approving" : "burning");
    const hash = await (walletClient.writeContract as (args: unknown) => Promise<Hex>)(args);
    report(approval ? "approved" : "confirming", hash);
    return hash;
  };
  return { ...walletClient, writeContract } as unknown as WalletClient;
}

/**
 * The inbound flow of one owner: burn on Base (the wallet's, or the
 * faucet's), then follow the burn until the USDC is minted on Stellar.
 *
 * A burn is money in transit, so it goes on record the moment its hash is
 * known and stays there until the USDC is delivered or the owner says to stop
 * tracking it. No outage, reload, second click or reset takes it off.
 */
export function createFundingController(owner: Address, deps: FundingDeps): FundingController {
  const { network, api, storage } = deps;
  const now = deps.now ?? Date.now;
  const sleepFor = deps.sleep ?? sleep;
  const afterDelay = deps.after ?? after;
  const fund = deps.fund ?? fundFromEvm;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const deliveringAfterMs = deps.deliveringAfterMs ?? DEFAULTS.deliveringAfterMs;
  const burnNotFoundAfterMs = deps.burnNotFoundAfterMs ?? DEFAULTS.burnNotFoundAfterMs;

  const key = fundingStorageKey(network.name, owner);
  const store = createStore<FundingState>(IDLE_FUNDING);
  let tracking: AbortController | null = null;
  let starting = false;
  /** The burn on record, kept here as well as in storage: storage may be missing or full. */
  let inFlight: Transfer | null = null;
  let saved = true;

  const dispatch = (event: FundingEvent): void => store.set(fundingReducer(store.get(), event));

  function note(transfer: Transfer, status: LogStatus, stellarTxHash?: string): void {
    deps.log?.(transfer.twin)?.put({
      id: `fund:${transfer.burnTxHash.toLowerCase()}`,
      kind: "receive",
      status,
      amount: transfer.amount === null ? null : toStellarUnits(BigInt(transfer.amount)).toString(),
      counterparty: null,
      at: transfer.startedAt,
      baseTxHash: transfer.burnTxHash,
      ...(stellarTxHash ? { stellarTxHash } : {}),
    });
  }

  function stored(): Transfer | null {
    const value = readJson<unknown>(storage, key);
    return isTransfer(value, network.name, owner) ? value : null;
  }

  const onRecord = (): Transfer | null => inFlight ?? stored();
  const sameBurn = (a: Transfer, hash: Hex): boolean => a.burnTxHash.toLowerCase() === hash.toLowerCase();

  function remember(transfer: Transfer): void {
    inFlight = transfer;
    writeJson(storage, key, transfer);
    const kept = stored();
    saved = kept !== null && sameBurn(kept, transfer.burnTxHash);
  }

  function forget(): void {
    inFlight = null;
    saved = true;
    removeKey(storage, key);
  }

  function halt(): void {
    tracking?.abort();
    tracking = null;
  }

  /** The server gave a final answer about the burn. It stays on record: only the owner takes it off. */
  function fail(reason: FundingFailure, transfer: Transfer): void {
    note(transfer, "failed");
    dispatch({ type: "FAILED", reason, at: now() });
  }

  async function track(transfer: Transfer, run: AbortController): Promise<void> {
    const live = () => tracking === run && !run.signal.aborted;
    const pause = (ms: number) => sleepFor(ms, run.signal).catch(() => undefined);
    let errors = 0;

    while (live()) {
      const cancelSlow = afterDelay(deliveringAfterMs, () => {
        if (live()) dispatch({ type: "DELIVERING" });
      });
      let answer: DeliverResponse;
      try {
        answer = await api.deliver({ sourceDomain: transfer.sourceDomain, txHash: transfer.burnTxHash }, run.signal);
      } catch (error) {
        cancelSlow();
        if (!live()) return;
        const { permanent, reason, retryAfterMs } = deliveryFailure(error);
        errors += 1;
        if (permanent) {
          tracking = null;
          fail(reason, transfer);
          return;
        }
        // An outage says nothing about the burn: keep waiting, more patiently each time.
        dispatch({ type: "PENDING", attestation: "unreachable" });
        await pause(retryAfterMs ?? pollIntervalMs * Math.min(errors, MAX_BACKOFF_STEPS));
        continue;
      }
      cancelSlow();
      if (!live()) return;
      errors = 0;

      if (answer.status === "delivered") {
        tracking = null;
        forget();
        dispatch({ type: "DELIVERED", hash: answer.hash, route: answer.route, at: now() });
        note(transfer, "done", answer.hash);
        return;
      }

      dispatch({ type: "PENDING", attestation: answer.attestation, delayReason: answer.delayReason });
      // A burn Circle has not heard of for this long may never have confirmed. It is still asked about, less often.
      const unseen = answer.attestation === "not_found" && now() - transfer.startedAt > burnNotFoundAfterMs;
      await pause(unseen ? pollIntervalMs * MAX_BACKOFF_STEPS : pollIntervalMs);
    }
  }

  function follow(transfer: Transfer): void {
    halt();
    const run = new AbortController();
    tracking = run;
    void track(transfer, run);
  }

  async function askFaucet(): Promise<Transfer | null> {
    try {
      const funded = await api.demoFund(owner);
      const transfer: Transfer = {
        network: network.name,
        burnTxHash: funded.burnTxHash,
        sourceDomain: funded.sourceDomain,
        owner,
        twin: funded.twin,
        amount: /^\d+$/.test(funded.amount) ? funded.amount : null,
        via: "demo",
        startedAt: now(),
      };
      // On record before anything else is awaited: the faucet has already burned.
      remember(transfer);
      return transfer;
    } catch (error) {
      dispatch({ type: "FAILED", reason: faucetFailure(error, network.evm.chain.name), at: now() });
      return null;
    }
  }

  async function burnFromWallet(request: Extract<FundingRequest, { via: "wallet" }>): Promise<Transfer | null> {
    const { amount } = request;
    const { chain, usdc, cctpDomain } = network.evm;
    const transferFor = (burnTxHash: Hex): Transfer => ({
      network: network.name,
      burnTxHash,
      sourceDomain: cctpDomain,
      owner,
      twin: twinAddress(owner, network),
      amount: amount.toString(),
      via: "wallet",
      startedAt: now(),
    });

    let sent: Transfer | null = null;
    /** The last thing the wallet was asked for: what an error after it can and cannot mean. */
    const prompt: { step: RequestStep } = { step: "starting" };
    try {
      if (amount <= 0n) throw new Error("Enter an amount above zero");
      const { walletClient, publicClient } = await request.clients();

      const payer = walletClient.account?.address;
      if (payer) {
        const held = await publicClient.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [payer],
        });
        if (held < amount) {
          const reason = failure(
            "insufficient_usdc",
            `The wallet holds ${formatEvmAmount(held)} USDC on ${chain.name}; this transfer needs ${formatEvmAmount(amount)}.`,
            false,
          );
          dispatch({ type: "FAILED", reason, at: now() });
          return null;
        }
      }

      const observed = observeWrites(walletClient, (step, hash) => {
        prompt.step = step;
        if (step === "confirming" && hash) {
          // On record from the moment Base has the burn: a reload while it confirms loses nothing.
          sent = transferFor(hash);
          remember(sent);
          dispatch({ type: "STEP", step, burnTxHash: hash });
        } else {
          dispatch({ type: "STEP", step, ...(step === "approved" && hash ? { approveTxHash: hash } : {}) });
        }
      });
      const burned = await fund({ walletClient: observed, publicClient, amount, owner, network });
      return sent ?? transferFor(burned.burnTxHash);
    } catch (error) {
      const problem = describeError(error);
      const burn: Transfer | null = sent;
      if (burn) {
        // Base has the transaction. Only a revert means it burned nothing; anything else is followed.
        if (problem.kind === "error" && problem.code === "reverted") {
          forget();
          dispatch({ type: "FAILED", reason: walletFailure(problem), at: now() });
          return null;
        }
        return burn;
      }
      if (problem.kind === "rejected") {
        dispatch({ type: "CANCELLED" });
      } else if (prompt.step === "burning" && INCONCLUSIVE_CODES.includes(problem.code)) {
        dispatch({
          type: "FAILED",
          reason: failure(
            "burn_unconfirmed",
            "The wallet did not say whether the burn was sent. Look at its activity: if the burn is there, follow it by its transaction hash. If it is not, nothing left the wallet.",
            false,
            problem,
          ),
          at: now(),
        });
      } else {
        dispatch({ type: "FAILED", reason: walletFailure(problem), at: now() });
      }
      return null;
    }
  }

  function begin(transfer: Transfer, event: "BURNED" | "RESUMED"): void {
    remember(transfer);
    dispatch({ type: event, transfer });
    const state = store.get();
    if (state.phase !== "burned" || state.transfer.burnTxHash !== transfer.burnTxHash) return;
    note(transfer, "pending");
    follow(transfer);
  }

  function resume(burnTxHash: Hex): boolean {
    if (!isTxHash(burnTxHash) || starting || isFundingActive(store.get())) return false;
    const known = onRecord();
    if (known && !sameBurn(known, burnTxHash)) return false;
    const transfer: Transfer =
      known
        ? known
        : {
            network: network.name,
            burnTxHash,
            sourceDomain: network.evm.cctpDomain,
            owner,
            twin: twinAddress(owner, network),
            amount: null,
            via: "wallet",
            startedAt: now(),
          };
    begin(transfer, "RESUMED");
    return true;
  }

  return {
    getState: store.get,
    subscribe: store.subscribe,

    async start(request) {
      if (starting || isFundingActive(store.get()) || onRecord()) return;
      starting = true;
      try {
        halt();
        dispatch({
          type: "REQUEST",
          via: request.via,
          owner,
          amount: request.via === "wallet" ? request.amount.toString() : null,
          at: now(),
        });
        const transfer = request.via === "demo" ? await askFaucet() : await burnFromWallet(request);
        if (!transfer) return;
        // If the request was dismissed meanwhile, the burn still happened: follow it all the same.
        begin(transfer, store.get().phase === "requesting" ? "BURNED" : "RESUMED");
      } finally {
        starting = false;
      }
    },

    resume,

    restore() {
      const known = onRecord();
      return known ? resume(known.burnTxHash) : false;
    },

    retry() {
      const state = store.get();
      if (state.phase !== "failed" || !state.transfer) return false;
      begin(state.transfer, "RESUMED");
      return true;
    },

    reset() {
      if (onRecord()) return false;
      halt();
      dispatch({ type: "RESET" });
      return true;
    },

    stopTracking() {
      if (!onRecord()) return false;
      halt();
      forget();
      dispatch({ type: "RESET" });
      return true;
    },

    tracked() {
      const transfer = onRecord();
      return transfer ? { transfer, saved: inFlight !== null ? saved : true } : null;
    },
  };
}
