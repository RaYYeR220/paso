import type { NetworkName } from "@paso/sdk";
import { defaultNetwork } from "./config";
import { ApiError, ConfigError } from "./errors";
import { clientIdentity, createLimiter } from "./ratelimit";

/** The largest request body a route reads. A relayed call, the largest request there is, stays well under it. */
export const MAX_BODY_BYTES = 65_536;
const MAX_DETAIL_CHARS = 400;
const MINUTE_MS = 60_000;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function tooLarge(): ApiError {
  return new ApiError("bad_request", `The request body is too large; the limit is ${MAX_BODY_BYTES} bytes`);
}

/**
 * The body as text, read no further than the limit: a request that declares
 * more is refused unread, and one that sends more than it declared is cut
 * off at the limit.
 */
async function readText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) throw tooLarge();

  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The request body as JSON, or a refusal when it is missing, too large or not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await readText(request);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("bad_request", "The request body could not be read");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "The request body must be JSON");
  }
}

/**
 * Requests per minute for each route: what one caller may send, and what
 * the route takes from everyone together. The second number does not depend
 * on telling callers apart, so it holds when that cannot be done. Both are
 * kept in memory and start over when the server restarts or is redeployed.
 *
 * Each network has counts of its own for every route: requests for one never
 * use up what is allowed for the other.
 */
const LIMITS = {
  relay: { perCaller: 30, overall: 300 },
  deploy: { perCaller: 10, overall: 60 },
  deliver: { perCaller: 120, overall: 1_200 },
  complete: { perCaller: 60, overall: 600 },
  fund: { perCaller: 10, overall: 60 },
  health: { perCaller: 60, overall: 600 },
} as const;

export type Route = keyof typeof LIMITS;

const EVERYONE = "everyone";

function limitersFor(route: Route) {
  const { perCaller, overall } = LIMITS[route];
  return {
    perCaller: createLimiter({ limit: perCaller, windowMs: MINUTE_MS }),
    overall: createLimiter({ limit: overall, windowMs: MINUTE_MS, maxKeys: 1 }),
  };
}

type RouteLimiters = Record<string, ReturnType<typeof limitersFor>>;

const globalForLimits = globalThis as typeof globalThis & { pasoRouteLimiters?: Partial<RouteLimiters> };

/**
 * The counts live with the process, not with this module: replacing the
 * module, as a development server does on every edit, does not start them
 * over. A route this code adds gets its limiters when it is first asked for.
 */
function limitersOf(route: Route, network?: NetworkName): ReturnType<typeof limitersFor> {
  const all = (globalForLimits.pasoRouteLimiters ??= {});
  return (all[network ? `${network}:${route}` : route] ??= limitersFor(route));
}

/**
 * Counts a request against its caller and against the route as a whole, or
 * refuses it. Both are looked at before either is counted, so a refused
 * request uses up nothing; a counted one is never given back. A request for
 * a network is counted with that network's requests only.
 */
export function limit(route: Route, request: Request, network?: NetworkName): void {
  const { perCaller, overall } = limitersOf(route, network);
  const caller = clientIdentity(request);
  for (const allowance of [perCaller.check(caller), overall.check(EVERYONE)]) {
    if (!allowance.ok) {
      throw new ApiError("rate_limited", "Too many requests; try again shortly", {
        retryAfterSeconds: allowance.retryAfterSeconds,
      });
    }
  }
  const taken = [perCaller.take(caller), overall.take(EVERYONE)];
  const refused = taken.find((allowance) => !allowance.ok);
  if (refused && !refused.ok) {
    throw new ApiError("rate_limited", "Too many requests; try again shortly", {
      retryAfterSeconds: refused.retryAfterSeconds,
    });
  }
}

/**
 * Lets a request for a route in: reads its body, finds the network it is
 * for, and counts it there. A request that names no network, or names
 * something else, or cannot be read at all, is taken to mean the default
 * network and counted with it, so no flood of nonsense can use up what is
 * allowed for a network it never named. The body is read first only to
 * learn the network; a request is counted before anything is done with it.
 */
export async function admit(route: Route, request: Request): Promise<{ body: unknown; network: NetworkName }> {
  let body: unknown;
  let unreadable: ApiError | undefined;
  try {
    body = await readJson(request);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    unreadable = error;
  }
  const named = typeof body === "object" && body !== null ? (body as { network?: unknown }).network : undefined;
  const network = named === "testnet" || named === "mainnet" ? named : defaultNetwork();
  limit(route, request, network);
  if (unreadable) throw unreadable;
  return { body, network };
}

/** One line, bounded, printable: a detail never carries a stack, a multi-line dump or control characters. */
function oneLine(text: string): string {
  const printable = Array.from(text, (char) => ((char.codePointAt(0) ?? 0) < 0x20 || char === "\u007f" ? " " : char));
  const flat = printable.join("").replace(/ {2,}/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * The response for anything a handler threw: `{ error, detail }` with a
 * status that says whose move it is.
 *
 * Only refusals written for the caller reach the caller. Anything else,
 * a missing setting included, is answered with a fixed sentence and its
 * specifics go to the server log: an unexpected error can quote an
 * endpoint, a path or a setting's name.
 */
export function failure(error: unknown): Response {
  if (error instanceof ApiError) {
    const { retryAfterSeconds, ...extra } = error.extra;
    return json(
      { error: error.code, detail: oneLine(error.detail), ...extra },
      error.status,
      retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
    );
  }
  if (error instanceof ConfigError) {
    console.error("Configuration:", error.message);
    return json({ error: "unavailable", detail: "The server is not configured" }, 503);
  }
  console.error("Request failed:", error instanceof Error ? `${error.name}: ${oneLine(error.message)}` : "unknown error");
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
