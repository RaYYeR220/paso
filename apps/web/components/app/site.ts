import { NETWORK_NAME } from "@/lib/client/config";

/** The network as the top bar names it. */
export const NETWORK_LABEL = NETWORK_NAME === "mainnet" ? "Mainnet" : "Testnet";

/** The pages of the app that every top bar links to. */
export const SITE_LINKS = [
  { href: "/app", label: "Account" },
  { href: "/lookup", label: "Look up an address" },
  { href: "/proof", label: "Proof" },
] as const;

/** A refusal recorded on Stellar mainnet: signed for one amount, submitted with another. */
export const REFUSAL_ON_CHAIN =
  "https://stellar.expert/explorer/public/tx/eb94539839cba10012c01cea9453410d740d89194c2e99c4b33958aec144b6a3";
