import type { InboundRoute, NetworkName } from "@paso/sdk";
import type { Address, Hex } from "viem";
import { NETWORK_NAME, ROUTES } from "./config";

/** A refusal from one of the app's API routes: the route's `error` code and its `detail` sentence. */
export class ApiFailure extends Error {
  constructor(
    /** The route's `error`, or `network` when the request never got an answer. */
    readonly code: string,
    readonly status: number,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
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

export interface DeployResponse {
  address: string;
  hash?: string;
  alreadyDeployed: boolean;
}

export interface HealthResponse {
  ok: boolean;
  network: NetworkName;
  hub: string;
  latestLedger: number | null;
  relayer: { address: string; xlm: string | null };
  payer: { address: Address; chain: string; usdc: string | null; eth: string | null } | null;
  maxResourceFee: string;
}

export interface PasoApi {
  /** Testnet faucet: burns test USDC on Base for the owner's Stellar account. */
  demoFund(owner: Address, signal?: AbortSignal): Promise<DemoFundResponse>;
  /** Asks once whether a burn is attested, and delivers it on Stellar when it is. */
  deliver(burn: { sourceDomain: number; txHash: Hex }, signal?: AbortSignal): Promise<DeliverResponse>;
  deploy(owner: Address, signal?: AbortSignal): Promise<DeployResponse>;
  health(signal?: AbortSignal): Promise<HealthResponse>;
}

export interface ApiOptions {
  /** Origin of the routes; empty for the page's own origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  network?: NetworkName;
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
  );
}

export function createApi(options: ApiOptions = {}): PasoApi {
  const { baseUrl = "", network = NETWORK_NAME } = options;
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
    deploy: (owner, signal) => post(ROUTES.deploy, { network, owner }, signal),
    health: (signal) => request(fetcher, `${baseUrl}${ROUTES.health}`, { signal, cache: "no-store" }),
  };
}

export type FaucetStatus = "ready" | "empty" | "off" | "unknown";

/** Whether the testnet faucet can pay out, judged from the health report. */
export function faucetStatus(health: HealthResponse | null | undefined): FaucetStatus {
  if (!health) return "unknown";
  if (health.network !== "testnet" || health.payer === null) return "off";
  const { usdc, eth } = health.payer;
  if (usdc === null || eth === null) return "unknown";
  return Number(usdc) >= 1 && Number(eth) > 0 ? "ready" : "empty";
}
