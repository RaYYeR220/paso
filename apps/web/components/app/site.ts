import type { NetworkName } from "@paso/sdk";

/** The pages of the app that every top bar links to. */
export const SITE_LINKS = [
  { href: "/app", label: "Account" },
  { href: "/lookup", label: "Look up an address" },
  { href: "/proof", label: "Proof" },
] as const;

/**
 * A refusal recorded on each network: a call signed for one amount and
 * submitted with another, which the account contract turned down on chain.
 */
export const REFUSAL_ON_CHAIN: Record<NetworkName, string> = {
  testnet: "https://stellar.expert/explorer/testnet/tx/ded23530dfc8d114a1350522e45b257170ed775738b0e85887f0e6667d52b181",
  mainnet: "https://stellar.expert/explorer/public/tx/eb94539839cba10012c01cea9453410d740d89194c2e99c4b33958aec144b6a3",
};

/** Where the repository says how to do, with its scripts, everything the hosted relayer does. */
export const SCRIPTS_URL = "https://github.com/RaYYeR220/paso#scripts";

/** What the persistent strip says while a page is on mainnet. */
export const MAINNET_CAUTION = "Mainnet. Real USDC. This software has not been audited — use small amounts.";

/**
 * The command that delivers a burn from a checkout of the repository. It
 * needs any funded Stellar account to pay the fee (`PASO_SOURCE_SECRET`),
 * and no key of the account's owner.
 */
export function deliverCommand(burnTxHash: string, network: NetworkName): string {
  return `pnpm deliver ${burnTxHash} --network ${network}`;
}
