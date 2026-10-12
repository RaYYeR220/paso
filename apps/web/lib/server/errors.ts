import type { RelayErrorCode } from "@paso/sdk";

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

/** A refusal with a reason the caller can act on. It becomes the JSON body of a non-2xx response. */
export class ApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode,
    readonly detail: string,
    /** Extra fields for the response body: a transaction hash, the network's own diagnostics, a retry delay. */
    readonly extra: { hash?: string; diagnostic?: string; retryAfterSeconds?: number } = {},
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
