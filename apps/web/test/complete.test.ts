import { NETWORKS } from "@paso/sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as completeRoute } from "@/app/api/cctp/complete/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { Relayer, type DemoFundResult } from "@/lib/server/relayer";
import inbound from "./fixtures/delivered-message.json";
import exit from "./fixtures/exit-message.json";
import { live, post } from "./helpers";

const IRIS = NETWORKS.testnet.irisUrl;
const realFetch = globalThis.fetch;

/** An exit through the hub on testnet, as Circle attested it: 0.5 USDC from Stellar to Base. */
const MESSAGE = exit.message as `0x${string}`;
const ATTESTATION = exit.attestation as `0x${string}`;
const MINT_HASH = `0x${"c3".repeat(32)}`;
const ETH = 10 ** 15;

const payerKey = generatePrivateKey();
const env = { RELAYER_SECRET: Keypair.random().secret(), DEMO_PAYER_PRIVATE_KEY: payerKey };

let exits = 0;
/** A Stellar transaction hash nobody has asked about yet. */
function freshTxHash(): string {
  exits += 1;
  return `${exits.toString(16).padStart(4, "0")}${Date.now().toString(16).padStart(60, "0")}`;
}
const request = () => ({ network: "testnet", txHash: freshTxHash() });

/** Answers Iris lookups, sandbox or not, with `answer`, records what was asked, and lets other requests through. */
function stubIris(answer: () => Response) {
  const lookups = vi.fn<(url: string) => Response>(() => answer());
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return /^https:\/\/iris-api(-sandbox)?\.circle\.com\//.test(url) ? Promise.resolve(lookups(url)) : realFetch(input, init);
  });
  return lookups;
}

const attested = (message: string = MESSAGE) =>
  Response.json({ messages: [{ message, attestation: ATTESTATION, status: "complete" }] });

interface Base {
  /** What `usedNonces` answers, read after read; the last answer from then on. */
  used?: number[];
  wei?: number;
  write?: () => Promise<string>;
  env?: Record<string, string>;
}

/** A relayer whose view of Base is scripted: nonce state, the payer's ETH, and what sending the mint does. */
function completing({ used = [0], wei = ETH, write, env: overrides = {} }: Base = {}) {
  const relayer = new Relayer(loadConfig({ ...env, ...overrides }));
  const reads = [...used];
  const publicClient = {
    readContract: vi.fn<(call: { functionName: string }) => Promise<bigint>>(async () =>
      BigInt(reads.length > 1 ? reads.shift()! : reads[0]!),
    ),
    getBalance: vi.fn(async () => BigInt(wei)),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
  };
  const walletClient = {
    account: privateKeyToAccount(payerKey),
    writeContract: vi.fn<(call: { address: string; functionName: string; args: readonly unknown[] }) => Promise<string>>(
      async () => (write ? write() : MINT_HASH),
    ),
  };
  vi.spyOn(relayer as unknown as { evmClients: () => unknown }, "evmClients").mockReturnValue({ publicClient, walletClient });
  return { relayer, publicClient, walletClient };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/cctp/complete, while Circle has not attested the exit", () => {
  it("answers pending, and asks Circle about a burn made on Stellar under the bare hash", async () => {
    const { relayer, publicClient } = completing();
    const lookups = stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    const asked = request();

    expect(await relayer.complete(asked, "caller")).toEqual({ status: "pending", attestation: "not_found" });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(lookups.mock.calls[0]![0]).toBe(`${IRIS}/v2/messages/27?transactionHash=${asked.txHash}`);
    expect(publicClient.readContract).not.toHaveBeenCalled();
  });

  it("answers pending while Circle waits for finality, or cannot be reached", async () => {
    const { relayer, walletClient } = completing();

    stubIris(() => Response.json({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] }));
    expect(await relayer.complete(request(), "caller")).toEqual({ status: "pending", attestation: "pending" });

    stubIris(() => new Response("Bad Gateway", { status: 502 }));
    expect(await relayer.complete(request(), "caller")).toEqual({ status: "pending", attestation: "pending" });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("asks again on every request until the exit is attested", async () => {
    const { relayer } = completing();
    const lookups = stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    const asked = request();

    await relayer.complete(asked, "caller");
    await relayer.complete(asked, "caller");
    expect(lookups).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/cctp/complete, once the exit is attested", () => {
  it("submits one receiveMessage with exactly the bytes Circle returned, and returns its hash", async () => {
    const { relayer, publicClient, walletClient } = completing();
    const lookups = stubIris(() => attested());
    const asked = request();

    expect(await relayer.complete(asked, "caller")).toEqual({ status: "minted", hash: MINT_HASH });

    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    const call = walletClient.writeContract.mock.calls[0]![0];
    expect(call.address).toBe(NETWORKS.testnet.evm.messageTransmitter);
    expect(call.functionName).toBe("receiveMessage");
    expect(call.args).toEqual([MESSAGE, ATTESTATION]);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MINT_HASH });

    // Asked again, it answers from memory: no lookup, no second transaction.
    expect(await relayer.complete(asked, "someone else")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("takes nothing but the hash from the caller", async () => {
    const { relayer, walletClient } = completing();
    stubIris(() => attested());

    await relayer.complete({ ...request(), message: `0x${"ff".repeat(376)}`, attestation: `0x${"ee".repeat(130)}` }, "caller");

    expect(walletClient.writeContract.mock.calls[0]![0].args).toEqual([MESSAGE, ATTESTATION]);
  });

  it("sends one transaction when the same exit is asked about twice at once", async () => {
    let finish: (hash: string) => void = () => undefined;
    const { relayer, walletClient } = completing({ write: () => new Promise<string>((resolve) => (finish = resolve)) });
    stubIris(() => attested());
    const asked = request();

    const both = Promise.all([relayer.complete(asked, "caller"), relayer.complete(asked, "caller")]);
    await vi.waitFor(() => expect(walletClient.writeContract).toHaveBeenCalledTimes(1));
    finish(MINT_HASH);

    expect(await both).toEqual([
      { status: "minted", hash: MINT_HASH },
      { status: "minted", hash: MINT_HASH },
    ]);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("answers minted without a hash when Base has the message already, and spends nothing", async () => {
    const { relayer, walletClient } = completing({ used: [1], env: { BASE_MINTS_PER_DAY: "1" } });
    stubIris(() => attested());

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("answers minted without a hash when its own call lost the race", async () => {
    const { relayer, walletClient } = completing({
      used: [0, 0, 1],
      write: async () => {
        throw new Error("execution reverted: Nonce already used");
      },
    });
    stubIris(() => attested());

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });
});

describe("what the server will not complete", () => {
  const refusal = async (relayer: Relayer, body: unknown = request()) =>
    (await relayer.complete(body, "caller").catch((error: unknown) => error)) as ApiError;

  it("refuses a transfer that does not go from Stellar to Base", async () => {
    const { relayer, publicClient, walletClient } = completing();

    // A real message the other way round: Ethereum to Stellar.
    stubIris(() => attested(inbound.message));
    expect(await refusal(relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("from CCTP domain 1 to 27") });

    // From Stellar, but to Arbitrum.
    stubIris(() => attested(`${MESSAGE.slice(0, 18)}00000003${MESSAGE.slice(26)}`));
    expect(await refusal(relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("from CCTP domain 27 to 3") });

    // To Base, but not from Stellar.
    stubIris(() => attested(`${MESSAGE.slice(0, 10)}00000000${MESSAGE.slice(18)}`));
    expect(await refusal(relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("from CCTP domain 0 to 6") });

    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("refuses a burn that was not made through the hub", async () => {
    const { relayer, walletClient } = completing();
    const sender = 2 + (148 + 100) * 2;
    stubIris(() => attested(`${MESSAGE.slice(0, sender)}${"ab".repeat(32)}${MESSAGE.slice(sender + 64)}`));

    expect(await refusal(relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("not sent through the hub") });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("refuses a message too large to be a transfer, and one that is not a transfer at all", async () => {
    const { relayer } = completing();

    stubIris(() => attested(`${MESSAGE}${"00".repeat(8_192)}`));
    expect(await refusal(relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("too large") });

    stubIris(() => attested(MESSAGE.slice(0, 300)));
    expect(await refusal(relayer)).toMatchObject({ code: "bad_request" });
  });

  it("refuses a hash with 0x, of the wrong length, or for another network", async () => {
    const { relayer } = completing();
    const lookups = stubIris(() => attested());
    const txHash = freshTxHash();

    for (const body of [
      { network: "testnet", txHash: `0x${txHash}` },
      { network: "testnet", txHash: txHash.slice(1) },
      { network: "testnet", txHash: `${txHash}0` },
      { network: "testnet", txHash: `${"g".repeat(64)}` },
      { network: "testnet", txHash: 5 },
      { network: "testnet" },
      { network: "mainnet", txHash },
      { txHash },
      [txHash],
      null,
    ]) {
      expect(await refusal(relayer, body)).toMatchObject({ code: "bad_request" });
    }
    expect(lookups).not.toHaveBeenCalled();
  });

  it("does not pay for mints on mainnet unless that was asked for by name", async () => {
    const onMainnet = { PASO_NETWORK: "mainnet", PASO_ALLOW_MAINNET: "true" };
    const body = { network: "mainnet", txHash: freshTxHash() };
    const lookups = stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));

    const byDefault = completing({ env: onMainnet });
    expect(await refusal(byDefault.relayer, body)).toMatchObject({
      code: "not_found",
      status: 404,
      detail: expect.stringContaining("your own wallet"),
    });
    expect(lookups).not.toHaveBeenCalled();

    const askedFor = completing({ env: { ...onMainnet, PAY_BASE_MINTS_ON_MAINNET: "true" } });
    expect(await askedFor.relayer.complete(body, "caller")).toEqual({ status: "pending", attestation: "not_found" });
    expect(lookups.mock.calls[0]![0]).toContain("https://iris-api.circle.com/v2/messages/27?");
  });

  it("is unavailable without an account on Base", async () => {
    const relayer = new Relayer(loadConfig({ RELAYER_SECRET: env.RELAYER_SECRET }));
    const lookups = stubIris(() => attested());

    expect(await refusal(relayer)).toMatchObject({ code: "unavailable", detail: expect.stringContaining("no account on Base") });
    expect(lookups).not.toHaveBeenCalled();
  });
});

describe("what the server pays for", () => {
  it("stops below its floor of ETH, without sending or counting anything", async () => {
    const dry = completing({ wei: 10 ** 14 - 1, env: { BASE_MINTS_PER_CALLER_PER_HOUR: "1" } });
    stubIris(() => attested());

    await expect(dry.relayer.complete(request(), "caller")).rejects.toMatchObject({
      code: "unavailable",
      detail: "The server is out of gas on Base Sepolia; submit the mint from your own wallet",
    });
    await expect(dry.relayer.complete(request(), "caller")).rejects.toMatchObject({ code: "unavailable" });
    expect(dry.walletClient.writeContract).not.toHaveBeenCalled();

    const enough = completing({ wei: 10 ** 14 });
    await expect(enough.relayer.complete(request(), "caller")).resolves.toEqual({ status: "minted", hash: MINT_HASH });

    const lean = completing({ wei: 1, env: { BASE_MINT_PAYER_ETH_FLOOR: "1" } });
    await expect(lean.relayer.complete(request(), "caller")).resolves.toMatchObject({ status: "minted" });
  });

  it("pays for a set number of mints per caller in an hour", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_CALLER_PER_HOUR: "2" } });
    stubIris(() => attested());

    await relayer.complete(request(), "203.0.113.1");
    await relayer.complete(request(), "203.0.113.1");
    const refused = (await relayer.complete(request(), "203.0.113.1").catch((error: unknown) => error)) as ApiError;

    expect(refused).toMatchObject({ code: "rate_limited", status: 429 });
    expect(refused.extra.retryAfterSeconds).toBeGreaterThan(0);
    await expect(relayer.complete(request(), "203.0.113.2")).resolves.toMatchObject({ status: "minted" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(3);
  });

  it("pays for a set number of mints a day, whoever asks", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_DAY: "2" } });
    stubIris(() => attested());

    await relayer.complete(request(), "203.0.113.1");
    await relayer.complete(request(), "203.0.113.2");

    await expect(relayer.complete(request(), "203.0.113.3")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("in a day"),
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
  });

  it("counts an attempt that failed, and keeps the provider's words out of the answer", async () => {
    const { relayer, walletClient } = completing({
      env: { BASE_MINTS_PER_CALLER_PER_HOUR: "1" },
      write: async () => {
        throw Object.assign(new Error("HTTP request failed. URL: https://base.example/v2/secret-api-key"), {
          shortMessage: "request to https://base.example/v2/secret-api-key failed",
        });
      },
    });
    stubIris(() => attested());
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = (await relayer.complete(request(), "caller").catch((error: unknown) => error)) as ApiError;

    expect(failed).toMatchObject({ code: "unavailable", detail: "The server could not submit the mint on Base Sepolia; try again later" });
    expect(JSON.stringify([failed.detail, failed.extra, logged.mock.calls])).not.toContain("secret-api-key");
    await expect(relayer.complete(request(), "caller")).rejects.toMatchObject({ code: "rate_limited" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("says only that Base could not be reached when it cannot be", async () => {
    const { relayer, publicClient } = completing();
    publicClient.getBalance.mockRejectedValue(new Error("fetch failed: https://base.example/v2/secret-api-key"));
    stubIris(() => attested());

    await expect(relayer.complete(request(), "caller")).rejects.toMatchObject({
      code: "unavailable",
      detail: "The server could not reach Base Sepolia; try again later",
    });
  });

  it("sends mints and the faucet's burns one at a time, from the one account they share", async () => {
    const order: string[] = [];
    const slowly = (name: string) => async () => {
      order.push(`${name} starts`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name} ends`);
    };
    const mint = slowly("mint");
    const burn = slowly("burn");
    const { relayer } = completing({
      write: async () => {
        await mint();
        return MINT_HASH;
      },
    });
    const internals = relayer as unknown as {
      assertFaucetFunded: () => Promise<void>;
      burnForDemo: () => Promise<DemoFundResult>;
    };
    vi.spyOn(internals, "assertFaucetFunded").mockResolvedValue(undefined);
    vi.spyOn(internals, "burnForDemo").mockImplementation(async () => {
      await burn();
      return { burnTxHash: "0x00", sourceDomain: 6, twin: "C", amount: "1000000" };
    });
    stubIris(() => attested());

    await Promise.all([
      relayer.demoFund({ owner: privateKeyToAccount(generatePrivateKey()).address }, "caller"),
      relayer.complete(request(), "caller"),
      relayer.complete(request(), "caller"),
    ]);

    expect(order).toHaveLength(6);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i + 1]).toBe(order[i]!.replace("starts", "ends"));
    }
  });

  it("gives up on a mint that hangs instead of holding the account's queue", async () => {
    vi.useFakeTimers();
    const { relayer } = completing({ write: () => new Promise<string>(() => undefined) });
    stubIris(() => attested());

    const stuck = relayer.complete(request(), "caller").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(55_000);

    expect(await stuck).toMatchObject({ code: "unavailable", detail: expect.stringContaining("too long") });
  });
});

describe("the route", () => {
  it("answers in the documented shape and limits how often a caller may ask", async () => {
    process.env.RELAYER_SECRET ??= Keypair.random().secret();
    process.env.DEMO_PAYER_PRIVATE_KEY ??= generatePrivateKey();
    stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));
    const ask = () => completeRoute(post("/api/cctp/complete", { network: "testnet", txHash: freshTxHash() }));

    const first = await ask();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "pending", attestation: "not_found" });

    const malformed = await completeRoute(post("/api/cctp/complete", { network: "testnet", txHash: "0xabc" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "bad_request" });

    for (let i = 0; i < 58; i += 1) await ask();
    const limited = await ask();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe.skipIf(!live)("on testnet", () => {
  it("answers minted, without a hash and without spending gas, for an exit Base has already received", async () => {
    const relayer = new Relayer(loadConfig());
    const payer = relayer.config.payer!.address;
    const clients = (relayer as unknown as { evmClients: () => { publicClient: { getBalance(args: { address: string }): Promise<bigint> } } }).evmClients();
    const before = await clients.publicClient.getBalance({ address: payer });

    const result = await relayer.complete({ network: "testnet", txHash: exit.stellarTransaction }, "caller");

    expect(result).toEqual({ status: "minted" });
    expect(await clients.publicClient.getBalance({ address: payer })).toBe(before);
  });
});
