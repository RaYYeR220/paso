/**
 * USDC has 6 decimals on every EVM chain Paso lists and 7 on Stellar. Every
 * amount crossing that boundary goes through here.
 */
export const EVM_DECIMALS = 6;
export const STELLAR_DECIMALS = 7;

const STELLAR_PER_EVM = 10n;

/** 6-decimal USDC (EVM) to 7-decimal USDC (Stellar). */
export function toStellarUnits(usdc6: bigint): bigint {
  return usdc6 * STELLAR_PER_EVM;
}

/**
 * 7-decimal USDC (Stellar) to 6-decimal USDC (EVM).
 *
 * Throws when the seventh decimal is not zero: no EVM chain can represent it, and
 * a bridge would leave it behind without saying so.
 */
export function toEvmUnits(usdc7: bigint): bigint {
  if (usdc7 % STELLAR_PER_EVM !== 0n) {
    throw new Error(
      `${formatStellarAmount(usdc7)} USDC has a non-zero seventh decimal, which USDC on an EVM chain cannot hold; use at most 6 decimals`,
    );
  }
  return usdc7 / STELLAR_PER_EVM;
}

/** Parses plain decimal text such as `"12.5"`. Never rounds: too many decimals is an error. */
export function parseAmount(text: string, decimals: number): bigint {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`"${text}" is not a valid amount`);
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`"${trimmed}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Formats units as decimal text without trailing zeros. */
export function formatAmount(units: bigint, decimals: number): string {
  const sign = units < 0n ? "-" : "";
  const digits = (units < 0n ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export const parseStellarAmount = (text: string): bigint => parseAmount(text, STELLAR_DECIMALS);
export const parseEvmAmount = (text: string): bigint => parseAmount(text, EVM_DECIMALS);
export const formatStellarAmount = (units: bigint): string => formatAmount(units, STELLAR_DECIMALS);
export const formatEvmAmount = (units: bigint): string => formatAmount(units, EVM_DECIMALS);

/**
 * On Arc gas is paid in USDC, and the native balance counts the same USDC
 * the token does, in 18 decimals instead of 6.
 */
export const NATIVE_USDC_DECIMALS = 18;

const NATIVE_PER_EVM = 10n ** BigInt(NATIVE_USDC_DECIMALS - EVM_DECIMALS);

/** Arc's native 18-decimal USDC in 6-decimal token units, rounded up: what a gas cost takes from the token balance. */
export function nativeUsdcToEvmUnits(native: bigint): bigint {
  if (native < 0n) throw new Error("A native amount cannot be negative");
  return (native + NATIVE_PER_EVM - 1n) / NATIVE_PER_EVM;
}

/** 6-decimal USDC token units as Arc's native 18-decimal amount. */
export function evmUnitsToNativeUsdc(usdc6: bigint): bigint {
  return usdc6 * NATIVE_PER_EVM;
}
