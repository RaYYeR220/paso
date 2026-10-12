import { describe, expect, it } from "vitest";
import { clientIdentity, createBudget, createLimiter, SHARED_IDENTITY } from "@/lib/server/ratelimit";

describe("createLimiter", () => {
  it("allows the limit within a window and then says how long to wait", () => {
    let now = 1_000_000;
    const limiter = createLimiter({ limit: 2, windowMs: 60_000, now: () => now });

    expect(limiter.take("a")).toEqual({ ok: true });
    now += 10_000;
    expect(limiter.take("a")).toEqual({ ok: true });
    now += 10_000;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 40 });
  });

  it("counts every key on its own", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });

    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false);
  });

  it("lets a key in again once its oldest use leaves the window", () => {
    let now = 0;
    const limiter = createLimiter({ limit: 1, windowMs: 1_000, now: () => now });

    expect(limiter.take("a").ok).toBe(true);
    now = 999;
    expect(limiter.take("a").ok).toBe(false);
    now = 1_000;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("answers whether a key has a use left without counting one", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });

    for (let i = 0; i < 5; i += 1) expect(limiter.check("a")).toEqual({ ok: true });
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
  });

  it("has no way of giving a use back", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });

    expect(Object.keys(limiter).sort()).toEqual(["check", "take"]);
    expect("refund" in limiter).toBe(false);
  });

  it("refuses new keys while its table is full, and keeps the counts it has", () => {
    let now = 0;
    const limiter = createLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => now });

    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("b").ok).toBe(true);
    expect(limiter.take("c").ok).toBe(false);
    expect(limiter.check("c").ok).toBe(false);
    expect(limiter.take("a").ok).toBe(false);

    now = 1_000;
    expect(limiter.take("c").ok).toBe(true);
  });

  it("says no when it cannot tell", () => {
    const broken = createLimiter({
      limit: 5,
      windowMs: 60_000,
      now: () => {
        throw new Error("no clock");
      },
    });
    expect(broken.take("a").ok).toBe(false);
    expect(broken.check("a").ok).toBe(false);

    const adrift = createLimiter({ limit: 5, windowMs: 60_000, now: () => Number.NaN });
    expect(adrift.take("a").ok).toBe(false);
    expect(createLimiter({ limit: 5, windowMs: 60_000 }).take(undefined as unknown as string).ok).toBe(false);
  });
});

describe("createBudget", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("sets amounts aside up to the limit and refuses the one that would pass it", () => {
    const budget = createBudget({ limit: BigInt(1_000), windowMs: DAY, now: () => 0 });

    expect(budget.spend(BigInt(600))).toBe(true);
    expect(budget.spend(BigInt(400))).toBe(true);
    expect(budget.spend(BigInt(1))).toBe(false);
    expect(budget.spent()).toBe(BigInt(1_000));
  });

  it("does not count an amount it refused", () => {
    const budget = createBudget({ limit: BigInt(1_000), windowMs: DAY, now: () => 0 });

    expect(budget.spend(BigInt(900))).toBe(true);
    expect(budget.spend(BigInt(500))).toBe(false);
    expect(budget.spend(BigInt(100))).toBe(true);
  });

  it("frees an amount once it has left the window, and not before", () => {
    let now = 10 * DAY;
    const budget = createBudget({ limit: BigInt(1_000), windowMs: DAY, now: () => now });

    expect(budget.spend(BigInt(1_000))).toBe(true);
    now += DAY - 1;
    expect(budget.spend(BigInt(1))).toBe(false);
    now += 10 * 60 * 1000;
    expect(budget.spend(BigInt(1_000))).toBe(true);
    expect(budget.spent()).toBe(BigInt(1_000));
  });

  it("refuses what it cannot account for", () => {
    const budget = createBudget({ limit: BigInt(1_000), windowMs: DAY, now: () => 0 });
    expect(budget.spend(BigInt(-1))).toBe(false);
    expect(budget.spend(5 as unknown as bigint)).toBe(false);

    const adrift = createBudget({ limit: BigInt(1_000), windowMs: DAY, now: () => Number.NaN });
    expect(adrift.spend(BigInt(1))).toBe(false);
  });
});

describe("clientIdentity", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });
  const onVercel = { VERCEL: "1" };

  it("believes the address the platform reports", () => {
    expect(clientIdentity(request({ "x-vercel-forwarded-for": "203.0.113.7" }), onVercel)).toBe("203.0.113.7");
    expect(clientIdentity(request({ "x-real-ip": "198.51.100.4" }), onVercel)).toBe("198.51.100.4");
    expect(
      clientIdentity(request({ "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" }), onVercel),
    ).toBe("203.0.113.7");
  });

  it("never reads x-forwarded-for, which the caller writes", () => {
    const spoofed = (address: string) => request({ "x-forwarded-for": address, "x-vercel-forwarded-for": "203.0.113.7" });

    expect(clientIdentity(spoofed("1.1.1.1"), onVercel)).toBe("203.0.113.7");
    expect(clientIdentity(spoofed("2.2.2.2, 3.3.3.3"), onVercel)).toBe("203.0.113.7");
    expect(clientIdentity(request({ "x-forwarded-for": "1.1.1.1" }), onVercel)).toBe(SHARED_IDENTITY);
  });

  it("puts every request in one bucket where no platform vouches for the headers", () => {
    const headers = { "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4", "x-forwarded-for": "1.1.1.1" };

    expect(clientIdentity(request(headers), {})).toBe(SHARED_IDENTITY);
    expect(clientIdentity(request({}), onVercel)).toBe(SHARED_IDENTITY);
  });

  it("takes the hop the platform saw when a platform header holds a chain", () => {
    expect(clientIdentity(request({ "x-vercel-forwarded-for": "1.1.1.1, 203.0.113.7" }), onVercel)).toBe("203.0.113.7");
  });

  it("treats a whole IPv6 /64 as one caller", () => {
    const from = (address: string) => clientIdentity(request({ "x-vercel-forwarded-for": address }), onVercel);

    expect(from("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(from("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(from("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(from("::1")).toBe("0:0:0:0::/64");
    expect(from("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("gives no bucket of its own to something that is not an address", () => {
    const from = (value: string) => clientIdentity(request({ "x-vercel-forwarded-for": value }), onVercel);

    for (const value of ["unknown", "999.1.1.1", "1.2.3", "a".repeat(500), "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "g::1"]) {
      expect(from(value)).toBe(SHARED_IDENTITY);
    }
  });
});
