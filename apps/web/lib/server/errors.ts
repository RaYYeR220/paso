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
    /**
     * Extra fields for the response body: a transaction hash, the network's
     * own diagnostics, a retry delay, and `sent`.
     *
     * `sent: false` is a statement about a relayed call: the server decided
     * this before handing anything to the network, and has checked that the
     * call has not run. `sent: true` says a transaction did go out. When the
     * field is absent the server makes no claim either way.
     */
    readonly extra: { hash?: string; diagnostic?: string; retryAfterSeconds?: number; sent?: boolean } = {},
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
