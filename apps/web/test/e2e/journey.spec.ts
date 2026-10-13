import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatEvmAmount, NETWORKS, parseEvmAmount, twinAddress, type NetworkName } from "@paso/sdk";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { concat, getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SyntheticWallet } from "./wallet";

/**
 * One journey through the app with a wallet that is not an extension:
 * connect, bring USDC from Base, send some on to another address's account,
 * send some back to Base, and on testnet watch a changed call be refused.
 *
 * Every step goes through the page, and every signature and transaction
 * through the provider the page finds at `window.ethereum`. On mainnet the
 * amounts are real: see `playwright.config.ts` for what sets them.
 */

const network = (process.env.PASO_E2E_NETWORK?.trim() || "testnet") as NetworkName;
if (network !== "testnet" && network !== "mainnet") throw new Error(`PASO_E2E_NETWORK must be testnet or mainnet`);

// The file holds the testnet keys of the web app. A mainnet run takes nothing from it.
const envFile = resolve(import.meta.dirname, "../../.env.local");
if (network === "testnet" && existsSync(envFile)) process.loadEnvFile(envFile);

function walletKey(): Hex {
  const from = process.env.PASO_E2E_KEY_FROM?.trim() || "PASO_E2E_OWNER_KEY";
  const key = process.env[from]?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${from} must hold the wallet's private key: 0x and 64 hex digits`);
  }
  return key as Hex;
}

const config = NETWORKS[network];
const base = config.evm.chain.name;
const amounts = {
  bring: process.env.PASO_E2E_BRING?.trim() || "0.5",
  send: process.env.PASO_E2E_SEND?.trim() || "0.1",
  back: process.env.PASO_E2E_BACK?.trim() || "0.2",
};

/** An address the wallet's holder can always get at: its key is derived from the wallet's own. */
function recipientOf(key: Hex): Address {
  const named = process.env.PASO_E2E_RECIPIENT?.trim();
  if (named) {
    if (!isAddress(named, { strict: false })) throw new Error("PASO_E2E_RECIPIENT must be an Ethereum address");
    return getAddress(named);
  }
  return privateKeyToAccount(keccak256(concat([key, stringToHex("paso e2e recipient")]))).address;
}

const hashIn = (href: string | null): string => href?.split("/").pop() ?? "";

/** With `PASO_E2E_SHOTS` set to a directory, the journey leaves a picture of each stage there. */
async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.PASO_E2E_SHOTS?.trim();
  if (directory) await page.screenshot({ path: resolve(directory, `${name}.png`) });
}

async function leg(scope: Locator, index: number): Promise<Locator> {
  return scope.locator(".legs li").nth(index);
}

/** Answers whatever stands between a review and the wallet: every confirmation the review asks for. */
async function sign(page: Page): Promise<void> {
  const review = page.locator('.verdict[data-state="review"]');
  await expect(review).toBeVisible({ timeout: 60_000 });
  for (const box of await review.locator('input[type="checkbox"]').all()) await box.check();
  await review.getByRole("button", { name: "Sign in wallet" }).click();
}

async function prepareSend(page: Page, to: string, amount: string): Promise<void> {
  const form = page.locator(".send");
  await form.locator("textarea").fill(to);
  await form.locator('.field input[type="text"]').fill(amount);
  await form.getByRole("button", { name: "Review and sign" }).click();
}

test(`${network}: connect, bring ${amounts.bring} USDC from ${base}, send ${amounts.send}, send ${amounts.back} back`, async ({ page }) => {
  const key = walletKey();
  const account = privateKeyToAccount(key);
  const recipient = recipientOf(key);
  const wallet = new SyntheticWallet({
    account,
    network: config,
    rpcUrl: process.env.BASE_RPC_URL?.trim() || undefined,
    spendLimit: parseEvmAmount(amounts.bring),
  });
  await wallet.install(page);

  const log = (label: string, value: string) => console.log(`    ${label.padEnd(12)} ${value}`);
  console.log(`\nPaso on ${network}, through the app at ${test.info().project.use.baseURL}`);
  log("wallet", account.address);
  log("account", twinAddress(account.address, config));
  log("recipient", `${recipient} (account ${twinAddress(recipient, config)})`);

  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  test.info().annotations.push({ type: "wallet", description: account.address });
  const report = () => {
    for (const refusal of wallet.refused) log("wallet said", refusal);
  };

  await test.step(`the hosted relayer is serving ${network}`, async () => {
    const health = (await (await page.request.get("/api/health")).json()) as {
      networks?: Record<string, { enabled: boolean; paysFees?: boolean; relayer?: { address: string; xlm: string | null } }>;
    };
    const report = health.networks?.[network];
    expect(report?.enabled, `the server at this address is not serving ${network}`).toBe(true);
    expect(report?.paysFees, `the ${network} relayer is not paying fees right now: its day is spent or its account is at its floor`).toBe(true);
    log("relayer", `${report?.relayer?.address} holds ${report?.relayer?.xlm} XLM`);
  });

  await test.step("open the app on the network and connect the wallet", async () => {
    await page.goto(`/app${network === "mainnet" ? "?network=mainnet" : ""}`);
    if (network === "mainnet") {
      await shot(page, "confirm-mainnet");
      await page.getByRole("button", { name: "Use mainnet" }).click();
      await expect(page.locator(".mainnet-strip")).toContainText("Mainnet. Real USDC. This software has not been audited");
      await expect(page.getByRole("button", { name: /without a wallet/i })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Browser wallet" }).click();
    await expect(page.locator(".who")).toContainText(account.address.slice(0, 6), { timeout: 30_000 });
    await expect(page.locator(".pair .addr").first()).toHaveText(account.address);
    await expect(page.locator(".pair .addr").nth(1)).toHaveText(twinAddress(account.address, config));
    await shot(page, "connected");
  });

  await test.step("show that the wallet signs with its own key", async () => {
    const check = page.getByRole("button", { name: "Check this wallet" });
    const amount = page.locator(".fund input");
    await expect(check.or(amount)).toBeVisible();
    if (await check.isVisible()) {
      await check.click();
      await expect(amount).toBeVisible({ timeout: 30_000 });
      expect(wallet.signedTypedData).toContain("KeyCheck");
    }
  });

  const balance = page.locator(".bal .num");
  /** USDC in the account as the page shows it, once it has been read from Stellar. */
  const held = async (): Promise<number> => Number.parseFloat(((await balance.textContent()) ?? "").replace(/,/g, ""));
  await expect.poll(held, { timeout: 60_000 }).not.toBeNaN();
  const before = await held();
  log("balance", `${before} USDC before`);

  await test.step(`bring ${amounts.bring} USDC from ${base}`, async () => {
    const fund = page.locator(".fund");
    await fund.locator("input").fill(amounts.bring);
    await fund.getByRole("button", { name: "Bring over" }).click();

    await expect(await leg(fund, 0))
      .toHaveAttribute("data-status", "done", { timeout: 180_000 })
      .catch((error: unknown) => {
        report();
        throw error;
      });
    expect(wallet.switches).toContain(config.evm.chain.id);
    const burn = wallet.sent.find((tx) => tx.kind === "burn");
    expect(burn, "the wallet sent the burn").toBeDefined();
    for (const tx of wallet.sent) log(tx.kind, `${tx.hash}  ${config.evm.chain.blockExplorers?.default.url}/tx/${tx.hash}`);

    await expect(await leg(fund, 2)).toHaveAttribute("data-status", "done", { timeout: 600_000 });
    const delivered = await (await leg(fund, 2)).locator("a").getAttribute("href");
    log("delivered", `${hashIn(delivered)}  ${delivered ?? "delivered by someone else"}`);
    // Circle keeps a fee of about a basis point; nearly all of it arrives.
    await expect.poll(held, { timeout: 90_000 }).toBeGreaterThan(before + Number(amounts.bring) * 0.99);
    log("balance", `${await held()} USDC after the delivery`);
  });

  await test.step(`send ${amounts.send} USDC to the account of another address`, async () => {
    await prepareSend(page, recipient, amounts.send);
    await sign(page);
    const match = page.locator('.verdict[data-state="match"]');
    await expect(match).toBeVisible({ timeout: 180_000 });
    await expect(match).toContainText("Match");
    const transfer = await match.getByRole("link", { name: /View the transaction/ }).getAttribute("href");
    log("transfer", `${hashIn(transfer)}  ${transfer}`);
    await match.getByRole("button", { name: "New send" }).click();
  });

  await test.step(`send ${amounts.back} USDC back to ${base}`, async () => {
    await page.getByRole("radio", { name: "back to Base" }).check();
    await prepareSend(page, account.address, amounts.back);
    await sign(page);
    await expect(page.locator('.verdict[data-state="match"]')).toBeVisible({ timeout: 180_000 });

    const exit = page.locator(".exit");
    await expect(exit).toBeVisible();
    const burned = await (await leg(exit, 0)).locator("a").getAttribute("href");
    log("exit", `${hashIn(burned)}  ${burned}`);

    const minted = await leg(exit, 2);
    const mine = exit.getByRole("button", { name: "Confirm the mint in your wallet" });
    await expect(mine.or(minted.and(exit.locator('[data-status="done"]')))).toBeVisible({ timeout: 600_000 });
    if (await mine.isVisible()) {
      log("mint", "attested; the wallet submits it");
      await shot(page, "wallet-mint-step");
      await mine.click();
    } else {
      log("mint", "submitted by the server");
    }
    await expect(minted).toHaveAttribute("data-status", "done", { timeout: 300_000 });
    const mint = await minted.locator("a").getAttribute("href").catch(() => null);
    log("minted", mint ? `${hashIn(mint)}  ${mint}` : "the message had been received already");
    await shot(page, "minted");
    await page.locator('.verdict[data-state="match"]').getByRole("button", { name: "New send" }).click();
  });

  if (network === "testnet") {
    await test.step("a call changed after signing is refused", async () => {
      await page.locator(".tamper .switch-track").click();
      await expect(page.getByRole("switch", { name: "Change the amount after signing" })).toBeChecked();
      await page.getByRole("radio", { name: "another Stellar account" }).check();
      await prepareSend(page, recipient, "0.01");
      await sign(page);
      const refused = page.locator('.verdict[data-state="refused"]');
      await expect(refused).toBeVisible({ timeout: 180_000 });
      await expect(refused).toContainText("BadSignature");
      await expect(page.locator('.line[data-role="cause"]').first()).toBeVisible();
      await shot(page, "refused");
      log("refused", "the relayer's simulation refused it: no transaction");
    });
  } else {
    await expect(page.getByText("Change the amount after signing")).toHaveCount(0);
  }

  expect(wallet.sent.every((tx) => ["approve", "burn", "mint"].includes(tx.kind))).toBe(true);
  expect(problems, "errors thrown in the page").toEqual([]);
  log("spent", `${formatEvmAmount(parseEvmAmount(amounts.bring))} USDC left the wallet on ${base}, in ${wallet.sent.length} transactions`);
});
