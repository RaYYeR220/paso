import { twinAddress } from "@paso/sdk";
import { Account, Keypair, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/server/config";
import { createQueue, QueueFullError, QueueTimeoutError } from "@/lib/server/queue";
import { Relayer } from "@/lib/server/relayer";
import delivered from "./fixtures/delivered-message.json";

type Sent = { status: string; hash: string; errorResult?: { result: { type: string } } };

interface Script {
  /** What `sendTransaction` answers, in order; a plain acceptance once they run out. */
  answers?: Sent[];
  confirmMs?: number;
  /** What every simulation says the transaction costs in resource fees, in stroops. */
  resourceFee?: string;
  env?: Record<string, string>;
}

const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;
const deployFor = (relayer: Relayer) => relayer.deploy({ network: "testnet", owner: randomOwner() });

/** A relayer talking to a scripted network: no account is deployed and every simulation succeeds. */
function scripted({ answers = [], confirmMs = 0, resourceFee = "100", env = {} }: Script = {}) {
  const relayer = new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret(), ...env }));
  const log: string[] = [];
  let sequence = 100;
  let sends = 0;
  const server = {
    getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }),
    getAccount: vi.fn(async (address: string) => {
      log.push("sequence");
      return new Account(address, String(sequence));
    }),
    simulateTransaction: vi.fn(async () => ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      minResourceFee: resourceFee,
      transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    })),
    sendTransaction: vi.fn(async (tx: { sequence: string; fee: string }) => {
      sends += 1;
      log.push(`send ${tx.sequence}`);
      const answer = answers.shift() ?? { status: "PENDING", hash: String(sends).padStart(64, "0") };
      if (answer.status === "PENDING") sequence += 1;
      return answer;
    }),
    pollTransaction: vi.fn(async (hash: string) => {
      await new Promise((resolve) => setTimeout(resolve, confirmMs));
      log.push("confirmed");
      return { status: "SUCCESS", txHash: hash };
    }),
    getTransaction: vi.fn<(hash: string) => Promise<{ status: string; latestLedgerCloseTime?: number }>>(async () => ({ status: "NOT_FOUND" })),
  };
  (relayer as unknown as { server: unknown }).server = server;
  return { relayer, server, log };
}

const staleSequence = (): Sent => ({ status: "ERROR", hash: "", errorResult: { result: { type: "txBadSeq" } } });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createQueue", () => {
  const roomy = { maxPending: 10, timeoutMs: 1_000 };

  it("runs tasks one at a time, in order, and carries on after a failure", async () => {
    const queue = createQueue(roomy);
    const log: string[] = [];
    const task = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name} starts`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name} ends`);
      if (fail) throw new Error(name);
      return name;
    };

    const results = await Promise.allSettled([queue(task("a", 20)), queue(task("b", 5, true)), queue(task("c", 1))]);

    expect(log).toEqual(["a starts", "a ends", "b starts", "b ends", "c starts", "c ends"]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("refuses a task once it holds as many as it takes, and takes one again when there is room", async () => {
    const queue = createQueue({ maxPending: 2, timeoutMs: 1_000 });
    let release: () => void = () => undefined;
    const held = queue(() => new Promise<void>((resolve) => (release = resolve)));
    const waiting = queue(async () => "second");

    await expect(queue(async () => "third")).rejects.toBeInstanceOf(QueueFullError);

    release();
    await held;
    expect(await waiting).toBe("second");
    expect(await queue(async () => "fourth")).toBe("fourth");
  });

  it("gives up on a task that hangs, tells it so, and runs the next one", async () => {
    vi.useFakeTimers();
    const queue = createQueue({ maxPending: 10, timeoutMs: 1_000 });
    let abandoned: AbortSignal | undefined;

    const hanging = queue((signal) => {
      abandoned = signal;
      return new Promise<string>(() => undefined);
    });
    const next = queue(async () => "next");
    const outcome = hanging.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(999);
    expect(abandoned?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeInstanceOf(QueueTimeoutError);
    expect(abandoned?.aborted).toBe(true);
    expect(await next).toBe("next");
  });
});

describe("transactions from the relayer account", () => {
  it("are sent one after another, each confirmed before the next reads the sequence number", async () => {
    const { relayer, log } = scripted({ confirmMs: 15 });

    const results = await Promise.all([deployFor(relayer), deployFor(relayer), deployFor(relayer)]);

    expect(log).toEqual([
      "sequence", "send 101", "confirmed",
      "sequence", "send 102", "confirmed",
      "sequence", "send 103", "confirmed",
    ]);
    expect(new Set(results.map((result) => result.hash)).size).toBe(3);
  });

  it("are rebuilt and sent again, once, when the sequence number was stale", async () => {
    const { relayer, server, log } = scripted({ answers: [staleSequence()] });
    const owner = randomOwner();

    const result = await relayer.deploy({ network: "testnet", owner });

    expect(result).toEqual({
      address: twinAddress(owner, "testnet"),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      alreadyDeployed: false,
    });
    expect(server.getAccount).toHaveBeenCalledTimes(2);
    expect(log).toEqual(["sequence", "send 101", "sequence", "send 101", "confirmed"]);
  });

  it("give up on a second stale sequence number instead of looping", async () => {
    const { relayer, server } = scripted({ answers: [staleSequence(), staleSequence()] });

    await expect(deployFor(relayer)).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("txBadSeq"),
    });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("wait and try again while the network asks to", async () => {
    vi.useFakeTimers();
    const { relayer, server } = scripted({ answers: [{ status: "TRY_AGAIN_LATER", hash: "" }] });

    const deployment = deployFor(relayer);
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(deployment).resolves.toMatchObject({ alreadyDeployed: false });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("do not stop the queue when one of them is refused", async () => {
    const { relayer } = scripted({
      answers: [{ status: "ERROR", hash: "", errorResult: { result: { type: "txInsufficientBalance" } } }],
    });

    const [refused, sent] = await Promise.allSettled([deployFor(relayer), deployFor(relayer)]);

    expect(refused.status).toBe("rejected");
    expect(sent.status).toBe("fulfilled");
  });

  it("do not hold the queue when the network stops answering", async () => {
    vi.useFakeTimers();
    const { relayer, server } = scripted();
    server.pollTransaction.mockImplementationOnce(() => new Promise(() => undefined));

    const stuck = deployFor(relayer).catch((error: unknown) => error);
    const next = deployFor(relayer);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(await stuck).toMatchObject({ code: "unavailable", detail: expect.stringContaining("too long") });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toMatchObject({ alreadyDeployed: false });
  });

  it("are not sent late by a request the queue has given up on", async () => {
    vi.useFakeTimers();
    const { relayer, server } = scripted();
    let answer: (account: Account) => void = () => undefined;
    server.getAccount.mockImplementationOnce(
      (address: string) => new Promise<Account>((resolve) => (answer = () => resolve(new Account(address, "100")))),
    );

    const stuck = deployFor(relayer).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await stuck).toMatchObject({ code: "unavailable" });

    answer(new Account(relayer.address, "100"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("are declined at once when too many are already waiting", async () => {
    const { relayer, server } = scripted();
    server.pollTransaction.mockImplementation(() => new Promise(() => undefined));

    const waiting = Array.from({ length: 8 }, () => deployFor(relayer).catch(() => undefined));
    await vi.waitFor(() => expect(server.sendTransaction).toHaveBeenCalledTimes(1));

    await expect(deployFor(relayer)).rejects.toMatchObject({ code: "unavailable", detail: expect.stringContaining("busy") });
    expect(waiting).toHaveLength(8);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("a transaction whose outcome was not learned", () => {
  /** A deployment whose transaction went out and was never seen to land: the wait for it ran out. */
  async function unconfirmed() {
    vi.useFakeTimers();
    const run = scripted();
    run.server.pollTransaction.mockImplementationOnce(() => new Promise(() => undefined));
    const body = { network: "testnet", owner: randomOwner() };

    const stuck = run.relayer.deploy(body).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await stuck).toMatchObject({ code: "unavailable" });
    const [pending] = [...run.relayer.state.sends.values()];
    return { ...run, body, hash: pending!.hash };
  }

  it("stays on record, and is not sent a second time while it may still land", async () => {
    const { relayer, server, body, hash } = await unconfirmed();

    for (let i = 0; i < 3; i += 1) {
      await expect(relayer.deploy(body)).rejects.toMatchObject({
        code: "unavailable",
        detail: expect.stringContaining("is on its way"),
        extra: { hash },
      });
    }
    expect(server.getTransaction).toHaveBeenCalledWith(hash);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.state.fees.spent()).toBe(BigInt(1_100));
  });

  it("is answered with its own hash once the network shows it applied", async () => {
    const { relayer, server, body, hash } = await unconfirmed();
    server.getTransaction.mockResolvedValue({ status: "SUCCESS" });

    await expect(relayer.deploy(body)).resolves.toMatchObject({ hash, alreadyDeployed: false });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.state.sends.size).toBe(0);
  });

  it("is reported as failed once the network shows it failed, and only then tried anew", async () => {
    const { relayer, server, body, hash } = await unconfirmed();
    server.getTransaction.mockResolvedValue({ status: "FAILED" });

    await expect(relayer.deploy(body)).rejects.toMatchObject({ code: "transaction_failed", extra: { hash } });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);

    const anew = relayer.deploy(body);
    await vi.advanceTimersByTimeAsync(10);
    await expect(anew).resolves.toMatchObject({ alreadyDeployed: false });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("is sent anew only once the network says it can no longer be included", async () => {
    const { relayer, server, body } = await unconfirmed();
    const [pending] = [...relayer.state.sends.values()];
    const networkClock = (seconds: number) => ({ status: "NOT_FOUND", latestLedgerCloseTime: seconds });

    // The latest ledger closed exactly at the time bound: the next one may still carry the transaction.
    server.getTransaction.mockResolvedValue(networkClock(pending!.deadline / 1000));
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(relayer.deploy(body)).rejects.toMatchObject({ code: "unavailable", detail: expect.stringContaining("is on its way") });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);

    server.getTransaction.mockResolvedValue(networkClock(pending!.deadline / 1000 + 1));
    const anew = relayer.deploy(body);
    await vi.advanceTimersByTimeAsync(10);
    await expect(anew).resolves.toMatchObject({ alreadyDeployed: false });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("counts as on its way when the network never said whether it took it", async () => {
    const { relayer, server } = scripted();
    server.sendTransaction.mockRejectedValueOnce(new Error("socket hang up"));
    const body = { network: "testnet", owner: randomOwner() };

    await expect(relayer.deploy(body)).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("did not say whether it took it"),
    });
    await expect(relayer.deploy(body)).rejects.toMatchObject({ detail: expect.stringContaining("is on its way") });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("counts as on its way when it was taken and not seen in a ledger in time", async () => {
    const { relayer, server } = scripted();
    server.pollTransaction.mockResolvedValueOnce({ status: "NOT_FOUND", txHash: "" });
    const body = { network: "testnet", owner: randomOwner() };

    await expect(relayer.deploy(body)).rejects.toMatchObject({ detail: expect.stringContaining("has not been confirmed yet") });
    await expect(relayer.deploy(body)).rejects.toMatchObject({ detail: expect.stringContaining("is on its way") });
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("is off the record at once when the network refused it", async () => {
    const { relayer } = scripted({
      answers: [{ status: "ERROR", hash: "", errorResult: { result: { type: "txInsufficientBalance" } } }],
    });

    await expect(deployFor(relayer)).rejects.toMatchObject({ code: "unavailable" });
    expect(relayer.state.sends.size).toBe(0);
  });
});

describe("what the relayer keeps on record", () => {
  it("is reserved once for requests that arrive together", async () => {
    const { relayer, server } = scripted({ confirmMs: 10, env: { RELAYER_MAX_DAILY_FEES: "1100" } });
    const body = { network: "testnet", owner: randomOwner() };

    const [first, second, third] = await Promise.all([relayer.deploy(body), relayer.deploy(body), relayer.deploy(body)]);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(relayer.state.fees.spent()).toBe(BigInt(1_100));
  });

  it("is never dropped to make room: with the table full, new sends are declined", async () => {
    const { relayer, server } = scripted();
    const { sends } = relayer.state;
    const onItsWay = (hash: string, deadline: number) => ({ hash, deadline, submissions: 1, bid: BigInt(1_000), setAside: BigInt(1_100) });
    for (let i = 0; i < 256; i += 1) sends.set(`deploy:${i}`, onItsWay(String(i), Date.now() + 60_000));
    const standing = [...sends.keys()];

    await expect(deployFor(relayer)).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("too many transactions"),
    });
    expect([...sends.keys()]).toEqual(standing);
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(relayer.state.fees.spent()).toBe(BigInt(0));

    // An entry leaves when its own time is up, and that is what makes room.
    sends.set("deploy:7", onItsWay("7", Date.now() - 31_000));
    await expect(deployFor(relayer)).resolves.toMatchObject({ alreadyDeployed: false });
    expect(sends.has("deploy:7")).toBe(false);
    expect(sends.size).toBe(255);
  });

  it("includes the transactions of code it replaced: nothing is paid for until those have settled", async () => {
    const { relayer, server } = scripted();
    let waiting = 2;
    relayer.state.predecessor = { inFlight: () => waiting, until: Date.now() + 60_000 };

    await expect(deployFor(relayer)).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("restarted with transactions on their way"),
    });
    expect(server.sendTransaction).not.toHaveBeenCalled();

    waiting = 0;
    await expect(deployFor(relayer)).resolves.toMatchObject({ alreadyDeployed: false });
    expect(relayer.state.predecessor).toBeUndefined();
  });

  it("waits out a set time when it cannot see what the replaced code had on its way", async () => {
    vi.useFakeTimers();
    const { relayer, server } = scripted();
    relayer.state.predecessor = { until: Date.now() + 180_000 };

    await expect(deployFor(relayer)).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(179_000);
    await expect(deployFor(relayer)).rejects.toMatchObject({ code: "unavailable" });
    expect(server.sendTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    const deployed = deployFor(relayer);
    await vi.advanceTimersByTimeAsync(10);
    await expect(deployed).resolves.toMatchObject({ alreadyDeployed: false });
  });

  it("counts what is queued, on its way and unsettled as in flight", async () => {
    const { relayer, server } = scripted();
    expect(relayer.state.inFlight()).toBe(0);

    server.pollTransaction.mockResolvedValueOnce({ status: "NOT_FOUND", txHash: "" });
    await deployFor(relayer).catch(() => undefined);
    expect(relayer.state.inFlight()).toBe(1);

    relayer.state.unsettled += 1;
    expect(relayer.state.inFlight()).toBe(2);
  });
});

describe("what the relayer account pays", () => {
  /** Makes Circle's attestation service answer with a real, attested message, and the chain say it is undelivered. */
  function attested(relayer: Relayer) {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("iris-api")
        ? Promise.resolve(
            Response.json({ messages: [{ message: delivered.message, attestation: delivered.attestation, status: "complete" }] }),
          )
        : realFetch(input, init),
    );
    vi.spyOn(relayer as unknown as { isNonceUsed: () => Promise<boolean> }, "isNonceUsed").mockResolvedValue(false);
    return { network: "testnet", sourceDomain: 1, txHash: `0x${"5e".repeat(32)}` };
  }

  it("is capped per transaction for a deployment, not only for a relayed call", async () => {
    const { relayer, server } = scripted({ resourceFee: "5000001" });

    await expect(deployFor(relayer)).rejects.toMatchObject({
      code: "simulation_failed",
      detail: expect.stringMatching(/cost 5000001 stroops .* up to 5000000 stroops \(0\.5 XLM\)/),
    });
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("is capped per transaction for a delivery", async () => {
    const { relayer, server } = scripted({ resourceFee: "777", env: { RELAYER_MAX_RESOURCE_FEE: "776" } });

    await expect(relayer.deliver(attested(relayer))).rejects.toMatchObject({
      code: "simulation_failed",
      detail: expect.stringMatching(/up to 776 stroops/),
    });
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("passes a transaction that costs exactly the cap", async () => {
    const { relayer, server } = scripted({ resourceFee: "776", env: { RELAYER_MAX_RESOURCE_FEE: "776" } });

    await expect(relayer.deliver(attested(relayer))).resolves.toMatchObject({ status: "delivered", route: "forwarder" });
    expect(server.sendTransaction.mock.calls[0]![0].fee).toBe("1776");
  });

  it("stops at the day's ceiling, whatever the transactions are for", async () => {
    // Each transaction costs 1000 for inclusion and 100 in resources.
    const { relayer, server } = scripted({ env: { RELAYER_MAX_DAILY_FEES: "3300" } });

    await deployFor(relayer);
    await relayer.deliver(attested(relayer));
    await deployFor(relayer);
    const refused = await deployFor(relayer).catch((error: unknown) => error);

    expect(refused).toMatchObject({ code: "unavailable", status: 503, detail: expect.stringMatching(/fees in a day/) });
    expect(server.sendTransaction).toHaveBeenCalledTimes(3);
    await expect(relayer.deliver({ ...attested(relayer), txHash: `0x${"5f".repeat(32)}` })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(server.sendTransaction).toHaveBeenCalledTimes(3);
  });

  it("counts a transaction once when it has to be rebuilt, and keeps counting one that failed", async () => {
    const rebuilt = scripted({ answers: [staleSequence()], env: { RELAYER_MAX_DAILY_FEES: "1100" } });
    await expect(deployFor(rebuilt.relayer)).resolves.toMatchObject({ alreadyDeployed: false });

    const failed = scripted({
      answers: [{ status: "ERROR", hash: "", errorResult: { result: { type: "txInsufficientBalance" } } }],
      env: { RELAYER_MAX_DAILY_FEES: "1100" },
    });
    await expect(deployFor(failed.relayer)).rejects.toMatchObject({ detail: expect.stringContaining("txInsufficientBalance") });
    await expect(deployFor(failed.relayer)).rejects.toMatchObject({ detail: expect.stringMatching(/fees in a day/) });
    expect(failed.server.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
