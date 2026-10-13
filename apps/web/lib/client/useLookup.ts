"use client";

import type { NetworkName } from "@paso/sdk";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { resolveEnsName } from "./ens";
import { describeFailure } from "./errors";
import { evmAddress } from "./explorer";
import { parseOwnerInput, type ParsedOwner } from "./parse";
import { createStore, type Store } from "./store";
import { useTwin, type Twin } from "./useTwin";

/** The Stellar account, on one network, behind whatever was typed: an Ethereum address or an ENS name. */
export interface Lookup {
  /** What the input is: nothing, an address, a name, or neither. Decided without the network. */
  parsed: ParsedOwner;
  /**
   * - `empty`: nothing typed
   * - `invalid`: not an address or a name; `error` says why
   * - `resolving`: the name is being looked up
   * - `not_found`: the name is valid and points to no address
   * - `error`: the name could not be looked up; `error` says why
   * - `ready`: `owner` and `twin.address` are known
   */
  status: "empty" | "invalid" | "resolving" | "not_found" | "error" | "ready";
  /** The ENS name, when one was typed. */
  name: string | null;
  /** The Ethereum address: typed, or resolved from the name. */
  owner: Address | null;
  /**
   * The Stellar account. Its `address` is there as soon as `owner` is, with
   * no network at all; `deployed` and `balance` follow when the network
   * answers.
   */
  twin: Twin;
  error: string | null;
  /** The owner on the Base explorer. */
  ownerLink: string | null;
}

type NameState =
  | { status: "resolving" }
  | { status: "resolved"; address: Address }
  | { status: "not_found" }
  | { status: "error"; message: string };

const RESOLVING: NameState = { status: "resolving" };
const DEBOUNCE_MS = 350;

const names = new Map<string, Store<NameState>>();
const asked = new Set<string>();

/** The state of one name's lookup, shared by everyone asking for the same name. */
function nameState(name: string): Store<NameState> {
  let store = names.get(name);
  if (!store) {
    store = createStore<NameState>(RESOLVING);
    names.set(name, store);
  }
  return store;
}

/** Asks for a name once. A lookup that failed is asked again the next time the name comes up. */
function lookUp(name: string): void {
  const store = nameState(name);
  if (asked.has(name) && store.get().status !== "error") return;
  asked.add(name);
  store.set(RESOLVING);
  resolveEnsName(name).then(
    (address) => store.set(address ? { status: "resolved", address } : { status: "not_found" }),
    (error) => store.set({ status: "error", message: describeFailure(error).message }),
  );
}

const noName = createStore<NameState>(RESOLVING);
const resolving = (): NameState => RESOLVING;

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Looks up the Stellar account of an Ethereum address or ENS name on
 * `network` as it is typed. An address answers at once and offline; a name is
 * resolved on Ethereum mainnet, whichever network the account is on, after a
 * short pause in typing.
 */
export function useLookup(input: string, network: NetworkName): Lookup {
  const parsed = useMemo(() => parseOwnerInput(input), [input]);
  const typedName = parsed.kind === "ens" ? parsed.name : null;
  const settledName = useSettled(typedName, DEBOUNCE_MS);
  const name = typedName !== null && typedName === settledName ? typedName : null;

  const lookup = name ? nameState(name) : noName;
  const resolution = useSyncExternalStore(lookup.subscribe, lookup.get, resolving);
  useEffect(() => {
    if (name) lookUp(name);
  }, [name]);

  const owner =
    parsed.kind === "address"
      ? parsed.address
      : name && resolution.status === "resolved"
        ? resolution.address
        : null;
  const twin = useTwin(owner, network);

  return useMemo(() => {
    let status: Lookup["status"];
    let error: string | null = null;
    switch (parsed.kind) {
      case "empty":
        status = "empty";
        break;
      case "invalid":
        status = "invalid";
        error = parsed.reason;
        break;
      case "address":
        status = "ready";
        break;
      case "ens":
        if (!name || resolution.status === "resolving") status = "resolving";
        else if (resolution.status === "resolved") status = "ready";
        else if (resolution.status === "not_found") {
          status = "not_found";
          error = `${parsed.name} does not point to an Ethereum address`;
        } else {
          status = "error";
          error = resolution.message;
        }
        break;
    }
    if (status === "ready" && !twin.address) {
      status = "error";
      error = twin.error;
    }
    return {
      parsed,
      status,
      name: typedName,
      owner,
      twin,
      error,
      ownerLink: owner ? evmAddress(owner, network) : null,
    };
  }, [parsed, name, typedName, resolution, owner, twin, network]);
}
