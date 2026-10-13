import { listEvmChains } from "paso-sdk";
import type { Chain } from "viem";
import { createConfig, fallback, http, type Transport } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";

/** Every EVM chain Paso lists, testnets first, each with the public endpoints the SDK checked, in order. */
const listed = [...listEvmChains("testnet"), ...listEvmChains("mainnet")];
const chains = listed.map((entry) => entry.chain) as [Chain, ...Chain[]];
const transports: Record<number, Transport> = Object.fromEntries(
  listed.map((entry) => [entry.chain.id, fallback(entry.rpcUrls.map((url) => http(url)))]),
);

/**
 * Wallets the app connects to: whatever the browser has injected (MetaMask,
 * Rabby, …) and Coinbase Wallet. Coinbase is asked for its regular wallet
 * only: a Paso account checks a plain 65-byte signature, which a
 * smart-contract wallet cannot produce.
 */
export const wagmiConfig = createConfig({
  chains,
  connectors: [injected(), coinbaseWallet({ appName: "Paso", preference: "eoaOnly" })],
  transports,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
