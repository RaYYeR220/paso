import { decodeBurnMessage, NETWORKS } from "@paso/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as deliverRoute } from "@/app/api/cctp/deliver/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { Relayer, type DeliverResult } from "@/lib/server/relayer";
import delivered from "./fixtures/delivered-message.json";
import { live, post, xlmBalance } from "./helpers";

const IRIS = NETWORKS.testnet.irisUrl;
const realFetch = globalThis.fetch;

/** A burn message that Circle attested and that was delivered on Stellar testnet long ago. */
const MESSAGE = delivered.message as `0x${string}`;
const ATTESTATION = delivered.attestation as `0x${string}`;

let burns = 0;
/** A burn transaction hash nobody has asked about yet, so nothing is remembered for it. */
function freshTxHash(): `0x${string}` {
  burns += 1;
  return `0x${burns.toString(16).padStart(4, "0")}${Date.now().toString(16).padStart(60, "0")}`;
}

/** Answers Iris lookups with `answer` and lets every other request through to the network. */
function stubIris(answer: () => Response) {
  const lookups = vi.fn(answer);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(IRIS) ? Promise.resolve(lookups()) : realFetch(input, init),
  );
  return lookups;
}

const complete = (message: string = MESSAGE) =>
  Response.json({ messages: [{ message, attestation: ATTESTATION, status: "complete" }] });

async function deliver(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await deliverRoute(post("/api/cctp/deliver", body));
  return { status: response.status, body: await response.json() };
}

function offlineRelayer(): Relayer {
  return new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret() }));
}

/** Replaces the relayer's own network calls, so only its decisions are exercised. */
function stubChain(relayer: Relayer, chain: { nonceUsed: boolean[]; send: () => Promise<string> }) {
  const internals = relayer as unknown as { isNonceUsed: () => Promise<boolean>; send: () => Promise<string> };
  const isNonceUsed = vi.spyOn(internals, "isNonceUsed");
  for (const used of chain.nonceUsed) isNonceUsed.mockResolvedValueOnce(used);
  const send = vi.spyOn(internals, "send").mockImplementation(chain.send);
  return { isNonceUsed, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/cctp/deliver, while Circle has not attested the burn", () => {
  const relayer = offlineRelayer();

  it("answers pending when Iris does not know the burn yet", async () => {
    const lookups = stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    const result = await relayer.deliver({ network: "testnet", sourceDomain: 6, txHash: freshTxHash() });

    expect(result).toEqual({ status: "pending", attestation: "not_found" });
    expect(lookups).toHaveBeenCalledTimes(1);
  });

  it("answers pending while Iris waits for finality, with the reason for a delay", async () => {
    stubIris(() =>
      Response.json({
        messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations", delayReason: "insufficient_fee" }],
      }),
    );
    const result = await relayer.deliver({ network: "testnet", sourceDomain: 6, txHash: freshTxHash() });

    expect(result).toEqual({ status: "pending", attestation: "pending", delayReason: "insufficient_fee" });
  });

  it("answers pending when Iris cannot be reached, and asks again on the next request", async () => {
    const lookups = stubIris(() => new Response("Bad Gateway", { status: 502 }));
    const request = { network: "testnet", sourceDomain: 6, txHash: freshTxHash() };

    expect(await relayer.deliver(request)).toEqual({ status: "pending", attestation: "unreachable" });
    expect(await relayer.deliver(request)).toEqual({ status: "pending", attestation: "unreachable" });
    expect(lookups).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/cctp/deliver, once the burn is attested", () => {
  it("delivers through the route the message names and returns the hash", async () => {
    const relayer = offlineRelayer();
    const lookups = stubIris(() => complete());
    const { send } = stubChain(relayer, { nonceUsed: [false], send: async () => "ab".repeat(32) });
    const request = { network: "testnet", sourceDomain: 1, txHash: freshTxHash() };

    expect(await relayer.deliver(request)).toEqual({ status: "delivered", hash: "ab".repeat(32), route: "forwarder" });
    expect(send).toHaveBeenCalledTimes(1);

    // Asked again, it answers from memory: no second lookup, no second transaction.
    expect(await relayer.deliver(request)).toEqual({ status: "delivered", hash: "ab".repeat(32), route: "forwarder" });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends one transaction when the same burn is asked about twice at once", async () => {
    const relayer = offlineRelayer();
    stubIris(() => complete());
    let finish: (hash: string) => void = () => undefined;
    const { send } = stubChain(relayer, {
      nonceUsed: [false],
      send: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    const request = { network: "testnet", sourceDomain: 1, txHash: freshTxHash() };

    const both = Promise.all([relayer.deliver(request), relayer.deliver(request)]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    finish("cd".repeat(32));

    const results = await both;
    expect(results[0]).toEqual({ status: "delivered", hash: "cd".repeat(32), route: "forwarder" });
    expect(results[1]).toEqual(results[0]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats a delivery that lost the race on chain as delivered", async () => {
    const relayer = offlineRelayer();
    stubIris(() => complete());
    stubChain(relayer, {
      nonceUsed: [false, true],
      send: async () => {
        throw new ApiError("transaction_failed", "included and failed", { hash: "ef".repeat(32) });
      },
    });

    const result = await relayer.deliver({ network: "testnet", sourceDomain: 1, txHash: freshTxHash() });
    expect(result).toEqual({ status: "delivered", route: "forwarder" });
  });

  it("reports a delivery that failed for a reason of its own", async () => {
    const relayer = offlineRelayer();
    stubIris(() => complete());
    stubChain(relayer, {
      nonceUsed: [false, false],
      send: async () => {
        throw new ApiError("transaction_failed", "included and failed", { hash: "ef".repeat(32) });
      },
    });

    await expect(relayer.deliver({ network: "testnet", sourceDomain: 1, txHash: freshTxHash() })).rejects.toMatchObject({
      code: "transaction_failed",
    });
  });

  it("refuses a message that is not addressed to Stellar", async () => {
    const relayer = offlineRelayer();
    const elsewhere = `${MESSAGE.slice(0, 18)}00000003${MESSAGE.slice(26)}`;
    expect(decodeBurnMessage(elsewhere as `0x${string}`).destinationDomain).toBe(3);
    stubIris(() => complete(elsewhere));

    await expect(relayer.deliver({ network: "testnet", sourceDomain: 1, txHash: freshTxHash() })).rejects.toMatchObject({
      code: "bad_request",
      detail: expect.stringContaining("not to Stellar"),
    });
  });

  it("refuses a message too large to be a USDC transfer, without decoding it", async () => {
    const relayer = offlineRelayer();
    const chain = stubChain(relayer, { nonceUsed: [], send: async () => "ab".repeat(32) });
    stubIris(() => complete(`${MESSAGE}${"00".repeat(8_192)}`));

    await expect(relayer.deliver({ network: "testnet", sourceDomain: 1, txHash: freshTxHash() })).rejects.toMatchObject({
      code: "bad_request",
      detail: expect.stringContaining("too large"),
    });
    expect(chain.isNonceUsed).not.toHaveBeenCalled();
    expect(chain.send).not.toHaveBeenCalled();
  });

  it("stops waiting for Iris and answers pending when it hangs", async () => {
    vi.useFakeTimers();
    const relayer = offlineRelayer();
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );

    const answer = relayer.deliver({ network: "testnet", sourceDomain: 6, txHash: freshTxHash() });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await answer).toEqual({ status: "pending", attestation: "unreachable" });
    vi.useRealTimers();
  });

  it("declines new burns while too many lookups are under way, and takes them again afterwards", async () => {
    const relayer = offlineRelayer();
    const answers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => answers.push(resolve)));
    const ask = () => relayer.deliver({ network: "testnet", sourceDomain: 6, txHash: freshTxHash() });

    const under = Array.from({ length: 64 }, ask);
    await expect(ask()).rejects.toMatchObject({ code: "unavailable", detail: expect.stringContaining("busy") });

    for (const answer of answers) answer(Response.json({ error: "Message not found" }, { status: 404 }));
    expect(new Set((await Promise.all(under)).map((result) => result.status))).toEqual(new Set(["pending"]));
    stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    await expect(ask()).resolves.toEqual({ status: "pending", attestation: "not_found" });
  });

  it("refuses requests that do not name a burn", async () => {
    const relayer = offlineRelayer();
    const good = { network: "testnet", sourceDomain: 6, txHash: freshTxHash() };

    await expect(relayer.deliver({ ...good, txHash: "0x1234" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, sourceDomain: 27 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, sourceDomain: "6" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, sourceDomain: -1 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, sourceDomain: 6.5 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, sourceDomain: 2 ** 32 })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, txHash: `0x${"a".repeat(65)}` })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, txHash: `0x${"g".repeat(64)}` })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, txHash: ["0x"] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver({ ...good, network: "mainnet" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(relayer.deliver("0xabc")).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe.skipIf(!live)("POST /api/cctp/deliver, for a message testnet has already seen", () => {
  it("answers delivered, without a hash and without spending anything, however often it is asked", async () => {
    stubIris(() => complete());
    const relayerAddress = Keypair.fromSecret(process.env.RELAYER_SECRET!).publicKey();
    const before = await xlmBalance(relayerAddress);
    const request = { network: "testnet", sourceDomain: delivered.sourceDomain, txHash: freshTxHash() };

    const first = await deliver(request);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "delivered", route: "forwarder" });

    const second = await deliver(request);
    expect(second.body).toEqual({ status: "delivered", route: "forwarder" });
    expect(await xlmBalance(relayerAddress)).toBe(before);
  });

  it("recognises Circle's nonce-already-used error when the delivery is attempted anyway", async () => {
    stubIris(() => complete());
    const relayer = new Relayer(loadConfig());
    const internals = relayer as unknown as { isNonceUsed: () => Promise<boolean> };
    vi.spyOn(internals, "isNonceUsed").mockResolvedValueOnce(false);
    const before = await xlmBalance(relayer.address);

    const result: DeliverResult = await relayer.deliver({
      network: "testnet",
      sourceDomain: delivered.sourceDomain,
      txHash: freshTxHash(),
    });

    expect(result).toEqual({ status: "delivered", route: "forwarder" });
    expect(await xlmBalance(relayer.address)).toBe(before);
  });

  it("answers pending through the route when Iris has nothing yet", async () => {
    stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    const { status, body } = await deliver({ network: "testnet", sourceDomain: 6, txHash: freshTxHash() });

    expect(status).toBe(200);
    expect(body).toEqual({ status: "pending", attestation: "not_found" });
  });
});
