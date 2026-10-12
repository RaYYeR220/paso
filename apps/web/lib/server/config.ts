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

export const DEFAULT_DEMO_FUND_PER_IP_PER_HOUR = 5;
export const DEFAULT_DEMO_FUND_PER_OWNER_PER_DAY = 2;

export interface ServerConfig {
  network: NetworkConfig;
  /** Pays the fee of every transaction the server sends on Stellar. It never authorises anything else. */
  relayer: Keypair;
  /** Burns test USDC on Base for the demo faucet. Absent when no key is configured. */
  payer: PrivateKeyAccount | null;
  /** RPC endpoint for Base; the chain's public endpoint when not set. */
  evmRpcUrl?: string;
  maxResourceFee: bigint;
  demoFund: { perIpPerHour: number; perOwnerPerDay: number };
}

type Env = Record<string, string | undefined>;

function positiveInteger(env: Env, name: string, fallback: number): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text) || Number(text) === 0) {
    throw new ConfigError(`${name} must be a positive whole number`);
  }
  return Number(text);
}

/** Reads the server's settings from the environment. Secrets are parsed here and never echoed in an error. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const name = env.PASO_NETWORK?.trim() || "testnet";
  if (name !== "testnet" && name !== "mainnet") {
    throw new ConfigError(`PASO_NETWORK must be "testnet" or "mainnet"`);
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

  const cap = env.RELAYER_MAX_RESOURCE_FEE?.trim();
  if (cap && !/^\d+$/.test(cap)) {
    throw new ConfigError("RELAYER_MAX_RESOURCE_FEE must be a whole number of stroops");
  }

  return {
    network,
    relayer,
    payer,
    evmRpcUrl: env.BASE_RPC_URL?.trim() || undefined,
    maxResourceFee: cap ? BigInt(cap) : DEFAULT_MAX_RESOURCE_FEE,
    demoFund: {
      perIpPerHour: positiveInteger(env, "DEMO_FUND_PER_IP_PER_HOUR", DEFAULT_DEMO_FUND_PER_IP_PER_HOUR),
      perOwnerPerDay: positiveInteger(env, "DEMO_FUND_PER_OWNER_PER_DAY", DEFAULT_DEMO_FUND_PER_OWNER_PER_DAY),
    },
  };
}
