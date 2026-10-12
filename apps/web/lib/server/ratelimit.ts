export interface LimiterOptions {
  /** How many uses a key gets per window. */
  limit: number;
  windowMs: number;
  /** How many keys are tracked at once. A new key is refused while the table is full. */
  maxKeys?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export type Allowance = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface Limiter {
  /** Whether `key` has a use left right now. Counts nothing. */
  check(key: string): Allowance;
  /** Counts one use for `key`, or refuses when the key has used up its window. */
  take(key: string): Allowance;
}

const DEFAULT_MAX_KEYS = 10_000;
/** What a caller is told to wait when the limiter cannot tell. */
const UNKNOWN_WAIT_SECONDS = 60;

/**
 * A sliding-window limiter kept in memory.
 *
 * It fails closed. A use is counted when it is taken and is never given
 * back, whatever happens to the request afterwards: a caller who can make a
 * request fail must not earn another try by doing so. When the table of keys
 * is full, new keys are refused rather than old counts dropped, and if the
 * limiter itself fails the answer is no.
 *
 * The counts belong to this process: they start again from zero whenever the
 * server restarts or is redeployed, and each server instance counts on its
 * own. That is enough to keep a faucet and a fee payer from being emptied by
 * one visitor; it is not an account of who used what.
 */
export function createLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = Date.now }: LimiterOptions): Limiter {
  const uses = new Map<string, number[]>();
  const refused: Allowance = { ok: false, retryAfterSeconds: UNKNOWN_WAIT_SECONDS };

  function recent(key: string, at: number): number[] {
    const kept = (uses.get(key) ?? []).filter((time) => at - time < windowMs);
    if (kept.length > 0) uses.set(key, kept);
    else uses.delete(key);
    return kept;
  }

  function forgetExpired(at: number): void {
    for (const key of [...uses.keys()]) recent(key, at);
  }

  /** The uses `key` still has on record, or a refusal when it has none left or cannot be tracked. */
  function room(key: string, at: number): { kept: number[] } | Allowance {
    if (typeof key !== "string" || !Number.isFinite(at)) return refused;
    const kept = recent(key, at);
    if (kept.length >= limit) {
      const oldest = kept[0] ?? at;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)) };
    }
    if (kept.length === 0 && uses.size >= maxKeys) {
      forgetExpired(at);
      if (uses.size >= maxKeys) return refused;
    }
    return { kept };
  }

  return {
    check(key) {
      try {
        const result = room(key, now());
        return "kept" in result ? { ok: true } : result;
      } catch {
        return refused;
      }
    },
    take(key) {
      try {
        const at = now();
        const result = room(key, at);
        if (!("kept" in result)) return result;
        uses.set(key, [...result.kept, at]);
        return { ok: true };
      } catch {
        return refused;
      }
    },
  };
}

export interface BudgetOptions {
  /** The most that may be set aside within one window. */
  limit: bigint;
  windowMs: number;
  now?: () => number;
}

export interface Budget {
  /** Sets `amount` aside when the window still has room for it. False, and nothing set aside, when it does not. */
  spend(amount: bigint): boolean;
  /** What has been set aside within the window. */
  spent(): bigint;
}

const BUDGET_SLICES = 288;

/**
 * A ceiling on a total over a rolling window, kept in memory: the bound that
 * still holds when every per-caller limit has been got around.
 *
 * Like the limiter it fails closed: what is set aside stays set aside until
 * it leaves the window, and an amount that cannot be accounted for is
 * refused. Amounts are added up per slice of the window (five minutes of a
 * day), so the record stays small and an amount counts for slightly longer
 * than the window, never shorter.
 */
export function createBudget({ limit, windowMs, now = Date.now }: BudgetOptions): Budget {
  const sliceMs = Math.max(1, Math.ceil(windowMs / BUDGET_SLICES));
  const slices = new Map<number, bigint>();
  const zero = BigInt(0);

  function total(at: number): bigint {
    let sum = zero;
    for (const [slice, amount] of slices) {
      if ((slice + 1) * sliceMs + windowMs <= at) slices.delete(slice);
      else sum += amount;
    }
    return sum;
  }

  return {
    spend(amount) {
      try {
        const at = now();
        if (typeof amount !== "bigint" || amount < zero || !Number.isFinite(at)) return false;
        if (total(at) + amount > limit) return false;
        const slice = Math.floor(at / sliceMs);
        slices.set(slice, (slices.get(slice) ?? zero) + amount);
        return true;
      } catch {
        return false;
      }
    },
    spent() {
      return total(now());
    },
  };
}

/** The bucket for every request whose origin cannot be established. */
export const SHARED_IDENTITY = "shared";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_CHARS = /^[0-9a-f:]{2,39}$/;

/**
 * An address as a limiter key. IPv4 addresses stand for themselves. IPv6
 * addresses are cut to their /64 network, because whoever holds one address
 * of a /64 holds all of them. Anything that is not an address has no key.
 */
function addressKey(text: string): string | null {
  const value = text.trim().toLowerCase();
  const mapped = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  const v4 = IPV4.exec(mapped);
  if (v4) {
    return v4.slice(1).every((part) => Number(part) <= 255) ? v4.slice(1).map(Number).join(".") : null;
  }
  if (!IPV6_CHARS.test(value) || !value.includes(":")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/** Request headers the hosting platform sets itself, overwriting whatever the caller sent. */
const PLATFORM_HEADERS = ["x-vercel-forwarded-for", "x-real-ip"];

/**
 * Who a request comes from, for rate limiting.
 *
 * Only what the hosting platform itself asserts is believed. On Vercel that
 * is `x-vercel-forwarded-for`, then `x-real-ip`: the platform overwrites
 * both. `x-forwarded-for` is never read: a caller can put anything in it,
 * and a new value per request would be a new allowance per request. Should a
 * platform header hold a chain, its last entry is used, the one hop the
 * platform saw for itself.
 *
 * Anywhere else, and whenever those headers hold no address, there is no
 * identity to trust and every such request shares one bucket.
 */
export function clientIdentity(request: Request, env: Record<string, string | undefined> = process.env): string {
  if (!env.VERCEL) return SHARED_IDENTITY;
  for (const name of PLATFORM_HEADERS) {
    const hops = request.headers.get(name)?.split(",") ?? [];
    const key = addressKey(hops[hops.length - 1] ?? "");
    if (key) return key;
  }
  return SHARED_IDENTITY;
}
