import { NETWORKS, type NetworkConfig, type NetworkName } from "@paso/sdk";
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

/** Mints on Base the server pays the gas for: per caller in an hour, and in any 24 hours whoever asks. */
export const DEFAULT_BASE_MINTS_PER_CALLER_PER_HOUR = 10;
export const DEFAULT_BASE_MINTS_PER_DAY = 100;
/** The server stops paying for mints while its account on Base holds less than this, in wei (0.0001 ETH). */
export const DEFAULT_BASE_MINT_PAYER_ETH_FLOOR = BigInt(100_000_000_000_000);
/** The most the server offers per unit of gas for a mint, in wei (0.25 gwei). Base usually asks a small fraction of it. */
export const DEFAULT_BASE_MINT_MAX_FEE_PER_GAS = BigInt(250_000_000);

/** The least a Stellar transaction may bid to be included, in stroops: the network's base fee. */
const MIN_INCLUSION_FEE = BigInt(100);

/** How many transactions of one kind the relayer account pays for in an hour: for one caller, and for everyone together. */
export interface SpendLimit {
  perCallerPerHour: number;
  perHour: number;
}

/** What the relayer account pays for, by kind: a relayed call, an account deployment, a delivery from Base. */
export type SpendKind = "relay" | "deploy" | "deliver";

interface Defaults {
  maxResourceFee: bigint;
  maxDailyFees: bigint;
  minBalance: bigint;
  inclusionFee: bigint;
  spend: Record<SpendKind, SpendLimit>;
}

/**
 * What applies when the environment says nothing.
 *
 * Testnet is generous: the funds are test funds and the app is there to be
 * tried. Mainnet is tight, because every stroop is real and the limits are
 * what bounds a bad day: 0.3 XLM a transaction, 2 XLM of fees in a day, a
 * handful of paid transactions per caller in an hour, and never below 2 XLM
 * in the account. A transaction bids 0.01 XLM to be included there; one that
 * bid the 100-stroop minimum has been left out of every ledger before.
 */
const DEFAULTS: Record<NetworkName, Defaults> = {
  testnet: {
    maxResourceFee: DEFAULT_MAX_RESOURCE_FEE,
    maxDailyFees: DEFAULT_MAX_DAILY_FEES,
    minBalance: BigInt(0),
    inclusionFee: BigInt(1_000),
    spend: {
      relay: { perCallerPerHour: 120, perHour: 1_200 },
      deploy: { perCallerPerHour: 60, perHour: 600 },
      deliver: { perCallerPerHour: 60, perHour: 600 },
    },
  },
  mainnet: {
    maxResourceFee: BigInt(3_000_000),
    maxDailyFees: BigInt(20_000_000),
    minBalance: BigInt(20_000_000),
    inclusionFee: BigInt(100_000),
    spend: {
      relay: { perCallerPerHour: 8, perHour: 40 },
      deploy: { perCallerPerHour: 3, perHour: 12 },
      deliver: { perCallerPerHour: 6, perHour: 20 },
    },
  },
};

export interface ServerConfig {
  network: NetworkConfig;
  /** Pays the fee of every transaction the server sends on Stellar. It never authorises anything else. */
  relayer: Keypair;
  /** The server's account on Base: it burns test USDC for the faucet and pays for mints. Absent when no key is configured. */
  payer: PrivateKeyAccount | null;
  /** RPC endpoint for Base; the chain's public endpoint when not set. */
  evmRpcUrl?: string;
  /** The most one transaction of the relayer account may cost in resource fees, in stroops. */
  maxResourceFee: bigint;
  /** The most the relayer account spends on fees per rolling day, in stroops. */
  maxDailyFees: bigint;
  /** What the relayer account keeps, in stroops: nothing is sent that could take its balance below this. Zero for no floor. */
  minBalance: bigint;
  /** What a transaction bids to be included in a ledger, in stroops, on top of its resource fee. Doubled when one is sent again. */
  inclusionFee: bigint;
  /** How many transactions of each kind are paid for in an hour. */
  spend: Record<SpendKind, SpendLimit>;
  demoFund: {
    perIpPerHour: number;
    perOwnerPerDay: number;
    /** Payouts per rolling day over all callers. */
    perDay: number;
    /** USDC the payer keeps, in 6-decimal units: no payout would take it below this. */
    payerFloor: bigint;
  };
  /** Completing a transfer back to Base: the server's account there submits the mint and pays its gas. */
  baseMints: {
    /** On testnet unless switched off. On mainnet only when asked for by name, on top of serving mainnet at all. */
    enabled: boolean;
    perCallerPerHour: number;
    perDay: number;
    /** ETH the account keeps, in wei: below this the server stops paying for mints. */
    payerEthFloor: bigint;
    /** Fee cap per unit of gas, in wei: while Base asks more, the server does not mint. */
    maxFeePerGas: bigint;
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

const NETWORK_NAMES: readonly NetworkName[] = ["testnet", "mainnet"];

/**
 * The network a request means when it names none: `PASO_NETWORK`, or testnet.
 * Every request the app itself sends names its network.
 */
export function defaultNetwork(env: Env = process.env): NetworkName {
  const name = env.PASO_NETWORK?.trim() || "testnet";
  if (name !== "testnet" && name !== "mainnet") {
    throw new ConfigError(`PASO_NETWORK must be "testnet" or "mainnet"`);
  }
  return name;
}

/**
 * Whether this server works on a network at all. Testnet always, given its
 * settings. Mainnet only when two things were done on purpose: the switch
 * was set, and the relayer was given an account of its own there. Without
 * both, requests for mainnet are declined and nothing about it is loaded.
 */
export function serves(name: NetworkName, env: Env = process.env): boolean {
  if (name === "testnet") return true;
  return env.PASO_ALLOW_MAINNET?.trim() === "true" && Boolean(env.RELAYER_SECRET_MAINNET?.trim());
}

/** The names of every network there is, served or not. */
export function networkNames(): readonly NetworkName[] {
  return NETWORK_NAMES;
}

/**
 * Reads a network's settings from the environment. Secrets are parsed here
 * and never echoed in an error.
 *
 * Mainnet has variables of its own, each ending in `_MAINNET`, and reads no
 * others: nothing set up for testnet, an account least of all, carries over
 * to real funds.
 */
export function loadConfig(env: Env = process.env, name: NetworkName = defaultNetwork(env)): ServerConfig {
  const mainnet = name === "mainnet";
  // Real funds are a decision of their own: naming the network is not enough to spend them.
  if (mainnet && env.PASO_ALLOW_MAINNET?.trim() !== "true") {
    throw new ConfigError("Mainnet was asked for; set PASO_ALLOW_MAINNET=true to work with real funds");
  }
  const variable = (testnetName: string): string => (mainnet ? `${testnetName}_MAINNET` : testnetName);
  const text = (testnetName: string): string | undefined => env[variable(testnetName)]?.trim() || undefined;
  const defaults = DEFAULTS[name];

  const base = NETWORKS[name];
  const rpcUrl = text("STELLAR_RPC_URL");
  const network: NetworkConfig = rpcUrl ? { ...base, stellar: { ...base.stellar, rpcUrl } } : base;

  const secretName = variable("RELAYER_SECRET");
  const secret = text("RELAYER_SECRET");
  if (!secret) {
    throw new ConfigError(`${secretName} is not set`);
  }
  if (mainnet && secret === env.RELAYER_SECRET?.trim()) {
    throw new ConfigError("RELAYER_SECRET_MAINNET is the testnet relayer's secret; mainnet needs an account of its own");
  }
  let relayer: Keypair;
  try {
    relayer = Keypair.fromSecret(secret);
  } catch {
    throw new ConfigError(`${secretName} is not a Stellar secret key`);
  }

  const payerName = mainnet ? "BASE_PAYER_PRIVATE_KEY_MAINNET" : "DEMO_PAYER_PRIVATE_KEY";
  const payerKey = env[payerName]?.trim();
  let payer: PrivateKeyAccount | null = null;
  if (payerKey) {
    if (!isHex(payerKey) || size(payerKey) !== 32) {
      throw new ConfigError(`${payerName} is not a 32-byte hex private key`);
    }
    payer = privateKeyToAccount(payerKey);
  }

  const inclusionFee = amount(env, variable("RELAYER_INCLUSION_FEE"), defaults.inclusionFee, "stroops");
  if (inclusionFee < MIN_INCLUSION_FEE) {
    throw new ConfigError(`${variable("RELAYER_INCLUSION_FEE")} must be at least ${MIN_INCLUSION_FEE} stroops, the network's base fee`);
  }
  const spendLimit = (kind: SpendKind, plural: string): SpendLimit => ({
    perCallerPerHour: positiveInteger(env, variable(`${plural}_PER_CALLER_PER_HOUR`), defaults.spend[kind].perCallerPerHour),
    perHour: positiveInteger(env, variable(`${plural}_PER_HOUR`), defaults.spend[kind].perHour),
  });

  return {
    network,
    relayer,
    payer,
    evmRpcUrl: text("BASE_RPC_URL"),
    maxResourceFee: amount(env, variable("RELAYER_MAX_RESOURCE_FEE"), defaults.maxResourceFee, "stroops"),
    maxDailyFees: amount(env, variable("RELAYER_MAX_DAILY_FEES"), defaults.maxDailyFees, "stroops"),
    minBalance: amount(env, variable("RELAYER_MIN_BALANCE"), defaults.minBalance, "stroops"),
    inclusionFee,
    spend: {
      relay: spendLimit("relay", "RELAYS"),
      deploy: spendLimit("deploy", "DEPLOYS"),
      deliver: spendLimit("deliver", "DELIVERIES"),
    },
    demoFund: {
      perIpPerHour: positiveInteger(env, "DEMO_FUND_PER_IP_PER_HOUR", DEFAULT_DEMO_FUND_PER_IP_PER_HOUR),
      perOwnerPerDay: positiveInteger(env, "DEMO_FUND_PER_OWNER_PER_DAY", DEFAULT_DEMO_FUND_PER_OWNER_PER_DAY),
      perDay: positiveInteger(env, "DEMO_FUND_PER_DAY", DEFAULT_DEMO_FUND_PER_DAY),
      payerFloor: amount(env, "DEMO_FUND_PAYER_FLOOR", DEFAULT_DEMO_FUND_PAYER_FLOOR, "USDC units (6 decimals)"),
    },
    baseMints: {
      // With real funds the owner's own wallet submits the mint; the server pays only if told to by name.
      enabled: mainnet ? env.PAY_BASE_MINTS_ON_MAINNET?.trim() === "true" : env.PAY_BASE_MINTS_ON_TESTNET?.trim() !== "false",
      perCallerPerHour: positiveInteger(env, variable("BASE_MINTS_PER_CALLER_PER_HOUR"), DEFAULT_BASE_MINTS_PER_CALLER_PER_HOUR),
      perDay: positiveInteger(env, variable("BASE_MINTS_PER_DAY"), DEFAULT_BASE_MINTS_PER_DAY),
      payerEthFloor: amount(env, variable("BASE_MINT_PAYER_ETH_FLOOR"), DEFAULT_BASE_MINT_PAYER_ETH_FLOOR, "wei"),
      maxFeePerGas: amount(env, variable("BASE_MINT_MAX_FEE_PER_GAS"), DEFAULT_BASE_MINT_MAX_FEE_PER_GAS, "wei"),
    },
  };
}
