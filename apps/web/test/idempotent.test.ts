import { prepare, relayRequest, sign, twinAddress, type RelayRequest, type Signed } from "@paso/sdk";
import { Account, Address, Keypair, nativeToScVal, Operation, SorobanDataBuilder, TransactionBuilder, xdr, type rpc } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as relayRoute } from "@/app/api/relay/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { getRelayer, Relayer } from "@/lib/server/relayer";
import { hub, post, usdc } from "./helpers";

const LATEST = 5_000_000;
const PASSPHRASE = "Test SDF Network ; September 2015";
const owner = privateKeyToAccount(generatePrivateKey());
const twin = twinAddress(owner.address, "testnet");

const BAD_SIGNATURE = `HostError: Error(Auth, InvalidAction)

Event log (newest first):
   0: [Diagnostic Event] contract:${usdc}, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", ${twin}, Error(Contract, #2)]`;
/** What simulating a call says once it has run: its nonce is spent. */
const NONCE_SPENT = `HostError: Error(Auth, ExistingValue)

Event log (newest first):
   0: [Diagnostic Event] contract:${usdc}, topics:[error, Error(Auth, ExistingValue)], data:["nonce already exists for address", ${twin}]`;

type Operations = { body: xdr.OperationBody }[];
function invocation(tx: { toEnvelope(): xdr.TransactionEnvelope }): { call: xdr.InvokeContractArgs; auth: xdr.SorobanAuthorizationEntry[] } {
  const envelope = tx.toEnvelope();
  const operations: Operations = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations : [];
  const body = operations[0]?.body;
  if (body?.type !== "invokeHostFunction") throw new Error("not a contract call");
  const func = body.invokeHostFunctionOp.hostFunction;
  if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return { call: func.invokeContract, auth: body.invokeHostFunctionOp.auth };
}

/** What the network records when asked what a call needs: one unsigned entry for the account, for that call. */
function recorded(call: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(twin).toScAddress(),
        nonce: BigInt(77),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
}

const simulated = (auth: xdr.SorobanAuthorizationEntry[]) => ({
  id: "1",
  latestLedger: LATEST,
  events: [],
  _parsed: true,
  minResourceFee: "100",
  transactionData: new SorobanDataBuilder().setResourceFee("100"),
  result: { auth, retval: xdr.ScVal.scvVoid() },
});

/** A signed USDC approval by the owner's account, made without the network. */
/** With `preparedAgo`, a call prepared that many ledgers back: one whose single ledger of validity has passed. */
async function signedCall(amount = 1, validForLedgers = 120, preparedAgo = 0): Promise<{ signed: Signed; body: RelayRequest }> {
  const server = {
    simulateTransaction: async (tx: never) => ({ ...simulated([recorded(invocation(tx).call)]), latestLedger: LATEST - preparedAgo }),
  } as unknown as rpc.Server;
  const prepared = await prepare(
    {
      kind: "invoke",
      contract: usdc,
      fn: "approve",
      args: [
        new Address(twin).toScVal(),
        new Address(hub).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
        nativeToScVal(LATEST + 1_000, { type: "u32" }),
      ],
    },
    { owner: owner.address, network: "testnet", server, validForLedgers },
  );
  const signed = await sign(prepared, owner);
  return { signed, body: relayRequest(signed) };
}

/** The transaction that carries a signed call, as the network would list it. */
function carrying(body: RelayRequest, ledger: number, hash: string, status = "SUCCESS") {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.fromXdr(body.func, "base64"),
        auth: body.auth.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64")),
      }),
    )
    .setTimeout(60)
    .build();
  return { status, ledger, txHash: hash, envelopeXdr: tx.toEnvelope() };
}

interface Chain {
  /** What enforcing the signed entry answers: nothing for success, or the network's explanation of a failure. */
  enforce?: () => string | undefined;
  /** The ledger in which the call's nonce was written, when it was. */
  spentIn?: number;
  transactions?: ReturnType<typeof carrying>[];
  confirmMs?: number;
}

/** A relayer on a scripted network where the account exists and every call needs just the account's entry. */
function relaying(chain: Chain = {}, relayer = new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret() }))) {
  let sequence = 100;
  const server = {
    getLatestLedger: vi.fn(async () => ({ sequence: LATEST })),
    getLedgerEntries: vi.fn(async (key: xdr.LedgerKey) => {
      const isNonce = key.type === "contractData" && key.contractData.key.type === "scvLedgerKeyNonce";
      if (!isNonce) return { entries: [{}], latestLedger: LATEST };
      return { entries: chain.spentIn === undefined ? [] : [{ lastModifiedLedgerSeq: chain.spentIn }], latestLedger: LATEST };
    }),
    simulateTransaction: vi.fn(async (tx: { toEnvelope(): xdr.TransactionEnvelope }) => {
      const { call, auth } = invocation(tx);
      if (auth.length === 0) return simulated([recorded(call)]);
      const failure = chain.enforce?.();
      return failure ? { id: "1", latestLedger: LATEST, events: [], _parsed: true, error: failure } : simulated(auth);
    }),
    getAccount: vi.fn(async (address: string) => new Account(address, String(sequence))),
    sendTransaction: vi.fn(async () => {
      sequence += 1;
      return { status: "PENDING", hash: "" };
    }),
    pollTransaction: vi.fn(async (): Promise<{ status: string }> => {
      await new Promise((resolve) => setTimeout(resolve, chain.confirmMs ?? 0));
      return { status: "SUCCESS" };
    }),
    getTransaction: vi.fn(async (): Promise<{ status: string }> => ({ status: "NOT_FOUND" })),
    getTransactions: vi.fn(async () => ({ transactions: chain.transactions ?? [], cursor: "c1" })),
  };
  (relayer as unknown as { server: unknown }).server = server;
  const work = () => [server.simulateTransaction, server.sendTransaction].map((mock) => mock.mock.calls.length);
  return { relayer, server, chain, work };
}

const refusalOf = async (relayer: Relayer, body: unknown) => (await relayer.relay(body).catch((error: unknown) => error)) as ApiError;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the same signed call, asked for again", () => {
  it("is sent once when requests arrive together, and all get the same transaction", async () => {
    const { relayer, server } = relaying({ confirmMs: 20 });
    const { body } = await signedCall();

    const answers = await Promise.all([relayer.relay(body), relayer.relay(body), relayer.relay({ ...body })]);

    expect(answers[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("gets the original transaction after it was applied, without anything being simulated or sent again", async () => {
    const { relayer, work } = relaying();
    const { body } = await signedCall();
    const first = await relayer.relay(body);
    const done = work();

    // By now the call's nonce is spent: simulated again, it would be refused.
    for (let i = 0; i < 3; i += 1) expect(await relayer.relay(body)).toEqual(first);
    expect(work()).toEqual(done);
  });

  it("is told its transaction is on its way while the outcome is not known, and is not judged a second time", async () => {
    const { relayer, server, work } = relaying();
    server.pollTransaction.mockResolvedValueOnce({ status: "NOT_FOUND" });
    const { body } = await signedCall();

    const first = await refusalOf(relayer, body);
    expect(first).toMatchObject({ code: "unavailable", status: 503, extra: { sent: true, retryAfterSeconds: 3, hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const done = work();

    const again = await refusalOf(relayer, body);
    expect(again).toMatchObject({ code: "unavailable", detail: expect.stringContaining("is on its way"), extra: { sent: true, retryAfterSeconds: 3, hash: first.extra.hash } });
    expect(work()).toEqual(done);

    // Once the network shows it applied, every further request gets its hash.
    server.getTransaction.mockResolvedValue({ status: "SUCCESS" });
    expect(await relayer.relay(body)).toEqual({ hash: first.extra.hash });
    expect(await relayer.relay(body)).toEqual({ hash: first.extra.hash });
    expect(work()).toEqual(done);
  });

  it("gets the same refusal after one that was decided before sending, marked as not sent", async () => {
    const { relayer, server, work } = relaying({ enforce: () => BAD_SIGNATURE });
    const { body } = await signedCall();

    const first = await refusalOf(relayer, body);
    expect(first).toMatchObject({ code: "bad_signature", status: 422, extra: { sent: false } });
    expect(first.detail).toMatch(/BadSignature \(account error #2\)/);
    const done = work();

    expect(await refusalOf(relayer, body)).toBe(first);
    expect(await refusalOf(relayer, { ...body })).toBe(first);
    expect(work()).toEqual(done);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("is a different call when one byte of it differs", async () => {
    const { relayer, server } = relaying();
    const one = await signedCall(1);
    const two = await signedCall(2);

    const first = await relayer.relay(one.body);
    const second = await relayer.relay(two.body);

    expect(second.hash).not.toBe(first.hash);
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("a call this server has no record of", () => {
  it("is answered with its transaction when the chain shows it has already run", async () => {
    const { body } = await signedCall();
    const hash = "ab".repeat(32);
    const { relayer, server } = relaying({
      enforce: () => NONCE_SPENT,
      spentIn: 4_999_990,
      transactions: [carrying((await signedCall(9)).body, 4_999_990, "cd".repeat(32)), carrying(body, 4_999_990, hash)],
    });

    expect(await relayer.relay(body)).toEqual({ hash });
    expect(server.getTransactions).toHaveBeenCalledWith({ startLedger: 4_999_990, pagination: { limit: 200 } });
    expect(server.sendTransaction).not.toHaveBeenCalled();

    // And from then on it is on record.
    const lookups = server.getTransactions.mock.calls.length;
    expect(await relayer.relay(body)).toEqual({ hash });
    expect(server.getTransactions).toHaveBeenCalledTimes(lookups);
  });

  it("is refused as not sent only when the chain shows it has not run", async () => {
    const { relayer, server } = relaying({ enforce: () => NONCE_SPENT });
    const { body } = await signedCall();

    const refused = await refusalOf(relayer, body);

    expect(refused).toMatchObject({ code: "bad_signature", extra: { sent: false } });
    expect(server.getTransactions).not.toHaveBeenCalled();
  });

  it("is not called refused when it has run and its transaction cannot be picked out yet", async () => {
    const { body } = await signedCall();
    const { relayer } = relaying({
      enforce: () => NONCE_SPENT,
      spentIn: 4_999_990,
      transactions: [carrying(body, 4_999_990, "ef".repeat(32), "FAILED"), carrying((await signedCall(9)).body, 4_999_990, "cd".repeat(32))],
    });

    const answer = await refusalOf(relayer, body);

    expect(answer).toMatchObject({ code: "unavailable", status: 503, extra: { sent: true, retryAfterSeconds: 3 } });
    expect(answer.detail).toMatch(/has run on Stellar/);
  });

  it("makes no claim about sending when the chain cannot be asked", async () => {
    const { relayer, server } = relaying({ enforce: () => NONCE_SPENT });
    const instance = server.getLedgerEntries.getMockImplementation()!;
    server.getLedgerEntries.mockImplementation(async (key: xdr.LedgerKey) => {
      if (key.type === "contractData" && key.contractData.key.type === "scvLedgerKeyNonce") throw new Error("socket hang up");
      return instance(key);
    });
    const { body } = await signedCall();

    const refused = await refusalOf(relayer, body);

    expect(refused.code).toBe("bad_signature");
    expect("sent" in refused.extra).toBe(false);
  });

  it("finds the transaction of an expired signature too, and otherwise says expired without a claim", async () => {
    const stale = await signedCall(1, 1, 4);
    const ran = relaying({ spentIn: 4_999_000, transactions: [carrying(stale.body, 4_999_000, "ab".repeat(32))] });
    expect(await ran.relayer.relay(stale.body)).toEqual({ hash: "ab".repeat(32) });

    const never = relaying();
    const expired = await refusalOf(never.relayer, stale.body);
    expect(expired).toMatchObject({ code: "expired", status: 409 });
    expect("sent" in expired.extra).toBe(false);
    expect(never.server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("does not take another call's transaction for this one", async () => {
    const { body } = await signedCall(1);
    const other = await signedCall(5);
    // The entry is genuine and spent, but the function sent with it is not the one it authorises.
    const swapped = { ...body, func: other.body.func };
    const { relayer, server } = relaying({
      enforce: () => NONCE_SPENT,
      spentIn: 4_999_990,
      transactions: [carrying(body, 4_999_990, "ab".repeat(32))],
    });

    const refused = await refusalOf(relayer, swapped);

    expect(refused).toMatchObject({ code: "bad_signature", extra: { sent: false } });
    expect(server.getTransactions).not.toHaveBeenCalled();
  });
});

describe("what an answer says about sending", () => {
  it("says not sent for a request that is not a relayable call at all", async () => {
    const { relayer } = relaying();
    const { body } = await signedCall();

    for (const malformed of [{ ...body, auth: [] }, { ...body, func: "AAAA" }, { ...body, owner: "nobody" }, null]) {
      expect(await refusalOf(relayer, malformed)).toMatchObject({ code: "bad_request", extra: { sent: false } });
    }
  });

  it("says not sent for a call that would cost more than the relayer pays for", async () => {
    const frugal = new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret(), RELAYER_MAX_RESOURCE_FEE: "50" }));
    const { relayer, server } = relaying({}, frugal);
    const { body } = await signedCall();

    expect(await refusalOf(relayer, body)).toMatchObject({ code: "simulation_failed", extra: { sent: false } });
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("says sent for a transaction that was included and failed", async () => {
    const { relayer, server } = relaying();
    server.pollTransaction.mockResolvedValueOnce({ status: "FAILED" });
    const { body } = await signedCall();

    expect(await refusalOf(relayer, body)).toMatchObject({ code: "transaction_failed", status: 502, extra: { sent: true } });
  });

  it("makes no claim when the relayer never got as far as looking", async () => {
    const { relayer, server } = relaying();
    server.getLatestLedger.mockRejectedValueOnce(new Error("socket hang up"));
    const { body } = await signedCall();

    const failure = await relayer.relay(body).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it("reaches the caller in the response: the field for a refusal, the header and the hash for a call on its way", async () => {
    process.env.RELAYER_SECRET ??= Keypair.random().secret();
    relaying({ enforce: () => BAD_SIGNATURE }, getRelayer());
    const refused = await relayRoute(post("/api/relay", (await signedCall(3)).body));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "bad_signature", sent: false });

    const onItsWay = relaying({}, getRelayer());
    onItsWay.server.pollTransaction.mockResolvedValueOnce({ status: "NOT_FOUND" });
    const { body } = await signedCall(4);
    await relayRoute(post("/api/relay", body));
    const again = await relayRoute(post("/api/relay", body));
    expect(again.status).toBe(503);
    expect(again.headers.get("retry-after")).toBe("3");
    expect(await again.json()).toMatchObject({ error: "unavailable", sent: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const landed = await relayRoute(post("/api/relay", (await signedCall(5)).body));
    expect(landed.status).toBe(200);
    expect(Object.keys(await landed.json())).toEqual(["hash"]);
  });
});

describe("what the relayer remembers of relayed calls", () => {
  it("is never dropped to make room: with the table full, a call is still relayed and still found on chain", async () => {
    const { relayer, server, chain } = relaying();
    const { relays } = relayer.state;
    for (let i = 0; i < 5_000; i += 1) relays.set(`relay:${i}`, { until: Date.now() + 60_000, result: { hash: String(i) } });
    const standing = [...relays.keys()];
    const { body } = await signedCall();

    const first = await relayer.relay(body);
    expect([...relays.keys()]).toEqual(standing);

    // Not on record here, so the chain is asked: the call is found, not sent again.
    chain.enforce = () => NONCE_SPENT;
    chain.spentIn = 4_999_990;
    chain.transactions = [carrying(body, 4_999_990, first.hash)];
    expect(await relayer.relay(body)).toEqual({ hash: first.hash });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);

    // An entry leaves when its own time is up, and that is what makes room.
    relays.set("relay:7", { until: Date.now() - 1, result: { hash: "7" } });
    await relayer.relay(body);
    expect(relays.has("relay:7")).toBe(false);
    expect(relays.size).toBe(5_000);
  });

  it("keeps a refusal for a quarter of an hour, then works the answer out again", async () => {
    vi.useFakeTimers();
    const refused = relaying({ enforce: () => BAD_SIGNATURE });
    const { body } = await signedCall();
    const first = await refusalOf(refused.relayer, body);

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(await refusalOf(refused.relayer, body)).toBe(first);
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await refusalOf(refused.relayer, body);
    expect(later).not.toBe(first);
    expect(later).toMatchObject({ code: "bad_signature", extra: { sent: false } });
  });
});

describe("a signature that would stay good for longer than the relayer lets through", () => {
  it("is not relayed, deployed for or sent: about ten minutes ahead is the most", async () => {
    // Prepared against a ledger far ahead, so its last valid ledger is 620 ledgers from now.
    const longLived = await signedCall(1, 120, -500);
    const { relayer, server } = relaying();

    const refused = await refusalOf(relayer, longLived.body);

    expect(refused).toMatchObject({
      code: "bad_request",
      status: 400,
      detail: expect.stringMatching(/valid for 620 ledgers.*at most 120/),
      extra: { sent: false },
    });
    expect(server.sendTransaction).not.toHaveBeenCalled();

    const atTheLimit = await signedCall(2, 120);
    await expect(relaying().relayer.relay(atTheLimit.body)).resolves.toMatchObject({ hash: expect.any(String) });
  });
});
