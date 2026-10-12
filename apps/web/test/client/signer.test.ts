import { prepare, sign } from "@paso/sdk";
import { isAddressEqual, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { ApiFailure, createApi } from "@/lib/client/api";
import { DEMO_KEY_STORAGE, DEMO_LABEL, ensureDemoKey, forgetDemoKey, loadDemoKey } from "@/lib/client/demoKey";
import { memoryStorage } from "@/lib/client/storage";
import { BURN, network, RECIPIENT, recordingServer, twin } from "./helpers";

describe("the demo key", () => {
  it("is made once and found again", () => {
    const storage = memoryStorage();
    expect(loadDemoKey(storage)).toBeNull();
    const key = ensureDemoKey(storage);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ensureDemoKey(storage)).toBe(key);
    expect(loadDemoKey(storage)).toBe(key);
  });

  it("is replaced by a different one after being forgotten", () => {
    const storage = memoryStorage();
    const first = ensureDemoKey(storage);
    forgetDemoKey(storage);
    expect(loadDemoKey(storage)).toBeNull();
    expect(ensureDemoKey(storage)).not.toBe(first);
  });

  it("ignores stored text that is not a key, and works without storage", () => {
    expect(loadDemoKey(memoryStorage({ [DEMO_KEY_STORAGE]: "hello" }))).toBeNull();
    expect(ensureDemoKey(null)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("says what it is", () => {
    expect(DEMO_LABEL).toMatch(/demo/i);
    expect(DEMO_LABEL).toMatch(/testnet/i);
  });

  it("signs a prepared call as the owner of its account, with nothing but the browser", async () => {
    const account = privateKeyToAccount(ensureDemoKey(memoryStorage()));
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
    const api = createApi({ fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    await expect(api.health()).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("lets an aborted request stay aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const api = createApi({ fetch: (async () => Promise.reject(new DOMException("Aborted", "AbortError"))) as unknown as typeof fetch });
    await expect(api.deliver({ sourceDomain: 6, txHash: BURN }, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
