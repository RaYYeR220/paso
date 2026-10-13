import { NETWORKS, twinAddress } from "@paso/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as fundRoute } from "@/app/api/demo/fund/route";
import { GET as healthRoute } from "@/app/api/health/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { getRelayer, Relayer, type DemoFundResult } from "@/lib/server/relayer";
import { live, post } from "./helpers";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const env = { RELAYER_SECRET: Keypair.random().secret(), DEMO_PAYER_PRIVATE_KEY: generatePrivateKey() };
const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;
const health = () => healthRoute(new Request("http://localhost/api/health"));

type Internals = {
  burnForDemo: (owner: string, payer: string, signal: AbortSignal) => Promise<DemoFundResult>;
  assertFaucetFunded: (payer: string) => Promise<void>;
  evmClients: () => unknown;
};

/** A relayer whose payer is taken to be funded and whose burn on Base is replaced: only the faucet's rules run. */
function faucet(overrides: Record<string, string> = {}, burn?: () => Promise<DemoFundResult>) {
  const relayer = new Relayer(loadConfig({ ...env, ...overrides }));
  const internals = relayer as unknown as Internals;
  const funded = vi.spyOn(internals, "assertFaucetFunded").mockResolvedValue(undefined);
  const burnForDemo = vi.spyOn(internals, "burnForDemo").mockImplementation(
    burn ??
      (async (owner) => ({
        burnTxHash: `0x${"ab".repeat(32)}`,
        sourceDomain: 6,
        twin: twinAddress(owner as `0x${string}`, "testnet"),
        amount: "1000000",
      })),
  );
  return { relayer, burnForDemo, funded };
}

const paid = async (): Promise<DemoFundResult> => ({ burnTxHash: "0x00", sourceDomain: 6, twin: "C", amount: "1000000" });

afterEach(() => vi.restoreAllMocks());

describe("the demo faucet", () => {
  it("burns one USDC for the owner's account and says where to follow it", async () => {
    const { relayer, burnForDemo } = faucet();
    const owner = randomOwner();

    expect(await relayer.demoFund({ owner }, "203.0.113.1")).toEqual({
      burnTxHash: `0x${"ab".repeat(32)}`,
      sourceDomain: 6,
      twin: twinAddress(owner, "testnet"),
      amount: "1000000",
    });
    expect(burnForDemo).toHaveBeenCalledWith(owner, relayer.config.payer?.address, expect.any(AbortSignal));
  });

  it("funds an owner twice a day and no more, whoever asks", async () => {
    const { relayer, burnForDemo } = faucet();
    const owner = randomOwner();

    await relayer.demoFund({ owner }, "203.0.113.1");
    await relayer.demoFund({ owner: owner.toLowerCase() }, "203.0.113.2");
    const refused = await relayer.demoFund({ owner }, "203.0.113.3").catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe("rate_limited");
    expect((refused as ApiError).status).toBe(429);
    expect((refused as ApiError).extra.retryAfterSeconds).toBeGreaterThan(23 * 3600);
    expect(burnForDemo).toHaveBeenCalledTimes(2);
  });

  it("serves a caller five times an hour and no more, whatever the owner", async () => {
    const { relayer, burnForDemo } = faucet();

    for (let i = 0; i < 5; i += 1) await relayer.demoFund({ owner: randomOwner() }, "203.0.113.9");
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.9")).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.10")).resolves.toBeDefined();
    expect(burnForDemo).toHaveBeenCalledTimes(6);
  });

  it("counts an attempt that failed: failing is not a way to try again for free", async () => {
    let attempts = 0;
    const { relayer, burnForDemo } = faucet({ DEMO_FUND_PER_IP_PER_HOUR: "2", DEMO_FUND_PER_OWNER_PER_DAY: "2" }, async () => {
      attempts += 1;
      throw new Error("the burn reverted after the approval was paid for");
    });
    const owner = randomOwner();

    await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({ code: "unavailable" });
    await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({ code: "unavailable" });

    // Both limits are used up by the two failures, for this caller and for this owner alike.
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(relayer.demoFund({ owner }, "203.0.113.2")).rejects.toMatchObject({ code: "rate_limited" });
    expect(attempts).toBe(2);
    expect(burnForDemo).toHaveBeenCalledTimes(2);
  });

  it("does not count a request it turned away before starting", async () => {
    const { relayer, burnForDemo, funded } = faucet({ DEMO_FUND_PER_IP_PER_HOUR: "1", DEMO_FUND_PER_OWNER_PER_DAY: "1" }, paid);
    const owner = randomOwner();
    funded.mockRejectedValueOnce(new ApiError("unavailable", "The demo faucet is out of test USDC on Base Sepolia"));

    await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({ code: "unavailable" });
    expect(burnForDemo).not.toHaveBeenCalled();

    // Refilled: the same caller and owner still have their one attempt, and a refusal by one limit uses up no other.
    await expect(relayer.demoFund({ owner }, "203.0.113.1")).resolves.toBeDefined();
    await expect(relayer.demoFund({ owner }, "203.0.113.2")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.2")).resolves.toBeDefined();
  });

  it("gives out a fixed number of payouts a day, however many callers and owners ask", async () => {
    const { relayer, burnForDemo } = faucet({ DEMO_FUND_PER_DAY: "3" }, paid);

    for (let i = 0; i < 3; i += 1) await relayer.demoFund({ owner: randomOwner() }, `203.0.113.${i}`);
    const refused = await relayer.demoFund({ owner: randomOwner() }, "203.0.113.200").catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: "unavailable", status: 503 });
    expect((refused as ApiError).detail).toMatch(/all it gives in a day/);
    expect(burnForDemo).toHaveBeenCalledTimes(3);
  });

  it("keeps the cause of a failed burn out of the answer", async () => {
    const endpoint = "https://base.example/v2/secret-api-key";
    const { relayer } = faucet({}, async () => {
      throw Object.assign(new Error(`HTTP request failed. URL: ${endpoint}`), { shortMessage: `request to ${endpoint} failed` });
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const refused = (await relayer.demoFund({ owner: randomOwner() }, "203.0.113.1").catch((error: unknown) => error)) as ApiError;

    expect(refused.code).toBe("unavailable");
    expect(refused.detail).toBe("The demo faucet could not send USDC on Base Sepolia; try again later");
    expect(JSON.stringify([refused.detail, refused.extra, vi.mocked(console.error).mock.calls])).not.toContain("secret-api-key");
  });

  it("burns one request at a time, so the payer's transactions keep their order", async () => {
    const order: string[] = [];
    const { relayer } = faucet({}, async () => {
      order.push("start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("end");
      return paid();
    });

    await Promise.all([
      relayer.demoFund({ owner: randomOwner() }, "203.0.113.1"),
      relayer.demoFund({ owner: randomOwner() }, "203.0.113.2"),
    ]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("declines at once when too many burns are already waiting", async () => {
    const { relayer, burnForDemo } = faucet({ DEMO_FUND_PER_IP_PER_HOUR: "50" }, () => new Promise<DemoFundResult>(() => undefined));

    const waiting = Array.from({ length: 4 }, () => relayer.demoFund({ owner: randomOwner() }, "203.0.113.1"));
    await vi.waitFor(() => expect(burnForDemo).toHaveBeenCalledTimes(1));

    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("busy"),
    });
    for (const request of waiting) request.catch(() => undefined);
  });

  it("exists on testnet only", async () => {
    const onMainnet = {
      PASO_ALLOW_MAINNET: "true",
      RELAYER_SECRET_MAINNET: Keypair.random().secret(),
      BASE_PAYER_PRIVATE_KEY_MAINNET: generatePrivateKey(),
    };
    const relayer = new Relayer(loadConfig({ ...env, ...onMainnet }, "mainnet"));
    const internals = relayer as unknown as Internals;
    const funded = vi.spyOn(internals, "assertFaucetFunded").mockResolvedValue(undefined);
    const burnForDemo = vi.spyOn(internals, "burnForDemo").mockImplementation(paid);

    for (const body of [{ owner: randomOwner() }, { owner: randomOwner(), network: "mainnet" }]) {
      await expect(relayer.demoFund(body, "203.0.113.1")).rejects.toMatchObject({
        code: "not_found",
        status: 404,
        detail: "The demo faucet exists on testnet only",
      });
    }
    expect(funded).not.toHaveBeenCalled();
    expect(burnForDemo).not.toHaveBeenCalled();
  });

  it("is unavailable without a payer, and refuses anything but an Ethereum address", async () => {
    const without = new Relayer(loadConfig({ RELAYER_SECRET: env.RELAYER_SECRET }));
    await expect(without.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
    });

    const { relayer, funded } = faucet();
    for (const owner of ["GABC", "0x1234", `0x${"g".repeat(40)}`, `0x${"a".repeat(41)}`, 5, null, ["0x"]]) {
      await expect(relayer.demoFund({ owner }, "203.0.113.1")).rejects.toMatchObject({ code: "bad_request" });
    }
    await expect(relayer.demoFund(null, "203.0.113.1")).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.demoFund({ owner: randomOwner(), network: "mainnet" }, "203.0.113.1")).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(funded).not.toHaveBeenCalled();
  });
});

describe("the faucet's payer", () => {
  /** A relayer that reads the given balances from Base instead of the network. */
  function payerHolding(usdc: number, wei: number, overrides: Record<string, string> = {}) {
    const relayer = new Relayer(loadConfig({ ...env, ...overrides }));
    const internals = relayer as unknown as Internals;
    vi.spyOn(internals, "evmClients").mockReturnValue({
      publicClient: { readContract: async () => BigInt(usdc), getBalance: async () => BigInt(wei) },
      walletClient: null,
    });
    const burnForDemo = vi.spyOn(internals, "burnForDemo").mockImplementation(paid);
    return { relayer, burnForDemo };
  }

  it("pays out while a payout leaves it its reserve of 2 USDC", async () => {
    const { relayer, burnForDemo } = payerHolding(3_000_000, 1);

    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).resolves.toBeDefined();
    expect(burnForDemo).toHaveBeenCalledTimes(1);
  });

  it("stops below that, without sending anything", async () => {
    const { relayer, burnForDemo } = payerHolding(2_999_999, 1);

    await expect(relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
      detail: "The demo faucet is out of test USDC on Base Sepolia",
    });
    expect(burnForDemo).not.toHaveBeenCalled();
  });

  it("honours a reserve set in the environment, and stops without gas", async () => {
    const lean = payerHolding(1_000_000, 1, { DEMO_FUND_PAYER_FLOOR: "0" });
    await expect(lean.relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).resolves.toBeDefined();

    const dry = payerHolding(50_000_000, 0);
    await expect(dry.relayer.demoFund({ owner: randomOwner() }, "203.0.113.1")).rejects.toMatchObject({
      code: "unavailable",
      detail: "The demo faucet is out of gas on Base Sepolia",
    });
  });

  it("says only that Base could not be reached when it cannot be", async () => {
    const relayer = new Relayer(loadConfig(env));
    vi.spyOn(relayer as unknown as Internals, "evmClients").mockReturnValue({
      publicClient: {
        readContract: async () => {
          throw new Error("fetch failed: https://base.example/v2/secret-api-key");
        },
        getBalance: async () => BigInt(1),
      },
      walletClient: null,
    });

    const refused = (await relayer.demoFund({ owner: randomOwner() }, "203.0.113.1").catch((error: unknown) => error)) as ApiError;
    expect(refused.detail).toBe("The demo faucet could not reach Base Sepolia; try again later");
  });
});

describe("GET /api/health", () => {
  it("asks the networks once for requests that come close together", async () => {
    const relayer = new Relayer(loadConfig(env));
    const readHealth = vi
      .spyOn(relayer as unknown as { readHealth: () => Promise<unknown> }, "readHealth")
      .mockResolvedValue({ ok: true });

    await Promise.all([relayer.health(), relayer.health(), relayer.health()]);
    expect(readHealth).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!live)("on testnet", () => {
  it("GET /api/health reports the network, the relayer and the payer, and no secrets", async () => {
    const response = await health();
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["default", "networks", "ok"]);
    expect(body.default).toBe("testnet");
    const { testnet } = body.networks;
    expect(testnet).toMatchObject({
      enabled: true,
      ok: true,
      network: "testnet",
      hub: NETWORKS.testnet.stellar.hub,
      relayer: { address: getRelayer("testnet").address, xlm: expect.stringMatching(/^\d+(\.\d+)?$/) },
      fees: { maxResourceFee: "5000000", inclusionFee: "1000", maxDailyFees: "500000000", minBalance: "0" },
      paysFees: true,
    });
    expect(Object.keys(testnet).sort()).toEqual(
      ["enabled", "faucet", "fees", "hub", "latestLedger", "limits", "network", "ok", "payer", "paysBaseMints", "paysFees", "relayer"],
    );
    expect(testnet.latestLedger).toBeGreaterThan(0);
    expect(Number(testnet.relayer.xlm)).toBeGreaterThan(1);
    if (process.env.DEMO_PAYER_PRIVATE_KEY) {
      expect(testnet.payer).toMatchObject({
        address: privateKeyToAccount(process.env.DEMO_PAYER_PRIVATE_KEY as `0x${string}`).address,
        chain: "Base Sepolia",
        usdc: expect.stringMatching(/^\d+(\.\d+)?$/),
        eth: expect.stringMatching(/^\d+(\.\d+)?$/),
      });
    }
    for (const secret of [process.env.RELAYER_SECRET, process.env.RELAYER_SECRET_MAINNET, process.env.DEMO_PAYER_PRIVATE_KEY]) {
      if (secret) expect(text).not.toContain(secret);
    }
  });

  it("POST /api/demo/fund says so when the payer has no test USDC, and does not count the request", async () => {
    const report = (await (await health()).json()).networks.testnet;
    if (!report.payer || Number(report.payer.usdc) >= 3) return;
    const owner = randomOwner();

    for (let i = 0; i < 3; i += 1) {
      const response = await fundRoute(post("/api/demo/fund", { owner }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "unavailable", detail: expect.stringContaining("out of test USDC") });
    }
  });
});
