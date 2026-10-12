import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESOURCE_FEE, loadConfig } from "@/lib/server/config";
import { ConfigError } from "@/lib/server/errors";

const relayer = Keypair.random();
const base = { RELAYER_SECRET: relayer.secret() };

describe("loadConfig", () => {
  it("defaults to testnet, a 0.5 XLM fee cap and no demo payer", () => {
    const config = loadConfig(base);

    expect(config.network.name).toBe("testnet");
    expect(config.relayer.publicKey()).toBe(relayer.publicKey());
    expect(config.payer).toBeNull();
    expect(config.maxResourceFee).toBe(DEFAULT_MAX_RESOURCE_FEE);
    expect(config.maxResourceFee).toBe(BigInt(5_000_000));
    expect(config.demoFund).toEqual({ perIpPerHour: 5, perOwnerPerDay: 2 });
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
      DEMO_FUND_PER_IP_PER_HOUR: "9",
      DEMO_FUND_PER_OWNER_PER_DAY: "4",
    });

    expect(config.payer?.address).toBe(privateKeyToAccount(key).address);
    expect(config.network.stellar.rpcUrl).toBe("https://rpc.example");
    expect(config.evmRpcUrl).toBe("https://base.example");
    expect(config.maxResourceFee).toBe(BigInt(1234));
    expect(config.demoFund).toEqual({ perIpPerHour: 9, perOwnerPerDay: 4 });
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

  it("refuses an unknown network and malformed numbers", () => {
    expect(() => loadConfig({ ...base, PASO_NETWORK: "futurenet" })).toThrow(/testnet.*mainnet/);
    expect(() => loadConfig({ ...base, RELAYER_MAX_RESOURCE_FEE: "0.5" })).toThrow(/whole number of stroops/);
    expect(() => loadConfig({ ...base, DEMO_FUND_PER_IP_PER_HOUR: "0" })).toThrow(/positive whole number/);
  });
});
