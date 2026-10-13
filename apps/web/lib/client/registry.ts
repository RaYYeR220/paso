import { erc20Abi, isDeployed, isReceivedOnEvm, twinAddress, usdcBalance, type NetworkName } from "@paso/sdk";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { createActionController, type ActionController } from "./action/controller";
import { loadChainActivity, type ChainActivity } from "./activity/events";
import { activityLogKey, createActivityLog, type ActivityLog } from "./activity/log";
import { createApi, type HealthResponse, type PasoApi } from "./api";
import { networkConfig, ROUTES, stellarServer } from "./config";
import { resolveEnsName } from "./ens";
import { askExit, createExitWatcher, exitStorageKey, isHubExit, type BaseReader, type ExitWatcher } from "./exit";
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
const BASE_BALANCE_REFRESH_MS = 15_000;
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

const readers = perNetwork<PublicClient>((network) =>
  createPublicClient({ chain: networkConfig(network).evm.chain, transport: http() }),
);

/** A reader for a network's Base, over the chain's public endpoint. */
export const baseReaderFor = (network: NetworkName): PublicClient => readers(network, "");

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

/** USDC an address holds on a network's Base, in 6-decimal units: what its wallet could bring over. */
const baseBalances = perNetwork<Resource<bigint>>((network, owner) =>
  createResource(
    () =>
      baseReaderFor(network).readContract({
        address: networkConfig(network).evm.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address],
      }),
    { intervalMs: BASE_BALANCE_REFRESH_MS },
  ),
);

/** What the exit watcher reads from a network's Base: whether a message was received, and what became of a mint. */
function baseReads(network: NetworkName): BaseReader {
  const config = networkConfig(network);
  return {
    isReceived: (message) => isReceivedOnEvm(baseReaderFor(network), message, config),
    async receipt(hash) {
      try {
        const { status } = await baseReaderFor(network).getTransactionReceipt({ hash });
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
    ask: (txHash, signal) =>
      askExit(txHash, { url: ROUTES.complete, network, signal, accepts: (message) => isHubExit(message, config) }),
    base: baseReads(network),
    storage: browserStorage(),
    storageKey: exitStorageKey(network, owner),
  });
});

export const fundingFor = (network: NetworkName, owner: Address): FundingController => fundings(network, ownerKey(owner));
export const actionFor = (network: NetworkName, owner: Address): ActionController => actions(network, ownerKey(owner));
export const exitWatcherFor = (network: NetworkName, owner: Address): ExitWatcher => exits(network, ownerKey(owner));
export const twinReadingFor = (network: NetworkName, owner: Address): Resource<TwinReading> => twins(network, ownerKey(owner));
export const chainActivityFor = (network: NetworkName, twin: string): Resource<ChainActivity> => activities(network, twin);
export const baseBalanceFor = (network: NetworkName, owner: Address): Resource<bigint> => baseBalances(network, ownerKey(owner));

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
