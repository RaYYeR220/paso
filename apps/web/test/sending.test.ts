import { twinAddress } from "@paso/sdk";
import { Account, Keypair, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as relayRoute } from "@/app/api/relay/route";
import { loadConfig } from "@/lib/server/config";
import { createQueue } from "@/lib/server/queue";
import { Relayer } from "@/lib/server/relayer";
import { post } from "./helpers";

type Sent = { status: string; hash: string; errorResult?: { result: { type: string } } };

const randomOwner = () => privateKeyToAccount(generatePrivateKey()).address;

/**
 * A relayer talking to a scripted network: no account is deployed, every
 * simulation succeeds, and `sendTransaction` answers with the next entry of
 * `answers` (a plain acceptance once they run out).
 */
function scripted(answers: Sent[] = [], confirmMs = 0) {
  const relayer = new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret() }));
  const log: string[] = [];
  let sequence = 100;
  let sends = 0;
  const server = {
    getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }),
    getAccount: vi.fn(async (address: string) => {
      log.push("sequence");
      return new Account(address, String(sequence));
    }),
    simulateTransaction: async () => ({
      id: "1",
      latestLedger: 1,
      events: [],
      _parsed: true,
      minResourceFee: "100",
      transactionData: new SorobanDataBuilder(),
      result: { auth: [], retval: xdr.ScVal.scvVoid() },
    }),
    sendTransaction: vi.fn(async (tx: { sequence: string }) => {
      sends += 1;
      log.push(`send ${tx.sequence}`);
      const answer = answers.shift() ?? { status: "PENDING", hash: String(sends).padStart(64, "0") };
      if (answer.status === "PENDING") sequence += 1;
      return answer;
    }),
    pollTransaction: async (hash: string) => {
      await new Promise((resolve) => setTimeout(resolve, confirmMs));
      log.push("confirmed");
      return { status: "SUCCESS", txHash: hash };
    },
  };
  (relayer as unknown as { server: unknown }).server = server;
  return { relayer, server, log };
}

const staleSequence = (): Sent => ({ status: "ERROR", hash: "", errorResult: { result: { type: "txBadSeq" } } });

afterEach(() => vi.useRealTimers());

describe("createQueue", () => {
  it("runs tasks one at a time, in order, and carries on after a failure", async () => {
    const queue = createQueue();
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
});

describe("transactions from the relayer account", () => {
  it("are sent one after another, each confirmed before the next reads the sequence number", async () => {
    const { relayer, log } = scripted([], 15);

    const results = await Promise.all([
      relayer.deploy({ network: "testnet", owner: randomOwner() }),
      relayer.deploy({ network: "testnet", owner: randomOwner() }),
      relayer.deploy({ network: "testnet", owner: randomOwner() }),
    ]);

    expect(log).toEqual([
      "sequence", "send 101", "confirmed",
      "sequence", "send 102", "confirmed",
      "sequence", "send 103", "confirmed",
    ]);
    expect(new Set(results.map((result) => result.hash)).size).toBe(3);
  });

  it("are rebuilt and sent again, once, when the sequence number was stale", async () => {
    const { relayer, server, log } = scripted([staleSequence()]);
    const owner = randomOwner();

    const result = await relayer.deploy({ network: "testnet", owner });

    expect(result).toEqual({ address: twinAddress(owner, "testnet"), hash: "2".padStart(64, "0"), alreadyDeployed: false });
    expect(server.getAccount).toHaveBeenCalledTimes(2);
    expect(log).toEqual(["sequence", "send 101", "sequence", "send 101", "confirmed"]);
  });

  it("give up on a second stale sequence number instead of looping", async () => {
    const { relayer, server } = scripted([staleSequence(), staleSequence()]);

    await expect(relayer.deploy({ network: "testnet", owner: randomOwner() })).rejects.toMatchObject({
      code: "unavailable",
      detail: expect.stringContaining("txBadSeq"),
    });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("wait and try again while the network asks to", async () => {
    vi.useFakeTimers();
    const { relayer, server } = scripted([{ status: "TRY_AGAIN_LATER", hash: "" }]);

    const deployment = relayer.deploy({ network: "testnet", owner: randomOwner() });
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(deployment).resolves.toMatchObject({ alreadyDeployed: false });
    expect(server.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("do not stop the queue when one of them is refused", async () => {
    const { relayer } = scripted([{ status: "ERROR", hash: "", errorResult: { result: { type: "txInsufficientBalance" } } }]);

    const [refused, sent] = await Promise.allSettled([
      relayer.deploy({ network: "testnet", owner: randomOwner() }),
      relayer.deploy({ network: "testnet", owner: randomOwner() }),
    ]);

    expect(refused.status).toBe("rejected");
    expect(sent.status).toBe("fulfilled");
  });
});

describe("request limits", () => {
  it("answer 429 with a Retry-After header once a caller has used up its minute", async () => {
    process.env.RELAYER_SECRET ??= Keypair.random().secret();
    const from = (ip: string) => relayRoute(post("/api/relay", "not json", { "x-forwarded-for": ip }));

    for (let i = 0; i < 30; i += 1) {
      expect((await from("203.0.113.50")).status).toBe(400);
    }
    const limited = await from("203.0.113.50");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });

    expect((await from("203.0.113.51")).status).toBe(400);
  });
});
