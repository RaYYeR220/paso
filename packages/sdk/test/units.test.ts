import { describe, expect, it } from "vitest";
import {
  evmUnitsToNativeUsdc,
  formatEvmAmount,
  nativeUsdcToEvmUnits,
  formatStellarAmount,
  parseEvmAmount,
  parseStellarAmount,
  toEvmUnits,
  toStellarUnits,
} from "../src/units";

describe("unit conversion", () => {
  it("scales 6-decimal USDC up to Stellar's 7 decimals", () => {
    expect(toStellarUnits(1_000_000n)).toBe(10_000_000n);
    expect(toStellarUnits(1n)).toBe(10n);
    expect(toStellarUnits(0n)).toBe(0n);
  });

  it("scales 7-decimal USDC down to 6 decimals", () => {
    expect(toEvmUnits(10_000_000n)).toBe(1_000_000n);
    expect(toEvmUnits(5_000_000n)).toBe(500_000n);
    expect(toEvmUnits(0n)).toBe(0n);
  });

  it("refuses an amount with a non-zero seventh decimal", () => {
    expect(() => toEvmUnits(1_234_567n)).toThrow(/0\.1234567.*seventh decimal/);
    expect(() => toEvmUnits(1n)).toThrow(/seventh decimal/);
  });
});

describe("parsing and formatting", () => {
  it("parses decimal text into Stellar units", () => {
    expect(parseStellarAmount("1")).toBe(10_000_000n);
    expect(parseStellarAmount("1.5")).toBe(15_000_000n);
    expect(parseStellarAmount("0.0000001")).toBe(1n);
    expect(parseStellarAmount(" 12.30 ")).toBe(123_000_000n);
  });

  it("parses decimal text into EVM units", () => {
    expect(parseEvmAmount("1")).toBe(1_000_000n);
    expect(parseEvmAmount("0.000001")).toBe(1n);
  });

  it("rejects more decimals than the unit holds instead of rounding", () => {
    expect(() => parseStellarAmount("0.00000001")).toThrow(/7 decimal/);
    expect(() => parseEvmAmount("0.0000001")).toThrow(/6 decimal/);
  });

  it("rejects text that is not a plain non-negative decimal", () => {
    for (const text of ["", "abc", "-1", "1e3", "1.", ".5", "1,5", "0x10"]) {
      expect(() => parseStellarAmount(text), text).toThrow(/not a valid amount/);
    }
  });

  it("formats units without trailing zeros", () => {
    expect(formatStellarAmount(15_000_000n)).toBe("1.5");
    expect(formatStellarAmount(10_000_000n)).toBe("1");
    expect(formatStellarAmount(1n)).toBe("0.0000001");
    expect(formatStellarAmount(0n)).toBe("0");
    expect(formatStellarAmount(-15_000_000n)).toBe("-1.5");
    expect(formatEvmAmount(1_500_000n)).toBe("1.5");
    expect(formatEvmAmount(1n)).toBe("0.000001");
  });

  it("round-trips", () => {
    for (const text of ["0", "1", "0.1", "123456.7654321"]) {
      expect(formatStellarAmount(parseStellarAmount(text))).toBe(text);
    }
  });
});

describe("Arc's native USDC", () => {
  it("counts the token's 6-decimal units in 18 decimals", () => {
    expect(evmUnitsToNativeUsdc(1_000_000n)).toBe(10n ** 18n);
    expect(evmUnitsToNativeUsdc(1n)).toBe(10n ** 12n);
    expect(evmUnitsToNativeUsdc(0n)).toBe(0n);
  });

  it("turns a native amount into token units, rounding a remainder up: gas is never undercounted", () => {
    expect(nativeUsdcToEvmUnits(10n ** 18n)).toBe(1_000_000n);
    expect(nativeUsdcToEvmUnits(10n ** 12n)).toBe(1n);
    expect(nativeUsdcToEvmUnits(10n ** 12n + 1n)).toBe(2n);
    expect(nativeUsdcToEvmUnits(1n)).toBe(1n);
    expect(nativeUsdcToEvmUnits(0n)).toBe(0n);
    expect(() => nativeUsdcToEvmUnits(-1n)).toThrow(/negative/);
  });
});
