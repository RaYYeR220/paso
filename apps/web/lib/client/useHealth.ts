"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { faucetStatus, type FaucetStatus, type HealthResponse } from "./api";
import { healthResource } from "./registry";
import { idleResource, type ResourceState } from "./resource";

/** What the server reports about itself: its network, its hub, the relayer and the faucet. */
export interface Health {
  report: HealthResponse | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Whether the testnet faucet can pay out right now, as far as the report tells. */
  faucet: FaucetStatus;
  refresh(): Promise<void>;
}

const idle = (): ResourceState<HealthResponse> => idleResource<HealthResponse>();

export function useHealth(): Health {
  const subscribe = useCallback((listener: () => void) => healthResource().subscribe(listener), []);
  const getState = useCallback(() => healthResource().getState(), []);
  const health = useSyncExternalStore(subscribe, getState, idle);
  const refresh = useCallback(() => healthResource().refresh(), []);

  return useMemo(
    () => ({
      report: health.data,
      status: health.status,
      error: health.error,
      faucet: faucetStatus(health.data),
      refresh,
    }),
    [health, refresh],
  );
}
