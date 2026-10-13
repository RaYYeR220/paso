import { formatEvmAmount, type EvmChainConfig, type NetworkName } from "paso-sdk";

/**
 * What the testnet faucet sends per request: 1 USDC, in 6-decimal units, on
 * Base Sepolia. The server decides the amount and reports the one it actually
 * burned with each transfer; this is that same fixed amount, known up front
 * so it can be shown before anything is asked.
 */
export const FAUCET_AMOUNT = 1_000_000n;

/**
 * The smallest burn a wallet can make, in 6-decimal units (0.000003 USDC). A burn names a fee cap that has to stay below the amount,
 * and whenever Circle charges a fee the cap is at least two units.
 */
export const WALLET_BURN_MIN = 3n;

/**
 * The most this app brings over in one transfer on mainnet, from any chain,
 * in 6-decimal units (25 USDC). The contracts set no such limit and neither
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

/**
 * USDC kept back for gas where gas is paid in USDC, in 6-decimal units
 * (0.02 USDC). On Arc an approval and a burn cost well under half of that,
 * and they come out of the same balance as the amount.
 */
export const USDC_GAS_RESERVE = 20_000n;

/** What has to stay in the wallet for gas on a chain, out of its USDC: something on Arc, nothing where gas is ETH. */
export function gasReserve(chain: Pick<EvmChainConfig, "gasToken">): bigint {
  return chain.gasToken.isUsdc ? USDC_GAS_RESERVE : 0n;
}

/** What a wallet can bring over right now, in 6-decimal units. */
export interface BurnLimits {
  min: bigint;
  /** The wallet's USDC on the chain: it cannot burn more than it holds. `null` until that is known. */
  max: bigint | null;
  /** The app's own ceiling on one transfer; absent or `null` where there is none. */
  ceiling?: bigint | null;
  /** USDC that has to stay for gas, on a chain where gas is paid in USDC. */
  gasReserve?: bigint;
}

/**
 * Why `amount` cannot be burned, or `null` when it can. `max` is the USDC
 * the wallet holds on `chainName`; with `null` only the minimum is checked,
 * and the balance is checked again right before the wallet is asked. On a
 * chain where gas is paid in USDC, `gasReserve` of it stays for the gas.
 * Where the network has a ceiling, an amount the wallet could cover is held
 * to it.
 */
export function burnAmountProblem(amount: bigint, limits: BurnLimits, chainName: string): string | null {
  if (amount <= 0n) return "Enter an amount above zero";
  if (amount < limits.min) return `The smallest amount that can be brought over is ${formatEvmAmount(limits.min)} USDC`;
  const reserve = limits.gasReserve ?? 0n;
  if (limits.max !== null && amount + reserve > limits.max) {
    if (limits.max < limits.min + reserve) return `The wallet holds no USDC on ${chainName} to bring over`;
    return reserve > 0n
      ? `The wallet holds ${formatEvmAmount(limits.max)} USDC on ${chainName}, and the gas comes out of it: bring at most ${formatEvmAmount(limits.max - reserve)}`
      : `The wallet holds ${formatEvmAmount(limits.max)} USDC on ${chainName}`;
  }
  if (limits.ceiling != null && amount > limits.ceiling) return ceilingProblem(limits.ceiling);
  return null;
}
