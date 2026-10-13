import { evmChain, messageTransmitterAbi, NETWORKS } from "paso-sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { ContractFunctionRevertedError, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as completeRoute } from "@/app/api/cctp/complete/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { Relayer, type DemoFundResult } from "@/lib/server/relayer";
import arcExit from "./fixtures/arc-exit-message.json";
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
const BLOCK = 1_000_000;

/** Where the fields of a CCTP message start, in bytes: its header is 148 bytes, the burn message follows. */
const FIELD = {
  sourceDomain: 4,
  destinationDomain: 8,
  nonce: 12,
  destinationCaller: 108,
  burnToken: 148 + 4,
  mintRecipient: 148 + 36,
  amount: 148 + 68,
  messageSender: 148 + 100,
  expirationBlock: 148 + 196,
} as const;

/** The exit with one field overwritten, as hex of the field's own length. */
function exitWith(field: keyof typeof FIELD, hex: string, message: string = MESSAGE): string {
  const start = 2 + FIELD[field] * 2;
  return `${message.slice(0, start)}${hex}${message.slice(start + hex.length)}`;
}
const word = (value: number | bigint) => BigInt(value).toString(16).padStart(64, "0");

const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
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

const attested = (...messages: string[]) =>
  Response.json({
    messages: (messages.length ? messages : [MESSAGE]).map((message) => ({ message, attestation: ATTESTATION, status: "complete" })),
  });

const reverting = (reason: string) => async (): Promise<bigint> => {
  throw new ContractFunctionRevertedError({ abi: messageTransmitterAbi, functionName: "receiveMessage", message: reason });
};

interface Base {
  /** What `usedNonces` answers, read after read; the last answer from then on. */
  used?: number[];
  wei?: number;
  block?: number;
  /** What simulating the mint answers: the gas it needs, or a failure. */
  simulate?: () => Promise<bigint>;
  feePerGas?: number;
  write?: () => Promise<string>;
  receipt?: string;
  env?: Record<string, string>;
}

/** A relayer whose view of Base is scripted: nonce state, the payer's ETH, the simulation, and what sending does. */
function completing({ used = [0], wei = ETH, block = BLOCK, simulate, feePerGas = 6_000_000, write, receipt = "success", env: overrides = {} }: Base = {}) {
  const relayer = new Relayer(loadConfig({ ...env, ...overrides }));
  const reads = [...used];
  const publicClient = {
    readContract: vi.fn<(call: { functionName: string }) => Promise<bigint>>(async () =>
      BigInt(reads.length > 1 ? reads.shift()! : reads[0]!),
    ),
    getBalance: vi.fn(async () => BigInt(wei)),
    getBlockNumber: vi.fn(async () => BigInt(block)),
    estimateContractGas: vi.fn<(call: { args: readonly unknown[]; account: string }) => Promise<bigint>>(async () =>
      simulate ? simulate() : BigInt(150_000),
    ),
    estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: BigInt(feePerGas), maxPriorityFeePerGas: BigInt(1_000_000) })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: receipt })),
    getTransactionReceipt: vi.fn<(call: { hash: string }) => Promise<{ status: string }>>(async () => {
      throw new Error("The transaction receipt could not be found");
    }),
  };
  const walletClient = {
    account: payer,
    writeContract: vi.fn<
      (call: { address: string; functionName: string; args: readonly unknown[]; gas: bigint; maxFeePerGas: bigint }) => Promise<string>
    >(async () => (write ? write() : MINT_HASH)),
  };
  const evmClients = vi
    .spyOn(relayer as unknown as { evmClients: (chain?: string) => unknown }, "evmClients")
    .mockReturnValue({ publicClient, walletClient });
  return { relayer, publicClient, walletClient, evmClients };
}

const refusal = async (relayer: Relayer, body: unknown = request(), caller = "caller") =>
  (await relayer.complete(body, caller).catch((error: unknown) => error)) as ApiError;

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
  it("simulates the call, then submits it once with exactly the bytes Circle returned", async () => {
    const { relayer, publicClient, walletClient } = completing();
    const lookups = stubIris(() => attested());
    const asked = request();

    expect(await relayer.complete(asked, "caller")).toEqual({ status: "minted", hash: MINT_HASH });

    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas.mock.calls[0]![0]).toMatchObject({ args: [MESSAGE, ATTESTATION], account: payer.address });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    const call = walletClient.writeContract.mock.calls[0]![0];
    expect(call.address).toBe(NETWORKS.testnet.evm.messageTransmitter);
    expect(call.functionName).toBe("receiveMessage");
    expect(call.args).toEqual([MESSAGE, ATTESTATION]);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MINT_HASH, confirmations: 2 });

    // Asked again, it answers from memory: no lookup, no second transaction.
    expect(await relayer.complete(asked, "someone else")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("sends with a gas limit of its own and the network's fee, both bounded", async () => {
    const { relayer, walletClient } = completing({ simulate: async () => BigInt(390_000), feePerGas: 250_000_000 });
    stubIris(() => attested());

    await relayer.complete(request(), "caller");

    const call = walletClient.writeContract.mock.calls[0]![0];
    expect(call.gas).toBe(BigInt(400_000));
    expect(call.maxFeePerGas).toBe(BigInt(250_000_000));

    const usual = completing();
    await usual.relayer.complete(request(), "caller");
    expect(usual.walletClient.writeContract.mock.calls[0]![0].gas).toBe(BigInt(180_000));
  });

  it("takes nothing but the hash from the caller", async () => {
    const { relayer, walletClient } = completing();
    stubIris(() => attested());

    await relayer.complete({ ...request(), message: `0x${"ff".repeat(376)}`, attestation: `0x${"ee".repeat(130)}` }, "caller");

    expect(walletClient.writeContract.mock.calls[0]![0].args).toEqual([MESSAGE, ATTESTATION]);
  });

  it("looks, simulates and sends once when the same exit is asked about several times at once", async () => {
    let finish: (hash: string) => void = () => undefined;
    const { relayer, publicClient, walletClient } = completing({ write: () => new Promise<string>((resolve) => (finish = resolve)) });
    const lookups = stubIris(() => attested());
    const asked = request();

    const all = Promise.all([
      relayer.complete(asked, "one"),
      relayer.complete(asked, "two"),
      relayer.complete({ ...asked, txHash: asked.txHash.toUpperCase() }, "three"),
    ]);
    await vi.waitFor(() => expect(walletClient.writeContract).toHaveBeenCalledTimes(1));
    finish(MINT_HASH);

    expect(await all).toEqual(new Array(3).fill({ status: "minted", hash: MINT_HASH }));
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("answers minted without a hash when Base has the message already, and spends nothing", async () => {
    const { relayer, publicClient, walletClient } = completing({ used: [1], env: { BASE_MINTS_PER_DAY: "1" } });
    stubIris(() => attested());

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(publicClient.estimateContractGas).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("answers minted without a hash when someone else got there while it waited or sent", async () => {
    const whileWaiting = completing({ used: [0, 1], env: { BASE_MINTS_PER_DAY: "1" } });
    stubIris(() => attested());
    expect(await whileWaiting.relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(whileWaiting.walletClient.writeContract).not.toHaveBeenCalled();
    // Nothing was submitted, so the day's one mint is still there.
    expect(await whileWaiting.relayer.complete(request(), "caller")).toEqual({ status: "minted" });

    const whileSending = completing({
      used: [0, 0, 0, 1],
      write: async () => {
        throw new Error("execution reverted: Nonce already used");
      },
    });
    expect(await whileSending.relayer.complete(request(), "caller")).toEqual({ status: "minted" });
    expect(whileSending.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("picks the exit by what the message says when the transaction carries others", async () => {
    const { relayer, walletClient } = completing();
    const elsewhere = exitWith("destinationDomain", "00000001");
    const notOurs = exitWith("messageSender", "ab".repeat(32));
    stubIris(() => attested(inbound.message, elsewhere, notOurs, MESSAGE));

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(walletClient.writeContract.mock.calls[0]![0].args).toEqual([MESSAGE, ATTESTATION]);
  });
});

describe("an exit to a chain other than Base", () => {
  const ARC_EXIT = arcExit.message as `0x${string}`;
  const ARC_ATTESTATION = arcExit.attestation as `0x${string}`;
  const arcAttested = () => Response.json({ messages: [{ message: ARC_EXIT, attestation: ARC_ATTESTATION, status: "complete" }] });
  const RECIPIENT = getAddress(`0x${ARC_EXIT.slice(2 + (148 + 36 + 12) * 2, 2 + (148 + 68) * 2)}`);

  it("is checked on Arc and handed back for the wallet, even by a server that pays for mints on Base", async () => {
    const { relayer, publicClient, walletClient, evmClients } = completing();
    stubIris(arcAttested);

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "attested", message: ARC_EXIT, attestation: ARC_ATTESTATION });

    expect(evmClients.mock.calls.map(([chain]) => chain)).toEqual(["arc"]);
    expect(publicClient.readContract.mock.calls[0]![0]).toMatchObject({ functionName: "usedNonces" });
    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(publicClient.estimateContractGas.mock.calls[0]![0]).toMatchObject({
      address: evmChain("testnet", "arc").messageTransmitter,
      args: [ARC_EXIT, ARC_ATTESTATION],
      account: RECIPIENT,
    });
    expect(publicClient.getBalance).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("costs no mint the server pays for: with one a day left, a mint on Base still goes out afterwards", async () => {
    const base = completing({ env: { BASE_MINTS_PER_DAY: "1", BASE_MINTS_PER_CALLER_PER_HOUR: "1" } });
    stubIris(() => attested(exitWith("destinationDomain", "00000003")));
    expect(await base.relayer.complete(request(), "caller")).toMatchObject({ status: "attested" });
    expect(base.evmClients.mock.calls.at(-1)).toEqual(["arbitrum"]);

    stubIris(() => attested());
    expect(await base.relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(base.evmClients.mock.calls.at(-1)).toEqual(["base"]);
    expect(base.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("is answered minted when Arc has received it already, and looked at there again later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { relayer, publicClient, evmClients } = completing({ used: [0, 1] });
    stubIris(arcAttested);
    const asked = request();

    expect(await relayer.complete(asked, "caller")).toMatchObject({ status: "attested" });
    vi.setSystemTime(Date.now() + 20_000);
    expect(await relayer.complete(asked, "caller")).toEqual({ status: "minted" });
    expect(evmClients.mock.calls.map(([chain]) => chain)).toEqual(["arc", "arc"]);
    expect(publicClient.readContract).toHaveBeenCalledTimes(2);
  });

  it("is refused, naming Arc, when its mint would revert there", async () => {
    const { relayer, walletClient } = completing({ simulate: reverting("Invalid attestation signature") });
    stubIris(arcAttested);

    expect(await refusal(relayer)).toMatchObject({
      code: "simulation_failed",
      detail: expect.stringMatching(/would revert on Arc Testnet \(Invalid attestation signature\)/),
    });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });
});

describe("an exit that cannot be minted", () => {
  /** Asked twice: refused both times, the second time from memory, with nothing sent and nothing charged. */
  async function terminal(base: ReturnType<typeof completing>, message: string, detail: RegExp, code = "simulation_failed") {
    const lookups = stubIris(() => attested(message));
    const asked = request();

    const first = await refusal(base.relayer, asked);
    expect(first).toMatchObject({ code, detail: expect.stringMatching(detail) });
    const work = [lookups, base.publicClient.readContract, base.publicClient.estimateContractGas].map((mock) => mock.mock.calls.length);

    expect(await refusal(base.relayer, asked, "someone else")).toBe(first);
    expect([lookups, base.publicClient.readContract, base.publicClient.estimateContractGas].map((mock) => mock.mock.calls.length)).toEqual(work);
    expect(base.walletClient.writeContract).not.toHaveBeenCalled();
    return first;
  }
  /** The shared allowances are untouched: with one mint a day and one per caller, the same caller still gets a mint. */
  const scarce = { BASE_MINTS_PER_DAY: "1", BASE_MINTS_PER_CALLER_PER_HOUR: "1" };
  async function stillMints(base: ReturnType<typeof completing>) {
    stubIris(() => attested());
    expect(await base.relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
  }

  it("is refused for good when only another address may complete it", async () => {
    const base = completing({ env: scarce });
    const refused = await terminal(base, exitWith("destinationCaller", `${"00".repeat(12)}${"ab".repeat(20)}`), /not this server/);

    expect(refused.status).toBe(422);
    expect(base.publicClient.estimateContractGas).not.toHaveBeenCalled();
    await stillMints(base);
  });

  it("is completed when the one address allowed is the server's own", async () => {
    const { relayer } = completing();
    stubIris(() => attested(exitWith("destinationCaller", `${"00".repeat(12)}${payer.address.slice(2).toLowerCase()}`)));

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
  });

  it("is refused when its attestation has expired on Base, and minted while it has not", async () => {
    const base = completing({ block: BLOCK, env: scarce });
    const refused = await terminal(base, exitWith("expirationBlock", word(BLOCK)), new RegExp(`expired at block ${BLOCK}`));
    expect(refused.status).toBe(422);
    await stillMints(base);

    const inTime = completing({ block: BLOCK });
    stubIris(() => attested(exitWith("expirationBlock", word(BLOCK + 1))));
    expect(await inTime.relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
  });

  it("is refused when its recipient, its token or its amount is not what a mint on Base needs", async () => {
    await terminal(completing(), exitWith("mintRecipient", `${"11".repeat(12)}${"ab".repeat(20)}`), /recipient is not an address/);
    await terminal(completing(), exitWith("mintRecipient", "00".repeat(32)), /recipient is not an address/);
    await terminal(completing(), exitWith("burnToken", "cd".repeat(32)), /not the USDC that Circle mints/);
    await terminal(completing(), exitWith("amount", word(9_999)), /too small/);
  });

  it("is refused when simulating the mint reverts: nothing is sent and nothing is charged", async () => {
    const base = completing({ simulate: reverting("Invalid attestation signature"), env: scarce });
    const refused = await terminal(base, MESSAGE, /would revert on Base Sepolia \(Invalid attestation signature\)/);

    expect(refused.status).toBe(422);
    expect(base.publicClient.estimateContractGas).toHaveBeenCalledTimes(1);

    // The same server, once Base accepts the call: the day's one mint and the caller's one mint are both still there.
    base.publicClient.estimateContractGas.mockResolvedValue(BigInt(150_000));
    await stillMints(base);
  });

  it("is refused when its mint would need more gas than the server pays for", async () => {
    await terminal(completing({ simulate: async () => BigInt(400_001) }), MESSAGE, /more gas than the server pays for/);
  });

  it("is refused when it is one of several exits in a transaction, or not a transfer the server completes", async () => {
    const twin = exitWith("nonce", "9a".repeat(32));
    const several = completing();
    const lookups = stubIris(() => attested(MESSAGE, twin));
    expect(await refusal(several.relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("several exits") });
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(several.publicClient.readContract).not.toHaveBeenCalled();

    await terminal(completing(), inbound.message, /from CCTP domain 1 to 27/, "bad_request");
    await terminal(completing(), exitWith("destinationDomain", "00000001"), /from CCTP domain 27 to 1/, "bad_request");
    await terminal(completing(), exitWith("sourceDomain", "00000000"), /from CCTP domain 0 to 6/, "bad_request");
    await terminal(completing(), exitWith("messageSender", "ab".repeat(32)), /not sent through the hub/, "bad_request");
    await terminal(completing(), MESSAGE.slice(0, 300), /does not carry a USDC transfer/, "bad_request");
  });

  it("compares fields whatever case Circle writes the hex in", async () => {
    const { relayer, walletClient } = completing();
    const shouting = `0x${MESSAGE.slice(2).toUpperCase()}`;
    stubIris(() => attested(shouting));

    expect(await relayer.complete(request(), "caller")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(walletClient.writeContract.mock.calls[0]![0].args[0]).toBe(shouting);
  });
});

describe("what Circle's answer may be", () => {
  it("is not read past its limit, nor acted on when it is not a short list of messages", async () => {
    const base = completing();
    const oversized = () => new Response(JSON.stringify({ messages: [], padding: "x".repeat(300_000) }));
    const lookups = stubIris(oversized);
    const asked = request();

    expect(await refusal(base.relayer, asked)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("the answer is too large") });
    expect(await refusal(base.relayer, asked)).toMatchObject({ code: "bad_request" });
    expect(lookups).toHaveBeenCalledTimes(1);

    stubIris(() => attested(...new Array<string>(17).fill(MESSAGE)));
    expect(await refusal(base.relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("too many messages") });

    stubIris(() => attested(`${MESSAGE}${"00".repeat(8_192)}`));
    expect(await refusal(base.relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("too large") });

    stubIris(() => Response.json({ messages: [{ status: "complete", message: MESSAGE }] }));
    expect(await refusal(base.relayer)).toMatchObject({ code: "bad_request", detail: expect.stringContaining("missing its bytes") });

    expect(base.publicClient.readContract).not.toHaveBeenCalled();
    expect(base.walletClient.writeContract).not.toHaveBeenCalled();
  });
});

describe("what the server will not complete", () => {
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

  it("asks Circle's production service about an exit on mainnet", async () => {
    const onMainnet = { PASO_ALLOW_MAINNET: "true", RELAYER_SECRET_MAINNET: Keypair.random().secret() };
    const relayer = new Relayer(loadConfig({ ...env, ...onMainnet }, "mainnet"));
    const lookups = stubIris(() => Response.json({ error: "Message not found" }, { status: 404 }));

    expect(await relayer.complete({ network: "mainnet", txHash: freshTxHash() }, "caller")).toEqual({ status: "pending", attestation: "not_found" });
    expect(lookups.mock.calls[0]![0]).toContain("https://iris-api.circle.com/v2/messages/27?");
    expect(await refusal(relayer, { network: "testnet", txHash: freshTxHash() })).toMatchObject({ code: "bad_request" });
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
    expect(dry.publicClient.estimateContractGas).not.toHaveBeenCalled();
    expect(dry.walletClient.writeContract).not.toHaveBeenCalled();

    const enough = completing({ wei: 10 ** 14 });
    await expect(enough.relayer.complete(request(), "caller")).resolves.toEqual({ status: "minted", hash: MINT_HASH });

    const lean = completing({ wei: 1, env: { BASE_MINT_PAYER_ETH_FLOOR: "1" } });
    await expect(lean.relayer.complete(request(), "caller")).resolves.toMatchObject({ status: "minted" });
  });

  it("does not mint while gas on Base costs more than its cap, and does when it costs less again", async () => {
    const base = completing({ feePerGas: 250_000_001 });
    stubIris(() => attested());
    const asked = request();

    await expect(base.relayer.complete(asked, "caller")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("costs more right now"),
    });
    expect(base.walletClient.writeContract).not.toHaveBeenCalled();

    base.publicClient.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: BigInt(1_000), maxPriorityFeePerGas: BigInt(5_000) });
    await expect(base.relayer.complete(asked, "caller")).resolves.toEqual({ status: "minted", hash: MINT_HASH });
    expect(base.walletClient.writeContract.mock.calls[0]![0]).toMatchObject({ maxFeePerGas: BigInt(1_000), maxPriorityFeePerGas: BigInt(1_000) });

    const dearer = completing({ feePerGas: 5, env: { BASE_MINT_MAX_FEE_PER_GAS: "4" } });
    await expect(dearer.relayer.complete(request(), "caller")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("pays for a set number of mints per caller in an hour", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_CALLER_PER_HOUR: "2" } });
    stubIris(() => attested());

    await relayer.complete(request(), "203.0.113.1");
    await relayer.complete(request(), "203.0.113.1");
    const refused = await refusal(relayer, request(), "203.0.113.1");

    expect(refused).toMatchObject({ code: "rate_limited", status: 429 });
    expect(refused.extra.retryAfterSeconds).toBeGreaterThan(0);
    await expect(relayer.complete(request(), "203.0.113.2")).resolves.toMatchObject({ status: "minted" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(3);
  });

  it("pays for a set number of mints a day, whoever asks, counted when a mint is submitted", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_DAY: "2" } });
    stubIris(() => attested());

    await relayer.complete(request(), "203.0.113.1");
    await relayer.complete(request(), "203.0.113.2");

    const asked = request();
    await expect(relayer.complete(asked, "203.0.113.3")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("in a day"),
    });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
  });

  it("examines a bounded number of attested exits per caller", async () => {
    const { relayer, publicClient } = completing({ used: [1] });
    stubIris(() => attested());

    for (let i = 0; i < 30; i += 1) await relayer.complete(request(), "203.0.113.1");
    await expect(relayer.complete(request(), "203.0.113.1")).rejects.toMatchObject({ code: "rate_limited", status: 429 });

    expect(publicClient.readContract).toHaveBeenCalledTimes(30);
    await expect(relayer.complete(request(), "203.0.113.2")).resolves.toEqual({ status: "minted" });
  });

  it("does not send again a mint that Base included and reverted", async () => {
    const { relayer, walletClient } = completing({ receipt: "reverted" });
    stubIris(() => attested());
    const asked = request();
    const reverted = { code: "simulation_failed", status: 422, detail: expect.stringContaining("included on Base Sepolia and reverted") };

    expect(await refusal(relayer, asked)).toMatchObject(reverted);
    expect(await refusal(relayer, asked, "someone else")).toMatchObject(reverted);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("says only that Base could not be reached when it cannot be, and decides nothing on that", async () => {
    const base = completing();
    stubIris(() => attested());
    const asked = request();
    const unreachable = { code: "unavailable", detail: "The server could not reach Base Sepolia; try again later" };

    base.publicClient.getBalance.mockRejectedValueOnce(new Error("fetch failed: https://base.example/v2/secret-api-key"));
    await expect(base.relayer.complete(asked, "caller")).rejects.toMatchObject(unreachable);

    base.publicClient.estimateContractGas.mockRejectedValueOnce(new Error("socket hang up: https://base.example/v2/secret-api-key"));
    await expect(base.relayer.complete(asked, "caller")).rejects.toMatchObject(unreachable);

    await expect(base.relayer.complete(asked, "caller")).resolves.toEqual({ status: "minted", hash: MINT_HASH });
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

  it("keeps looking at exits out of the queue the account's transactions wait in", async () => {
    const { relayer, publicClient } = completing({ simulate: reverting("Invalid attestation signature") });
    const queue = vi.spyOn(relayer as unknown as { evmQueue: (task: unknown) => Promise<unknown> }, "evmQueue");
    stubIris(() => attested());

    for (let i = 0; i < 10; i += 1) await refusal(relayer);

    expect(publicClient.estimateContractGas).toHaveBeenCalledTimes(10);
    expect(queue).not.toHaveBeenCalled();
  });

  it("writes its reservation and counts the mint before the transaction goes out", async () => {
    const asked = request();
    let seen: unknown;
    const base = completing({
      env: { BASE_MINTS_PER_CALLER_PER_HOUR: "1" },
      write: async () => {
        seen = {
          exit: base.relayer.state.exits.get(asked.txHash)?.kind,
          left: base.relayer.state.mintsPerCaller.check("caller").ok,
          unsettled: base.relayer.state.unsettled,
        };
        return MINT_HASH;
      },
    });
    stubIris(() => attested());

    await base.relayer.complete(asked, "caller");

    expect(seen).toEqual({ exit: "sending", left: false, unsettled: 1 });
    expect(base.relayer.state.exits.get(asked.txHash)?.kind).toBe("minted");
    expect(base.relayer.state.unsettled).toBe(0);
  });

  it("counts one mint for requests that arrive together", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_CALLER_PER_HOUR: "2" } });
    stubIris(() => attested());
    const asked = request();

    await Promise.all([relayer.complete(asked, "caller"), relayer.complete(asked, "caller"), relayer.complete(asked, "caller")]);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);

    // One of the caller's two mints was used, not three: there is exactly one left.
    await expect(relayer.complete(request(), "caller")).resolves.toMatchObject({ status: "minted" });
    await expect(relayer.complete(request(), "caller")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("holds a mint whose outcome it never learned as on its way, and does not send it again", async () => {
    const base = completing({
      env: { BASE_MINTS_PER_CALLER_PER_HOUR: "1" },
      write: async () => {
        throw Object.assign(new Error("HTTP request failed. URL: https://base.example/v2/secret-api-key"), {
          shortMessage: "request to https://base.example/v2/secret-api-key failed",
        });
      },
    });
    const lookups = stubIris(() => attested());
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const asked = request();
    const onItsWay = { code: "unavailable", status: 503, detail: expect.stringContaining("has not confirmed it yet") };

    const first = await refusal(base.relayer, asked);
    expect(first).toMatchObject(onItsWay);
    expect(JSON.stringify([first.detail, first.extra, logged.mock.calls])).not.toContain("secret-api-key");
    expect(base.relayer.state.exits.get(asked.txHash)?.kind).toBe("sending");

    // Asked again, by anyone: still on its way. Nothing is looked up at Circle, simulated or sent.
    for (const caller of ["caller", "someone else", "a third"]) expect(await refusal(base.relayer, asked, caller)).toMatchObject(onItsWay);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(base.publicClient.estimateContractGas).toHaveBeenCalledTimes(1);
    expect(base.walletClient.writeContract).toHaveBeenCalledTimes(1);

    // It was submitted, so it stays counted against the caller.
    expect(await refusal(base.relayer)).toMatchObject({ code: "rate_limited" });

    // Until Base itself says the message has been received.
    base.publicClient.readContract.mockResolvedValue(BigInt(1));
    expect(await base.relayer.complete(asked, "caller")).toEqual({ status: "minted" });
    expect(base.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("settles a mint it stopped waiting for by what Base says became of the transaction", async () => {
    vi.useFakeTimers();
    const landed = completing();
    landed.publicClient.waitForTransactionReceipt.mockImplementation(() => new Promise(() => undefined));
    stubIris(() => attested());
    const asked = request();

    const stuck = refusal(landed.relayer, asked);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(await stuck).toMatchObject({ code: "unavailable", detail: expect.stringContaining("has not confirmed it yet") });
    expect(await refusal(landed.relayer, asked)).toMatchObject({ code: "unavailable" });
    expect(landed.publicClient.getTransactionReceipt).toHaveBeenCalledWith({ hash: MINT_HASH });

    landed.publicClient.getTransactionReceipt.mockResolvedValue({ status: "success" });
    landed.publicClient.readContract.mockResolvedValue(BigInt(1));
    expect(await landed.relayer.complete(asked, "caller")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(landed.walletClient.writeContract).toHaveBeenCalledTimes(1);

    const reverted = completing();
    reverted.publicClient.waitForTransactionReceipt.mockImplementation(() => new Promise(() => undefined));
    const other = request();
    const waiting = refusal(reverted.relayer, other);
    await vi.advanceTimersByTimeAsync(55_000);
    await waiting;
    reverted.publicClient.getTransactionReceipt.mockResolvedValue({ status: "reverted" });

    expect(await refusal(reverted.relayer, other)).toMatchObject({ code: "simulation_failed", detail: expect.stringContaining("reverted") });
    expect(await refusal(reverted.relayer, other)).toMatchObject({ code: "simulation_failed" });
    expect(reverted.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("lets the transaction's own outcome end the reservation, however late it comes", async () => {
    vi.useFakeTimers();
    let land: (hash: string) => void = () => undefined;
    const { relayer, publicClient, walletClient } = completing({ write: () => new Promise<string>((resolve) => (land = resolve)) });
    stubIris(() => attested());
    const asked = request();

    const stuck = refusal(relayer, asked);
    await vi.advanceTimersByTimeAsync(55_000);
    await stuck;
    expect(relayer.state.exits.get(asked.txHash)?.kind).toBe("sending");
    expect(relayer.state.inFlight()).toBe(2);

    land(MINT_HASH);
    await vi.advanceTimersByTimeAsync(10);

    expect(relayer.state.exits.get(asked.txHash)?.kind).toBe("minted");
    expect(relayer.state.inFlight()).toBe(0);
    const reads = publicClient.readContract.mock.calls.length;
    expect(await relayer.complete(asked, "caller")).toEqual({ status: "minted", hash: MINT_HASH });
    expect(publicClient.readContract).toHaveBeenCalledTimes(reads);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("never drops what it has on record to make room: with the table full, no mint is sent or counted", async () => {
    const { relayer, walletClient } = completing({ env: { BASE_MINTS_PER_CALLER_PER_HOUR: "1" } });
    const { exits } = relayer.state;
    for (let i = 0; i < 5_000; i += 1) exits.set(`exit-${i}`, { kind: "sending", until: Date.now() + 60_000, message: MESSAGE });
    stubIris(() => attested());

    await expect(relayer.complete(request(), "caller")).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("busy"),
    });
    expect(exits.size).toBe(5_000);
    expect([...exits.values()].every((exit) => exit.kind === "sending")).toBe(true);
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(relayer.state.mintsPerCaller.check("caller").ok).toBe(true);

    // An entry leaves when its own time is up, and that is what makes room.
    exits.set("exit-7", { kind: "sending", until: Date.now() - 1, message: MESSAGE });
    await expect(relayer.complete(request(), "caller")).resolves.toEqual({ status: "minted", hash: MINT_HASH });
    expect(exits.has("exit-7")).toBe(false);
  });

  it("looks again at an exit it refused, in case someone else has minted it since", async () => {
    vi.useFakeTimers();
    const base = completing({ simulate: reverting("Invalid attestation signature") });
    const lookups = stubIris(() => attested());
    const asked = request();

    const refused = await refusal(base.relayer, asked);
    expect(refused).toMatchObject({ code: "simulation_failed" });
    base.publicClient.readContract.mockResolvedValue(BigInt(1));

    // Within a quarter of a minute the answer comes from memory, untouched.
    const reads = base.publicClient.readContract.mock.calls.length;
    expect(await refusal(base.relayer, asked)).toBe(refused);
    expect(base.publicClient.readContract).toHaveBeenCalledTimes(reads);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await base.relayer.complete(asked, "caller")).toEqual({ status: "minted" });
    expect(base.publicClient.readContract).toHaveBeenCalledTimes(reads + 1);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(base.walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("gives up on a mint that hangs instead of holding the queue, and does not send it again by itself", async () => {
    vi.useFakeTimers();
    const { relayer, walletClient } = completing({ write: () => new Promise<string>(() => undefined) });
    stubIris(() => attested());
    const asked = request();

    const stuck = refusal(relayer, asked);
    await vi.advanceTimersByTimeAsync(55_000);

    expect(await stuck).toMatchObject({ code: "unavailable", detail: expect.stringContaining("has not confirmed it yet") });
    expect(await refusal(relayer, asked)).toMatchObject({ code: "unavailable" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
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
    const address = relayer.config.payer!.address;
    const clients = (relayer as unknown as { evmClients: () => { publicClient: { getBalance(args: { address: string }): Promise<bigint> } } }).evmClients();
    const before = await clients.publicClient.getBalance({ address });

    const result = await relayer.complete({ network: "testnet", txHash: exit.stellarTransaction }, "caller");

    expect(result).toEqual({ status: "minted" });
    expect(await clients.publicClient.getBalance({ address })).toBe(before);
  });
});
