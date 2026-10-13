import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  isAddress,
  isHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { listEvmChains, NETWORKS, type NetworkName } from "./networks";

/**
 * What the code at an Ethereum address says about who controls it.
 *
 * - `wallet`: every chain answered, and none has contract code at the address.
 * - `contract`: at least one chain has contract code at the address.
 * - `unknown`: no chain has contract code there, and at least one could not be asked.
 */
export type OwnerKind = "wallet" | "contract" | "unknown";

/**
 * What one chain has at an address.
 *
 * - `none`: no code.
 * - `delegated`: an EIP-7702 delegation. The address runs another contract's code and still has its key.
 * - `contract`: contract code.
 * - `unknown`: the chain failed, took too long, or answered with something that is not code.
 */
export type CodeKind = "none" | "delegated" | "contract" | "unknown";

export interface OwnerChain {
  chain: Chain;
  /** RPC endpoints tried in order; the chain's public default when empty or absent. */
  rpcUrls?: readonly string[];
}

export interface OwnerCheck {
  kind: OwnerKind;
  /** What each chain said, in the order asked. */
  chains: { name: string; chainId: number; code: CodeKind }[];
}

export interface OwnerKindOptions {
  /** The chains to ask. Defaults to `OWNER_CHAINS`. */
  chains?: readonly OwnerChain[];
  /** Per chain, in milliseconds. Default 6000. */
  timeoutMs?: number;
  /**
   * Replaces the network read, for tests and for callers with their own
   * clients. Resolves with the code at the address ("0x" or undefined for none).
   */
  getCode?: (chain: OwnerChain, address: Address) => Promise<Hex | undefined>;
  /** Ends the wait early. Chains that have not answered by then are reported as "unknown". */
  signal?: AbortSignal;
}

/**
 * The chains asked by default: every EVM chain Paso lists, mainnet first
 * (Ethereum, Base, Arbitrum, OP Mainnet, Arc), then their testnets, each
 * through the public endpoints listed for it.
 *
 * A smart account often has the same address on several chains and is
 * deployed on only some of them, so code found on any one chain counts.
 */
export const OWNER_CHAINS: readonly OwnerChain[] = ownerChainsOf(["mainnet", "testnet"]);

function ownerChainsOf(networks: readonly NetworkName[]): OwnerChain[] {
  const seen = new Set<number>();
  const chains: OwnerChain[] = [];
  for (const network of networks) {
    const listed = listEvmChains(NETWORKS[network]);
    // Ethereum first: it is where an address is most likely to have been used.
    listed.sort((a, b) => Number(b.name === "ethereum") - Number(a.name === "ethereum"));
    for (const { chain, rpcUrls } of listed) {
      if (seen.has(chain.id)) continue;
      seen.add(chain.id);
      chains.push({ chain, rpcUrls });
    }
  }
  return chains;
}

const DEFAULT_TIMEOUT_MS = 6000;
const DELEGATION_PREFIX = "0xef0100";
const DELEGATION_HEX_LENGTH = DELEGATION_PREFIX.length + 2 * 20;

/**
 * Classifies the code at an address.
 *
 * No code is "none". Exactly 23 bytes that start with `0xef0100` are an
 * EIP-7702 delegation designator, the prefix and the address delegated to:
 * the address is still controlled by its key, so that is "delegated". Any
 * other code is "contract". An answer that is not whole hex bytes is
 * "unknown".
 */
export function codeKind(code: Hex | undefined | null): CodeKind {
  if (code === undefined || code === null || code === "0x") return "none";
  if (!isHex(code) || code.length % 2 !== 0) return "unknown";
  const delegated = code.length === DELEGATION_HEX_LENGTH && code.toLowerCase().startsWith(DELEGATION_PREFIX);
  return delegated ? "delegated" : "contract";
}

type CodeReader = NonNullable<OwnerKindOptions["getCode"]>;

/** Reads the code through the chain's endpoints, each tried for at most `timeoutMs`. */
function rpcReader(timeoutMs: number): CodeReader {
  return ({ chain, rpcUrls = [] }, address) => {
    const transport =
      rpcUrls.length > 0
        ? fallback(rpcUrls.map((url) => http(url, { timeout: timeoutMs })))
        : http(undefined, { timeout: timeoutMs });
    return createPublicClient({ chain, transport }).getCode({ address });
  };
}

/**
 * What one chain says, or "unknown" when the read fails, takes longer than
 * `timeoutMs`, or `signal` aborts first. Never rejects.
 */
function codeWithin(read: () => Promise<Hex | undefined>, timeoutMs: number, signal?: AbortSignal): Promise<CodeKind> {
  if (signal?.aborted) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    const settle = (kind: CodeKind) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", giveUp);
      resolve(kind);
    };
    const giveUp = () => settle("unknown");
    const timer = setTimeout(giveUp, timeoutMs);
    signal?.addEventListener("abort", giveUp, { once: true });
    Promise.resolve().then(read).then(codeKind).then(settle, giveUp);
  });
}

function overall(codes: CodeKind[]): OwnerKind {
  if (codes.includes("contract")) return "contract";
  if (codes.length === 0 || codes.includes("unknown")) return "unknown";
  return "wallet";
}

/**
 * Tells whether an Ethereum address is a wallet with a key or a contract, by
 * asking several chains for the code at the address.
 *
 * A Paso account obeys one thing: a signature from the key of its owner
 * address. An address that is a contract (a Safe, a smart wallet) has no
 * private key, so the Stellar account derived from it can receive USDC and
 * never spend it. Ask before showing the account of an owner as a place to
 * send USDC to.
 *
 * All chains are asked at once, each for at most `timeoutMs`. Contract code
 * on any chain makes the answer "contract". Otherwise a chain that failed or
 * timed out makes it "unknown", and so does an empty list of chains. Network
 * failures never throw; only an `address` that is not an Ethereum address
 * does.
 *
 * The limit: a smart account that has not been deployed yet has no code, so
 * "wallet" means "no code found", not proof of a key.
 */
export async function ownerKind(address: Address, options: OwnerKindOptions = {}): Promise<OwnerCheck> {
  if (!isAddress(address, { strict: false })) {
    throw new Error(`"${address}" is not an Ethereum address`);
  }
  const { chains = OWNER_CHAINS, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  const getCode = options.getCode ?? rpcReader(timeoutMs);
  const owner = getAddress(address);

  const answers = await Promise.all(
    chains.map(async (entry) => ({
      name: entry.chain.name,
      chainId: entry.chain.id,
      code: await codeWithin(() => getCode(entry, owner), timeoutMs, signal),
    })),
  );
  return { kind: overall(answers.map(({ code }) => code)), chains: answers };
}
