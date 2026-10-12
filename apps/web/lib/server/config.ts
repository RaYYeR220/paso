import { NETWORKS, type NetworkConfig } from "@paso/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { isHex, size } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ConfigError } from "./errors";

/**
 * The most a relayed call may cost in resource fees, in stroops (0.5 XLM).
 * A transfer, an approval and an exit through the hub each cost well under a
 * tenth of that; the cap is there so the relayer cannot be made to pay for
 * arbitrary heavy contract calls.
 */
export const DEFAULT_MAX_RESOURCE_FEE = BigInt(5_000_000);

/**
 * The most the relayer account spends on fees in any 24 hours, in stroops
 * (50 XLM): thousands of ordinary calls. Past it the relayer declines until
 * older spending leaves the window, so the worst day has a known price even
 * if every per-caller limit is got around.
 */
export const DEFAULT_MAX_DAILY_FEES = BigInt(500_000_000);

export const DEFAULT_DEMO_FUND_PER_IP_PER_HOUR = 5;
export const DEFAULT_DEMO_FUND_PER_OWNER_PER_DAY = 2;
/** Faucet payouts in any 24 hours, whoever asks. */
export const DEFAULT_DEMO_FUND_PER_DAY = 50;
/** The faucet stops while a payout would leave its payer with less USDC than this, in 6-decimal units (2 USDC). */
export const DEFAULT_DEMO_FUND_PAYER_FLOOR = BigInt(2_000_000);

export interface ServerConfig {
  network: NetworkConfig;
  /** Pays the fee of every transaction the server sends on Stellar. It never authorises anything else. */
  relayer: Keypair;
  /** Burns test USDC on Base for the demo faucet. Absent when no key is configured. */
  payer: PrivateKeyAccount | null;
  /** RPC endpoint for Base; the chain's public endpoint when not set. */
  evmRpcUrl?: string;
  /** The most one transaction of the relayer account may cost in resource fees, in stroops. */
  maxResourceFee: bigint;
  /** The most the relayer account spends on fees per rolling day, in stroops. */
  maxDailyFees: bigint;
  demoFund: {
    perIpPerHour: number;
    perOwnerPerDay: number;
    /** Payouts per rolling day over all callers. */
    perDay: number;
    /** USDC the payer keeps, in 6-decimal units: no payout would take it below this. */
    payerFloor: bigint;
  };
}

type Env = Record<string, string | undefined>;

function positiveInteger(env: Env, name: string, fallback: number): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  if (!/^\d{1,9}$/.test(text) || Number(text) === 0) {
    throw new ConfigError(`${name} must be a positive whole number`);
  }
  return Number(text);
}

function amount(env: Env, name: string, fallback: bigint, unit: string): bigint {
  const text = env[name]?.trim();
  if (!text) return fallback;
  if (!/^\d{1,30}$/.test(text)) {
    throw new ConfigError(`${name} must be a whole number of ${unit}`);
  }
  return BigInt(text);
}

/** Reads the server's settings from the environment. Secrets are parsed here and never echoed in an error. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const name = env.PASO_NETWORK?.trim() || "testnet";
  if (name !== "testnet" && name !== "mainnet") {
    throw new ConfigError(`PASO_NETWORK must be "testnet" or "mainnet"`);
  }
  // Real funds are a decision of their own: naming the network is not enough to spend them.
  if (name === "mainnet" && env.PASO_ALLOW_MAINNET?.trim() !== "true") {
    throw new ConfigError(`PASO_NETWORK is "mainnet"; set PASO_ALLOW_MAINNET=true to run with real funds`);
  }
  const base = NETWORKS[name];
  const rpcUrl = env.STELLAR_RPC_URL?.trim();
  const network: NetworkConfig = rpcUrl ? { ...base, stellar: { ...base.stellar, rpcUrl } } : base;

  const secret = env.RELAYER_SECRET?.trim();
  if (!secret) {
    throw new ConfigError("RELAYER_SECRET is not set");
  }
  let relayer: Keypair;
  try {
    relayer = Keypair.fromSecret(secret);
  } catch {
    throw new ConfigError("RELAYER_SECRET is not a Stellar secret key");
  }

  const payerKey = env.DEMO_PAYER_PRIVATE_KEY?.trim();
  let payer: PrivateKeyAccount | null = null;
  if (payerKey) {
    if (!isHex(payerKey) || size(payerKey) !== 32) {
      throw new ConfigError("DEMO_PAYER_PRIVATE_KEY is not a 32-byte hex private key");
    }
    payer = privateKeyToAccount(payerKey);
  }

  return {
    network,
    relayer,
    payer,
    evmRpcUrl: env.BASE_RPC_URL?.trim() || undefined,
    maxResourceFee: amount(env, "RELAYER_MAX_RESOURCE_FEE", DEFAULT_MAX_RESOURCE_FEE, "stroops"),
    maxDailyFees: amount(env, "RELAYER_MAX_DAILY_FEES", DEFAULT_MAX_DAILY_FEES, "stroops"),
    demoFund: {
      perIpPerHour: positiveInteger(env, "DEMO_FUND_PER_IP_PER_HOUR", DEFAULT_DEMO_FUND_PER_IP_PER_HOUR),
      perOwnerPerDay: positiveInteger(env, "DEMO_FUND_PER_OWNER_PER_DAY", DEFAULT_DEMO_FUND_PER_OWNER_PER_DAY),
      perDay: positiveInteger(env, "DEMO_FUND_PER_DAY", DEFAULT_DEMO_FUND_PER_DAY),
      payerFloor: amount(env, "DEMO_FUND_PAYER_FLOOR", DEFAULT_DEMO_FUND_PAYER_FLOOR, "USDC units (6 decimals)"),
    },
  };
}
