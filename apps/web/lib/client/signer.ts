"use client";

import type { AuthorizationTypedData, EvmChainName, NetworkConfig, NetworkName } from "@paso/sdk";
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
import { chainOf } from "./chains";
import { networkConfig } from "./config";
import { DEMO_LABEL, DEMO_TESTNET_ONLY, demoAvailable, ensureDemoKey, forgetDemoKey, loadDemoKey } from "./demoKey";
import { describeError } from "./errors";
import type { EvmClients } from "./funding/controller";
import { isKeyProven, markKeyProven, proveKey } from "./keyProof";
import { browserStorage, removeKey } from "./storage";
import { createStore } from "./store";
import { isDiscovered, pickConnector, walletOptions, type WalletOption } from "./wallets";

export type { WalletOption } from "./wallets";

export type SignerKind = "wallet" | "demo";
export type SignerStatus = "disconnected" | "connecting" | "connected";

/**
 * Whatever signs for the account: a connected wallet, or the demo key. Fits
 * the SDK's `sign`. A signer belongs to a network: the demo key exists on
 * testnet only, and a wallet brings USDC from that network's EVM chains.
 */
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
  /** The chain the wallet is on. Signing for Stellar works on any chain. */
  chainId: number | null;
  /** The wallet on one EVM chain of the network, switched there if need be, with a reader for it: what a burn or a mint needs. */
  evmClients(chain: EvmChainName): Promise<EvmClients>;
  /**
   * True once this browser has seen the wallet sign with its own key on this
   * network. Until then it is offered no way to bring USDC over: an address
   * without a key has an account that can receive and never spend.
   */
  keyProven: boolean;
  /**
   * Asks the wallet to sign the key check, a message that moves nothing, and
   * verifies the signature is the address's own. Rejects with the wallet's
   * refusal, or with why the wallet cannot sign for an account.
   */
  proveKey(): Promise<void>;
}

export interface DemoSigner extends Signer {
  kind: "demo";
  /** False on any network but testnet: there the throwaway key cannot be used, and `connect` only says so. */
  available: boolean;
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
  /** Which kind the visitor last chose, on each network. */
  chosen: Record<NetworkName, SignerKind | null>;
  /** The throwaway key of this browser. It is testnet's and is never looked at for any other network. */
  demoKey: Hex | null;
  /** The connector being opened, while the wallet has not answered yet. */
  connectingId: string | null;
  error: string | null;
}

/** Where the kind of signer last chosen on a network is kept. */
export function chosenSignerKey(network: NetworkName): string {
  return `paso.signer.${network}`;
}

const SERVER_STATE: LocalState = {
  chosen: { testnet: null, mainnet: null },
  demoKey: null,
  connectingId: null,
  error: null,
};

/** The kind remembered for a network. The demo key is no choice at all where it does not exist. */
function storedChoice(network: NetworkName): SignerKind | null {
  let chosen: string | null = null;
  try {
    chosen = browserStorage()?.getItem(chosenSignerKey(network)) ?? null;
  } catch {
    chosen = null;
  }
  if (chosen === "wallet") return "wallet";
  return chosen === "demo" && demoAvailable(network) ? "demo" : null;
}

function initialState(): LocalState {
  return {
    ...SERVER_STATE,
    chosen: { testnet: storedChoice("testnet"), mainnet: storedChoice("mainnet") },
    demoKey: loadDemoKey("testnet", browserStorage()),
  };
}

const local = createStore<LocalState>(typeof window === "undefined" ? SERVER_STATE : initialState());

function update(change: Partial<LocalState>): void {
  local.set({ ...local.get(), ...change });
}

function choose(network: NetworkName, kind: SignerKind | null): void {
  const storage = browserStorage();
  try {
    if (kind) storage?.setItem(chosenSignerKey(network), kind);
    else removeKey(storage, chosenSignerKey(network));
  } catch {
    // The choice then lasts until the page is closed.
  }
  update({ chosen: { ...local.get().chosen, [network]: kind } });
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
 * Connects a wallet, as the signer for `network`. While the wallet has not
 * answered, `connectingId` names it; a second call in that time is ignored.
 * Declining in the wallet leaves no error behind.
 */
export async function connectWallet(config: Config, network: NetworkName, connectorId?: string): Promise<void> {
  if (local.get().connectingId !== null) return;
  if (getAccount(config).status === "connected") {
    choose(network, "wallet");
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
    choose(network, "wallet");
  } catch (error) {
    const problem = describeError(error);
    if (problem.kind === "error" && /already connected/i.test(problem.detail ?? problem.message)) {
      choose(network, "wallet");
    } else if (problem.kind === "error") {
      update({ error: problem.message });
    }
  } finally {
    update({ connectingId: null });
  }
}

const NO_KEYS: ReadonlySet<string> = new Set();
/** The wallets seen to sign with their own key since the page was opened, as `network:address`. */
const provenKeys = createStore<ReadonlySet<string>>(NO_KEYS);
const provenKey = (network: NetworkName, wallet: Address): string => `${network}:${wallet.toLowerCase()}`;

/** Whether this browser has seen `wallet` sign with its own key on `network`: just now, or before a reload. */
export function keyProven(network: NetworkName, wallet: Address, seen: ReadonlySet<string> = provenKeys.get()): boolean {
  return seen.has(provenKey(network, wallet)) || isKeyProven(browserStorage(), network, wallet);
}

/** Records that `wallet` signed with its own key on `network`: the key check, or a call it signed for its account. */
export function rememberKeyProven(network: NetworkName, wallet: Address): void {
  const key = provenKey(network, wallet);
  if (provenKeys.get().has(key)) return;
  markKeyProven(browserStorage(), network, wallet);
  provenKeys.set(new Set([...provenKeys.get(), key]));
}

/** The signer's own state, for watching a connection from outside React. */
export const signerState = { get: local.get, subscribe: local.subscribe };

/**
 * What the demo key amounts to on a network, given what the browser holds.
 * On testnet: the key, and whether it is the signer in use. On any other
 * network: nothing, whatever is stored, so the throwaway key can never sign
 * where the funds are real.
 */
export function demoState(
  network: NetworkName,
  state: Pick<LocalState, "chosen" | "demoKey">,
): { available: boolean; key: Hex | null; chosen: boolean } {
  const available = demoAvailable(network);
  const key = available ? state.demoKey : null;
  return { available, key, chosen: available && state.chosen[network] === "demo" && key !== null };
}

/**
 * Starts the no-wallet demo: finds or makes the throwaway key and makes it
 * the signer. On a network without a demo it does neither, and leaves the
 * reason where the chooser shows it. Returns whether the demo started.
 */
export function startDemo(network: NetworkName, renew = false): boolean {
  if (!demoAvailable(network)) {
    update({ error: DEMO_TESTNET_ONLY });
    return false;
  }
  const storage = browserStorage();
  if (renew) forgetDemoKey(storage);
  const key = renew ? ensureDemoKey(network, storage) : (local.get().demoKey ?? ensureDemoKey(network, storage));
  update({ demoKey: key, error: null });
  choose(network, "demo");
  return true;
}

/**
 * The connected wallet on one EVM chain of a network, with a reader for that
 * chain. The wallet is asked to switch when it is somewhere else; one that
 * does not know the chain is offered it first. Nothing is sent from here.
 */
export async function evmClients(config: Config, network: NetworkConfig, name: EvmChainName): Promise<EvmClients> {
  const { chain, label } = chainOf(network, name);
  const chainId = chain.id;
  if (getAccount(config).chainId !== chainId) {
    await switchChain(config, { chainId });
  }
  const walletClient = await getWalletClient(config, { chainId });
  const publicClient = getPublicClient(config, { chainId });
  if (!publicClient) throw new Error(`${label} is not configured`);
  return { walletClient, publicClient };
}

const notConnected = (): Promise<never> => Promise.reject(new Error("Connect a wallet first"));

/**
 * The signer in use on `network`: the connected wallet, or on testnet the
 * demo key when the visitor chose to try without a wallet. Both kinds share
 * one interface, so the rest of the app never asks which one it is holding.
 *
 * On mainnet there is only the wallet. The throwaway key is not offered, not
 * restored and cannot be connected there, whatever the browser remembers.
 *
 * On the server, and in the browser's first render, nothing is connected:
 * what the browser remembers shows up right after hydration.
 */
export function useSigner(name: NetworkName): ActiveSigner {
  const network = networkConfig(name);
  const config = useConfig();
  const store = walletStore(config);
  const account = useSyncExternalStore(store.subscribe, store.getSnapshot, noWallet);
  const options = useSyncExternalStore(store.subscribeOptions, store.options, store.configuredOptions);
  const state = useSyncExternalStore(local.subscribe, local.get, () => SERVER_STATE);
  const seenKeys = useSyncExternalStore(provenKeys.subscribe, provenKeys.get, () => NO_KEYS);

  const walletAddress = account.address;
  const connectingId = state.connectingId;
  const walletStatus: SignerStatus = walletAddress
    ? "connected"
    : connectingId !== null || account.restoring
      ? "connecting"
      : "disconnected";
  const { walletName, chainId } = account;
  const networkName = network.name;

  const wallet = useMemo<WalletSigner>(
    () => ({
      kind: "wallet",
      address: walletAddress,
      status: walletStatus,
      options,
      connectingId,
      walletName,
      chainId,
      signTypedData: (typedData) =>
        walletAddress ? signTypedData(config, { ...typedData, account: walletAddress }) : notConnected(),
      connect: (connectorId?: string) => connectWallet(config, networkName, connectorId),
      async disconnect() {
        await disconnect(config);
        if (local.get().chosen[networkName] === "wallet") choose(networkName, null);
      },
      evmClients: (chain: EvmChainName) => evmClients(config, network, chain),
      keyProven: walletAddress !== null && keyProven(networkName, walletAddress, seenKeys),
      async proveKey() {
        if (!walletAddress) return notConnected();
        await proveKey(walletAddress, (data) => signTypedData(config, { ...data, account: walletAddress }));
        rememberKeyProven(networkName, walletAddress);
      },
    }),
    [config, network, networkName, options, connectingId, walletAddress, walletStatus, walletName, chainId, seenKeys],
  );
  const { available, key: demoKey, chosen: demoChosen } = demoState(networkName, state);
  const demo = useMemo<DemoSigner>(() => {
    const signingAccount = demoKey ? demoAccount(demoKey) : null;
    return {
      kind: "demo",
      label: DEMO_LABEL,
      available,
      address: demoChosen && signingAccount ? signingAccount.address : null,
      status: demoChosen ? "connected" : "disconnected",
      signTypedData: (typedData) => (demoChosen && signingAccount ? signingAccount.signTypedData(typedData) : notConnected()),
      async connect() {
        startDemo(networkName);
      },
      async disconnect() {
        // The key stays in the browser, so the same account is there next time.
        if (local.get().chosen[networkName] === "demo") choose(networkName, null);
      },
      async renew() {
        startDemo(networkName, true);
      },
    };
  }, [available, networkName, demoKey, demoChosen]);

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
