"use client";

import type { AuthorizationTypedData } from "@paso/sdk";
import { useMemo, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { useConfig, type Config } from "wagmi";
import {
  connect,
  disconnect,
  getAccount,
  getConnectors,
  getPublicClient,
  getWalletClient,
  signTypedData,
  switchChain,
  watchAccount,
  watchConnectors,
} from "wagmi/actions";
import type { AppChainId } from "../wagmi";
import { NETWORK } from "./config";
import { DEMO_LABEL, ensureDemoKey, forgetDemoKey, loadDemoKey } from "./demoKey";
import { describeError } from "./errors";
import type { EvmClients } from "./funding/controller";
import { browserStorage, removeKey } from "./storage";
import { createStore } from "./store";
import { isDiscovered, pickConnector, walletOptions, type WalletOption } from "./wallets";

export type { WalletOption } from "./wallets";

export type SignerKind = "wallet" | "demo";
export type SignerStatus = "disconnected" | "connecting" | "connected";

/** Whatever signs for the account: a connected wallet, or the demo key. Fits the SDK's `sign`. */
export interface Signer {
  kind: SignerKind;
  /** The Ethereum address that owns the account, once connected. */
  address: Address | null;
  status: SignerStatus;
  signTypedData(typedData: AuthorizationTypedData): Promise<Hex>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface WalletSigner extends Signer {
  kind: "wallet";
  /** Connects the named wallet, or the first one the browser offers. */
  connect(connectorId?: string): Promise<void>;
  /** The wallets found in this browser, plus Coinbase Wallet: `{ id, name, ready }[]`. */
  options: WalletOption[];
  /** The id of the wallet being opened while a connection is pending; `null` otherwise. */
  connectingId: string | null;
  /** Name of the connected wallet. */
  walletName: string | null;
  chainId: number | null;
  /** True when the wallet is on the Base network USDC is brought from. Signing for Stellar works on any network. */
  onBase: boolean;
  /** The wallet on Base, switched there if need be, with a reader for Base: what a burn needs. */
  evmClients(): Promise<EvmClients>;
}

export interface DemoSigner extends Signer {
  kind: "demo";
  /** Says what this key is, for display wherever its address is shown. */
  label: string;
  /** Throws the key away and makes a new one: a fresh account with nothing in it. */
  renew(): Promise<void>;
}

/** The signer in use, with both kinds within reach to connect either. */
export interface ActiveSigner extends Signer {
  /** Connects the wallet with this connector id. Without an id, connects the kind in use. */
  connect(connectorId?: string): Promise<void>;
  /** The wallets that can be connected: `{ id, name, ready }[]`. The same list as `wallet.options`. */
  connectors: WalletOption[];
  /** The id of the wallet being opened while a connection is pending; `null` otherwise. */
  connectingId: string | null;
  isDemo: boolean;
  wallet: WalletSigner;
  demo: DemoSigner;
  /** Why the last attempt to connect failed. Declining in the wallet is not a failure and leaves this `null`. */
  error: string | null;
  clearError(): void;
}

interface LocalState {
  /** Which kind the visitor last chose. */
  chosen: SignerKind | null;
  demoKey: Hex | null;
  /** The connector being opened, while the wallet has not answered yet. */
  connectingId: string | null;
  error: string | null;
}

const CHOSEN_STORAGE = "paso.signer";
const SERVER_STATE: LocalState = { chosen: null, demoKey: null, connectingId: null, error: null };

function initialState(): LocalState {
  const storage = browserStorage();
  let chosen: string | null = null;
  try {
    chosen = storage?.getItem(CHOSEN_STORAGE) ?? null;
  } catch {
    chosen = null;
  }
  return {
    ...SERVER_STATE,
    chosen: chosen === "demo" || chosen === "wallet" ? chosen : null,
    demoKey: loadDemoKey(storage),
  };
}

const local = createStore<LocalState>(typeof window === "undefined" ? SERVER_STATE : initialState());

function update(change: Partial<LocalState>): void {
  local.set({ ...local.get(), ...change });
}

function choose(kind: SignerKind | null): void {
  const storage = browserStorage();
  try {
    if (kind) storage?.setItem(CHOSEN_STORAGE, kind);
    else removeKey(storage, CHOSEN_STORAGE);
  } catch {
    // The choice then lasts until the page is closed.
  }
  update({ chosen: kind });
}

const demoAccounts = new Map<Hex, PrivateKeyAccount>();

function demoAccount(key: Hex): PrivateKeyAccount {
  let account = demoAccounts.get(key);
  if (!account) {
    account = privateKeyToAccount(key);
    demoAccounts.set(key, account);
  }
  return account;
}

const baseChainId = NETWORK.evm.chain.id as AppChainId;

/** What the app needs to know about the wallet connection. */
interface WalletSnapshot {
  address: Address | null;
  /** True while a wallet that was connected before is being brought back after a reload. */
  restoring: boolean;
  chainId: number | null;
  walletName: string | null;
}

/**
 * What the server renders, and what the browser must render first to match
 * it: no wallet. The real state follows straight after hydration.
 */
const NO_WALLET: WalletSnapshot = { address: null, restoring: false, chainId: null, walletName: null };
const noWallet = (): WalletSnapshot => NO_WALLET;

interface WalletStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WalletSnapshot;
  options(): WalletOption[];
  configuredOptions(): WalletOption[];
  subscribeOptions(listener: () => void): () => void;
}

type Connectors = ReturnType<typeof getConnectors>;

/** Whether the browser has a wallet at `window.ethereum`. */
function injectedProviderPresent(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
}

const walletStores = new WeakMap<Config, WalletStore>();

/**
 * The wallet connection as snapshots that stay the same object until
 * something changes, which is what React needs to watch them.
 */
function walletStore(config: Config): WalletStore {
  let store = walletStores.get(config);
  if (store) return store;

  let snapshot = NO_WALLET;
  let listed: { from: Connectors; all: WalletOption[]; configured: WalletOption[] } | null = null;

  const list = () => {
    const connectors = getConnectors(config);
    if (listed?.from !== connectors) {
      listed = {
        from: connectors,
        all: walletOptions(connectors, injectedProviderPresent()),
        // What the server lists: the configured wallets, none of them asked about yet.
        configured: walletOptions(
          connectors.filter((connector) => !isDiscovered(connector)),
          false,
        ),
      };
    }
    return listed;
  };

  store = {
    subscribe: (listener) => watchAccount(config, { onChange: () => listener() }),
    getSnapshot() {
      const account = getAccount(config);
      const connected = account.status === "connected";
      const next: WalletSnapshot = {
        address: connected ? (account.address ?? null) : null,
        restoring: account.status === "reconnecting",
        chainId: connected ? (account.chainId ?? null) : null,
        walletName: connected ? (account.connector?.name ?? null) : null,
      };
      const unchanged =
        next.address === snapshot.address &&
        next.restoring === snapshot.restoring &&
        next.chainId === snapshot.chainId &&
        next.walletName === snapshot.walletName;
      if (!unchanged) snapshot = next;
      return snapshot;
    },
    subscribeOptions: (listener) => watchConnectors(config, { onChange: () => listener() }),
    options: () => list().all,
    // Wallets announce themselves only in the browser: the server lists the configured ones.
    configuredOptions: () => list().configured,
  };
  walletStores.set(config, store);
  return store;
}

/**
 * Connects a wallet. While the wallet has not answered, `connectingId` names
 * it; a second call in that time is ignored. Declining in the wallet leaves
 * no error behind.
 */
export async function connectWallet(config: Config, connectorId?: string): Promise<void> {
  if (local.get().connectingId !== null) return;
  if (getAccount(config).status === "connected") {
    choose("wallet");
    return;
  }
  const connector = pickConnector(getConnectors(config), connectorId);
  if (!connector) {
    update({ error: "No wallet is available in this browser. Install one, or try without a wallet." });
    return;
  }
  update({ connectingId: connector.id, error: null });
  try {
    await connect(config, { connector });
    choose("wallet");
  } catch (error) {
    const problem = describeError(error);
    if (problem.kind === "error" && /already connected/i.test(problem.detail ?? problem.message)) {
      choose("wallet");
    } else if (problem.kind === "error") {
      update({ error: problem.message });
    }
  } finally {
    update({ connectingId: null });
  }
}

/** The signer's own state, for watching a connection from outside React. */
export const signerState = { get: local.get, subscribe: local.subscribe };

async function evmClients(config: Config): Promise<EvmClients> {
  if (getAccount(config).chainId !== baseChainId) {
    await switchChain(config, { chainId: baseChainId });
  }
  const walletClient = await getWalletClient(config, { chainId: baseChainId });
  const publicClient = getPublicClient(config, { chainId: baseChainId });
  if (!publicClient) throw new Error(`${NETWORK.evm.chain.name} is not configured`);
  return { walletClient, publicClient };
}

const notConnected = (): Promise<never> => Promise.reject(new Error("Connect a wallet first"));

/**
 * The signer in use: the connected wallet, or the demo key when the visitor
 * chose to try without a wallet. Both kinds share one interface, so the rest
 * of the app never asks which one it is holding.
 *
 * On the server, and in the browser's first render, nothing is connected:
 * what the browser remembers shows up right after hydration.
 */
export function useSigner(): ActiveSigner {
  const config = useConfig();
  const store = walletStore(config);
  const account = useSyncExternalStore(store.subscribe, store.getSnapshot, noWallet);
  const options = useSyncExternalStore(store.subscribeOptions, store.options, store.configuredOptions);
  const state = useSyncExternalStore(local.subscribe, local.get, () => SERVER_STATE);

  const walletAddress = account.address;
  const connectingId = state.connectingId;
  const walletStatus: SignerStatus = walletAddress
    ? "connected"
    : connectingId !== null || account.restoring
      ? "connecting"
      : "disconnected";
  const { walletName, chainId } = account;

  const wallet = useMemo<WalletSigner>(
    () => ({
      kind: "wallet",
      address: walletAddress,
      status: walletStatus,
      options,
      connectingId,
      walletName,
      chainId,
      onBase: chainId === baseChainId,
      signTypedData: (typedData) =>
        walletAddress ? signTypedData(config, { ...typedData, account: walletAddress }) : notConnected(),
      connect: (connectorId?: string) => connectWallet(config, connectorId),
      async disconnect() {
        await disconnect(config);
        if (local.get().chosen === "wallet") choose(null);
      },
      evmClients: () => evmClients(config),
    }),
    [config, options, connectingId, walletAddress, walletStatus, walletName, chainId],
  );
  const demoKey = state.demoKey;
  const demoChosen = state.chosen === "demo" && demoKey !== null;
  const demo = useMemo<DemoSigner>(() => {
    const signingAccount = demoKey ? demoAccount(demoKey) : null;
    return {
      kind: "demo",
      label: DEMO_LABEL,
      address: demoChosen && signingAccount ? signingAccount.address : null,
      status: demoChosen ? "connected" : "disconnected",
      signTypedData: (typedData) => (signingAccount ? signingAccount.signTypedData(typedData) : notConnected()),
      async connect() {
        const key = ensureDemoKey(browserStorage());
        update({ demoKey: key, error: null });
        choose("demo");
      },
      async disconnect() {
        // The key stays in the browser, so the same account is there next time.
        if (local.get().chosen === "demo") choose(null);
      },
      async renew() {
        const storage = browserStorage();
        forgetDemoKey(storage);
        update({ demoKey: ensureDemoKey(storage) });
        choose("demo");
      },
    };
  }, [demoKey, demoChosen]);

  const error = state.error;
  return useMemo<ActiveSigner>(() => {
    const active: Signer = demoChosen ? demo : wallet;
    return {
      kind: active.kind,
      address: active.address,
      status: active.status,
      signTypedData: active.signTypedData,
      connect: (connectorId?: string) => (connectorId === undefined ? active.connect() : wallet.connect(connectorId)),
      disconnect: () => active.disconnect(),
      connectors: wallet.options,
      connectingId: wallet.connectingId,
      isDemo: demoChosen,
      wallet,
      demo,
      error,
      clearError: () => update({ error: null }),
    };
  }, [demoChosen, demo, wallet, error]);
}
