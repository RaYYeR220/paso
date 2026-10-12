import { StrKey } from "@stellar/stellar-sdk";
import type { Hex, PublicClient, WalletClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardRecipientHookData, fundFromEvm } from "../src/evm";
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

function clients({ allowance = 0n, burnStatus = "success" }: { allowance?: bigint; burnStatus?: string } = {}) {
  const writes: Write[] = [];
  const walletClient = {
    account: { address: PAYER, type: "json-rpc" },
    writeContract: vi.fn(async (request: Write) => {
      writes.push(request);
      return request.functionName === "approve" ? APPROVE_HASH : BURN_HASH;
    }),
  };
  const publicClient = {
    readContract: vi.fn(async () => allowance),
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
