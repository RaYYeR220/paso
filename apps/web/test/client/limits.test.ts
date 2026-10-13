import { maxFeeFor } from "paso-sdk";
import { describe, expect, it } from "vitest";
import { burnAmountProblem, FAUCET_AMOUNT, WALLET_BURN_MIN } from "@/lib/client/funding/limits";
import { isDiscovered, pickConnector, walletOptions, type ConnectorLike } from "@/lib/client/wallets";

describe("funding limits", () => {
  it("knows what the faucet sends: one USDC in Base's units", () => {
    expect(FAUCET_AMOUNT).toBe(1_000_000n);
  });

  it("sets the minimum where a fee cap still fits under the amount", () => {
    // Whatever Circle charges, from nothing to far more than it ever has, the minimum can be burned.
    for (const feeBps of [0, 0.01, 1, 1.3, 14, 100, 3_000]) {
      expect(maxFeeFor(WALLET_BURN_MIN, feeBps)).toBeLessThan(WALLET_BURN_MIN);
    }
    // One unit less cannot, as soon as there is any fee at all.
    expect(maxFeeFor(WALLET_BURN_MIN - 1n, 1)).toBeGreaterThanOrEqual(WALLET_BURN_MIN - 1n);
  });

  it("accepts anything between the minimum and what the wallet holds", () => {
    const limits = { min: WALLET_BURN_MIN, max: 25_000_000n };
    expect(burnAmountProblem(WALLET_BURN_MIN, limits, "Base Sepolia")).toBeNull();
    expect(burnAmountProblem(10_000_000n, limits, "Base Sepolia")).toBeNull();
    expect(burnAmountProblem(25_000_000n, limits, "Base Sepolia")).toBeNull();
  });

  it("says why an amount is out of range", () => {
    const limits = { min: WALLET_BURN_MIN, max: 25_000_000n };
    expect(burnAmountProblem(0n, limits, "Base Sepolia")).toBe("Enter an amount above zero");
    expect(burnAmountProblem(2n, limits, "Base Sepolia")).toBe("The smallest amount that can be brought over is 0.000003 USDC");
    expect(burnAmountProblem(25_000_001n, limits, "Base Sepolia")).toBe("The wallet holds 25 USDC on Base Sepolia");
    expect(burnAmountProblem(5n, { min: WALLET_BURN_MIN, max: 0n }, "Base Sepolia")).toBe("The wallet holds no USDC on Base Sepolia to bring over");
  });

  it("checks only the minimum while the wallet's balance is not known", () => {
    const limits = { min: WALLET_BURN_MIN, max: null };
    expect(burnAmountProblem(10n ** 15n, limits, "Base Sepolia")).toBeNull();
    expect(burnAmountProblem(1n, limits, "Base Sepolia")).toMatch(/smallest amount/);
  });
});

describe("the wallets on offer", () => {
  const injected: ConnectorLike = { id: "injected", name: "Injected", type: "injected" };
  const coinbase: ConnectorLike = { id: "coinbaseWalletSDK", name: "Coinbase Wallet", type: "coinbaseWallet" };
  const metamask: ConnectorLike = { id: "io.metamask", name: "MetaMask", type: "injected", icon: "data:image/svg+xml,…" };
  const rabby: ConnectorLike = { id: "io.rabby", name: "Rabby Wallet", type: "injected" };

  it("lists the configured wallets, and the browser's as ready only when the browser has one", () => {
    expect(walletOptions([injected, coinbase], false)).toEqual([
      { id: "injected", name: "Browser wallet", ready: false },
      { id: "coinbaseWalletSDK", name: "Coinbase Wallet", ready: true },
    ]);
    expect(walletOptions([injected, coinbase], true)[0]).toEqual({ id: "injected", name: "Browser wallet", ready: true });
  });

  it("names the wallets that announced themselves and drops the generic entry they replace", () => {
    expect(walletOptions([injected, coinbase, metamask, rabby], true)).toEqual([
      { id: "coinbaseWalletSDK", name: "Coinbase Wallet", ready: true },
      { id: "io.metamask", name: "MetaMask", ready: true, icon: "data:image/svg+xml,…" },
      { id: "io.rabby", name: "Rabby Wallet", ready: true },
    ]);
  });

  it("tells an announced wallet from a configured one", () => {
    expect(isDiscovered(metamask)).toBe(true);
    expect(isDiscovered(injected)).toBe(false);
    expect(isDiscovered(coinbase)).toBe(false);
  });

  it("connects the wallet that was named, and nothing else in its place", () => {
    const all = [injected, coinbase, metamask, rabby];
    expect(pickConnector(all, "io.rabby")).toBe(rabby);
    expect(pickConnector(all, "coinbaseWalletSDK")).toBe(coinbase);
    expect(pickConnector(all, "not.installed")).toBeUndefined();
  });

  it("without a name, prefers an announced wallet, then the browser's, then the first", () => {
    expect(pickConnector([injected, coinbase, metamask])).toBe(metamask);
    expect(pickConnector([coinbase, injected])).toBe(injected);
    expect(pickConnector([coinbase])).toBe(coinbase);
    expect(pickConnector([])).toBeUndefined();
  });
});
