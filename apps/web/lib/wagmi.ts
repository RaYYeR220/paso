import { createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected } from "wagmi/connectors";

/**
 * Wallets the app connects to: whatever the browser has injected (MetaMask,
 * Rabby, …) and Coinbase Wallet. Coinbase is asked for its regular wallet
 * only: a Paso account checks a plain 65-byte signature, which a
 * smart-contract wallet cannot produce.
 */
export const wagmiConfig = createConfig({
  chains: [baseSepolia, base],
  connectors: [injected(), coinbaseWallet({ appName: "Paso", preference: "eoaOnly" })],
  transports: {
    [baseSepolia.id]: http(),
    [base.id]: http(),
  },
  ssr: true,
});

export type AppChainId = (typeof wagmiConfig)["chains"][number]["id"];

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
