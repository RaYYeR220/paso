"use client";

import type { NetworkName } from "paso-sdk";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { faucetStatus, relayerStatus, type FaucetStatus, type HealthResponse, type NetworkHealth, type RelayerStatus } from "./api";
import { healthResource } from "./registry";
import { idleResource, type ResourceState } from "./resource";

/** What the server reports about itself: each network on its own, its relayer, its limits, and testnet's faucet. */
export interface Health {
  report: HealthResponse | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** Whether the testnet faucet can pay out right now, as far as the report tells. */
  faucet: FaucetStatus;
  /** One network's part of the report, or `null` before there is a report. */
  of(network: NetworkName): NetworkHealth | null;
  /** Whether the hosted relayer is there to pay fees on a network. */
  relayer(network: NetworkName): RelayerStatus;
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
      of: (network) => health.data?.networks?.[network] ?? null,
      relayer: (network) => relayerStatus(health.data, network),
      refresh,
    }),
    [health, refresh],
  );
}
