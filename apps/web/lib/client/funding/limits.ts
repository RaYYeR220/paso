import { formatEvmAmount, type NetworkName } from "@paso/sdk";

/**
 * What the testnet faucet sends per request: 1 USDC, in Base's 6-decimal
 * units. The server decides the amount and reports the one it actually
 * burned with each transfer; this is that same fixed amount, known up front
 * so it can be shown before anything is asked.
 */
export const FAUCET_AMOUNT = 1_000_000n;

/**
 * The smallest burn a wallet can make, in Base's 6-decimal units
 * (0.000003 USDC). A burn names a fee cap that has to stay below the amount,
 * and whenever Circle charges a fee the cap is at least two units.
 */
export const WALLET_BURN_MIN = 3n;

/**
 * The most this app brings over in one transfer on mainnet, in Base's
 * 6-decimal units (25 USDC). The contracts set no such limit and neither
 * does Circle; it is the app's own, because the software has not been
 * audited and a mistake should cost little.
 */
export const MAINNET_BURN_CEILING = 25_000_000n;

/** The ceiling on one transfer for a network, or `null` where there is none. */
export function burnCeiling(network: NetworkName): bigint | null {
  return network === "mainnet" ? MAINNET_BURN_CEILING : null;
}

/** Why an amount above the ceiling is not taken. */
export function ceilingProblem(ceiling: bigint): string {
  return `On mainnet this app brings over at most ${formatEvmAmount(ceiling)} USDC at a time: the software has not been audited.`;
}

/** What a wallet can bring over right now, in Base's 6-decimal units. */
export interface BurnLimits {
  min: bigint;
  /** The wallet's USDC on Base: it cannot burn more than it holds. `null` until that is known. */
  max: bigint | null;
  /** The app's own ceiling on one transfer; absent or `null` where there is none. */
  ceiling?: bigint | null;
}

/**
 * Why `amount` cannot be burned, or `null` when it can. `max` is the USDC
 * the wallet holds on `chainName`; with `null` only the minimum is checked,
 * and the balance is checked again right before the wallet is asked. Where
 * the network has a ceiling, an amount the wallet could cover is held to it.
 */
export function burnAmountProblem(amount: bigint, limits: BurnLimits, chainName: string): string | null {
  if (amount <= 0n) return "Enter an amount above zero";
  if (amount < limits.min) return `The smallest amount that can be brought over is ${formatEvmAmount(limits.min)} USDC`;
  if (limits.max !== null && amount > limits.max) {
    return limits.max < limits.min
      ? `The wallet holds no USDC on ${chainName} to bring over`
      : `The wallet holds ${formatEvmAmount(limits.max)} USDC on ${chainName}`;
  }
  if (limits.ceiling != null && amount > limits.ceiling) return ceilingProblem(limits.ceiling);
  return null;
}
