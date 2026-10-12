import { describe, expect, it } from "vitest";
import { clientIp, createLimiter } from "@/lib/server/ratelimit";

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

  it("gives a use back", () => {
    const limiter = createLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });

    expect(limiter.take("a").ok).toBe(true);
    limiter.refund("a");
    expect(limiter.take("a").ok).toBe(true);
    limiter.refund("never seen");
  });
});

describe("clientIp", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

  it("takes the first address of x-forwarded-for", () => {
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientIp(request({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(request({}))).toBe("unknown");
  });
});
