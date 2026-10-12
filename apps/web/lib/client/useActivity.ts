"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ChainActivity } from "./activity/events";
import type { LogEntry } from "./activity/log";
import { mergeActivity, type ActivityItem } from "./activity/merge";
import { NETWORK } from "./config";
import { activityLogFor, chainActivityFor } from "./registry";
import { idleResource, type ResourceState } from "./resource";
import { noSubscription } from "./store";

/** What happened to an account, newest first. */
export interface Activity {
  /** USDC movements Stellar reports for the account, merged with what this browser did itself. */
  items: ActivityItem[];
  /**
   * How the network's side of the list is doing. The browser's own record is
   * shown whatever this says, so the list is never blank just because the
   * network did not answer.
   */
  status: "idle" | "loading" | "ready" | "error";
  /** Why the network's side could not be read, or `null`. */
  error: string | null;
  /** True when both records are empty and the network has answered. */
  isEmpty: boolean;
  /**
   * How far back the network's record reaches, in milliseconds. Stellar RPC
   * keeps about seven days of events: older movements are not listed.
   */
  since: number | null;
  refreshing: boolean;
  refresh(): Promise<void>;
}

const NO_LOG: LogEntry[] = [];
const idle = (): ResourceState<ChainActivity> => idleResource<ChainActivity>();
const noLog = (): LogEntry[] => NO_LOG;

/** The activity of the Stellar account `twin` (`C…`), kept fresh while the tab is visible. */
export function useActivity(twin: string | null | undefined): Activity {
  const resource = twin ? chainActivityFor(twin) : null;
  const log = twin ? activityLogFor(twin) : null;
  const chain = useSyncExternalStore(resource?.subscribe ?? noSubscription, resource?.getState ?? idle, idle);
  const entries = useSyncExternalStore(log?.subscribe ?? noSubscription, log?.list ?? noLog, noLog);
  const refresh = useCallback(() => resource?.refresh() ?? Promise.resolve(), [resource]);

  return useMemo(() => {
    const items = twin ? mergeActivity(chain.data?.transfers ?? [], entries, { account: twin, network: NETWORK }) : [];
    return {
      items,
      status: chain.status,
      error: chain.error,
      isEmpty: items.length === 0 && chain.status === "ready",
      since: chain.data?.since ?? null,
      refreshing: chain.refreshing,
      refresh,
    };
  }, [twin, chain, entries, refresh]);
}
