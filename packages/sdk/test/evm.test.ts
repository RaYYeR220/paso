import { StrKey } from "@stellar/stellar-sdk";
import type { Hex, PublicClient, WalletClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultFinalityOf,
  forwardRecipientHookData,
  fundFromEvm,
  isReceivedOnEvm,
  receiveMessageOnEvm,
  TransactionRevertedError,
} from "../src/evm";
import { evmChain, NETWORKS } from "../src/networks";
import { twinAddress } from "../src/twin";
import { hex, OWNER, testNetwork } from "./helpers";

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TWIN = twinAddress(OWNER, testNetwork);
const TWIN_BYTES32 = `0x${hex(StrKey.decodeContract(TWIN))}`;
const FORWARDER_BYTES32 = `0x${hex(StrKey.decodeContract(testNetwork.stellar.forwarder))}`;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const APPROVE_HASH = `0x${"a1".repeat(32)}` as Hex;
const BURN_HASH = `0x${"b2".repeat(32)}` as Hex;

interface Write {
  address: string;
  functionName: string;
  args: readonly unknown[];
  chain: { id: number };
  account: { address: string };
}

interface Chain {
  /** The allowance before any approval. */
  allowance?: bigint;
  burnStatus?: string;
  /** How many reads after the approval still show the old allowance: a reader that has not caught up. */
  staleReads?: number;
  /** What asking for the burn does, attempt after attempt; a plain success once they run out. */
  burns?: (Error | "sent")[];
}

function clients({ allowance = 0n, burnStatus = "success", staleReads = 0, burns = [] }: Chain = {}) {
  const writes: Write[] = [];
  let approved: bigint | undefined;
  let stale = staleReads;
  const walletClient = {
    account: { address: PAYER, type: "json-rpc" },
    writeContract: vi.fn(async (request: Write) => {
      writes.push(request);
      if (request.functionName === "approve") {
        approved = request.args[1] as bigint;
        return APPROVE_HASH;
      }
      const outcome = burns.shift();
      if (outcome instanceof Error) throw outcome;
      return BURN_HASH;
    }),
  };
  const publicClient = {
    readContract: vi.fn(async () => {
      if (approved === undefined) return allowance;
      if (stale > 0) {
        stale -= 1;
        return allowance;
      }
      return approved;
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({
      status: hash === BURN_HASH ? burnStatus : "success",
    })),
  };
  return {
    writes,
    walletClient: walletClient as unknown as WalletClient,
    publicClient: publicClient as unknown as PublicClient,
    mocks: { walletClient, publicClient },
  };
}

describe("forwardRecipientHookData", () => {
  it("is a 32-byte header followed by the recipient strkey as text", () => {
    const recipient = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
    const reserved = "00".repeat(24);
    const version = "00000000";
    const length = "00000038";
    expect(forwardRecipientHookData(recipient)).toBe(
      `0x${reserved}${version}${length}${Buffer.from(recipient, "ascii").toString("hex")}`,
    );
  });

  it("accepts account addresses too", () => {
    const recipient = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(forwardRecipientHookData(recipient).endsWith(Buffer.from(recipient, "ascii").toString("hex"))).toBe(true);
  });

  it("rejects text that is not a Stellar address", () => {
    expect(() => forwardRecipientHookData("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toThrow(
      /not a Stellar address/,
    );
  });
});

describe("fundFromEvm", () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = { amount: 1_000_000n, owner: OWNER, network: testNetwork, maxFee: 156n } as const;

  it("burns through the forwarder with the twin named in the hook data", async () => {
    const { walletClient, publicClient, writes } = clients({ allowance: 1_000_000n });
    const result = await fundFromEvm({ ...base, walletClient, publicClient, route: "forwarder" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      address: testNetwork.evm.tokenMessenger,
      functionName: "depositForBurnWithHook",
      args: [
        1_000_000n,
        27,
        FORWARDER_BYTES32,
        testNetwork.evm.usdc,
        FORWARDER_BYTES32,
        156n,
        1000,
        forwardRecipientHookData(TWIN),
      ],
      chain: { id: 84532 },
      account: { address: PAYER },
    });
    expect(result).toEqual({ burnTxHash: BURN_HASH, route: "forwarder", twin: TWIN, maxFee: 156n });
  });

  it("burns directly to the twin's contract id with no destination caller", async () => {
    const { walletClient, publicClient, writes } = clients({ allowance: 5_000_000n });
    const result = await fundFromEvm({ ...base, walletClient, publicClient, route: "direct" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      address: testNetwork.evm.tokenMessenger,
      functionName: "depositForBurn",
      args: [1_000_000n, 27, TWIN_BYTES32, testNetwork.evm.usdc, ZERO_BYTES32, 156n, 1000],
    });
    expect(result.route).toBe("direct");
  });

  it("approves the token messenger first when the allowance is short", async () => {
    const { walletClient, publicClient, writes, mocks } = clients({ allowance: 999_999n });
    const result = await fundFromEvm({ ...base, walletClient, publicClient, route: "direct" });

    expect(mocks.publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: testNetwork.evm.usdc,
        functionName: "allowance",
        args: [PAYER, testNetwork.evm.tokenMessenger],
      }),
    );
    expect(writes.map((write) => write.functionName)).toEqual(["approve", "depositForBurn"]);
    expect(writes[0]).toMatchObject({
      address: testNetwork.evm.usdc,
      args: [testNetwork.evm.tokenMessenger, 1_000_000n],
    });
    expect(mocks.publicClient.waitForTransactionReceipt).toHaveBeenNthCalledWith(1, { hash: APPROVE_HASH });
    expect(result.approveTxHash).toBe(APPROVE_HASH);
  });

  describe("right after an approval", () => {
    const notYet = () =>
      Object.assign(new Error("Execution reverted with reason: ERC20: transfer amount exceeds allowance."), { code: -32603 });
    const short = { ...base, route: "direct" } as const;

    it("waits until the approval shows before it asks for the burn", async () => {
      vi.useFakeTimers();
      try {
        const { walletClient, publicClient, writes } = clients({ staleReads: 3 });
        const funding = fundFromEvm({ ...short, walletClient, publicClient });

        await vi.advanceTimersByTimeAsync(2_500);
        expect(writes.map((write) => write.functionName)).toEqual(["approve"]);
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(funding).resolves.toMatchObject({ burnTxHash: BURN_HASH, approveTxHash: APPROVE_HASH });
        expect(writes.map((write) => write.functionName)).toEqual(["approve", "depositForBurn"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks for the burn again, after a pause, when the wallet's side has not seen the approval yet", async () => {
      vi.useFakeTimers();
      try {
        const { walletClient, publicClient, writes } = clients({ burns: [notYet(), notYet()] });
        const funding = fundFromEvm({ ...short, walletClient, publicClient });
        await vi.advanceTimersByTimeAsync(10_000);

        await expect(funding).resolves.toMatchObject({ burnTxHash: BURN_HASH });
        expect(writes.map((write) => write.functionName)).toEqual(["approve", "depositForBurn", "depositForBurn", "depositForBurn"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gives up after three tries, with the wallet's own words", async () => {
      vi.useFakeTimers();
      try {
        const { walletClient, publicClient, writes } = clients({ burns: [notYet(), notYet(), notYet(), notYet()] });
        const funding = fundFromEvm({ ...short, walletClient, publicClient }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(await funding).toMatchObject({ message: expect.stringContaining("exceeds allowance") });
        expect(writes.filter((write) => write.functionName === "depositForBurn")).toHaveLength(3);
        expect(writes.filter((write) => write.functionName === "approve")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not ask twice for any other refusal, or when it made no approval itself", async () => {
      const declined = Object.assign(new Error("User rejected the request."), { code: 4001 });
      const rejecting = clients({ burns: [declined] });
      await expect(fundFromEvm({ ...short, walletClient: rejecting.walletClient, publicClient: rejecting.publicClient })).rejects.toBe(declined);
      expect(rejecting.writes.filter((write) => write.functionName === "depositForBurn")).toHaveLength(1);

      const approvedBefore = clients({ allowance: 5_000_000n, burns: [notYet()] });
      await expect(
        fundFromEvm({ ...short, walletClient: approvedBefore.walletClient, publicClient: approvedBefore.publicClient }),
      ).rejects.toThrow(/exceeds allowance/);
      expect(approvedBefore.writes.map((write) => write.functionName)).toEqual(["depositForBurn"]);
    });
  });

  it("asks Iris for the fast-transfer fee when no maximum is given", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify([
            { finalityThreshold: 1000, minimumFee: 1.3 },
            { finalityThreshold: 2000, minimumFee: 0 },
          ]),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { walletClient, publicClient, writes } = clients({ allowance: 1_000_000n });
    const { maxFee: _given, ...withoutFee } = base;
    const result = await fundFromEvm({ ...withoutFee, walletClient, publicClient, route: "direct" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/27");
    expect(result.maxFee).toBe(156n);
    expect(writes[0]?.args[5]).toBe(156n);
  });

  describe("from another chain", () => {
    const arc = evmChain(testNetwork, "arc");
    const fees = () => {
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify([
              { finalityThreshold: 1000, minimumFee: 1 },
              { finalityThreshold: 2000, minimumFee: 0 },
            ]),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    };

    it("burns on Arc through Arc's contracts, with a standard transfer and Circle's fee for it", async () => {
      const fetchMock = fees();
      const { walletClient, publicClient, writes, mocks } = clients({ allowance: 0n });
      const { maxFee: _given, ...withoutFee } = base;
      const result = await fundFromEvm({ ...withoutFee, walletClient, publicClient, route: "forwarder", chain: "arc" });

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/26/27");
      expect(mocks.publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: arc.usdc, functionName: "allowance", args: [PAYER, arc.tokenMessenger] }),
      );
      expect(writes.map((write) => [write.address, write.functionName, write.chain.id])).toEqual([
        [arc.usdc, "approve", 5042002],
        [arc.tokenMessenger, "depositForBurnWithHook", 5042002],
      ]);
      // 6-decimal units through the USDC token, as on every other chain.
      expect(writes[0]?.args).toEqual([arc.tokenMessenger, 1_000_000n]);
      expect(writes[1]?.args).toEqual([
        1_000_000n,
        27,
        FORWARDER_BYTES32,
        "0x3600000000000000000000000000000000000000",
        FORWARDER_BYTES32,
        0n,
        2000,
        forwardRecipientHookData(TWIN),
      ]);
      expect(result).toEqual({ burnTxHash: BURN_HASH, approveTxHash: APPROVE_HASH, route: "forwarder", twin: TWIN, maxFee: 0n });
    });

    it("burns on Ethereum with a fast transfer and Circle's fee for it", async () => {
      const fetchMock = fees();
      const ethereum = evmChain(testNetwork, "ethereum");
      const { walletClient, publicClient, writes } = clients({ allowance: 1_000_000n });
      const { maxFee: _given, ...withoutFee } = base;
      const result = await fundFromEvm({ ...withoutFee, walletClient, publicClient, route: "direct", chain: "ethereum" });

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/0/27");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        address: ethereum.tokenMessenger,
        functionName: "depositForBurn",
        args: [1_000_000n, 27, TWIN_BYTES32, ethereum.usdc, ZERO_BYTES32, 120n, 1000],
        chain: { id: 11155111 },
      });
      expect(result.maxFee).toBe(120n);
    });

    it("burns with the finality it is given, and asks the fee for that finality", async () => {
      const fetchMock = fees();
      const { walletClient, publicClient, writes } = clients({ allowance: 1_000_000n });
      const { maxFee: _given, ...withoutFee } = base;
      await fundFromEvm({ ...withoutFee, walletClient, publicClient, route: "direct", chain: "optimism", minFinalityThreshold: 2000 });

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/2/27");
      expect(writes[0]?.args.slice(5)).toEqual([0n, 2000]);
    });

    it("asks for fast transfers where Circle offers them and standard ones elsewhere", () => {
      for (const network of [NETWORKS.testnet, NETWORKS.mainnet]) {
        expect(defaultFinalityOf(evmChain(network, "base"))).toBe(1000);
        expect(defaultFinalityOf(evmChain(network, "ethereum"))).toBe(1000);
        expect(defaultFinalityOf(evmChain(network, "arbitrum"))).toBe(1000);
        expect(defaultFinalityOf(evmChain(network, "optimism"))).toBe(1000);
        expect(defaultFinalityOf(evmChain(network, "arc"))).toBe(2000);
      }
    });

    it("refuses a chain Paso does not list before anything is read or sent", async () => {
      const fetchMock = fees();
      const { walletClient, publicClient, writes, mocks } = clients();
      await expect(
        fundFromEvm({ ...base, walletClient, publicClient, chain: "polygon" as never }),
      ).rejects.toThrow(/Unknown EVM chain "polygon"/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.publicClient.readContract).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    });

    it("names the chain a burn reverted on", async () => {
      const { walletClient, publicClient } = clients({ allowance: 1_000_000n, burnStatus: "reverted" });
      await expect(fundFromEvm({ ...base, walletClient, publicClient, route: "direct", chain: "arc" })).rejects.toThrow(
        new RegExp(`burn reverted on Arc: ${BURN_HASH}`),
      );
    });
  });

  it("fails when the burn reverts", async () => {
    const { walletClient, publicClient } = clients({ allowance: 1_000_000n, burnStatus: "reverted" });
    await expect(fundFromEvm({ ...base, walletClient, publicClient, route: "direct" })).rejects.toThrow(
      new RegExp(`burn.*reverted.*${BURN_HASH}`),
    );
  });

  it("needs a wallet with an account and a positive amount", async () => {
    const { walletClient, publicClient } = clients();
    const noAccount = { ...walletClient, account: undefined } as unknown as WalletClient;
    await expect(fundFromEvm({ ...base, walletClient: noAccount, publicClient, route: "direct" })).rejects.toThrow(
      /no account/,
    );
    await expect(fundFromEvm({ ...base, amount: 0n, walletClient, publicClient, route: "direct" })).rejects.toThrow(
      /positive/,
    );
  });

  it("refuses a maximum fee that would swallow the transfer", async () => {
    const { walletClient, publicClient } = clients({ allowance: 1_000_000n });
    await expect(
      fundFromEvm({ ...base, amount: 100n, maxFee: 100n, walletClient, publicClient, route: "direct" }),
    ).rejects.toThrow(/fee.*less than the amount/);
  });
});

describe("receiveMessageOnEvm", () => {
  const MINT_HASH = `0x${"c3".repeat(32)}` as Hex;
  const NONCE = `0x${"07".repeat(32)}`;
  const ATTESTATION = `0x${"ee".repeat(130)}` as Hex;
  /** A CCTP message from Stellar to Base: a 148-byte header carrying the nonce, then a burn message body. */
  const MESSAGE = `0x${"00000001"}${"0000001b"}${"00000006"}${NONCE.slice(2)}${"11".repeat(104)}${"22".repeat(228)}` as Hex;

  /** Base as seen through `usedNonces`: each read answers with the next entry of `used`, the last one from then on. */
  function base({ used = [0n], write, status = "success" }: { used?: bigint[]; write?: () => Promise<Hex>; status?: string } = {}) {
    const reads = [...used];
    const publicClient = {
      readContract: vi.fn(async (_request: { functionName: string; args: readonly unknown[]; address: string }) =>
        reads.length > 1 ? reads.shift()! : reads[0]!,
      ),
      waitForTransactionReceipt: vi.fn(async (_request: { hash: Hex }) => ({ status })),
    };
    const walletClient = {
      account: { address: PAYER, type: "json-rpc" },
      writeContract: vi.fn(async (_request: Write) => (write ? write() : MINT_HASH)),
    };
    const args = {
      walletClient: walletClient as unknown as WalletClient,
      publicClient: publicClient as unknown as PublicClient,
      message: MESSAGE,
      attestation: ATTESTATION,
      network: testNetwork,
    };
    return { args, publicClient, walletClient };
  }

  it("hands exactly the attested bytes to the message transmitter and waits for the mint", async () => {
    const { args, publicClient, walletClient } = base();

    expect(await receiveMessageOnEvm(args)).toEqual({ hash: MINT_HASH, alreadyReceived: false });

    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    const request = walletClient.writeContract.mock.calls[0]![0];
    expect(request.address).toBe(testNetwork.evm.messageTransmitter);
    expect(request.functionName).toBe("receiveMessage");
    expect(request.args).toEqual([MESSAGE, ATTESTATION]);
    expect(request.chain.id).toBe(testNetwork.evm.chain.id);
    expect(request.account.address).toBe(PAYER);
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MINT_HASH });
  });

  it("sends with the gas limit, the fee caps and the confirmations it is given", async () => {
    const { args, publicClient, walletClient } = base();

    await receiveMessageOnEvm({ ...args, gas: 240_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 3n, confirmations: 2 });

    expect(walletClient.writeContract.mock.calls[0]![0]).toMatchObject({ gas: 240_000n, maxFeePerGas: 7n, maxPriorityFeePerGas: 3n });
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: MINT_HASH, confirmations: 2 });

    const plain = base();
    await receiveMessageOnEvm(plain.args);
    const request = plain.walletClient.writeContract.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect("gas" in request || "maxFeePerGas" in request || "maxPriorityFeePerGas" in request).toBe(false);
  });

  it("never sends a failed call a second time", async () => {
    const refused = base({
      write: async () => {
        throw new Error("insufficient funds for gas");
      },
    });
    await expect(receiveMessageOnEvm(refused.args)).rejects.toThrow();
    expect(refused.walletClient.writeContract).toHaveBeenCalledTimes(1);

    const reverted = base({ status: "reverted" });
    await expect(receiveMessageOnEvm(reverted.args)).rejects.toThrow();
    expect(reverted.walletClient.writeContract).toHaveBeenCalledTimes(1);
  });

  it("asks the chain for the message's nonce before spending anything", async () => {
    const { args, publicClient, walletClient } = base({ used: [1n] });

    expect(await receiveMessageOnEvm(args)).toEqual({ alreadyReceived: true });

    const read = publicClient.readContract.mock.calls[0]![0];
    expect(read.address).toBe(testNetwork.evm.messageTransmitter);
    expect(read.functionName).toBe("usedNonces");
    expect(read.args).toEqual([NONCE]);
    expect(walletClient.writeContract).not.toHaveBeenCalled();
    expect(await isReceivedOnEvm(args.publicClient, MESSAGE, testNetwork)).toBe(true);
  });

  it("counts a call that lost the race as received, not as a failure", async () => {
    const lost = base({
      used: [0n, 1n],
      write: async () => {
        throw new Error("execution reverted: Nonce already used");
      },
    });
    expect(await receiveMessageOnEvm(lost.args)).toEqual({ alreadyReceived: true });

    const revertedOnChain = base({ used: [0n, 1n], status: "reverted" });
    expect(await receiveMessageOnEvm(revertedOnChain.args)).toEqual({ alreadyReceived: true });
  });

  it("fails when the call fails and the message is still unreceived", async () => {
    const refused = base({
      write: async () => {
        throw new Error("insufficient funds for gas");
      },
    });
    await expect(receiveMessageOnEvm(refused.args)).rejects.toThrow("insufficient funds for gas");

    const reverted = base({ status: "reverted" });
    const failure = await receiveMessageOnEvm(reverted.args).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransactionRevertedError);
    expect((failure as TransactionRevertedError).hash).toBe(MINT_HASH);
    expect((failure as Error).message).toMatch(/mint reverted on Base/);
  });

  it("reports the hash as soon as the call is sent, before it is confirmed", async () => {
    const order: string[] = [];
    const { args, publicClient } = base();
    publicClient.waitForTransactionReceipt.mockImplementation(async () => {
      order.push("confirmed");
      return { status: "success" };
    });

    await receiveMessageOnEvm({ ...args, onSubmitted: (hash) => order.push(`submitted ${hash}`) });

    expect(order).toEqual([`submitted ${MINT_HASH}`, "confirmed"]);
  });

  it("mints on the chain it is told, through that chain's transmitter", async () => {
    const arc = evmChain(testNetwork, "arc");
    const toArc = `0x${"00000001"}${"0000001b"}${"0000001a"}${NONCE.slice(2)}${"11".repeat(104)}${"22".repeat(228)}` as Hex;
    const { args, publicClient, walletClient } = base();

    expect(await receiveMessageOnEvm({ ...args, message: toArc, chain: "arc" })).toEqual({ hash: MINT_HASH, alreadyReceived: false });

    expect(publicClient.readContract.mock.calls[0]![0].address).toBe(arc.messageTransmitter);
    const request = walletClient.writeContract.mock.calls[0]![0];
    expect(request.address).toBe(arc.messageTransmitter);
    expect(request.chain.id).toBe(5042002);
    expect(request.args).toEqual([toArc, ATTESTATION]);
  });

  it("refuses a message for another chain than the one it is told, before anything is read or sent", async () => {
    const { args, publicClient, walletClient } = base();

    await expect(receiveMessageOnEvm({ ...args, chain: "arc" })).rejects.toThrow(/CCTP domain 6, not for Arc Testnet \(26\)/);
    expect(publicClient.readContract).not.toHaveBeenCalled();
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it("names the chain a mint reverted on", async () => {
    const toArc = `0x${"00000001"}${"0000001b"}${"0000001a"}${NONCE.slice(2)}${"11".repeat(104)}${"22".repeat(228)}` as Hex;
    const reverted = base({ status: "reverted" });
    const failure = await receiveMessageOnEvm({ ...reverted.args, message: toArc, chain: "arc" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransactionRevertedError);
    expect((failure as Error).message).toBe(`The mint reverted on Arc: ${MINT_HASH}`);
  });

  it("reads whether a message was received on the chain it is told", async () => {
    const { args, publicClient } = base({ used: [1n] });
    expect(await isReceivedOnEvm(args.publicClient, MESSAGE, testNetwork, "ethereum")).toBe(true);
    expect(publicClient.readContract.mock.calls[0]![0].address).toBe(evmChain(testNetwork, "ethereum").messageTransmitter);
    await expect(isReceivedOnEvm(args.publicClient, MESSAGE, testNetwork, "polygon" as never)).rejects.toThrow(/Unknown EVM chain/);
  });

  it("needs a wallet with an account", async () => {
    const { args } = base();
    const walletClient = { writeContract: vi.fn() } as unknown as WalletClient;

    await expect(receiveMessageOnEvm({ ...args, walletClient })).rejects.toThrow(/no account/);
  });
});
