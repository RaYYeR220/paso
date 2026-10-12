import { isDeployed, twinAddress, usdcBalance } from "@paso/sdk";
import type { Address } from "viem";
import { createActionController, type ActionController } from "./action/controller";
import { loadChainActivity, type ChainActivity } from "./activity/events";
import { activityLogKey, createActivityLog, type ActivityLog } from "./activity/log";
import { createApi, type HealthResponse } from "./api";
import { NETWORK, NETWORK_NAME, ROUTES, stellarServer } from "./config";
import { resolveEnsName } from "./ens";
import { createFundingController, type FundingController } from "./funding/controller";
import { createResource, keyedResources, type Resource } from "./resource";
import { browserStorage } from "./storage";

/**
 * The page's shared state: one controller, one log and one reader per
 * account, however many components ask for them. Everything here is made on
 * first use, in the browser.
 */

export const api = createApi();

const TWIN_REFRESH_MS = 10_000;
const ACTIVITY_REFRESH_MS = 20_000;
const HEALTH_REFRESH_MS = 30_000;

function memo<T>(create: (key: string) => T): (key: string) => T {
  const made = new Map<string, T>();
  return (key) => {
    let value = made.get(key);
    if (value === undefined) {
      value = create(key);
      made.set(key, value);
    }
    return value;
  };
}

/** What the network says about an account. */
export interface TwinReading {
  /** Whether the account contract exists yet. It can hold USDC before it does. */
  deployed: boolean;
  /** USDC held, in 7-decimal units. */
  balance: bigint;
}

export const activityLogFor: (twin: string) => ActivityLog = memo((twin) =>
  createActivityLog(browserStorage(), activityLogKey(NETWORK_NAME, twin)),
);

const fundingByOwner = memo<FundingController>((owner) =>
  createFundingController(owner as Address, {
    network: NETWORK,
    api,
    storage: browserStorage(),
    log: activityLogFor,
  }),
);

const actionByOwner = memo<ActionController>((owner) =>
  createActionController(owner as Address, {
    network: NETWORK,
    relayUrl: ROUTES.relay,
    resolveName: resolveEnsName,
    log: activityLogFor,
  }),
);

const twinByOwner = keyedResources<TwinReading>((owner) =>
  createResource(
    async () => {
      const server = stellarServer();
      const [deployed, balance] = await Promise.all([
        isDeployed(owner as Address, NETWORK, server),
        usdcBalance(twinAddress(owner as Address, NETWORK), NETWORK, server),
      ]);
      return { deployed, balance };
    },
    { intervalMs: TWIN_REFRESH_MS },
  ),
);

const activityByTwin = keyedResources<ChainActivity>((twin) =>
  createResource(() => loadChainActivity(twin, NETWORK, stellarServer()), { intervalMs: ACTIVITY_REFRESH_MS }),
);

const key = (owner: Address): string => owner.toLowerCase();

export const fundingFor = (owner: Address): FundingController => fundingByOwner(key(owner));
export const actionFor = (owner: Address): ActionController => actionByOwner(key(owner));
export const twinReadingFor = (owner: Address): Resource<TwinReading> => twinByOwner(key(owner));
export const chainActivityFor = (twin: string): Resource<ChainActivity> => activityByTwin(twin);

let health: Resource<HealthResponse> | undefined;

export function healthResource(): Resource<HealthResponse> {
  health ??= createResource(() => api.health(), { intervalMs: HEALTH_REFRESH_MS });
  return health;
}

/** Reads the balance and the activity of an owner's account again: something just moved. */
export function refreshAccount(owner: Address): void {
  void twinReadingFor(owner).refresh();
  try {
    void chainActivityFor(twinAddress(owner, NETWORK)).refresh();
  } catch {
    // No account can be derived on this network; there is nothing to refresh.
  }
}
