import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ownerOf, readContract, usdcBalance } from "../src/read";
import { twinAddress } from "../src/twin";
import { OWNER, testNetwork, USDC } from "./helpers";

const TWIN = twinAddress(OWNER, testNetwork);

/** A server that answers every simulation with `retval`, and finds `instances` contract instances. */
function serverReturning(retval: xdr.ScVal, instances = 1) {
  const simulateTransaction = vi.fn(async (_tx: unknown) => ({
    id: "1",
    latestLedger: 5_000_000,
    events: [],
    _parsed: true,
    minResourceFee: "100",
    result: { auth: [], retval },
  }));
  const getLedgerEntries = vi.fn(async () => ({ entries: new Array(instances).fill({}), latestLedger: 5_000_000 }));
  return { simulateTransaction, getLedgerEntries } as unknown as rpc.Server & {
    simulateTransaction: typeof simulateTransaction;
  };
}

function simulatedCall(server: ReturnType<typeof serverReturning>): xdr.InvokeContractArgs {
  const tx = server.simulateTransaction.mock.calls[0]![0] as { toEnvelope(): xdr.TransactionEnvelope };
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("unexpected envelope");
  const body = envelope.v1.tx.operations[0]!.body;
  if (body.type !== "invokeHostFunction") throw new Error("unexpected operation");
  const func = body.invokeHostFunctionOp.hostFunction;
  if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return func.invokeContract;
}

describe("readContract", () => {
  it("simulates the call and returns its result", async () => {
    const server = serverReturning(xdr.ScVal.scvU32(7));
    const value = await readContract(USDC, "decimals", [], testNetwork, server);

    expect(value.toXdr("base64")).toBe(xdr.ScVal.scvU32(7).toXdr("base64"));
    const call = simulatedCall(server);
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(USDC);
    expect(call.functionName.toString()).toBe("decimals");
  });

  it("explains a call that cannot be read", async () => {
    const server = {
      simulateTransaction: async () => ({ id: "1", latestLedger: 1, events: [], _parsed: true, error: "HostError: missing" }),
    } as unknown as rpc.Server;

    await expect(readContract(USDC, "nothing", [], testNetwork, server)).rejects.toThrow(/nothing on .* could not be read/);
  });
});

describe("usdcBalance", () => {
  it("asks the USDC contract for the balance of the address, in 7-decimal units", async () => {
    const server = serverReturning(xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 9_998_700n })));

    expect(await usdcBalance(TWIN, testNetwork, server)).toBe(9_998_700n);
    const call = simulatedCall(server);
    expect(Address.fromScAddress(call.contractAddress).toString()).toBe(USDC);
    expect(call.functionName.toString()).toBe("balance");
    expect(call.args.map((arg) => Address.fromScVal(arg).toString())).toEqual([TWIN]);
  });
});

describe("ownerOf", () => {
  it("returns the checksummed Ethereum address the account stores", async () => {
    const server = serverReturning(xdr.ScVal.scvBytes(hexToBytes(OWNER)));
    expect(await ownerOf(TWIN, testNetwork, server)).toBe(OWNER);
  });

  it("returns null where nothing is deployed, without calling the contract", async () => {
    const server = serverReturning(xdr.ScVal.scvVoid(), 0);
    expect(await ownerOf(TWIN, testNetwork, server)).toBeNull();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects a contract that does not answer with 20 bytes", async () => {
    const server = serverReturning(xdr.ScVal.scvBytes(new Uint8Array(32)));
    await expect(ownerOf(TWIN, testNetwork, server)).rejects.toThrow(/not a Paso account/);
  });
});
