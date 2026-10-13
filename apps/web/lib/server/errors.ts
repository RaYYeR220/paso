import type { RelayErrorCode } from "paso-sdk";

export type ApiErrorCode = RelayErrorCode | "not_found";

const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  expired: 409,
  bad_signature: 422,
  simulation_failed: 422,
  rate_limited: 429,
  transaction_failed: 502,
  unavailable: 503,
};

/**
 * Why the server is not paying for something right now, though nothing is
 * wrong with what was asked.
 *
 * - `not_serving`: this server does not work on the network the request names.
 * - `daily_budget`: the relayer has spent what it spends on fees in a day.
 * - `hourly_limit`: the relayer has paid for as many of these as it does in an hour.
 * - `low_balance`: the relayer's account is down to what it keeps in reserve.
 */
export type DeclineReason = "not_serving" | "daily_budget" | "hourly_limit" | "low_balance";

/** A refusal with a reason the caller can act on. It becomes the JSON body of a non-2xx response. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    readonly detail: string,
    /**
     * Extra fields for the response body: a transaction hash, the network's
     * own diagnostics, a retry delay, `sent` and `reason`.
     *
     * `sent: false` is a statement about what was asked for: nothing that
     * was handed to the network for it can still be applied. Either the
     * server decided before sending anything and has checked that the call
     * has not run, or the transaction it sent is past its time bound by the
     * network's own clock. `sent: true` says a transaction went out and may
     * yet land. When the field is absent the server makes no claim either
     * way.
     *
     * `reason` names why the server is declining for now, where a client
     * has something particular to say about it.
     */
    readonly extra: { hash?: string; diagnostic?: string; retryAfterSeconds?: number; sent?: boolean; reason?: DeclineReason } = {},
  ) {
    super(detail);
    this.name = "ApiError";
    this.status = STATUS[code];
  }
}

/** The server is missing a setting it cannot work without. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
