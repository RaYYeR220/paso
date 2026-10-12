import { Address, Keypair, rpc, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOperation,
  isExpired,
  prepare,
  relay,
  RelayError,
  relayRequest,
  sign,
  SimulationError,
  type Action,
} from "../src/actions";
import { authPayload } from "../src/auth";
import { renderArg } from "../src/render";
import { twinAddress } from "../src/twin";
import { hex, HUB, ISSUER, OTHER_KEY, OWNER, OWNER_KEY, testNetwork, USDC } from "./helpers";

const TWIN = twinAddress(OWNER, testNetwork);
const LATEST_LEDGER = 5_000_000;
const NONCE = 77n;
const EVM_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function invokeArgs(operation: xdr.Operation): xdr.InvokeContractArgs {
  const { body } = operation;
  if (body.type !== "invokeHostFunction") throw new Error(`unexpected operation ${body.type}`);
  const { hostFunction } = body.invokeHostFunctionOp;
  if (hostFunction.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return hostFunction.invokeContract;
}

function sourceOf(txXdr: string): string {
  const tx = TransactionBuilder.fromXdr(txXdr, testNetwork.stellar.networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("unexpected fee bump");
  return tx.source;
}

function describeCall(operation: xdr.Operation) {
  const call = invokeArgs(operation);
  return {
    contract: Address.fromScAddress(call.contractAddress).toString(),
    fn: call.functionName.toString(),
    args: call.args.map(renderArg),
  };
}

/** Answers a simulation the way the network does in recording mode: one unsigned entry for the twin. */
function recordingServer(extraEntries: xdr.SorobanAuthorizationEntry[] = []) {
  const simulateTransaction = vi.fn(async (tx: ReturnType<TransactionBuilder["build"]>) => {
    const envelope = tx.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") throw new Error(`unexpected envelope ${envelope.type}`);
    const operation = envelope.v1.tx.operations[0];
    if (!operation) throw new Error("no operation");
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: new Address(TWIN).toScAddress(),
          nonce: NONCE,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs(operation)),
        subInvocations: [],
      }),
    });
    return {
      id: "1",
      latestLedger: LATEST_LEDGER,
      events: [],
      _parsed: true,
      minResourceFee: "1000",
      result: { auth: [...extraEntries, entry], retval: xdr.ScVal.scvVoid() },
    };
  });
  return { simulateTransaction } as unknown as rpc.Server & { simulateTransaction: typeof simulateTransaction };
}

const unreachableServer = {
  simulateTransaction: () => {
    throw new Error("the network must not be reached");
  },
} as unknown as rpc.Server;

const transfer: Action = { kind: "transfer", to: ISSUER, amount: 2_500_000n };
const options = { owner: OWNER, network: testNetwork } as const;

describe("buildOperation", () => {
  it("builds a USDC transfer out of the twin", async () => {
    expect(describeCall(await buildOperation(transfer, options))).toEqual({
      contract: USDC,
      fn: "transfer",
      args: [TWIN, ISSUER, "2500000"],
    });
  });

  it("pays the twin of an Ethereum address when the recipient is 0x…", async () => {
    const operation = await buildOperation({ kind: "transfer", to: EVM_RECIPIENT, amount: 1n }, options);
    expect(describeCall(operation).args).toEqual([TWIN, twinAddress(EVM_RECIPIENT, testNetwork), "1"]);
  });

  it("builds an exit through the hub with the recipient padded to 32 bytes", async () => {
    const exit: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 0n };
    expect(describeCall(await buildOperation(exit, options))).toEqual({
      contract: HUB,
      fn: "exit",
      args: [TWIN, "5000000", "6", `0x${"00".repeat(12)}70997970c51812dc3a010c7d01b50e0d17dc79c8`, "0", "1000"],
    });
  });

  it("types the exit arguments the way the hub declares them", async () => {
    const exit: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 10n };
    const types = invokeArgs(await buildOperation(exit, options)).args.map((arg) => arg.type);
    expect(types).toEqual(["scvAddress", "scvI128", "scvU32", "scvBytes", "scvI128", "scvU32"]);
  });

  it("rejects an exit with a non-zero seventh decimal before anything is signed", async () => {
    const exit: Action = { kind: "exit", amount: 5_000_001n, recipient: EVM_RECIPIENT, maxFee: 0n };
    await expect(prepare(exit, { ...options, server: unreachableServer })).rejects.toThrow(/seventh decimal/);
  });

  it("rejects a fee cap with a non-zero seventh decimal", async () => {
    const exit: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 5n };
    await expect(buildOperation(exit, options)).rejects.toThrow(/seventh decimal/);
  });

  it("asks Iris for the exit fee, in Stellar units, when no cap is given", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 1.3 }])),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const exit: Action = { kind: "exit", amount: 10_000_000n, recipient: EVM_RECIPIENT };
      expect(describeCall(await buildOperation(exit, options)).args[4]).toBe("1560");
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/6");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects amounts that are not positive", async () => {
    await expect(buildOperation({ kind: "transfer", to: ISSUER, amount: 0n }, options)).rejects.toThrow(/positive/);
    const exit: Action = { kind: "exit", amount: -10n, recipient: EVM_RECIPIENT, maxFee: 0n };
    await expect(buildOperation(exit, options)).rejects.toThrow(/positive/);
  });

  it("rejects a recipient that is neither a Stellar nor an Ethereum address", async () => {
    await expect(buildOperation({ kind: "transfer", to: "nobody", amount: 1n }, options)).rejects.toThrow(
      /not a Stellar address/,
    );
  });

  it("passes a generic invocation through untouched", async () => {
    const invoke: Action = {
      kind: "invoke",
      contract: USDC,
      fn: "approve",
      args: [new Address(TWIN).toScVal(), xdr.ScVal.scvU32(9)],
    };
    expect(describeCall(await buildOperation(invoke, options))).toEqual({
      contract: USDC,
      fn: "approve",
      args: [TWIN, "9"],
    });
  });
});

describe("prepare", () => {
  it("simulates with a placeholder source and returns what the wallet must sign", async () => {
    const server = recordingServer();
    const prepared = await prepare(transfer, { ...options, server });

    expect(prepared.network).toBe("testnet");
    expect(prepared.owner).toBe(OWNER);
    expect(prepared.account).toBe(TWIN);
    expect(prepared.validUntilLedger).toBe(LATEST_LEDGER + 120);
    expect(prepared.calls).toEqual([{ contract: USDC, fn: "transfer", args: [TWIN, ISSUER, "2500000"] }]);
    expect(prepared.typedData.message.account).toBe(TWIN);
    expect(prepared.typedData.message.calls).toEqual(prepared.calls);

    const entry = xdr.SorobanAuthorizationEntry.fromXdr(prepared.entries[0]!, "base64");
    expect(prepared.typedData.message.payload).toBe(authPayload(entry, prepared.validUntilLedger, testNetwork));

    expect(sourceOf(prepared.txXdr)).toBe(StrKey.encodeEd25519PublicKey(new Uint8Array(32)));
    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("honours the source account and validity window it is given", async () => {
    const source = Keypair.random().publicKey();
    const prepared = await prepare(transfer, { ...options, server: recordingServer(), source, validForLedgers: 30 });

    expect(sourceOf(prepared.txXdr)).toBe(source);
    expect(prepared.validUntilLedger).toBe(LATEST_LEDGER + 30);
  });

  it("keeps entries that belong to someone else untouched", async () => {
    const foreign = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(USDC).toScAddress(),
            functionName: "noop",
            args: [],
          }),
        ),
        subInvocations: [],
      }),
    });
    const prepared = await prepare(transfer, { ...options, server: recordingServer([foreign]) });

    expect(prepared.entries).toHaveLength(2);
    expect(prepared.entries[0]).toBe(foreign.toXdr("base64"));
  });

  it("surfaces a failed simulation with the network's explanation", async () => {
    const server = {
      simulateTransaction: async () => ({ id: "1", latestLedger: LATEST_LEDGER, events: [], _parsed: true, error: "HostError: balance is not sufficient" }),
    } as unknown as rpc.Server;

    const failure = await prepare(transfer, { ...options, server }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SimulationError);
    expect((failure as SimulationError).detail).toContain("balance is not sufficient");
  });
});

describe("sign", () => {
  it("attaches the wallet's signature to the twin's entry", async () => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    const signed = await sign(prepared, privateKeyToAccount(OWNER_KEY));

    expect(await recoverTypedDataAddress({ ...prepared.typedData, signature: signed.signature })).toBe(OWNER);

    const entry = xdr.SorobanAuthorizationEntry.fromXdr(signed.entries[0]!, "base64");
    if (entry.credentials.type !== "sorobanCredentialsAddressV2") throw new Error("unexpected credentials");
    const credentials = entry.credentials.addressV2;
    expect(credentials.signatureExpirationLedger).toBe(prepared.validUntilLedger);
    if (credentials.signature.type !== "scvBytes") throw new Error("signature is not bytes");
    expect(`0x${hex(credentials.signature.bytes.toBytes())}`).toBe(signed.signature);
    expect(signed.txXdr).toBe(prepared.txXdr);
  });

  it("refuses a signature from a wallet that does not own the account", async () => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    await expect(sign(prepared, privateKeyToAccount(OTHER_KEY))).rejects.toThrow(
      /signed by 0x70997970C51812dc3A010C7d01b50e0d17dc79C8.*belongs to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/,
    );
  });

  it("accepts a wallet client style signer that receives the typed data", async () => {
    const account = privateKeyToAccount(OWNER_KEY);
    const signer = { signTypedData: vi.fn((data: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(data)) };
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    await sign(prepared, signer);

    expect(signer.signTypedData).toHaveBeenCalledWith(prepared.typedData);
  });
});

describe("relay", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function signedTransfer() {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    return sign(prepared, privateKeyToAccount(OWNER_KEY));
  }

  it("describes the signed call as the function plus its entries", async () => {
    const signed = await signedTransfer();
    const request = relayRequest(signed);

    expect(request).toEqual({ network: "testnet", owner: OWNER, func: expect.any(String), auth: signed.entries });
    const func = xdr.HostFunction.fromXdr(request.func, "base64");
    if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
    expect(func.invokeContract.functionName.toString()).toBe("transfer");
  });

  it("posts that request and returns the transaction hash", async () => {
    const signed = await signedTransfer();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hash: "abc123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await relay(signed, "https://paso.example/api/relay")).toEqual({ hash: "abc123" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://paso.example/api/relay");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(relayRequest(signed));
  });

  it("raises the relayer's error code so the caller can ask for a new signature", async () => {
    const signed = await signedTransfer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "expired", detail: "ledger 5000200" }), { status: 400 })),
    );

    const failure = await relay(signed, "https://paso.example/api/relay").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).code).toBe("expired");
    expect((failure as RelayError).detail).toBe("ledger 5000200");
  });

  it("reports a relayer that answers with something else", async () => {
    const signed = await signedTransfer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })));

    const failure = await relay(signed, "https://paso.example/api/relay").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).code).toBe("relay_failed");
    expect((failure as RelayError).status).toBe(502);
  });
});

describe("isExpired", () => {
  it("is expired once the latest ledger reaches the expiration ledger", async () => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    const signature = `0x${"00".repeat(65)}` as Hex;
    const signed = { ...prepared, signature };

    expect(isExpired(signed, prepared.validUntilLedger - 1)).toBe(false);
    expect(isExpired(signed, prepared.validUntilLedger)).toBe(true);
    expect(isExpired(signed, prepared.validUntilLedger + 1)).toBe(true);
  });
});
