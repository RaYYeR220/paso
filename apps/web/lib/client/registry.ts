import {
  defaultFinalityOf,
  erc20Abi,
  fetchBurnFee,
  isDeployed,
  isReceivedOnEvm,
  twinAddress,
  usdcBalance,
  type EvmChainName,
  type NetworkName,
} from "paso-sdk";
import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { createActionController, type ActionController } from "./action/controller";
import { loadChainActivity, type ChainActivity } from "./activity/events";
import { activityLogKey, createActivityLog, type ActivityLog } from "./activity/log";
import { createApi, type HealthResponse, type PasoApi } from "./api";
import { chainOf } from "./chains";
import { networkConfig, ROUTES, stellarServer } from "./config";
import { resolveEnsName } from "./ens";
import { askExit, createExitWatcher, exitStorageKey, isHubExit, type ChainReader, type ExitWatcher } from "./exit";
import { createFundingController, type FundingController } from "./funding/controller";
import { burnCeiling } from "./funding/limits";
import { checkOwner } from "./ownerCheck";
import { createResource, type Resource } from "./resource";
import { browserStorage } from "./storage";

/**
 * The page's shared state: one controller, one log and one reader per
 * network and account, however many components ask for them. Everything
 * here is made on first use, in the browser.
 *
 * Every entry is asked for by network, and kept under it. An account's
 * address is different on each network, because the hub that derives it is;
 * so are its balance, its transfers in flight and its history. Nothing made
 * for one network is ever handed out for the other.
 */

const TWIN_REFRESH_MS = 10_000;
const WALLET_BALANCE_REFRESH_MS = 15_000;
/** Circle changes its fees rarely: once a few minutes is often enough to show the one in force. */
const BURN_FEE_REFRESH_MS = 5 * 60_000;
const ACTIVITY_REFRESH_MS = 20_000;
const HEALTH_REFRESH_MS = 30_000;

/** One value per network and id, made on first use. */
function perNetwork<T>(create: (network: NetworkName, id: string) => T): (network: NetworkName, id: string) => T {
  const made = new Map<string, T>();
  return (network, id) => {
    const key = `${network}:${id}`;
    let value = made.get(key);
    if (value === undefined) {
      value = create(network, id);
      made.set(key, value);
    }
    return value;
  };
}

const ownerKey = (owner: Address): string => owner.toLowerCase();

const apis = perNetwork<PasoApi>((network) => createApi({ network }));

/** The app's routes, for one network: every request it sends names that network. */
export const apiFor = (network: NetworkName): PasoApi => apis(network, "");

const readers = perNetwork<PublicClient>((network, name) => {
  const { chain, rpcUrls } = chainOf(networkConfig(network), name as EvmChainName);
  return createPublicClient({ chain, transport: fallback(rpcUrls.map((url) => http(url))) });
});

/** A reader for one EVM chain of a network, over the public endpoints the SDK lists for it. */
export const evmReaderFor = (network: NetworkName, chain: EvmChainName): PublicClient => readers(network, chain);

/** What the network says about an account. */
export interface TwinReading {
  /** Whether the account contract exists yet. It can hold USDC before it does. */
  deployed: boolean;
  /** USDC held, in 7-decimal units. */
  balance: bigint;
}

const logs = perNetwork<ActivityLog>((network, twin) => createActivityLog(browserStorage(), activityLogKey(network, twin)));

/** The session log of an account on a network. */
export const activityLogFor = (network: NetworkName, twin: string): ActivityLog => logs(network, twin);

const fundings = perNetwork<FundingController>((network, owner) =>
  createFundingController(owner as Address, {
    network: networkConfig(network),
    api: apiFor(network),
    storage: browserStorage(),
    ceiling: burnCeiling(network),
    log: (twin) => activityLogFor(network, twin),
  }),
);

const actions = perNetwork<ActionController>((network, owner) => {
  const config = networkConfig(network);
  return createActionController(owner as Address, {
    network: config,
    relayUrl: ROUTES.relay,
    resolveName: resolveEnsName,
    async inspectRecipient(address) {
      const [check, deployed] = await Promise.all([
        checkOwner(address),
        isDeployed(address, config, stellarServer(config)).catch(() => null),
      ]);
      return { kind: check.kind, deployed };
    },
    log: (twin) => activityLogFor(network, twin),
  });
});

const twins = perNetwork<Resource<TwinReading>>((network, owner) =>
  createResource(
    async () => {
      const config = networkConfig(network);
      const server = stellarServer(config);
      const [deployed, balance] = await Promise.all([
        isDeployed(owner as Address, config, server),
        usdcBalance(twinAddress(owner as Address, config), config, server),
      ]);
      return { deployed, balance };
    },
    { intervalMs: TWIN_REFRESH_MS },
  ),
);

const activities = perNetwork<Resource<ChainActivity>>((network, twin) => {
  const config = networkConfig(network);
  return createResource(() => loadChainActivity(twin, config, stellarServer(config)), { intervalMs: ACTIVITY_REFRESH_MS });
});

/** What a wallet holds on one EVM chain, in that chain's units. */
export interface WalletBalance {
  /** USDC, 6 decimals: what the wallet could bring over. */
  usdc: bigint;
  /** The gas token, 18 decimals. On Arc it is the same USDC counted natively, and `usdc` is what to show. */
  gas: bigint;
}

const walletBalances = perNetwork<Resource<WalletBalance>>((network, id) => {
  const [name, owner] = id.split(":") as [EvmChainName, Address];
  const reader = evmReaderFor(network, name);
  const { usdc } = chainOf(networkConfig(network), name);
  return createResource(
    async () => {
      const [held, gas] = await Promise.all([
        reader.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        reader.getBalance({ address: owner }),
      ]);
      return { usdc: held, gas };
    },
    { intervalMs: WALLET_BALANCE_REFRESH_MS },
  );
});

/** Circle's fee, in basis points, for a burn from a chain to Stellar at the finality the app asks for there. */
const burnFees = perNetwork<Resource<number>>((network, name) => {
  const config = networkConfig(network);
  const chain = chainOf(config, name as EvmChainName);
  return createResource(() => fetchBurnFee(chain.name, "stellar", config, { finalityThreshold: defaultFinalityOf(chain) }), {
    intervalMs: BURN_FEE_REFRESH_MS,
  });
});

/** What the exit watcher reads from the chains: whether a message was received, and what became of a mint. */
function chainReads(network: NetworkName): ChainReader {
  const config = networkConfig(network);
  return {
    isReceived: (message, chain) => isReceivedOnEvm(evmReaderFor(network, chain), message, config, chain),
    async receipt(hash, chain) {
      try {
        const { status } = await evmReaderFor(network, chain).getTransactionReceipt({ hash });
        return status === "success" ? "success" : "reverted";
      } catch {
        return null;
      }
    },
  };
}

const exits = perNetwork<ExitWatcher>((network, owner) => {
  const config = networkConfig(network);
  return createExitWatcher({
    network,
    ask: (txHash, signal, chain) =>
      askExit(txHash, { url: ROUTES.complete, network, signal, accepts: (message) => isHubExit(message, config, chain) }),
    reader: chainReads(network),
    storage: browserStorage(),
    storageKey: exitStorageKey(network, owner),
  });
});

export const fundingFor = (network: NetworkName, owner: Address): FundingController => fundings(network, ownerKey(owner));
export const actionFor = (network: NetworkName, owner: Address): ActionController => actions(network, ownerKey(owner));
export const exitWatcherFor = (network: NetworkName, owner: Address): ExitWatcher => exits(network, ownerKey(owner));
export const twinReadingFor = (network: NetworkName, owner: Address): Resource<TwinReading> => twins(network, ownerKey(owner));
export const chainActivityFor = (network: NetworkName, twin: string): Resource<ChainActivity> => activities(network, twin);
/** What `owner` holds on one chain of a network: USDC, and the gas token. */
export const walletBalanceFor = (network: NetworkName, chain: EvmChainName, owner: Address): Resource<WalletBalance> =>
  walletBalances(network, `${chain}:${ownerKey(owner)}`);
/** Circle's fee for bringing USDC from `chain` to Stellar, in basis points. */
export const burnFeeFor = (network: NetworkName, chain: EvmChainName): Resource<number> => burnFees(network, chain);

let health: Resource<HealthResponse> | undefined;

/** The server's report on itself. One report covers every network, each on its own. */
export function healthResource(): Resource<HealthResponse> {
  health ??= createResource(() => apiFor("testnet").health(), { intervalMs: HEALTH_REFRESH_MS });
  return health;
}

/** Reads the balance and the activity of an owner's account on a network again: something just moved. */
export function refreshAccount(network: NetworkName, owner: Address): void {
  void twinReadingFor(network, owner).refresh();
  try {
    void chainActivityFor(network, twinAddress(owner, networkConfig(network))).refresh();
  } catch {
    // No account can be derived on this network; there is nothing to refresh.
  }
}
