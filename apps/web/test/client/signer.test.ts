import { prepare, sign } from "paso-sdk";
import { isAddressEqual, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ApiFailure, createApi } from "@/lib/client/api";
import { ROUTES } from "@/lib/client/config";
import { DEMO_KEY_STORAGE, DEMO_LABEL, DEMO_TESTNET_ONLY, ensureDemoKey, forgetDemoKey, loadDemoKey } from "@/lib/client/demoKey";
import { demoState, signerState, startDemo } from "@/lib/client/signer";
import { memoryStorage } from "@/lib/client/storage";
import { BURN, network, RECIPIENT, recordingServer, twin } from "./helpers";

describe("the demo key", () => {
  it("is made once and found again", () => {
    const storage = memoryStorage();
    expect(loadDemoKey("testnet", storage)).toBeNull();
    const key = ensureDemoKey("testnet", storage);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ensureDemoKey("testnet", storage)).toBe(key);
    expect(loadDemoKey("testnet", storage)).toBe(key);
  });

  it("is replaced by a different one after being forgotten", () => {
    const storage = memoryStorage();
    const first = ensureDemoKey("testnet", storage);
    forgetDemoKey(storage);
    expect(loadDemoKey("testnet", storage)).toBeNull();
    expect(ensureDemoKey("testnet", storage)).not.toBe(first);
  });

  it("ignores stored text that is not a key, and works without storage", () => {
    expect(loadDemoKey("testnet", memoryStorage({ [DEMO_KEY_STORAGE]: "hello" }))).toBeNull();
    expect(ensureDemoKey("testnet", null)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("says what it is", () => {
    expect(DEMO_LABEL).toMatch(/demo/i);
    expect(DEMO_LABEL).toMatch(/testnet/i);
  });

  it("signs a prepared call as the owner of its account, with nothing but the browser", async () => {
    const account = privateKeyToAccount(ensureDemoKey("testnet", memoryStorage()));
    const prepared = await prepare(
      { kind: "transfer", to: RECIPIENT, amount: 1n },
      { owner: account.address, network, server: recordingServer(account.address) },
    );
    const signed = await sign(prepared, { signTypedData: (typedData) => account.signTypedData(typedData) });
    const signedBy = await recoverTypedDataAddress({ ...prepared.typedData, signature: signed.signature });
    expect(isAddressEqual(signedBy, account.address)).toBe(true);
    expect(prepared.account).not.toBe(twin);
  });
});

describe("the demo signer on mainnet", () => {
  const key = `0x${"3c".repeat(32)}` as const;

  it("is nothing at all, whatever the browser remembers", () => {
    const remembered = { chosen: { testnet: "demo", mainnet: "demo" }, demoKey: key } as const;

    expect(demoState("testnet", remembered)).toEqual({ available: true, key, chosen: true });
    expect(demoState("mainnet", remembered)).toEqual({ available: false, key: null, chosen: false });
    expect(demoState("testnet", { chosen: { testnet: "wallet", mainnet: null }, demoKey: key })).toEqual({ available: true, key, chosen: false });
  });

  it("cannot be started: no key is made, nothing is chosen, and the reason is said", () => {
    const before = signerState.get();

    expect(startDemo("mainnet")).toBe(false);

    expect(signerState.get().error).toBe(DEMO_TESTNET_ONLY);
    expect(signerState.get().chosen).toEqual(before.chosen);
    expect(signerState.get().demoKey).toBe(before.demoKey);
    expect(DEMO_TESTNET_ONLY).toMatch(/testnet only/);
  });

  it("stays off mainnet after the demo was started on testnet", () => {
    expect(startDemo("testnet")).toBe(true);
    const state = signerState.get();

    expect(state.chosen).toEqual({ testnet: "demo", mainnet: null });
    expect(state.demoKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(state.error).toBeNull();
    expect(demoState("mainnet", state)).toEqual({ available: false, key: null, chosen: false });

    const key = state.demoKey;
    expect(startDemo("testnet", true)).toBe(true);
    expect(signerState.get().demoKey).not.toBe(key);
  });
});

describe("the API client", () => {
  function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
    }) as unknown as typeof fetch;
    return { requests, api: createApi({ fetch: fetcher, baseUrl: "http://paso.test", network: "testnet" }) };
  }

  it("names the network in every request", async () => {
    const { api, requests } = respond(200, { status: "pending", attestation: "pending" });
    await api.deliver({ sourceDomain: 6, txHash: BURN });
    expect(requests[0]?.url).toBe("http://paso.test/api/cctp/deliver");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ network: "testnet", sourceDomain: 6, txHash: BURN });
    expect(requests[0]?.init.method).toBe("POST");

    const requestsOnMainnet: RequestInit[] = [];
    const mainnet = createApi({
      network: "mainnet",
      fetch: (async (_: string, init: RequestInit) => {
        requestsOnMainnet.push(init);
        return new Response(JSON.stringify({ status: "pending", attestation: "pending" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await mainnet.deliver({ sourceDomain: 6, txHash: BURN });
    expect(requestsOnMainnet.map((init) => JSON.parse(String(init.body)).network)).toEqual(["mainnet"]);
  });

  it("has no way to ask for an account to be deployed on its own", () => {
    const api = createApi({ network: "mainnet" });
    expect(Object.keys(api).sort()).toEqual(["deliver", "demoFund", "health"]);
    expect(Object.values(ROUTES)).not.toContain("/api/deploy");
  });

  it("carries the server's reason for declining, when it gives one it knows", async () => {
    const declined = respond(503, { error: "unavailable", detail: "This server is not serving mainnet right now", reason: "not_serving" });
    await expect(declined.api.deliver({ sourceDomain: 6, txHash: BURN })).rejects.toMatchObject({ code: "unavailable", reason: "not_serving" });

    const other = respond(503, { error: "unavailable", detail: "busy", reason: "something new" });
    const refusal = (await other.api.deliver({ sourceDomain: 6, txHash: BURN }).catch((error: unknown) => error)) as ApiFailure;
    expect(refusal.reason).toBeUndefined();
  });

  it("turns a refusal into its code, its sentence and its wait", async () => {
    const { api } = respond(429, { error: "rate_limited", detail: "Too many requests; try again shortly" }, { "retry-after": "17" });
    const refusal = await api.demoFund(`0x${"11".repeat(20)}`).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiFailure);
    expect(refusal).toMatchObject({ code: "rate_limited", status: 429, detail: "Too many requests; try again shortly", retryAfterSeconds: 17 });
  });

  it("copes with an answer that is not JSON", async () => {
    const { api } = respond(502, "<html>Bad gateway</html>");
    await expect(api.health()).rejects.toMatchObject({ code: "unavailable", status: 502, detail: "The server answered 502" });
  });

  it("reports a server that cannot be reached", async () => {
    const api = createApi({ network: "testnet", fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    await expect(api.health()).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("lets an aborted request stay aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const api = createApi({ network: "testnet", fetch: (async () => Promise.reject(new DOMException("Aborted", "AbortError"))) as unknown as typeof fetch });
    await expect(api.deliver({ sourceDomain: 6, txHash: BURN }, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
