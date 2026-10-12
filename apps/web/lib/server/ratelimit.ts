export interface LimiterOptions {
  /** How many uses a key gets per window. */
  limit: number;
  windowMs: number;
  /** Clock, for tests. */
  now?: () => number;
}

export type Allowance = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface Limiter {
  /** Counts one use for `key`, or refuses when the key has used up its window. */
  take(key: string): Allowance;
  /** Gives the latest use back, for a request that failed through no fault of the caller. */
  refund(key: string): void;
}

const MAX_TRACKED_KEYS = 10_000;

/**
 * A sliding-window limiter kept in memory.
 *
 * The counts belong to this process: they start again from zero whenever the
 * server restarts or is redeployed, and each server instance counts on its
 * own. That is enough to keep a faucet and a fee payer from being emptied by
 * one visitor; it is not an account of who used what.
 */
export function createLimiter({ limit, windowMs, now = Date.now }: LimiterOptions): Limiter {
  const uses = new Map<string, number[]>();

  function recent(key: string, at: number): number[] {
    const kept = (uses.get(key) ?? []).filter((time) => at - time < windowMs);
    if (kept.length > 0) uses.set(key, kept);
    else uses.delete(key);
    return kept;
  }

  function forgetExpired(at: number): void {
    for (const key of [...uses.keys()]) recent(key, at);
  }

  return {
    take(key) {
      const at = now();
      const kept = recent(key, at);
      if (kept.length >= limit) {
        const oldest = kept[0] ?? at;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)) };
      }
      if (uses.size >= MAX_TRACKED_KEYS) forgetExpired(at);
      uses.set(key, [...kept, at]);
      return { ok: true };
    },
    refund(key) {
      const kept = uses.get(key);
      if (!kept) return;
      kept.pop();
      if (kept.length === 0) uses.delete(key);
    },
  };
}

/**
 * The address a request came from, as the hosting platform reports it. Behind
 * a proxy that is the first entry of `x-forwarded-for`.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}
