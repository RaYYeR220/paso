import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESOURCE_FEE, defaultNetwork, loadConfig, serves } from "@/lib/server/config";
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
      maxFeePerGas: BigInt(250_000_000),
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

  it("pays for mints on Base on testnet unless told not to", () => {
    expect(
      loadConfig({ ...base, BASE_MINTS_PER_CALLER_PER_HOUR: "3", BASE_MINTS_PER_DAY: "9", BASE_MINT_PAYER_ETH_FLOOR: "5" }).baseMints,
    ).toEqual({ enabled: true, perCallerPerHour: 3, perDay: 9, payerEthFloor: BigInt(5), maxFeePerGas: BigInt(250_000_000) });
    expect(loadConfig({ ...base, BASE_MINT_MAX_FEE_PER_GAS: "77" }).baseMints.maxFeePerGas).toBe(BigInt(77));
    expect(() => loadConfig({ ...base, BASE_MINT_PAYER_ETH_FLOOR: "0.1" })).toThrow(/whole number of wei/);

    expect(loadConfig({ ...base, PAY_BASE_MINTS_ON_TESTNET: "false" }).baseMints.enabled).toBe(false);
    expect(loadConfig({ ...base, PAY_BASE_MINTS_ON_TESTNET: "no" }).baseMints.enabled).toBe(true);
  });

  it("on testnet bids little to be included, keeps no balance floor and lets one caller have a lot paid for", () => {
    const config = loadConfig(base);

    expect(config.inclusionFee).toBe(BigInt(1_000));
    expect(config.minBalance).toBe(BigInt(0));
    expect(config.spend).toEqual({
      relay: { perCallerPerHour: 120, perHour: 1_200 },
      deploy: { perCallerPerHour: 60, perHour: 600 },
      deliver: { perCallerPerHour: 60, perHour: 600 },
    });
    expect(
      loadConfig({ ...base, RELAYER_INCLUSION_FEE: "250", RELAYER_MIN_BALANCE: "70000000", RELAYS_PER_CALLER_PER_HOUR: "4", DELIVERIES_PER_HOUR: "9" }),
    ).toMatchObject({
      inclusionFee: BigInt(250),
      minBalance: BigInt(70_000_000),
      spend: { relay: { perCallerPerHour: 4, perHour: 1_200 }, deliver: { perCallerPerHour: 60, perHour: 9 } },
    });
    expect(() => loadConfig({ ...base, RELAYER_INCLUSION_FEE: "99" })).toThrow(/at least 100 stroops/);
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

describe("loadConfig for mainnet", () => {
  const mainnetRelayer = Keypair.random();
  const mainnet = { ...base, PASO_ALLOW_MAINNET: "true", RELAYER_SECRET_MAINNET: mainnetRelayer.secret() };

  it("is served only with the switch and a relayer account of its own", () => {
    expect(serves("testnet", base)).toBe(true);
    expect(serves("mainnet", base)).toBe(false);
    expect(serves("mainnet", { ...base, PASO_ALLOW_MAINNET: "true" })).toBe(false);
    expect(serves("mainnet", { ...base, RELAYER_SECRET_MAINNET: mainnetRelayer.secret() })).toBe(false);
    expect(serves("mainnet", { ...mainnet, PASO_ALLOW_MAINNET: "1" })).toBe(false);
    expect(serves("mainnet", mainnet)).toBe(true);

    expect(() => loadConfig(base, "mainnet")).toThrow(ConfigError);
    expect(() => loadConfig(base, "mainnet")).toThrow(/PASO_ALLOW_MAINNET=true/);
    expect(() => loadConfig({ ...mainnet, PASO_ALLOW_MAINNET: "1" }, "mainnet")).toThrow(/PASO_ALLOW_MAINNET=true/);
    expect(() => loadConfig({ ...base, PASO_ALLOW_MAINNET: "true" }, "mainnet")).toThrow(/RELAYER_SECRET_MAINNET is not set/);

    const config = loadConfig(mainnet, "mainnet");
    expect(config.network.name).toBe("mainnet");
    expect(config.relayer.publicKey()).toBe(mainnetRelayer.publicKey());
    expect(loadConfig(mainnet).network.name).toBe("testnet");
    expect(loadConfig(mainnet).relayer.publicKey()).toBe(relayer.publicKey());
  });

  it("never pays from the testnet relayer's account", () => {
    const reused = { ...base, PASO_ALLOW_MAINNET: "true", RELAYER_SECRET_MAINNET: relayer.secret() };

    expect(() => loadConfig(reused, "mainnet")).toThrow(ConfigError);
    expect(() => loadConfig(reused, "mainnet")).toThrow(/an account of its own/);
    expect(() => loadConfig(reused, "mainnet")).not.toThrow(new RegExp(relayer.secret()));
    expect(() => loadConfig({ ...mainnet, RELAYER_SECRET_MAINNET: "SBADSECRETVALUE" }, "mainnet")).toThrow(
      /RELAYER_SECRET_MAINNET is not a Stellar secret key/,
    );
  });

  it("caps a transaction at 0.3 XLM, a day at 2 XLM, keeps 2 XLM, and bids 0.01 XLM to be included", () => {
    const config = loadConfig(mainnet, "mainnet");

    expect(config.maxResourceFee).toBe(BigInt(3_000_000));
    expect(config.maxDailyFees).toBe(BigInt(20_000_000));
    expect(config.minBalance).toBe(BigInt(20_000_000));
    expect(config.inclusionFee).toBe(BigInt(100_000));
    expect(config.spend).toEqual({
      relay: { perCallerPerHour: 8, perHour: 40 },
      deploy: { perCallerPerHour: 3, perHour: 12 },
      deliver: { perCallerPerHour: 6, perHour: 20 },
    });
  });

  it("reads its own settings, and none of the ones made for testnet", () => {
    const testnetOnly = loadConfig(
      {
        ...mainnet,
        STELLAR_RPC_URL: "https://testnet-rpc.example",
        BASE_RPC_URL: "https://sepolia.example",
        DEMO_PAYER_PRIVATE_KEY: generatePrivateKey(),
        RELAYER_MAX_RESOURCE_FEE: "1",
        RELAYER_MAX_DAILY_FEES: "2",
        RELAYER_MIN_BALANCE: "3",
        RELAYER_INCLUSION_FEE: "100",
        RELAYS_PER_CALLER_PER_HOUR: "999",
      },
      "mainnet",
    );
    expect(testnetOnly.network.stellar.rpcUrl).toBe("https://mainnet.sorobanrpc.com");
    expect(testnetOnly.evmRpcUrl).toBeUndefined();
    expect(testnetOnly.payer).toBeNull();
    expect(testnetOnly.maxResourceFee).toBe(BigInt(3_000_000));
    expect(testnetOnly.maxDailyFees).toBe(BigInt(20_000_000));
    expect(testnetOnly.minBalance).toBe(BigInt(20_000_000));
    expect(testnetOnly.inclusionFee).toBe(BigInt(100_000));
    expect(testnetOnly.spend.relay.perCallerPerHour).toBe(8);

    const key = generatePrivateKey();
    const own = loadConfig(
      {
        ...mainnet,
        STELLAR_RPC_URL_MAINNET: "https://rpc.example",
        BASE_RPC_URL_MAINNET: "https://base.example",
        BASE_PAYER_PRIVATE_KEY_MAINNET: key,
        RELAYER_MAX_RESOURCE_FEE_MAINNET: "1234",
        RELAYER_MAX_DAILY_FEES_MAINNET: "99999",
        RELAYER_MIN_BALANCE_MAINNET: "5",
        RELAYER_INCLUSION_FEE_MAINNET: "200000",
        RELAYS_PER_CALLER_PER_HOUR_MAINNET: "2",
        RELAYS_PER_HOUR_MAINNET: "3",
        DEPLOYS_PER_CALLER_PER_HOUR_MAINNET: "4",
        DEPLOYS_PER_HOUR_MAINNET: "5",
        DELIVERIES_PER_CALLER_PER_HOUR_MAINNET: "6",
        DELIVERIES_PER_HOUR_MAINNET: "7",
      },
      "mainnet",
    );
    expect(own.network.stellar.rpcUrl).toBe("https://rpc.example");
    expect(own.evmRpcUrl).toBe("https://base.example");
    expect(own.payer?.address).toBe(privateKeyToAccount(key).address);
    expect(own.maxResourceFee).toBe(BigInt(1_234));
    expect(own.maxDailyFees).toBe(BigInt(99_999));
    expect(own.minBalance).toBe(BigInt(5));
    expect(own.inclusionFee).toBe(BigInt(200_000));
    expect(own.spend).toEqual({
      relay: { perCallerPerHour: 2, perHour: 3 },
      deploy: { perCallerPerHour: 4, perHour: 5 },
      deliver: { perCallerPerHour: 6, perHour: 7 },
    });
    // The other network's own settings are left alone.
    expect(loadConfig({ ...mainnet, RELAYER_MAX_RESOURCE_FEE_MAINNET: "1234" }).maxResourceFee).toBe(DEFAULT_MAX_RESOURCE_FEE);
  });

  it("does not pay for mints on Base unless that was asked for by name", () => {
    expect(loadConfig(mainnet, "mainnet").baseMints.enabled).toBe(false);
    expect(loadConfig({ ...mainnet, PAY_BASE_MINTS_ON_MAINNET: "1" }, "mainnet").baseMints.enabled).toBe(false);
    expect(loadConfig({ ...mainnet, PAY_BASE_MINTS_ON_TESTNET: "true" }, "mainnet").baseMints.enabled).toBe(false);
    expect(loadConfig({ ...mainnet, PAY_BASE_MINTS_ON_MAINNET: "true" }, "mainnet").baseMints.enabled).toBe(true);
  });
});

describe("the network a request means when it names none", () => {
  it("is testnet, unless PASO_NETWORK says otherwise", () => {
    expect(defaultNetwork({})).toBe("testnet");
    expect(defaultNetwork({ PASO_NETWORK: " testnet " })).toBe("testnet");
    expect(defaultNetwork({ PASO_NETWORK: "mainnet" })).toBe("mainnet");
    expect(() => defaultNetwork({ PASO_NETWORK: "futurenet" })).toThrow(/testnet.*mainnet/);
    expect(() => loadConfig({ ...base, PASO_NETWORK: "mainnet" })).toThrow(/PASO_ALLOW_MAINNET=true/);
  });
});
