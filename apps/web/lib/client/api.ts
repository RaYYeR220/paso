import type { InboundRoute, NetworkName } from "@paso/sdk";
import type { Address, Hex } from "viem";
import { ROUTES } from "./config";

/**
 * Why a server is declining to pay for something for now, when it says:
 * it does not work on the network, it has spent its day's fees, it has paid
 * for all it pays for in an hour, or its account is down to its reserve.
 */
export type DeclineReason = "not_serving" | "daily_budget" | "hourly_limit" | "low_balance";

const DECLINE_REASONS: readonly string[] = ["not_serving", "daily_budget", "hourly_limit", "low_balance"];

export function declineReason(value: unknown): DeclineReason | undefined {
  return typeof value === "string" && DECLINE_REASONS.includes(value) ? (value as DeclineReason) : undefined;
}

/** A refusal from one of the app's API routes: the route's `error` code and its `detail` sentence. */
export class ApiFailure extends Error {
  constructor(
    /** The route's `error`, or `network` when the request never got an answer. */
    readonly code: string,
    readonly status: number,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
    /** Why the server is declining for now, when it gave a reason. */
    readonly reason?: DeclineReason,
  ) {
    super(detail);
    this.name = "ApiFailure";
  }
}

export interface DemoFundResponse {
  burnTxHash: Hex;
  sourceDomain: number;
  twin: string;
  /** USDC burned, in Base's 6-decimal units. */
  amount: string;
}

export type DeliverResponse =
  | { status: "pending"; attestation: "not_found" | "pending" | "unreachable"; delayReason?: string }
  | { status: "delivered"; hash?: string; route: InboundRoute };

/** How many transactions of one kind the relayer pays for in an hour: from one caller, and from everyone. */
export interface SpendLimit {
  perCallerPerHour: number;
  perHour: number;
}

/** What the relayer of one network reports about itself. Amounts under `fees` are stroops, as text. */
export interface RelayerReport {
  enabled: true;
  ok: boolean;
  network: NetworkName;
  hub: string;
  latestLedger: number | null;
  relayer: { address: string; xlm: string | null };
  payer: { address: Address; chain: string; usdc: string | null; eth: string | null } | null;
  fees: {
    maxResourceFee: string;
    inclusionFee: string;
    maxDailyFees: string;
    spentToday: string;
    remainingToday: string;
    minBalance: string;
  };
  limits: { relay: SpendLimit; deploy: SpendLimit; deliver: SpendLimit };
  /** False while the relayer would decline to pay a fee: its day is spent, or its account is down to what it keeps. */
  paysFees: boolean;
  /** Whether the server submits the mint that finishes a transfer back to Base. Where it does not, the wallet does. */
  paysBaseMints: boolean;
  faucet: boolean;
}

/** A network's report, or word that the server does not work on that network. */
export type NetworkHealth = RelayerReport | { enabled: false };

export interface HealthResponse {
  ok: boolean;
  /** The network a request means when it names none. */
  default: NetworkName;
  networks: Record<NetworkName, NetworkHealth>;
}

export interface PasoApi {
  /** Testnet faucet: burns test USDC on Base for the owner's Stellar account. */
  demoFund(owner: Address, signal?: AbortSignal): Promise<DemoFundResponse>;
  /** Asks once whether a burn is attested, and delivers it on Stellar when it is. */
  deliver(burn: { sourceDomain: number; txHash: Hex }, signal?: AbortSignal): Promise<DeliverResponse>;
  health(signal?: AbortSignal): Promise<HealthResponse>;
}

export interface ApiOptions {
  /** The network every request is for. It is named in each of them. */
  network: NetworkName;
  /** Origin of the routes; empty for the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(fetcher: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiFailure("network", 0, "The server could not be reached");
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }

  if (response.ok && isRecord(body)) return body as T;

  const record = isRecord(body) ? body : {};
  const retryAfter = Number(response.headers.get("retry-after"));
  throw new ApiFailure(
    typeof record.error === "string" ? record.error : "unavailable",
    response.status,
    typeof record.detail === "string" ? record.detail : `The server answered ${response.status}`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    declineReason(record.reason),
  );
}

export function createApi(options: ApiOptions): PasoApi {
  const { baseUrl = "", network } = options;
  const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(fetcher, `${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

  return {
    demoFund: (owner, signal) => post(ROUTES.demoFund, { network, owner }, signal),
    deliver: ({ sourceDomain, txHash }, signal) => post(ROUTES.deliver, { network, sourceDomain, txHash }, signal),
    health: (signal) => request(fetcher, `${baseUrl}${ROUTES.health}`, { signal, cache: "no-store" }),
  };
}

export type FaucetStatus = "ready" | "empty" | "off" | "unknown";

/** Whether the testnet faucet can pay out, judged from testnet's report. The faucet exists nowhere else. */
export function faucetStatus(health: HealthResponse | null | undefined): FaucetStatus {
  const testnet = health?.networks.testnet;
  if (!testnet) return "unknown";
  if (!testnet.enabled || testnet.payer === null) return "off";
  const { usdc, eth } = testnet.payer;
  if (usdc === null || eth === null) return "unknown";
  return Number(usdc) >= 1 && Number(eth) > 0 ? "ready" : "empty";
}

/**
 * Whether the hosted relayer is there to pay fees on a network, as far as
 * the health report tells.
 *
 * - `serving`: it works on the network and is paying.
 * - `not_serving`: this server does not work on the network at all.
 * - `not_paying`: it works there and is declining fees for now: its day's
 *   budget is spent, or its account is down to what it keeps.
 * - `unknown`: no report yet, or the report could not be read.
 */
export type RelayerStatus = "serving" | "not_serving" | "not_paying" | "unknown";

export function relayerStatus(health: HealthResponse | null | undefined, network: NetworkName): RelayerStatus {
  const report = health?.networks?.[network];
  if (!report) return "unknown";
  if (!report.enabled) return "not_serving";
  return report.paysFees ? "serving" : "not_paying";
}
