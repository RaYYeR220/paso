import { existsSync } from "node:fs";

// Secrets for the tests that reach testnet live in the same file the app reads.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}
