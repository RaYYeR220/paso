"use client";

import type { NetworkName } from "@paso/sdk";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createChoiceStore,
  DEMO_PARAM,
  NETWORK_PARAM,
  networkHref,
  NOTHING_REMEMBERED,
  resolveChoice,
  withNetworkParam,
  type ChoiceStore,
  type Remembered,
} from "./network";
import { browserStorage } from "./storage";
import { noSubscription } from "./store";

/** The network a page is on, and the ways to change it. */
export interface NetworkChoice {
  /** The network everything on the page works on. Mainnet only once real funds were confirmed in this browser. */
  network: NetworkName;
  /** True when mainnet was asked for and is waiting to be confirmed. The page is on testnet until it is. */
  confirming: boolean;
  /** False on the server and until the browser has said what it remembers: nothing network-specific is shown before. */
  ready: boolean;
  /** Switches the page. Choosing mainnet for the first time opens the confirmation instead. */
  choose(network: NetworkName): void;
  /** Says yes to working with real funds, once for this browser, and goes to mainnet. */
  confirm(): void;
  /** Says no: back to testnet. */
  decline(): void;
  /** A link to one of the app's own pages that stays on the network in effect. */
  href(path: string): string;
}

let remembered: ChoiceStore | undefined;

function choiceStore(): ChoiceStore {
  remembered ??= createChoiceStore(browserStorage());
  return remembered;
}

const subscribe = (listener: () => void) => choiceStore().subscribe(listener);
const snapshot = (): Remembered => choiceStore().get();
const nothing = (): Remembered => NOTHING_REMEMBERED;
const inBrowser = () => true;
const onServer = () => false;

/**
 * The network choice of the page it is used on, read from the address bar
 * (`?network=mainnet`) and from what the browser remembers. Whatever on the
 * page depends on the network is handed `network` from here: nothing else
 * decides it.
 *
 * It reads the query string, so the component that calls it has to sit
 * under a `Suspense` boundary.
 */
export function useNetworkChoice(): NetworkChoice {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const kept = useSyncExternalStore(subscribe, snapshot, nothing);
  const ready = useSyncExternalStore(noSubscription, inBrowser, onServer);

  const param = params.get(NETWORK_PARAM);
  const demo = params.get(DEMO_PARAM) === "1";
  const search = params.toString();
  const { network, confirming } = resolveChoice({ param, remembered: kept.remembered, acknowledged: kept.acknowledged, demo });

  const go = useCallback(
    (to: NetworkName) => {
      const query = withNetworkParam(search, to);
      router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
    },
    [router, pathname, search],
  );

  // On mainnet the address says so, also when it was the browser that remembered it.
  const unnamed = ready && network === "mainnet" && param !== "mainnet";
  useEffect(() => {
    if (unnamed) go("mainnet");
  }, [unnamed, go]);

  const choose = useCallback(
    (to: NetworkName) => {
      // Mainnet is remembered when it is confirmed, not when it is asked for.
      if (to === "testnet" || choiceStore().get().acknowledged) choiceStore().remember(to);
      go(to);
    },
    [go],
  );
  const confirm = useCallback(() => {
    choiceStore().acknowledge();
    choiceStore().remember("mainnet");
    go("mainnet");
  }, [go]);
  const decline = useCallback(() => {
    choiceStore().remember("testnet");
    go("testnet");
  }, [go]);

  return useMemo(
    () => ({ network, confirming, ready, choose, confirm, decline, href: (path: string) => networkHref(path, network) }),
    [network, confirming, ready, choose, confirm, decline],
  );
}
