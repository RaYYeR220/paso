import { EVM_DECIMALS, STELLAR_DECIMALS } from "paso-sdk";

const ELLIPSIS = "…";

/**
 * Shortens an address for display: `0x7880…767C`, `GDTU…7XII`.
 *
 * `lead` counts the characters kept after a `0x` prefix, so both kinds of
 * address show the same number of meaningful characters.
 */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  const prefix = /^0x/i.test(address) ? 2 : 0;
  if (address.length <= prefix + lead + tail + 1) return address;
  return `${address.slice(0, prefix + lead)}${ELLIPSIS}${address.slice(-tail)}`;
}

/** Shortens a transaction hash: `0x3fa9…c2a1`, `a1b2…9f00`. */
export function shortHash(hash: string): string {
  return shortAddress(hash, 4, 4);
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats token units for display: at least `minFraction` decimals, and every
 * further digit that is not a trailing zero. Never rounds.
 */
export function formatUnits(units: bigint, decimals: number, minFraction = 2): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits
    .slice(digits.length - decimals)
    .replace(/0+$/, "")
    .padEnd(Math.min(minFraction, decimals), "0");
  return `${negative ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
}

/** USDC on Stellar, 7-decimal units: `125000000n` is `"12.50"`. */
export function formatUsdc(units: bigint): string {
  return formatUnits(units, STELLAR_DECIMALS);
}

/** USDC on Base, 6-decimal units: `10000000n` is `"10.00"`. */
export function formatBaseUsdc(units: bigint): string {
  return formatUnits(units, EVM_DECIMALS);
}

/** How long ago `then` was, seen from `now`, both in milliseconds: `"2 min ago"`. */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** A running time: `"8 s"`, `"1 min 05 s"`. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole} s`;
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** How long to wait, rounded up to something sayable: `"40 s"`, `"12 min"`, `"3 h"`. */
export function formatWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) return `${whole} s`;
  if (whole < 3600) return `${Math.ceil(whole / 60)} min`;
  return `${Math.ceil(whole / 3600)} h`;
}
