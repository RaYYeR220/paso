"use client";

import { twinAddress, type NetworkName } from "paso-sdk";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { networkConfig } from "./config";
import { stellarAddress } from "./explorer";
import { formatUsdc } from "./format";
import { twinReadingFor, type TwinReading } from "./registry";
import { idleResource, type ResourceState } from "./resource";
import { noSubscription } from "./store";

/** The Stellar account of an Ethereum address on one network: where it is, and what that network says about it. */
export interface Twin {
  /** The network this account is on. The same owner has another address on the other one. */
  network: NetworkName;
  owner: Address | null;
  /** The account's address (`C…`). Pure arithmetic: known at once, offline, before anything is deployed. */
  address: string | null;
  /** Whether the account contract exists yet; `null` until the network has answered. */
  deployed: boolean | null;
  /** USDC held, in 7-decimal units; `null` until the network has answered. */
  balance: bigint | null;
  /** The balance as text: `"12.50"`. */
  balanceFormatted: string | null;
  /** `ready` once the network has answered; later failures keep the last answer and set `error`. */
  status: "idle" | "loading" | "ready" | "error";
  /** Why the address could not be derived, or why the latest read failed. */
  error: string | null;
  refreshing: boolean;
  updatedAt: number | null;
  /** The account on the Stellar explorer. */
  link: string | null;
  /** Reads the balance and the deployment again, now. */
  refresh(): Promise<void>;
}

const idle = (): ResourceState<TwinReading> => idleResource<TwinReading>();

/** Derives an owner's account on a network, or says why it cannot be derived there. */
export function deriveTwin(owner: Address | null | undefined, network: NetworkName): { address: string | null; error: string | null } {
  if (!owner) return { address: null, error: null };
  try {
    return { address: twinAddress(owner, networkConfig(network)), error: null };
  } catch (error) {
    return { address: null, error: error instanceof Error ? error.message : "The account could not be derived" };
  }
}

/**
 * The Stellar account of `owner` on `network`: its address at once, then its
 * balance and whether it is deployed, refreshed every few seconds while the
 * tab is visible and whenever `refresh` is called.
 */
export function useTwin(owner: Address | null | undefined, network: NetworkName): Twin {
  const derived = useMemo(() => deriveTwin(owner, network), [owner, network]);
  const resource = owner && derived.address ? twinReadingFor(network, owner) : null;
  const reading = useSyncExternalStore(resource?.subscribe ?? noSubscription, resource?.getState ?? idle, idle);
  const refresh = useCallback(() => resource?.refresh() ?? Promise.resolve(), [resource]);

  return useMemo(() => {
    const balance = reading.data?.balance ?? null;
    return {
      network,
      owner: owner ?? null,
      address: derived.address,
      deployed: reading.data?.deployed ?? null,
      balance,
      balanceFormatted: balance === null ? null : formatUsdc(balance),
      status: derived.error ? "error" : reading.status,
      error: derived.error ?? reading.error,
      refreshing: reading.refreshing,
      updatedAt: reading.updatedAt,
      link: derived.address ? stellarAddress(derived.address, network) : null,
      refresh,
    };
  }, [network, owner, derived, reading, refresh]);
}
