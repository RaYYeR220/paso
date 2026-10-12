import { ApiError, ConfigError } from "./errors";
import { clientIp, createLimiter, type Limiter } from "./ratelimit";

const MAX_BODY_CHARS = 100_000;
const MINUTE_MS = 60_000;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** The request body as JSON, or a refusal when it is missing, too large or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError("bad_request", "The request body could not be read");
  }
  if (text.length > MAX_BODY_CHARS) {
    throw new ApiError("bad_request", "The request body is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "The request body must be JSON");
  }
}

/** Per-caller request limits, in memory: they start over when the server restarts or is redeployed. */
const limiters = {
  relay: createLimiter({ limit: 30, windowMs: MINUTE_MS }),
  deploy: createLimiter({ limit: 10, windowMs: MINUTE_MS }),
  deliver: createLimiter({ limit: 120, windowMs: MINUTE_MS }),
} satisfies Record<string, Limiter>;

export function limit(route: keyof typeof limiters, request: Request): void {
  const allowance = limiters[route].take(clientIp(request));
  if (!allowance.ok) {
    throw new ApiError("rate_limited", "Too many requests; try again shortly", {
      retryAfterSeconds: allowance.retryAfterSeconds,
    });
  }
}

/** The response for anything a handler threw: `{ error, detail }` with a status that says whose move it is. */
export function failure(error: unknown): Response {
  if (error instanceof ApiError) {
    const { retryAfterSeconds, ...extra } = error.extra;
    return json(
      { error: error.code, detail: error.detail, ...extra },
      error.status,
      retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
    );
  }
  if (error instanceof ConfigError) {
    return json({ error: "unavailable", detail: `The server is not configured: ${error.message}` }, 503);
  }
  console.error("Request failed:", error instanceof Error ? error.message : error);
  return json({ error: "unavailable", detail: "The server could not complete the request; try again" }, 503);
}

/** Runs a handler and turns whatever it throws into a JSON refusal. */
export async function respond(handler: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await handler());
  } catch (error) {
    return failure(error);
  }
}
