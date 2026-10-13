import { defineConfig } from "@playwright/test";

/**
 * The synthetic-wallet journey: the app's real wallet path, driven without a
 * browser extension.
 *
 *   pnpm --filter @paso/web e2e
 *
 * Settings, all from the environment:
 *
 *   PASO_E2E_BASE_URL   where the app runs. Default http://localhost:3000.
 *   PASO_E2E_NETWORK    testnet (default) or mainnet. Mainnet moves real funds.
 *   PASO_E2E_OWNER_KEY  the wallet's private key (0x…). It owns the account and pays on Base.
 *   PASO_E2E_KEY_FROM   instead of the above: the name of the variable that holds the key.
 *   PASO_E2E_BRING      USDC brought from Base. Default 0.5.
 *   PASO_E2E_SEND       USDC sent on to another address's account. Default 0.1.
 *   PASO_E2E_BACK       USDC sent back to Base. Default 0.2.
 *   PASO_E2E_RECIPIENT  the Ethereum address whose account is paid. Default: an address derived from the wallet's key.
 *   PASO_E2E_SHOTS      a directory to leave a screenshot of each stage in. Default: none are taken.
 *   BASE_RPC_URL        RPC endpoint the wallet uses for Base. Default: the chain's public endpoint.
 *
 * On testnet, `apps/web/.env.local` is read as well when it exists. On
 * mainnet nothing is read from that file.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "./.results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.PASO_E2E_BASE_URL?.replace(/\/+$/, "") || "http://localhost:3000",
    browserName: "chromium",
    viewport: { width: 1440, height: 960 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: "only-on-failure",
    trace: "off",
  },
});
