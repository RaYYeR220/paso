import { NETWORK_NAME } from "@/lib/client/config";

/** The network as the top bar names it. */
export const NETWORK_LABEL = NETWORK_NAME === "mainnet" ? "Mainnet" : "Testnet";

/** The pages of the app that every top bar links to. */
export const SITE_LINKS = [
  { href: "/app", label: "Account" },
  { href: "/lookup", label: "Look up an address" },
  { href: "/proof", label: "Proof" },
] as const;

/** A refusal recorded on Stellar testnet: signed for one amount, submitted with another. */
export const REFUSAL_ON_CHAIN =
  "https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181";
