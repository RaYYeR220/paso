import { formatEvmAmount } from "@paso/sdk";

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

/** What a wallet can bring over right now, in Base's 6-decimal units. */
export interface BurnLimits {
  min: bigint;
  /** The wallet's USDC on Base: it cannot burn more than it holds. `null` until that is known. */
  max: bigint | null;
}

/**
 * Why `amount` cannot be burned, or `null` when it can. `max` is the USDC
 * the wallet holds on `chainName`; with `null` only the minimum is checked,
 * and the balance is checked again right before the wallet is asked.
 */
export function burnAmountProblem(amount: bigint, limits: BurnLimits, chainName: string): string | null {
  if (amount <= 0n) return "Enter an amount above zero";
  if (amount < limits.min) return `The smallest amount that can be brought over is ${formatEvmAmount(limits.min)} USDC`;
  if (limits.max !== null && amount > limits.max) {
    return limits.max < limits.min
      ? `The wallet holds no USDC on ${chainName} to bring over`
      : `The wallet holds ${formatEvmAmount(limits.max)} USDC on ${chainName}`;
  }
  return null;
}
