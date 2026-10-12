import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESOURCE_FEE, loadConfig } from "@/lib/server/config";
import { ConfigError } from "@/lib/server/errors";

const relayer = Keypair.random();
const base = { RELAYER_SECRET: relayer.secret() };

describe("loadConfig", () => {
  it("defaults to testnet, a 0.5 XLM cap per transaction, 50 XLM a day and no demo payer", () => {
    const config = loadConfig(base);

    expect(config.network.name).toBe("testnet");
    expect(config.relayer.publicKey()).toBe(relayer.publicKey());
    expect(config.payer).toBeNull();
    expect(config.maxResourceFee).toBe(DEFAULT_MAX_RESOURCE_FEE);
    expect(config.maxResourceFee).toBe(BigInt(5_000_000));
    expect(config.maxDailyFees).toBe(BigInt(500_000_000));
    expect(config.demoFund).toEqual({ perIpPerHour: 5, perOwnerPerDay: 2, perDay: 50, payerFloor: BigInt(2_000_000) });
    expect(config.baseMints).toEqual({
      enabled: true,
      perCallerPerHour: 10,
      perDay: 100,
      payerEthFloor: BigInt(100_000_000_000_000),
    });
  });

  it("reads the payer, the endpoints, the fee cap and the faucet limits", () => {
    const key = generatePrivateKey();
    const config = loadConfig({
      ...base,
      PASO_NETWORK: "testnet",
      DEMO_PAYER_PRIVATE_KEY: key,
      STELLAR_RPC_URL: "https://rpc.example",
      BASE_RPC_URL: "https://base.example",
      RELAYER_MAX_RESOURCE_FEE: "1234",
      RELAYER_MAX_DAILY_FEES: "99999",
      DEMO_FUND_PER_IP_PER_HOUR: "9",
      DEMO_FUND_PER_OWNER_PER_DAY: "4",
      DEMO_FUND_PER_DAY: "7",
      DEMO_FUND_PAYER_FLOOR: "0",
    });

    expect(config.payer?.address).toBe(privateKeyToAccount(key).address);
    expect(config.network.stellar.rpcUrl).toBe("https://rpc.example");
    expect(config.evmRpcUrl).toBe("https://base.example");
    expect(config.maxResourceFee).toBe(BigInt(1234));
    expect(config.maxDailyFees).toBe(BigInt(99_999));
    expect(config.demoFund).toEqual({ perIpPerHour: 9, perOwnerPerDay: 4, perDay: 7, payerFloor: BigInt(0) });
  });

  it("refuses to start without a relayer key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/RELAYER_SECRET is not set/);
  });

  it("never repeats a malformed secret in the error", () => {
    const secret = "SBADSECRETVALUE";
    const failure = (() => {
      try {
        loadConfig({ RELAYER_SECRET: secret });
      } catch (error) {
        return error as Error;
      }
    })();
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure?.message).not.toContain(secret);

    const key = "0x1234";
    expect(() => loadConfig({ ...base, DEMO_PAYER_PRIVATE_KEY: key })).toThrow(/32-byte hex private key/);
    expect(() => loadConfig({ ...base, DEMO_PAYER_PRIVATE_KEY: key })).not.toThrow(new RegExp(key));
  });

  it("runs on mainnet only when that is asked for in so many words", () => {
    expect(() => loadConfig({ ...base, PASO_NETWORK: "mainnet" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PASO_NETWORK: "mainnet" })).toThrow(/PASO_ALLOW_MAINNET=true/);
    expect(() => loadConfig({ ...base, PASO_NETWORK: "mainnet", PASO_ALLOW_MAINNET: "1" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, PASO_NETWORK: "mainnet", PASO_ALLOW_MAINNET: "true" }).network.name).toBe("mainnet");
    expect(loadConfig({ ...base, PASO_ALLOW_MAINNET: "true" }).network.name).toBe("testnet");
  });

  it("pays for mints on Base on testnet, and on mainnet only when told to", () => {
    const mainnet = { ...base, PASO_NETWORK: "mainnet", PASO_ALLOW_MAINNET: "true" };

    expect(loadConfig(mainnet).baseMints.enabled).toBe(false);
    expect(loadConfig({ ...mainnet, PAY_BASE_MINTS_ON_MAINNET: "1" }).baseMints.enabled).toBe(false);
    expect(loadConfig({ ...mainnet, PAY_BASE_MINTS_ON_MAINNET: "true" }).baseMints.enabled).toBe(true);
    expect(
      loadConfig({ ...base, BASE_MINTS_PER_CALLER_PER_HOUR: "3", BASE_MINTS_PER_DAY: "9", BASE_MINT_PAYER_ETH_FLOOR: "5" }).baseMints,
    ).toEqual({ enabled: true, perCallerPerHour: 3, perDay: 9, payerEthFloor: BigInt(5) });
    expect(() => loadConfig({ ...base, BASE_MINT_PAYER_ETH_FLOOR: "0.1" })).toThrow(/whole number of wei/);
  });

  it("refuses an unknown network and malformed numbers", () => {
    expect(() => loadConfig({ ...base, PASO_NETWORK: "futurenet" })).toThrow(/testnet.*mainnet/);
    expect(() => loadConfig({ ...base, RELAYER_MAX_DAILY_FEES: "-1" })).toThrow(/whole number of stroops/);
    expect(() => loadConfig({ ...base, DEMO_FUND_PER_DAY: "many" })).toThrow(/positive whole number/);
    expect(() => loadConfig({ ...base, DEMO_FUND_PAYER_FLOOR: "2.5" })).toThrow(/whole number of USDC units/);
    expect(() => loadConfig({ ...base, RELAYER_MAX_RESOURCE_FEE: "0.5" })).toThrow(/whole number of stroops/);
    expect(() => loadConfig({ ...base, DEMO_FUND_PER_IP_PER_HOUR: "0" })).toThrow(/positive whole number/);
  });
});
