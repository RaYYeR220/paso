import { Account, Address, Keypair, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import type { Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cctpDomainOf,
  decodeBurnMessage,
  fetchAttestation,
  fetchAttestations,
  fetchBurnFee,
  findBurnSource,
  inboundRouteOf,
  maxFeeFor,
  mintAndForwardOperation,
  receiveMessageOperation,
  waitForAttestation,
  type AttestationStatus,
} from "../src/iris";
import { deliverWith, SimulationError } from "../src/actions";
import { forwardRecipientHookData } from "../src/evm";
import { renderArg } from "../src/render";
import { twinAddress, twinContractId } from "../src/twin";
import { OWNER, testNetwork } from "./helpers";

const TX_HASH = `0x${"cd".repeat(32)}`;
const ATTESTATION = `0x${"ee".repeat(65)}` as Hex;
const NONCE = `0x${"07".repeat(32)}`;
const TWIN = twinAddress(OWNER, testNetwork);

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const u32 = (value: number) => value.toString(16).padStart(8, "0");
const bytes32 = (value: string) => value.replace(/^0x/, "").padStart(64, "0");

/** A CCTP v2 burn message laid out field by field. */
function burnMessage(mintRecipient: string, hookData = ""): Hex {
  const header = [
    u32(1), // version
    u32(6), // source domain
    u32(27), // destination domain
    bytes32(NONCE),
    bytes32("8fe6b999dc680ccfdd5bf7eb0974218be2542daa"), // sender
    "11".repeat(32), // recipient
    "22".repeat(32), // destination caller
    u32(1000), // minimum finality threshold
    u32(1000), // finality threshold executed
  ];
  const body = [
    u32(1), // version
    bytes32("036cbd53842c5426634e7929541ec2318f3dcf7e"), // burn token
    bytes32(mintRecipient),
    word(1_000_000n), // amount
    bytes32("70997970c51812dc3a010c7d01b50e0d17dc79c8"), // message sender
    word(156n), // max fee
    word(130n), // fee executed
    word(0n), // expiration block
    hookData.replace(/^0x/, ""),
  ];
  return `0x${header.join("")}${body.join("")}`;
}

const DIRECT_MESSAGE = burnMessage(twinContractId(OWNER, testNetwork));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchBurnFee and maxFeeFor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the fee for the requested finality", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchBurnFee(6, 27, "testnet")).toBe(1.3);
    expect(await fetchBurnFee(6, 27, "testnet", { finalityThreshold: 2000 })).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/27");
  });

  it("fails loudly when Iris does not answer with a fee", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "nope" }, 500)));
    await expect(fetchBurnFee(6, 27, "testnet")).rejects.toThrow(/Iris.*500/);
  });

  it("rounds the fee up and leaves headroom", () => {
    expect(maxFeeFor(1_000_000n, 1.3)).toBe(156n);
    expect(maxFeeFor(1n, 1.3)).toBe(2n);
    expect(maxFeeFor(123_456_789n, 1)).toBe(14_816n);
    expect(maxFeeFor(1_000_000n, 0)).toBe(0n);
  });
});

describe("waitForAttestation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps polling until the attestation is complete", async () => {
    const answers = [
      () => json({ error: "Message not found for provided parameters" }, 404),
      () => json({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ messages: [{ message: DIRECT_MESSAGE, attestation: ATTESTATION, status: "complete" }] }),
    ];
    const fetchMock = vi.fn<typeof fetch>(async () => answers.shift()!());
    vi.stubGlobal("fetch", fetchMock);
    const seen: AttestationStatus[] = [];

    const result = await waitForAttestation(6, TX_HASH, "testnet", {
      intervalMs: 1,
      onStatus: (status) => seen.push(status),
    });

    expect(result).toEqual({ message: DIRECT_MESSAGE, attestation: ATTESTATION, nonce: NONCE });
    expect(seen.map((status) => status.state)).toEqual(["not_found", "pending", "unreachable", "complete"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${TX_HASH}`,
    );
  });

  it("reports why a fast transfer is being held back", async () => {
    const answers = [
      json({
        messages: [
          { message: "0x", attestation: "PENDING", status: "pending_confirmations", delayReason: "insufficient_fee" },
        ],
      }),
      json({ messages: [{ message: DIRECT_MESSAGE, attestation: ATTESTATION, status: "complete" }] }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => answers.shift()!));
    const seen: AttestationStatus[] = [];

    await waitForAttestation(6, TX_HASH, "testnet", { intervalMs: 1, onStatus: (status) => seen.push(status) });

    expect(seen[0]).toEqual({ state: "pending", delayReason: "insufficient_fee" });
  });

  it("stops when the caller aborts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "not found" }, 404)));
    const controller = new AbortController();
    const waiting = waitForAttestation(6, TX_HASH, "testnet", { intervalMs: 5, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForAttestation(6, TX_HASH, "testnet", { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchAttestation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks Iris once and reports a burn it has not indexed", async () => {
    const fetchMock = vi.fn(async () => json({ error: "Message not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchAttestation(6, TX_HASH, testNetwork)).toEqual({ status: { state: "not_found" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      `https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=${TX_HASH}`,
    );
  });

  it("reports a pending attestation without one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] })),
    );

    expect(await fetchAttestation(6, TX_HASH, testNetwork)).toEqual({ status: { state: "pending" } });
  });

  it("returns the message, the attestation and the nonce once complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ messages: [{ message: DIRECT_MESSAGE, attestation: ATTESTATION, status: "complete" }] })),
    );

    expect(await fetchAttestation(6, TX_HASH, testNetwork)).toEqual({
      status: { state: "complete" },
      attestation: { message: DIRECT_MESSAGE, attestation: ATTESTATION, nonce: NONCE },
    });
  });

  it("reports an Iris that cannot be reached instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    expect(await fetchAttestation(6, TX_HASH, testNetwork)).toEqual({
      status: { state: "unreachable", detail: "socket hang up" },
    });
  });
});

describe("fetchAttestations", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => json(body, status)));
  const complete = (message: string = DIRECT_MESSAGE, attestation: string = ATTESTATION) => ({ message, attestation, status: "complete" });
  const lookUp = (limits = {}) => fetchAttestations(27, "ab".repeat(32), testNetwork, limits);

  it("returns every message of the transaction once all are attested", async () => {
    const second = burnMessage("33".repeat(32));
    answer({ messages: [complete(), complete(second)] });

    expect(await lookUp()).toEqual({
      state: "complete",
      attestations: [
        { message: DIRECT_MESSAGE, attestation: ATTESTATION, nonce: NONCE },
        { message: second, attestation: ATTESTATION, nonce: NONCE },
      ],
    });
  });

  it("is pending while any message is, and says why when Iris does", async () => {
    answer({ messages: [complete(), { message: "0x", attestation: "PENDING", status: "pending_confirmations", delayReason: "insufficient_fee" }] });
    expect(await lookUp()).toEqual({ state: "pending", delayReason: "insufficient_fee" });

    answer({ messages: [{ status: "pending_confirmations" }] });
    expect(await lookUp()).toEqual({ state: "pending" });
  });

  it("tells a burn Iris does not know from an Iris that cannot be reached", async () => {
    answer({ error: "Message not found" }, 404);
    expect(await lookUp()).toEqual({ state: "not_found" });
    answer({ messages: [] });
    expect(await lookUp()).toEqual({ state: "not_found" });

    answer("Bad Gateway", 502);
    expect(await lookUp()).toEqual({ state: "unreachable", detail: "Iris answered 502" });
  });

  it("does not read an answer past its limit", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 65_536;
        controller.enqueue(new Uint8Array(65_536).fill(0x20));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(endless)));
    expect(await lookUp()).toEqual({ state: "malformed", detail: "the answer is too large" });
    expect(sent).toBeLessThan(1_000_000);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-length": "99999999" } })));
    expect(await lookUp()).toEqual({ state: "malformed", detail: "the answer is too large" });

    answer({ messages: [complete()] });
    expect(await lookUp({ maxResponseBytes: 100 })).toEqual({ state: "malformed", detail: "the answer is too large" });
  });

  it("refuses more messages, or larger ones, than a transfer has", async () => {
    answer({ messages: new Array(17).fill(complete()) });
    expect(await lookUp()).toEqual({ state: "malformed", detail: "the transaction carries too many messages" });

    answer({ messages: [complete(`${DIRECT_MESSAGE}${"00".repeat(8_192)}`)] });
    expect(await lookUp()).toEqual({ state: "malformed", detail: "a message is too large" });

    answer({ messages: [complete(DIRECT_MESSAGE, `0x${"ee".repeat(2_049)}`)] });
    expect(await lookUp()).toEqual({ state: "malformed", detail: "an attestation is too large" });
  });

  it("refuses anything that is not a list of well-formed messages", async () => {
    for (const body of [null, 5, "text", [], {}, { messages: "many" }, { messages: { 0: complete() } }]) {
      answer(body);
      expect((await lookUp()).state).toBe("malformed");
    }
    for (const entry of [null, "complete", {}, { status: 1 }, { status: "complete" }, complete("0xzz"), complete("0x1234"), complete(DIRECT_MESSAGE, "PENDING"), complete(5 as unknown as string)]) {
      answer({ messages: [entry] });
      expect((await lookUp()).state).toBe("malformed");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>")));
    expect(await lookUp()).toEqual({ state: "malformed", detail: "the answer is not JSON" });
  });
});

describe("decodeBurnMessage", () => {
  it("reads the fields at Circle's offsets", () => {
    const hookData = forwardRecipientHookData(TWIN);
    const message = burnMessage(Buffer.from(Address.fromString(testNetwork.stellar.forwarder).toBuffer()).toString("hex"), hookData);

    expect(decodeBurnMessage(message)).toEqual({
      sourceDomain: 6,
      destinationDomain: 27,
      nonce: NONCE,
      destinationCaller: `0x${"22".repeat(32)}`,
      burnToken: `0x${"00".repeat(12)}036cbd53842c5426634e7929541ec2318f3dcf7e`,
      mintRecipient: `0x${Buffer.from(Address.fromString(testNetwork.stellar.forwarder).toBuffer()).toString("hex")}`,
      amount: 1_000_000n,
      messageSender: `0x${"00".repeat(12)}70997970c51812dc3a010c7d01b50e0d17dc79c8`,
      maxFee: 156n,
      feeExecuted: 130n,
      expirationBlock: 0n,
      hookData,
    });
  });

  it("rejects bytes too short to be a burn message", () => {
    expect(() => decodeBurnMessage("0x00")).toThrow(/too short/);
  });

  it("tells the two inbound routes apart by the mint recipient", () => {
    const forwarded = burnMessage(
      Buffer.from(Address.fromString(testNetwork.stellar.forwarder).toBuffer()).toString("hex"),
      forwardRecipientHookData(TWIN),
    );
    expect(inboundRouteOf(forwarded, testNetwork)).toBe("forwarder");
    expect(inboundRouteOf(DIRECT_MESSAGE, testNetwork)).toBe("direct");
  });
});

describe("delivery operations", () => {
  function call(operation: xdr.Operation) {
    if (operation.body.type !== "invokeHostFunction") throw new Error("not a host function");
    const { hostFunction } = operation.body.invokeHostFunctionOp;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
    const { contractAddress, functionName, args } = hostFunction.invokeContract;
    return {
      contract: Address.fromScAddress(contractAddress).toString(),
      fn: functionName.toString(),
      args: args.map(renderArg),
      types: args.map((arg) => arg.type),
    };
  }

  it("calls mint_and_forward on the forwarder", () => {
    expect(call(mintAndForwardOperation(DIRECT_MESSAGE, ATTESTATION, testNetwork))).toEqual({
      contract: testNetwork.stellar.forwarder,
      fn: "mint_and_forward",
      args: [DIRECT_MESSAGE, ATTESTATION],
      types: ["scvBytes", "scvBytes"],
    });
  });

  it("calls receive_message on the message transmitter with the caller first", () => {
    const caller = Keypair.random().publicKey();
    expect(call(receiveMessageOperation(caller, DIRECT_MESSAGE, ATTESTATION, testNetwork))).toEqual({
      contract: testNetwork.stellar.messageTransmitter,
      fn: "receive_message",
      args: [caller, DIRECT_MESSAGE, ATTESTATION],
      types: ["scvAddress", "scvBytes", "scvBytes"],
    });
  });
});

describe("deliverWith", () => {
  const source = Keypair.random();

  /** A server that knows the source account and answers every simulation with `error`. */
  function refusingServer(error: string) {
    const simulateTransaction = vi.fn(async (_tx: unknown) => ({ id: "1", latestLedger: 5_000_000, events: [], _parsed: true, error }));
    const getAccount = vi.fn(async (address: string) => new Account(address, "41"));
    return { simulateTransaction, getAccount } as unknown as rpc.Server & {
      simulateTransaction: typeof simulateTransaction;
    };
  }

  function simulatedCall(server: ReturnType<typeof refusingServer>) {
    const tx = server.simulateTransaction.mock.calls[0]![0] as { source: string; toEnvelope(): xdr.TransactionEnvelope };
    const envelope = tx.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") throw new Error("unexpected envelope");
    const body = envelope.v1.tx.operations[0]!.body;
    if (body.type !== "invokeHostFunction") throw new Error("unexpected operation");
    const func = body.invokeHostFunctionOp.hostFunction;
    if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
    return { source: tx.source, call: func.invokeContract };
  }

  it("pays from the given account and calls the message transmitter itself for a direct burn", async () => {
    const server = refusingServer("HostError: Error(Contract, #6908)");
    const failure = await deliverWith({ message: DIRECT_MESSAGE, attestation: ATTESTATION }, source, testNetwork, server).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SimulationError);
    expect((failure as SimulationError).detail).toContain("#6908");
    const { source: payer, call } = simulatedCall(server);
    expect(payer).toBe(source.publicKey());
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(testNetwork.stellar.messageTransmitter);
    expect(call.functionName.toString()).toBe("receive_message");
    expect(renderArg(call.args[0]!)).toBe(source.publicKey());
  });

  it("goes through the forwarder for a burn that names it", async () => {
    const forwarder = Buffer.from(StrKey.decodeContract(testNetwork.stellar.forwarder)).toString("hex");
    const message = burnMessage(forwarder, forwardRecipientHookData(TWIN));
    const server = refusingServer("HostError: Error(Contract, #6908)");

    await expect(deliverWith({ message, attestation: ATTESTATION }, source, testNetwork, server)).rejects.toThrow(SimulationError);
    const { call } = simulatedCall(server);
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(testNetwork.stellar.forwarder);
    expect(call.functionName.toString()).toBe("mint_and_forward");
  });
});

describe("naming either end of a transfer by its chain", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["base", 6],
    ["ethereum", 0],
    ["arbitrum", 3],
    ["optimism", 2],
    ["arc", 26],
    ["stellar", 27],
    [26, 26],
    [0, 0],
  ] as const)("reads %j as domain %d", (endpoint, domain) => {
    expect(cctpDomainOf(endpoint, "testnet")).toBe(domain);
    expect(cctpDomainOf(endpoint, "mainnet")).toBe(domain);
  });

  it.each(["polygon", "Stellar", "", -1, 1.5, 2 ** 32])("refuses %j", (endpoint) => {
    expect(() => cctpDomainOf(endpoint as never, "testnet")).toThrow();
  });

  it("asks Iris for the fee of the route between the chains named", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json([{ finalityThreshold: 2000, minimumFee: 0 }]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchBurnFee("arc", "stellar", "testnet", { finalityThreshold: 2000 })).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/26/27");
  });

  it("looks a burn up under the domain of the chain named", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ messages: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAttestations("arbitrum", TX_HASH, "mainnet");
    await fetchAttestation("optimism", TX_HASH, "testnet");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `https://iris-api.circle.com/v2/messages/3?transactionHash=${TX_HASH}`,
      `https://iris-api-sandbox.circle.com/v2/messages/2?transactionHash=${TX_HASH}`,
    ]);
  });

  it("throws for a chain it does not know instead of calling Iris unreachable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAttestations("polygon" as never, TX_HASH, "testnet")).rejects.toThrow(/neither a CCTP domain/);
    await expect(fetchAttestation("polygon" as never, TX_HASH, "testnet")).rejects.toThrow(/neither a CCTP domain/);
    await expect(fetchBurnFee("polygon" as never, 27, "testnet")).rejects.toThrow(/neither a CCTP domain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("findBurnSource", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The same burn message, sent from another domain. */
  const fromDomain = (message: Hex, domain: number) => `${message.slice(0, 10)}${u32(domain)}${message.slice(18)}` as Hex;
  const complete = (message: Hex) => ({ messages: [{ message, attestation: ATTESTATION, status: "complete" }] });

  /** Iris as seen per domain: an answer for the domains given, 404 for every other. */
  function iris(answers: Record<number, Response | (() => Response)>) {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const domain = Number(/\/v2\/messages\/(\d+)\?/.exec(String(input))?.[1]);
      const answer = answers[domain];
      if (answer === undefined) return json({ error: "Message not found for provided parameters" }, 404);
      return typeof answer === "function" ? answer() : answer;
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks under the domain of every chain listed, all at once, and names the one that knows the hash", async () => {
    const message = fromDomain(DIRECT_MESSAGE, 26);
    const fetchMock = iris({ 26: json(complete(message)) });

    const found = await findBurnSource(TX_HASH, "testnet");

    expect(found).toMatchObject({ state: "found", chain: { name: "arc", cctpDomain: 26 }, lookup: { state: "complete" } });
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual(
      [6, 0, 3, 2, 26].map((domain) => `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${TX_HASH}`).sort(),
    );
  });

  it("names the chain of a burn Iris knows and has not attested yet", async () => {
    iris({ 0: json({ messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] }) });
    expect(await findBurnSource(TX_HASH, "mainnet")).toMatchObject({ state: "found", chain: { name: "ethereum" }, lookup: { state: "pending" } });
  });

  it("asks only the chains it is given", async () => {
    const fetchMock = iris({ 6: json(complete(DIRECT_MESSAGE)) });
    expect(await findBurnSource(TX_HASH, "testnet", { chains: ["arc", "base"] })).toMatchObject({ state: "found", chain: { name: "base" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("says not found when no chain knows the hash", async () => {
    iris({});
    expect(await findBurnSource(TX_HASH, "testnet")).toEqual({ state: "not_found" });
  });

  it("says unreachable when no chain knows the hash and one could not be asked", async () => {
    iris({ 3: json({ error: "busy" }, 503) });
    expect(await findBurnSource(TX_HASH, "testnet")).toEqual({ state: "unreachable", detail: "Arbitrum Sepolia: Iris answered 503" });
  });

  it("still names the chain that knows the hash when another could not be asked", async () => {
    iris({ 3: json({ error: "busy" }, 503), 2: json(complete(fromDomain(DIRECT_MESSAGE, 2))) });
    expect(await findBurnSource(TX_HASH, "testnet")).toMatchObject({ state: "found", chain: { name: "optimism" } });
  });

  it("refuses to guess when two chains know the hash", async () => {
    iris({ 6: json(complete(DIRECT_MESSAGE)), 26: json(complete(fromDomain(DIRECT_MESSAGE, 26))) });
    const found = await findBurnSource(TX_HASH, "testnet");
    expect(found.state).toBe("ambiguous");
    expect(found.state === "ambiguous" && found.chains.map((chain) => chain.name)).toEqual(["base", "arc"]);
  });

  it("calls an attested message from another domain than the one it was filed under malformed", async () => {
    iris({ 26: json(complete(DIRECT_MESSAGE)) });
    expect(await findBurnSource(TX_HASH, "testnet")).toMatchObject({
      state: "found",
      chain: { name: "arc" },
      lookup: { state: "malformed", detail: expect.stringMatching(/another domain under Arc Testnet/) },
    });
  });

  it("refuses a chain it does not list before asking anything", async () => {
    const fetchMock = iris({});
    await expect(findBurnSource(TX_HASH, "testnet", { chains: ["polygon" as never] })).rejects.toThrow(/Unknown EVM chain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
