import { NETWORKS, type NetworkName } from "paso-sdk";
import { Account, Keypair, SorobanDataBuilder, StrKey, xdr } from "@stellar/stellar-sdk";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { Relayer } from "@/lib/server/relayer";
import delivered from "./fixtures/arc-delivered-message.json";
import exit from "./fixtures/exit-message.json";
import { post } from "./helpers";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const XLM = 10_000_000;
const testnetSecret = Keypair.random().secret();
const mainnetSecret = Keypair.random().secret();
const both = { RELAYER_SECRET: testnetSecret, PASO_ALLOW_MAINNET: "true", RELAYER_SECRET_MAINNET: mainnetSecret };

const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;
const realFetch = globalThis.fetch;

type Sent = { status: string; hash: string; errorResult?: { result: { type: string } } };
type Polled = { status: string; txHash?: string; latestLedgerCloseTime?: number };

interface Script {
  network?: NetworkName;
  env?: Record<string, string>;
  /** What every simulation says the transaction costs in resource fees, in stroops. */
  resourceFee?: string;
  /** What the relayer account holds, in stroops. */
  balance?: number;
  answers?: Sent[];
}

/**
 * A relayer on a scripted network: no account is deployed, every simulation
 * succeeds, and a transaction is applied as soon as it is asked about unless
 * the test says otherwise.
 */
function scripted({ network = "testnet", env = {}, resourceFee = "100", balance = 100 * XLM, answers = [] }: Script = {}) {
  const relayer = new Relayer(loadConfig({ ...both, ...env }, network));
  let sequence = 100;
  let sends = 0;
  const sent: { fee: string; maxTime: number; sequence: string }[] = [];
  const server = {
    getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }),
    getLatestLedger: vi.fn(async () => ({ sequence: 1 })),
    getAccount: vi.fn(async (address: string) => new Account(address, String(sequence))),
    getAccountEntry: vi.fn(async () => ({ balance: BigInt(balance) })),
    simulateTransaction: vi.fn(async () => ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      minResourceFee: resourceFee,
      transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    })),
    sendTransaction: vi.fn(async (tx: { sequence: string; fee: string; timeBounds?: { maxTime: string } }) => {
      sends += 1;
      sent.push({ fee: tx.fee, maxTime: Number(tx.timeBounds?.maxTime ?? 0), sequence: tx.sequence });
      const answer = answers.shift() ?? { status: "PENDING", hash: String(sends).padStart(64, "0") };
      if (answer.status === "PENDING") sequence += 1;
      return answer;
    }),
    pollTransaction: vi.fn<(hash: string) => Promise<Polled>>(async (hash) => ({ status: "SUCCESS", txHash: hash })),
    getTransaction: vi.fn<(hash: string) => Promise<Polled>>(async () => ({ status: "NOT_FOUND", latestLedgerCloseTime: 0 })),
  };
  (relayer as unknown as { server: unknown }).server = server;

  /** The network's answer for a transaction no ledger has: not found, with its clock before or after the time bound. */
  const missing = (clock: "before" | "after") => async (): Promise<Polled> => ({
    status: "NOT_FOUND",
    latestLedgerCloseTime: sent[sent.length - 1]!.maxTime + (clock === "after" ? 1 : -5),
  });
  /**
   * Deploys an owner's account the way the relayer does before a first
   * relayed call. It is what these tests pay for, on either network; the
   * deploy route itself is testnet's.
   */
  const deployOwner = async (owner: Address, caller = "caller") => {
    const internals = relayer as unknown as { ensureDeployed(owner: Address, caller: string): Promise<string | undefined> };
    const hash = await internals.ensureDeployed(owner, caller);
    return hash ? { hash, alreadyDeployed: false } : { alreadyDeployed: true };
  };
  const deploy = (caller = "caller", owner = randomOwner()) => deployOwner(owner, caller);
  return { relayer, server, sent, answers, missing, deploy, deployOwner, network };
}

const refusalOf = async (attempt: Promise<unknown>) => (await attempt.catch((error: unknown) => error)) as ApiError;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a transaction the network left out", () => {
  it("is known to be dead once the network's own clock has passed its time bound, and is sent again with twice the bid", async () => {
    const run = scripted();
    const body = { network: "testnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementationOnce(run.missing("after"));

    const leftOut = await refusalOf(run.deployOwner(body.owner, "caller"));
    expect(leftOut).toMatchObject({
      code: "unavailable",
      detail: expect.stringMatching(/was not included before its time ran out/),
      extra: { sent: false, retryAfterSeconds: 1 },
    });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(run.sent[0]!.fee).toBe("1100");

    await expect(run.deployOwner(body.owner, "caller")).resolves.toMatchObject({ alreadyDeployed: false });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(2);
    expect(run.sent[1]!.fee).toBe("2100");
    expect(run.relayer.state.sends.size).toBe(0);
  });

  it("valid for half a minute, so one request sees its whole time through", async () => {
    const run = scripted();
    const before = Math.floor(Date.now() / 1000);

    await run.deploy();

    expect(run.sent[0]!.maxTime - before).toBeGreaterThanOrEqual(29);
    expect(run.sent[0]!.maxTime - before).toBeLessThanOrEqual(31);
  });

  it("sets the fee of the second one aside as the difference: the first can never be charged", async () => {
    const run = scripted();
    const body = { network: "testnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementationOnce(run.missing("after"));

    await refusalOf(run.deployOwner(body.owner, "caller"));
    expect(run.relayer.state.fees.spent()).toBe(BigInt(1_100));
    await run.deployOwner(body.owner, "caller");
    expect(run.relayer.state.fees.spent()).toBe(BigInt(2_100));
  });

  it("counts once against its caller, however often it has to be sent", async () => {
    const run = scripted({ env: { DEPLOYS_PER_CALLER_PER_HOUR: "1" } });
    const body = { network: "testnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementationOnce(run.missing("after"));

    await refusalOf(run.deployOwner(body.owner, "caller"));
    await expect(run.deployOwner(body.owner, "caller")).resolves.toMatchObject({ alreadyDeployed: false });
    expect(await refusalOf(run.deploy("caller"))).toMatchObject({ code: "rate_limited" });
  });

  it("is never sent again while the network's clock has not passed its time bound, however long that takes", async () => {
    vi.useFakeTimers();
    const run = scripted();
    const body = { network: "testnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementationOnce(run.missing("before"));
    run.server.getTransaction.mockImplementation(run.missing("before"));

    expect(await refusalOf(run.deployOwner(body.owner, "caller"))).toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("has not been confirmed yet"),
      extra: { sent: true },
    });
    for (const wait of [1_000, 60_000, 600_000]) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(await refusalOf(run.deployOwner(body.owner, "caller"))).toMatchObject({
        code: "unavailable",
        detail: expect.stringContaining("is on its way"),
        extra: { sent: true },
      });
    }
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(1);

    // The network catches up and says the time bound has passed: only now is another one sent.
    run.server.getTransaction.mockImplementation(run.missing("after"));
    const again = run.deployOwner(body.owner, "caller");
    await vi.advanceTimersByTimeAsync(10);
    await expect(again).resolves.toMatchObject({ alreadyDeployed: false });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("is given up on after three, each bidding twice the last, and left alone for a while", async () => {
    vi.useFakeTimers();
    const run = scripted({ network: "mainnet" });
    const body = { network: "mainnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementation(run.missing("after"));

    const first = await refusalOf(run.deployOwner(body.owner, "caller"));
    const second = await refusalOf(run.deployOwner(body.owner, "caller"));
    const third = await refusalOf(run.deployOwner(body.owner, "caller"));

    expect(run.sent.map((tx) => tx.fee)).toEqual(["100100", "200100", "400100"]);
    expect([first, second].map((refusal) => refusal.detail)).toEqual([
      expect.stringMatching(/was not included before its time ran out/),
      expect.stringMatching(/was not included before its time ran out/),
    ]);
    expect(third).toMatchObject({
      code: "unavailable",
      detail: expect.stringMatching(/left it out 3 times/),
      extra: { sent: false },
    });
    expect(third.extra.retryAfterSeconds).toBeGreaterThan(200);

    // Asked again at once, nothing more is sent.
    expect(await refusalOf(run.deployOwner(body.owner, "caller"))).toMatchObject({ detail: expect.stringMatching(/left it out 3 times/) });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(3);

    // After the pause the same thing starts over, at the usual bid.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    run.server.pollTransaction.mockImplementation(async (hash) => ({ status: "SUCCESS", txHash: hash }));
    const anew = run.deployOwner(body.owner, "caller");
    await vi.advanceTimersByTimeAsync(10);
    await expect(anew).resolves.toMatchObject({ alreadyDeployed: false });
    expect(run.sent[3]!.fee).toBe("100100");
  });

  it("keeps its place when the network would not even take the next one", async () => {
    const run = scripted();
    const body = { network: "testnet", owner: randomOwner() };
    run.server.pollTransaction.mockImplementationOnce(run.missing("after"));
    await refusalOf(run.deployOwner(body.owner, "caller"));

    run.answers.push({ status: "ERROR", hash: "", errorResult: { result: { type: "txInsufficientBalance" } } });
    expect(await refusalOf(run.deployOwner(body.owner, "caller"))).toMatchObject({ detail: expect.stringContaining("txInsufficientBalance") });

    await run.deployOwner(body.owner, "caller");
    expect(run.sent.map((tx) => tx.fee)).toEqual(["1100", "2100", "2100"]);
  });
});

describe("what the mainnet relayer pays", () => {
  it("bids 0.01 XLM to be included, where testnet bids a thousand stroops", async () => {
    const mainnet = scripted({ network: "mainnet" });
    const testnet = scripted();

    await mainnet.deploy();
    await testnet.deploy();

    expect(mainnet.sent[0]!.fee).toBe(String(100_000 + 100));
    expect(testnet.sent[0]!.fee).toBe(String(1_000 + 100));
  });

  it("is capped at 0.3 XLM of resource fees a transaction", async () => {
    const over = scripted({ network: "mainnet", resourceFee: "3000001" });
    expect(await refusalOf(over.deploy())).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringMatching(/cost 3000001 stroops .* up to 3000000 stroops \(0\.3 XLM\)/),
    });
    expect(over.server.sendTransaction).not.toHaveBeenCalled();

    const exactly = scripted({ network: "mainnet", resourceFee: "3000000" });
    await expect(exactly.deploy()).resolves.toMatchObject({ alreadyDeployed: false });
  });

  it("stops at 2 XLM of fees in a day, and says that this is why", async () => {
    // Each transaction: 0.29 XLM in resources and 0.01 XLM to be included.
    const run = scripted({ network: "mainnet", resourceFee: "2900000" });

    for (let i = 0; i < 6; i += 1) await run.deploy(`caller-${i}`);
    const refused = await refusalOf(run.deploy("caller-6"));

    expect(refused).toMatchObject({ code: "unavailable", status: 503, detail: expect.stringMatching(/fees in a day/), extra: { reason: "daily_budget" } });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(6);
    expect(run.relayer.state.fees.spent()).toBe(BigInt(18_000_000));
  });

  it("never takes its account below the 2 XLM it keeps", async () => {
    const fee = 100_000 + 100;
    const short = scripted({ network: "mainnet", balance: 2 * XLM + fee - 1 });
    const refused = await refusalOf(short.deploy());

    expect(refused).toMatchObject({ code: "unavailable", status: 503, extra: { reason: "low_balance" } });
    expect(refused.detail).toMatch(/keeps in reserve/);
    expect(short.server.sendTransaction).not.toHaveBeenCalled();
    expect(short.relayer.state.fees.spent()).toBe(BigInt(0));

    const enough = scripted({ network: "mainnet", balance: 2 * XLM + fee });
    await expect(enough.deploy()).resolves.toMatchObject({ alreadyDeployed: false });
  });

  it("sends nothing when it cannot read what its account holds", async () => {
    const run = scripted({ network: "mainnet" });
    run.server.getAccountEntry.mockRejectedValue(new Error("fetch failed: https://rpc.example/secret-api-key"));

    const refused = await refusalOf(run.deploy());

    expect(refused).toMatchObject({ code: "unavailable" });
    expect(refused.detail).not.toContain("secret-api-key");
    expect(run.server.sendTransaction).not.toHaveBeenCalled();
  });

  it("keeps no floor on testnet unless one is set", async () => {
    const free = scripted({ balance: 1 });
    await expect(free.deploy()).resolves.toMatchObject({ alreadyDeployed: false });
    expect(free.server.getAccountEntry).not.toHaveBeenCalled();

    const floored = scripted({ balance: 5 * XLM, env: { RELAYER_MIN_BALANCE: String(5 * XLM) } });
    expect(await refusalOf(floored.deploy())).toMatchObject({ extra: { reason: "low_balance" } });
  });
});

describe("how much one caller can have paid for on mainnet", () => {
  it("is three account deployments an hour, and twelve for everyone together", async () => {
    vi.useFakeTimers();
    const run = scripted({ network: "mainnet", env: { RELAYER_MAX_DAILY_FEES_MAINNET: String(100 * XLM) } });
    const paid = async (caller: string) => {
      const deployment = run.deploy(caller);
      await vi.advanceTimersByTimeAsync(10);
      return deployment;
    };

    for (let i = 0; i < 3; i += 1) await paid("203.0.113.1");
    const fourth = await refusalOf(run.deploy("203.0.113.1"));
    expect(fourth).toMatchObject({ code: "rate_limited", status: 429, detail: expect.stringMatching(/3 account deployments an hour/) });
    expect(fourth.extra.retryAfterSeconds).toBeGreaterThan(3_500);
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 9; i += 1) await paid(`198.51.100.${i}`);
    const thirteenth = await refusalOf(run.deploy("198.51.100.200"));
    expect(thirteenth).toMatchObject({ code: "unavailable", status: 503, extra: { reason: "hourly_limit" } });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(12);

    // An hour on, the first caller has its three again.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(paid("203.0.113.1")).resolves.toMatchObject({ alreadyDeployed: false });
  });

  it("is six deliveries an hour, counted when one is sent and not when one is asked about", async () => {
    const run = scripted({ network: "mainnet" });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("iris-api.circle.com")
        ? Promise.resolve(Response.json({ messages: [{ message: delivered.message, attestation: delivered.attestation, status: "complete" }] }))
        : realFetch(input, init),
    );
    const nonceUsed = vi.spyOn(run.relayer as unknown as { isNonceUsed: () => Promise<boolean> }, "isNonceUsed").mockResolvedValue(false);
    const burn = (index: number) => ({ network: "mainnet", sourceDomain: delivered.sourceDomain, txHash: `0x${index.toString(16).padStart(64, "0")}` });
    const deliver = (index: number, caller: string) => run.relayer.deliver(burn(index), caller);

    for (let i = 0; i < 6; i += 1) await expect(deliver(i, "203.0.113.1")).resolves.toMatchObject({ status: "delivered" });
    expect(await refusalOf(deliver(6, "203.0.113.1"))).toMatchObject({
      code: "rate_limited",
      detail: expect.stringMatching(/6 deliveries an hour/),
    });
    await expect(deliver(7, "203.0.113.2")).resolves.toMatchObject({ status: "delivered" });

    // A burn that is delivered already costs nothing and counts for nothing.
    nonceUsed.mockResolvedValue(true);
    for (let i = 10; i < 30; i += 1) await expect(deliver(i, "203.0.113.1")).resolves.toMatchObject({ status: "delivered" });
    expect(run.server.sendTransaction).toHaveBeenCalledTimes(7);
  });
});

describe("two networks in one server", () => {
  const shared = globalThis as { pasoRelayers?: unknown; pasoRelayerStates?: unknown; pasoRelayerState?: unknown; pasoRouteLimiters?: unknown };
  const restart = () => {
    delete shared.pasoRelayers;
    delete shared.pasoRelayerStates;
    delete shared.pasoRelayerState;
    delete shared.pasoRouteLimiters;
  };
  type Handler = (request: Request) => Promise<Response>;

  beforeEach(() => {
    vi.resetModules();
    restart();
    for (const [name, value] of Object.entries(both)) vi.stubEnv(name, value);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("PASO_NETWORK", "");
  });
  afterEach(restart);

  const load = async () => (await import("@/lib/server/relayer")).getRelayer;
  const route = async (path: string): Promise<Handler> => (await import(`@/app/api/${path}/route`)).POST;

  it("have a relayer each, with an account, a queue, a budget and a record of its own", async () => {
    const getRelayer = await load();
    const testnet = getRelayer("testnet");
    const mainnet = getRelayer("mainnet");

    expect(getRelayer("testnet")).toBe(testnet);
    expect(getRelayer()).toBe(testnet);
    expect(mainnet).not.toBe(testnet);
    expect(testnet.address).toBe(Keypair.fromSecret(testnetSecret).publicKey());
    expect(mainnet.address).toBe(Keypair.fromSecret(mainnetSecret).publicKey());
    expect(mainnet.config.network.stellar.hub).toBe(NETWORKS.mainnet.stellar.hub);

    const [a, b] = [testnet.state, mainnet.state];
    expect(a).not.toBe(b);
    for (const key of ["queue", "evmQueue", "fees", "sends", "relays", "relaying", "deployments", "deliveries", "delivered", "exits", "spending"] as const) {
      expect(a[key], key).not.toBe(b[key]);
    }

    a.fees.spend(BigInt(499_000_000));
    expect(b.fees.spent()).toBe(BigInt(0));
    expect(b.fees.spend(BigInt(20_000_000))).toBe(true);
    expect(a.fees.spend(BigInt(1_000_000))).toBe(true);
    expect(a.fees.spend(BigInt(1))).toBe(false);
  });

  it("do not share what is on its way: the same owner can be waited for on one and deployed on the other", async () => {
    const owner = randomOwner();
    const testnet = scripted();
    const mainnet = scripted({ network: "mainnet" });
    testnet.server.pollTransaction.mockImplementationOnce(testnet.missing("before"));
    testnet.server.getTransaction.mockImplementation(testnet.missing("before"));

    await refusalOf(testnet.deployOwner(owner));
    expect(testnet.relayer.state.sends.size).toBe(1);

    await expect(mainnet.deployOwner(owner)).resolves.toMatchObject({ alreadyDeployed: false });
    expect(await refusalOf(testnet.deployOwner(owner))).toMatchObject({
      detail: expect.stringContaining("is on its way"),
    });
  });

  it("do not share a caller's allowance: a flood for testnet leaves mainnet's alone, and the other way round", async () => {
    const relay = await route("relay");
    const asking = (network: string) => post("/api/relay", { network, owner: "nobody" });
    const statusesOf = async (network: string, count: number) => {
      const seen: number[] = [];
      for (let i = 0; i < count; i += 1) seen.push((await relay(asking(network))).status);
      return seen;
    };

    expect(await statusesOf("testnet", 31)).toEqual([...new Array(30).fill(400), 429]);
    expect(await statusesOf("mainnet", 31)).toEqual([...new Array(30).fill(400), 429]);

    restart();
    vi.resetModules();
    const again = await route("relay");
    for (let i = 0; i < 31; i += 1) await again(asking("mainnet"));
    expect((await again(asking("mainnet"))).status).toBe(429);
    expect((await again(asking("testnet"))).status).toBe(400);
  });

  it("count a request that names no network, or cannot be read, against the default one", async () => {
    const relay = await route("relay");
    for (let i = 0; i < 30; i += 1) await relay(post("/api/relay", i % 2 ? "not json" : { owner: "nobody" }));

    expect((await relay(post("/api/relay", { network: "testnet", owner: "nobody" }))).status).toBe(429);
    expect((await relay(post("/api/relay", { network: "mainnet", owner: "nobody" }))).status).toBe(400);
  });

  it("answer a request with the relayer of the network it names", async () => {
    const getRelayer = await load();
    const relay = await route("relay");
    const onTestnet = vi.spyOn(getRelayer("testnet"), "relay").mockResolvedValue({ hash: "testnet" });
    const onMainnet = vi.spyOn(getRelayer("mainnet"), "relay").mockResolvedValue({ hash: "mainnet" });
    const owner = randomOwner();

    expect(await (await relay(post("/api/relay", { network: "mainnet", owner }))).json()).toEqual({ hash: "mainnet" });
    expect(await (await relay(post("/api/relay", { network: "testnet", owner }))).json()).toEqual({ hash: "testnet" });
    expect(await (await relay(post("/api/relay", { owner }))).json()).toEqual({ hash: "testnet" });
    expect(onMainnet).toHaveBeenCalledTimes(1);
    expect(onTestnet).toHaveBeenCalledTimes(2);
    expect(onMainnet.mock.calls[0]![1]).toBe("shared");
  });

  describe("when mainnet is not set up", () => {
    const routes = ["relay", "deploy", "cctp/deliver", "cctp/complete", "demo/fund"] as const;
    const notServing = { error: "unavailable", detail: "This server is not serving mainnet right now", reason: "not_serving" };

    it.each([
      ["nothing is set", { PASO_ALLOW_MAINNET: "", RELAYER_SECRET_MAINNET: "" }],
      ["only the switch is set", { RELAYER_SECRET_MAINNET: "" }],
      ["only the account is set", { PASO_ALLOW_MAINNET: "" }],
      ["the switch is not the word true", { PASO_ALLOW_MAINNET: "yes" }],
    ])("every route declines a request for mainnet when %s", async (_, env) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

      for (const path of routes) {
        const response = await (await route(path))(post(`/api/${path}`, { network: "mainnet", owner: randomOwner(), txHash: "ab".repeat(32) }));
        expect(response.status, path).toBe(503);
        expect(await response.json(), path).toEqual(notServing);
      }
      expect(logged).not.toHaveBeenCalled();
      expect(shared.pasoRelayers ?? {}).not.toHaveProperty("mainnet");
    });

    it("testnet goes on as before", async () => {
      vi.stubEnv("PASO_ALLOW_MAINNET", "");
      const deploy = await route("deploy");

      const response = await deploy(post("/api/deploy", { network: "testnet", owner: "nobody" }));

      expect(response.status).toBe(400);
    });

    it("the health check says so, and reports testnet", async () => {
      vi.stubEnv("PASO_ALLOW_MAINNET", "");
      const getRelayer = await load();
      vi.spyOn(getRelayer("testnet"), "health").mockResolvedValue({ ok: true, network: "testnet" } as never);
      const health = (await import("@/app/api/health/route")).GET;

      const body = await (await health(new Request("http://localhost/api/health"))).json();

      expect(body).toEqual({
        ok: true,
        default: "testnet",
        networks: { testnet: { enabled: true, ok: true, network: "testnet" }, mainnet: { enabled: false } },
      });
    });
  });

  it("the health check reports each network on its own", async () => {
    const getRelayer = await load();
    vi.spyOn(getRelayer("testnet"), "health").mockResolvedValue({ ok: true, network: "testnet" } as never);
    vi.spyOn(getRelayer("mainnet"), "health").mockResolvedValue({ ok: false, network: "mainnet" } as never);
    const health = (await import("@/app/api/health/route")).GET;

    const response = await health(new Request("http://localhost/api/health"));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: false,
      default: "testnet",
      networks: { testnet: { enabled: true, ok: true, network: "testnet" }, mainnet: { enabled: true, ok: false, network: "mainnet" } },
    });
    for (const secret of [testnetSecret, mainnetSecret]) expect(text).not.toContain(secret);
  });

  it("the deploy route refuses mainnet, and the mainnet relayer sends nothing for it", async () => {
    const getRelayer = await load();
    const mainnet = getRelayer("mainnet") as unknown as { send: () => Promise<string>; ensureDeployed: () => Promise<string> };
    const send = vi.spyOn(mainnet, "send");
    const ensureDeployed = vi.spyOn(mainnet, "ensureDeployed");
    const deploy = await route("deploy");

    for (const body of [{ network: "mainnet", owner: randomOwner() }, { network: "mainnet", owner: randomOwner(), proof: `0x${"ab".repeat(65)}` }]) {
      const response = await deploy(post("/api/deploy", body));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "not_found",
        detail: "On mainnet an account is deployed only with its owner's first signed call, through /api/relay; this route deploys on testnet only",
      });
    }
    expect(ensureDeployed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("the faucet refuses a request for mainnet, served or not", async () => {
    vi.stubEnv("DEMO_PAYER_PRIVATE_KEY", generatePrivateKey());
    vi.stubEnv("BASE_PAYER_PRIVATE_KEY_MAINNET", generatePrivateKey());
    const getRelayer = await load();
    const burn = vi.spyOn(getRelayer("mainnet") as unknown as { burnForDemo: () => Promise<unknown> }, "burnForDemo");
    const fund = await route("demo/fund");

    const response = await fund(post("/api/demo/fund", { network: "mainnet", owner: randomOwner() }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found", detail: expect.stringContaining("testnet only") });
    expect(burn).not.toHaveBeenCalled();
  });
});

describe("what a relayer reports about itself", () => {
  it("is its account, what it has left to spend today, and its caps: nothing secret", async () => {
    const run = scripted({ network: "mainnet", balance: 7 * XLM });
    vi.spyOn(run.relayer as unknown as { evmClients: () => unknown }, "evmClients").mockReturnValue({ publicClient: {}, walletClient: null });
    await run.deploy();

    const report = await run.relayer.health();

    expect(report).toEqual({
      ok: true,
      network: "mainnet",
      hub: NETWORKS.mainnet.stellar.hub,
      latestLedger: 1,
      relayer: { address: Keypair.fromSecret(mainnetSecret).publicKey(), xlm: "7" },
      payer: null,
      fees: {
        maxResourceFee: "3000000",
        inclusionFee: "100000",
        maxDailyFees: "20000000",
        spentToday: "100100",
        remainingToday: "19899900",
        minBalance: "20000000",
      },
      limits: {
        relay: { perCallerPerHour: 8, perHour: 40 },
        deploy: { perCallerPerHour: 3, perHour: 12 },
        deliver: { perCallerPerHour: 6, perHour: 20 },
      },
      paysFees: true,
      paysBaseMints: false,
      faucet: false,
    });
    expect(JSON.stringify(report)).not.toContain(mainnetSecret);
  });

  it("says it is not paying fees while its account is under what it keeps, or its day is spent", async () => {
    const low = scripted({ network: "mainnet", balance: 2 * XLM - 1 });
    vi.spyOn(low.relayer as unknown as { evmClients: () => unknown }, "evmClients").mockReturnValue({ publicClient: {}, walletClient: null });
    expect(await low.relayer.health()).toMatchObject({ paysFees: false });

    const spent = scripted({ network: "mainnet" });
    vi.spyOn(spent.relayer as unknown as { evmClients: () => unknown }, "evmClients").mockReturnValue({ publicClient: {}, walletClient: null });
    spent.relayer.state.fees.spend(BigInt(20_000_000));
    expect(await spent.relayer.health()).toMatchObject({ paysFees: false, fees: { remainingToday: "0" } });
  });
});

describe("finishing an exit where the server does not pay for the mint", () => {
  const ATTESTATION = exit.attestation as `0x${string}`;
  const RECIPIENT = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
  const hex = (contract: string) => Buffer.from(StrKey.decodeContract(contract)).toString("hex");
  /** Where the fields of a CCTP message start, in bytes: its header is 148 bytes, the burn message follows. */
  const FIELD = { destinationCaller: 108, burnToken: 148 + 4, messageSender: 148 + 100, expirationBlock: 148 + 196 } as const;
  const withField = (message: string, field: keyof typeof FIELD, value: string) => {
    const start = 2 + FIELD[field] * 2;
    return `${message.slice(0, start)}${value}${message.slice(start + value.length)}`;
  };
  /** The testnet exit as it would read on mainnet: burned by the mainnet hub, in mainnet USDC. */
  const MAINNET_EXIT = withField(
    withField(exit.message, "messageSender", hex(NETWORKS.mainnet.stellar.hub)),
    "burnToken",
    hex(NETWORKS.mainnet.stellar.usdc),
  ) as `0x${string}`;

  let exits = 0;
  const freshTxHash = () => `${(exits += 1).toString(16).padStart(4, "0")}${Date.now().toString(16).padStart(60, "0")}`;

  function stubIris(answer: () => Response) {
    const lookups = vi.fn<(url: string) => Response>(() => answer());
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      return /^https:\/\/iris-api(-sandbox)?\.circle\.com\//.test(url) ? Promise.resolve(lookups(url)) : realFetch(input, init);
    });
    return lookups;
  }
  const attested = (message: string) => Response.json({ messages: [{ message, attestation: ATTESTATION, status: "complete" }] });

  interface Base {
    network?: NetworkName;
    env?: Record<string, string>;
    used?: number[];
    simulate?: () => Promise<bigint>;
    block?: number;
  }

  /** A relayer with no key on Base at all, whose reads of Base are scripted. */
  function handingOver({ network = "mainnet", env = {}, used = [0], simulate, block = 1_000_000 }: Base = {}) {
    const relayer = new Relayer(loadConfig({ ...both, ...env }, network));
    const reads = [...used];
    const publicClient = {
      readContract: vi.fn(async () => BigInt(reads.length > 1 ? reads.shift()! : reads[0]!)),
      getBalance: vi.fn(async () => BigInt(0)),
      getBlockNumber: vi.fn(async () => BigInt(block)),
      estimateContractGas: vi.fn<(call: { args: readonly unknown[]; account: string }) => Promise<bigint>>(async () =>
        simulate ? simulate() : BigInt(150_000),
      ),
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: BigInt(1), maxPriorityFeePerGas: BigInt(1) })),
    };
    const writeContract = vi.fn(async () => `0x${"c3".repeat(32)}`);
    const walletClient = relayer.config.payer ? { account: relayer.config.payer, writeContract } : null;
    vi.spyOn(relayer as unknown as { evmClients: () => unknown }, "evmClients").mockReturnValue({ publicClient, walletClient });
    const ask = (txHash = freshTxHash(), caller = "caller") => relayer.complete({ network, txHash }, caller);
    return { relayer, publicClient, writeContract, ask };
  }

  it("answers with the attested message and its attestation on mainnet, and sends nothing", async () => {
    const { ask, publicClient, writeContract } = handingOver();
    const lookups = stubIris(() => attested(MAINNET_EXIT));

    expect(await ask()).toEqual({ status: "attested", message: MAINNET_EXIT, attestation: ATTESTATION });

    expect(lookups.mock.calls[0]![0]).toContain("https://iris-api.circle.com/v2/messages/27?");
    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas.mock.calls[0]![0]).toMatchObject({ args: [MAINNET_EXIT, ATTESTATION], account: RECIPIENT });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("answers pending until Circle has attested the exit", async () => {
    const { ask, publicClient } = handingOver();
    stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));

    expect(await ask()).toEqual({ status: "pending", attestation: "not_found" });
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it("answers minted when Base has the message already", async () => {
    const { ask, publicClient } = handingOver({ used: [1] });
    stubIris(() => attested(MAINNET_EXIT));

    expect(await ask()).toEqual({ status: "minted" });
    expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
  });

  it("checks the exit exactly as it does before paying for one itself", async () => {
    const refused = async (message: string, base: Base = {}) => {
      const { ask } = handingOver(base);
      stubIris(() => attested(message));
      return refusalOf(ask());
    };
    const reverting = async (): Promise<bigint> => {
      const { ContractFunctionRevertedError } = await import("viem");
      const { messageTransmitterAbi } = await import("paso-sdk");
      throw new ContractFunctionRevertedError({ abi: messageTransmitterAbi, functionName: "receiveMessage", message: "Invalid attestation signature" });
    };

    expect(await refused(exit.message)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("not sent through the hub") });
    expect(await refused(withField(MAINNET_EXIT, "burnToken", "cd".repeat(32)))).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringContaining("not the USDC that Circle mints"),
    });
    expect(await refused(withField(MAINNET_EXIT, "expirationBlock", BigInt(1_000_000).toString(16).padStart(64, "0")))).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringContaining("expired at block 1000000"),
    });
    expect(await refused(withField(MAINNET_EXIT, "destinationCaller", `${"00".repeat(12)}${"ab".repeat(20)}`))).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringContaining("names the one address allowed to complete it"),
    });
    expect(await refused(MAINNET_EXIT, { simulate: reverting })).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringContaining("would revert on Base (Invalid attestation signature)"),
    });
  });

  it("answers from memory when asked again, and looks at Base now and then for a mint made meanwhile", async () => {
    vi.useFakeTimers();
    const { ask, publicClient } = handingOver({ used: [0, 0, 1] });
    const lookups = stubIris(() => attested(MAINNET_EXIT));
    const txHash = freshTxHash();

    const first = await ask(txHash);
    expect(first).toMatchObject({ status: "attested" });
    expect(await ask(txHash, "someone else")).toEqual(first);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(publicClient.readContract).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await ask(txHash)).toEqual(first);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await ask(txHash)).toEqual({ status: "minted" });
    expect(lookups).toHaveBeenCalledTimes(1);
  });

  it("still bounds how many exits one caller may have examined", async () => {
    const { ask } = handingOver();
    stubIris(() => attested(MAINNET_EXIT));

    for (let i = 0; i < 30; i += 1) await ask();
    expect(await refusalOf(ask())).toMatchObject({ code: "rate_limited" });
    await expect(ask(freshTxHash(), "someone else")).resolves.toMatchObject({ status: "attested" });
  });

  it("does the same on testnet when told not to pay there, or given no account on Base", async () => {
    const switchedOff = handingOver({ network: "testnet", env: { DEMO_PAYER_PRIVATE_KEY: generatePrivateKey(), PAY_BASE_MINTS_ON_TESTNET: "false" } });
    stubIris(() => attested(exit.message));
    expect(await switchedOff.ask()).toEqual({ status: "attested", message: exit.message, attestation: ATTESTATION });
    expect(switchedOff.writeContract).not.toHaveBeenCalled();

    const noAccount = handingOver({ network: "testnet" });
    expect(await noAccount.ask()).toEqual({ status: "attested", message: exit.message, attestation: ATTESTATION });
  });

  it("pays for the mint on mainnet only when that was asked for by name and it has an account there", async () => {
    const paying = handingOver({ env: { PAY_BASE_MINTS_ON_MAINNET: "true", BASE_PAYER_PRIVATE_KEY_MAINNET: generatePrivateKey() } });
    paying.publicClient.getBalance.mockResolvedValue(BigInt(10 ** 15));
    Object.assign(paying.publicClient, { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) });
    stubIris(() => attested(MAINNET_EXIT));
    expect(await paying.ask()).toEqual({ status: "minted", hash: `0x${"c3".repeat(32)}` });
    expect(paying.writeContract).toHaveBeenCalledTimes(1);

    const askedButNoAccount = handingOver({ env: { PAY_BASE_MINTS_ON_MAINNET: "true" } });
    expect(await askedButNoAccount.ask()).toMatchObject({ status: "attested" });
  });
});
