import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { post } from "./helpers";

vi.mock("next/server", () => ({ connection: async () => undefined }));

type Handler = (request: Request) => Promise<Response>;

const shared = globalThis as { pasoRelayer?: unknown; pasoRelayerState?: unknown; pasoRouteLimiters?: unknown };

/** What a server process keeps between requests. Forgetting it is what a restart does. */
function restart(): void {
  delete shared.pasoRelayer;
  delete shared.pasoRelayerState;
  delete shared.pasoRouteLimiters;
}

/** Each test gets a process that has counted nothing, and a relayer of its own. */
beforeEach(() => {
  vi.resetModules();
  restart();
  vi.stubEnv("RELAYER_SECRET", Keypair.random().secret());
  vi.stubEnv("VERCEL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  restart();
});

const relayRoute = async (): Promise<Handler> => (await import("@/app/api/relay/route")).POST;
const deployRoute = async (): Promise<Handler> => (await import("@/app/api/deploy/route")).POST;
const fundRoute = async (): Promise<Handler> => (await import("@/app/api/demo/fund/route")).POST;
const healthRoute = async (): Promise<Handler> => (await import("@/app/api/health/route")).GET;

/** Sends `count` requests one after another and returns their statuses. */
async function statuses(handler: Handler, count: number, request: (index: number) => Request): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < count; i += 1) seen.push((await handler(request(i))).status);
  return seen;
}

describe("who a request is counted against", () => {
  it("is not chosen by the caller: a new x-forwarded-for each time is still one caller", async () => {
    const relay = await relayRoute();
    const spoofing = (index: number) => post("/api/relay", "not json", { "x-forwarded-for": `198.51.100.${index}` });

    expect(await statuses(relay, 30, spoofing)).toEqual(new Array(30).fill(400));
    const limited = await relay(spoofing(30));

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("is not chosen by the caller on Vercel either, where the platform names the address", async () => {
    vi.stubEnv("VERCEL", "1");
    const relay = await relayRoute();
    const from = (address: string, claimed: string) =>
      post("/api/relay", "not json", { "x-vercel-forwarded-for": address, "x-forwarded-for": claimed });

    expect(await statuses(relay, 30, (index) => from("203.0.113.50", `198.51.100.${index}`))).toEqual(new Array(30).fill(400));
    expect((await relay(from("203.0.113.50", "198.51.100.200"))).status).toBe(429);

    // Another address, as the platform reports it, has an allowance of its own.
    expect((await relay(from("203.0.113.51", "198.51.100.200"))).status).toBe(400);
  });

  it("does not matter to the limit a route has for everyone together", async () => {
    vi.stubEnv("VERCEL", "1");
    const deploy = await deployRoute();
    const stranger = (index: number) =>
      post("/api/deploy", { network: "testnet", owner: "nobody" }, { "x-vercel-forwarded-for": `203.0.${index >> 8}.${index & 255}` });

    expect(await statuses(deploy, 60, stranger)).toEqual(new Array(60).fill(400));
    const limited = await deploy(stranger(60));

    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("applies to the faucet and to the health check as well", async () => {
    const fund = await fundRoute();
    expect(await statuses(fund, 10, () => post("/api/demo/fund", { owner: "nobody" }))).toEqual(new Array(10).fill(400));
    expect((await fund(post("/api/demo/fund", { owner: "nobody" }))).status).toBe(429);

    const health = await healthRoute();
    const { getRelayer } = await import("@/lib/server/relayer");
    const read = vi.spyOn(getRelayer(), "health").mockResolvedValue({ ok: true } as never);
    const ask = () => new Request("http://localhost/api/health");

    expect(await statuses(health, 60, ask)).toEqual(new Array(60).fill(200));
    expect((await health(ask())).status).toBe(429);
    expect(read).toHaveBeenCalledTimes(60);
  });
});

describe("replacing the code while the process runs", () => {
  it("does not start the request counts over", async () => {
    const spoofing = () => post("/api/relay", "not json");
    expect(await statuses(await relayRoute(), 30, spoofing)).toEqual(new Array(30).fill(400));

    // What a development server does on an edit: the modules are loaded afresh, the process stays.
    vi.resetModules();
    const reloaded = await relayRoute();

    expect((await reloaded(spoofing())).status).toBe(429);
  });
});

describe("replacing the relayer's code while the process runs", () => {
  const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;
  type Faucet = { assertFaucetFunded: () => Promise<void>; burnForDemo: () => Promise<unknown> };
  /** Takes the payer to be funded and the burn to succeed, so that only the relayer's own rules decide. */
  function funded(relayer: unknown): void {
    vi.spyOn(relayer as Faucet, "assertFaucetFunded").mockResolvedValue(undefined);
    vi.spyOn(relayer as Faucet, "burnForDemo").mockResolvedValue({ burnTxHash: "0x00", sourceDomain: 6, twin: "C", amount: "1000000" });
  }
  const load = async () => (await import("@/lib/server/relayer")).getRelayer();

  it("keeps what it has counted, spent and sent", async () => {
    vi.stubEnv("DEMO_PAYER_PRIVATE_KEY", generatePrivateKey());
    vi.stubEnv("DEMO_FUND_PER_DAY", "1");
    const first = await load();
    funded(first);
    await first.demoFund({ owner: randomOwner() }, "caller");
    first.state.fees.spend(BigInt(1_234));
    first.state.sends.set("deploy:0xabc", { hash: "ab".repeat(32), deadline: Date.now() + 60_000 });
    expect(await load()).toBe(first);

    // The module is loaded afresh, as on an edit: a new class, so a new relayer.
    vi.resetModules();
    const second = await load();
    funded(second);

    expect(second).not.toBe(first);
    expect(second.state).toBe(first.state);
    await expect(second.demoFund({ owner: randomOwner() }, "someone else")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("all it gives in a day"),
    });
    expect(second.state.fees.spent()).toBe(BigInt(1_234));
    expect(second.state.sends.has("deploy:0xabc")).toBe(true);
    expect(second.state.inFlight()).toBe(1);
  });

  it("pays for nothing until the transactions of code it cannot take over from have settled", async () => {
    vi.stubEnv("DEMO_PAYER_PRIVATE_KEY", generatePrivateKey());
    let waiting = 1;
    shared.pasoRelayerState = { version: -1, inFlight: () => waiting };
    const relayer = await load();
    funded(relayer);

    expect(relayer.state.predecessor).toBeDefined();
    await expect(relayer.demoFund({ owner: randomOwner() }, "caller")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("restarted with transactions on their way"),
    });

    waiting = 0;
    await expect(relayer.demoFund({ owner: randomOwner() }, "caller")).resolves.toBeDefined();
  });

  it("gives itself a few minutes when it cannot even ask the code it replaced", async () => {
    vi.stubEnv("DEMO_PAYER_PRIVATE_KEY", generatePrivateKey());
    shared.pasoRelayerState = { queue: "from another time" };
    const relayer = await load();
    funded(relayer);

    await expect(relayer.demoFund({ owner: randomOwner() }, "caller")).rejects.toMatchObject({ code: "unavailable" });
    expect(relayer.state.predecessor?.until).toBeGreaterThan(Date.now() + 170_000);
    expect(relayer.state.predecessor?.until).toBeLessThanOrEqual(Date.now() + 180_000);
  });
});

describe("what a request may carry", () => {
  it("is read up to the limit and no further", async () => {
    const relay = await relayRoute();
    const { MAX_BODY_BYTES } = await import("@/lib/server/http");
    const padded = (bytes: number) => JSON.stringify({ network: "testnet", padding: "x".repeat(bytes) });

    const oversized = await relay(post("/api/relay", padded(MAX_BODY_BYTES)));
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: "bad_request", detail: expect.stringContaining("too large") });

    // Well under the limit, the same request is read and refused for what it says instead.
    const small = await relay(post("/api/relay", padded(1_000)));
    expect((await small.json()).detail).not.toContain("too large");
  });

  it("is refused unread when it declares more than the limit", async () => {
    const relay = await relayRoute();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    const request = new Request("http://localhost/api/relay", {
      method: "POST",
      headers: { "content-length": "10000000" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await relay(request);

    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("too large");
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("is cut off at the limit when it never ends", async () => {
    const relay = await relayRoute();
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 16_384;
        controller.enqueue(new Uint8Array(16_384).fill(0x20));
      },
    });
    const request = new Request("http://localhost/api/relay", { method: "POST", body: endless, duplex: "half" } as RequestInit);

    const response = await relay(request);

    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("too large");
    expect(sent).toBeLessThan(200_000);
  });

  it("is bounded in what it asks the server to decode", async () => {
    const relay = await relayRoute();
    const request = { network: "testnet", owner: "0x000000000000000000000000000000000000dEaD", func: "AAAA", auth: ["AAAA"] };
    const refusedFor = async (body: unknown) => (await (await relay(post("/api/relay", body))).json()) as { detail: string };

    for (const body of [
      { ...request, auth: ["AAAA", "AAAA", "AAAA"] },
      { ...request, func: "A".repeat(16_385) },
      { ...request, auth: ["A".repeat(16_385)] },
      { ...request, owner: `0x${"a".repeat(41)}` },
      { ...request, auth: "AAAA" },
      { ...request, auth: [5] },
    ]) {
      expect((await refusedFor(body)).detail).toMatch(/^owner must be an Ethereum address, func a base64 host function/);
    }
  });
});

describe("what an answer may reveal", () => {
  it("says the server is not configured without naming the setting", async () => {
    vi.stubEnv("RELAYER_SECRET", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deploy = await deployRoute();

    const response = await deploy(post("/api/deploy", { network: "testnet", owner: "0x000000000000000000000000000000000000dEaD" }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: "unavailable", detail: "The server is not configured" });
    expect(text).not.toContain("RELAYER_SECRET");
    expect(logged).toHaveBeenCalledWith("Configuration:", "RELAYER_SECRET is not set");
  });

  it("refuses to run on mainnet unless that was asked for in so many words", async () => {
    vi.stubEnv("PASO_NETWORK", "mainnet");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deploy = await deployRoute();

    const response = await deploy(post("/api/deploy", { network: "mainnet", owner: "0x000000000000000000000000000000000000dEaD" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable", detail: "The server is not configured" });
  });

  it("keeps the text of an unexpected error to the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deploy = await deployRoute();
    const { getRelayer } = await import("@/lib/server/relayer");
    vi.spyOn(getRelayer(), "deploy").mockRejectedValue(
      new Error("connect ECONNREFUSED https://rpc.example/v1/secret-api-key\n    at /srv/app/lib/server/relayer.ts:1:1"),
    );

    const response = await deploy(post("/api/deploy", { network: "testnet", owner: "0x000000000000000000000000000000000000dEaD" }));
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: "unavailable", detail: "The server could not complete the request; try again" });
    expect(text).not.toMatch(/secret-api-key|relayer\.ts|ECONNREFUSED/);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("is one bounded line even when a refusal quotes something long", async () => {
    const { failure } = await import("@/lib/server/http");
    const { ApiError } = await import("@/lib/server/errors");

    const body = await failure(new ApiError("bad_request", `first line\n    at somewhere\t${"x".repeat(2_000)}`)).json();

    expect(body.detail).toMatch(/^first line at somewhere x+…$/);
    expect(body.detail.length).toBeLessThanOrEqual(401);
  });
});
