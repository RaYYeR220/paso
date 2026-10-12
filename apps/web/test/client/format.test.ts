import { describe, expect, it } from "vitest";
import {
  formatBaseUsdc,
  formatElapsed,
  formatUnits,
  formatUsdc,
  formatWait,
  relativeTime,
  shortAddress,
  shortHash,
} from "@/lib/client/format";

describe("shortAddress", () => {
  it("keeps the same number of meaningful characters for both kinds of address", () => {
    expect(shortAddress("0x7880DA9a52Af491f76421869d4e28DC0A4D1767C")).toBe("0x7880…767C");
    expect(shortAddress("GDTU3U4XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7XII")).toBe("GDTU…7XII");
  });

  it("takes other lengths", () => {
    expect(shortAddress("CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME", 8, 8)).toBe("CCI3UVOB…QCOH2VME");
  });

  it("leaves short text alone", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
    expect(shortAddress("")).toBe("");
  });

  it("shortens hashes with and without 0x", () => {
    expect(shortHash(`0x3fa9${"0".repeat(56)}c2a1`)).toBe("0x3fa9…c2a1");
    expect(shortHash(`a1b2${"0".repeat(56)}9f00`)).toBe("a1b2…9f00");
  });
});

describe("amounts", () => {
  it("shows at least two decimals and never rounds", () => {
    expect(formatUsdc(125_000_000n)).toBe("12.50");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(1n)).toBe("0.0000001");
    expect(formatUsdc(50_000_000n)).toBe("5.00");
    expect(formatUsdc(12_345_678n)).toBe("1.2345678");
  });

  it("groups thousands", () => {
    expect(formatUsdc(12_345_670_000_000n)).toBe("1,234,567.00");
  });

  it("formats Base's six decimals", () => {
    expect(formatBaseUsdc(10_000_000n)).toBe("10.00");
    expect(formatBaseUsdc(1_500_001n)).toBe("1.500001");
  });

  it("handles negatives and tokens without decimals", () => {
    expect(formatUnits(-15n, 1)).toBe("-1.5");
    expect(formatUnits(42n, 0)).toBe("42");
  });
});

describe("time", () => {
  const now = 1_800_000_000_000;

  it("says how long ago", () => {
    expect(relativeTime(now - 2_000, now)).toBe("just now");
    expect(relativeTime(now - 25_000, now)).toBe("25 s ago");
    expect(relativeTime(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 d ago");
    expect(relativeTime(now - 60 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("treats a time ahead of the clock as now", () => {
    expect(relativeTime(now + 5_000, now)).toBe("just now");
  });

  it("formats a running timer", () => {
    expect(formatElapsed(0)).toBe("0 s");
    expect(formatElapsed(8.9)).toBe("8 s");
    expect(formatElapsed(65)).toBe("1 min 05 s");
  });

  it("rounds a wait up", () => {
    expect(formatWait(0)).toBe("1 s");
    expect(formatWait(40)).toBe("40 s");
    expect(formatWait(61)).toBe("2 min");
    expect(formatWait(3_601)).toBe("2 h");
  });
});
