import {
  Account,
  Address,
  Keypair,
  MuxedAccount,
  Operation,
  rpc,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOperation,
  DEFAULT_VALIDITY_LEDGERS,
  isExpired,
  LEDGER_SECONDS,
  MAX_VALIDITY_LEDGERS,
  prepare,
  relay,
  RelayError,
  relayRequest,
  sign,
  signedFromRelayRequest,
  simulateSigned,
  SimulationError,
  submitWith,
  validForSeconds,
  withArgument,
  type Action,
  type Signed,
} from "../src/actions";
import { AuthorizationEntriesError, authPayload, entryTypedData } from "../src/auth";
import { renderArg } from "../src/render";
import { twinAddress } from "../src/twin";
import { fromHex, hex, HUB, ISSUER, OTHER_KEY, OWNER, OWNER_KEY, testNetwork, USDC } from "./helpers";

const TWIN = twinAddress(OWNER, testNetwork);
const LATEST_LEDGER = 5_000_000;
const NONCE = 77n;
const EVM_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** `ISSUER` with the id 5 folded in: the `M…` form an exchange hands out as a deposit address. */
const MUXED_RECIPIENT = new MuxedAccount(new Account(ISSUER, "0"), "5").accountId();

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

const noop = new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    new xdr.InvokeContractArgs({ contractAddress: new Address(USDC).toScAddress(), functionName: "noop", args: [] }),
  ),
  subInvocations: [],
});

/** An entry the transaction's source account would satisfy just by signing the envelope. */
function sourceAccountEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: noop,
  });
}

function addressEntry(address: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: NONCE,
        signatureExpirationLedger: LATEST_LEDGER + 10,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: noop,
  });
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

  it.each([
    ["ethereum", "0"],
    ["optimism", "2"],
    ["arbitrum", "3"],
    ["base", "6"],
    ["arc", "26"],
  ] as const)("sends an exit to %s through its CCTP domain %s", async (destinationChain, domain) => {
    const exit: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 0n, destinationChain };
    expect(describeCall(await buildOperation(exit, options)).args[2]).toBe(domain);
  });

  it("asks Iris for the fee of the route to the chain the exit names", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 0 }])),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const exit: Action = { kind: "exit", amount: 10_000_000n, recipient: EVM_RECIPIENT, destinationChain: "arc" };
      const { args } = describeCall(await buildOperation(exit, options));
      expect(args[2]).toBe("26");
      expect(args[4]).toBe("0");
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/26");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes a chain and its own domain together, and refuses a chain with another domain", async () => {
    const same: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 0n, destinationChain: "arc", destinationDomain: 26 };
    expect(describeCall(await buildOperation(same, options)).args[2]).toBe("26");

    const clash: Action = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, maxFee: 0n, destinationChain: "arc", destinationDomain: 6 };
    await expect(buildOperation(clash, options)).rejects.toThrow(/Arc Testnet, whose CCTP domain is 26, and domain 6/);
  });

  it("refuses an exit to a chain Paso does not list before anything is signed", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const exit = { kind: "exit", amount: 5_000_000n, recipient: EVM_RECIPIENT, destinationChain: "polygon" } as unknown as Action;
      await expect(prepare(exit, { ...options, server: unreachableServer })).rejects.toThrow(/Unknown EVM chain "polygon"/);
      expect(fetchMock).not.toHaveBeenCalled();
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

  it("refuses a muxed recipient, which a wallet could only show as a hash", async () => {
    expect(MUXED_RECIPIENT).toMatch(/^M[A-Z2-7]{68}$/);
    expect(StrKey.isValidMed25519PublicKey(MUXED_RECIPIENT)).toBe(true);

    const failure = await buildOperation({ kind: "transfer", to: MUXED_RECIPIENT, amount: 1n }, options).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain(MUXED_RECIPIENT);
    expect(message).toMatch(/muxed address/);
    expect(message).toMatch(/wallet can only show .* as a hash/);
    expect(message).toMatch(/not accepted/);
    expect(message).toMatch(/G… address it stands for/);
  });

  it("does not replace a muxed recipient with the address it stands for", async () => {
    const failure = await buildOperation({ kind: "transfer", to: MUXED_RECIPIENT, amount: 1n }, options).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(ISSUER);
  });

  it("treats an M… address with a wrong checksum as no address at all", async () => {
    const last = MUXED_RECIPIENT.at(-1) === "A" ? "B" : "A";
    const damaged = `${MUXED_RECIPIENT.slice(0, -1)}${last}`;
    expect(StrKey.isValidMed25519PublicKey(damaged)).toBe(false);

    await expect(buildOperation({ kind: "transfer", to: damaged, amount: 1n }, options)).rejects.toThrow(
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
    expect(prepared.preparedAtLedger).toBe(LATEST_LEDGER);
    expect(prepared.validUntilLedger).toBe(LATEST_LEDGER + DEFAULT_VALIDITY_LEDGERS);
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

  it("keeps a signature valid for about two minutes by default and for ten at most", () => {
    expect(DEFAULT_VALIDITY_LEDGERS).toBe(24);
    expect(MAX_VALIDITY_LEDGERS).toBe(120);
    expect(LEDGER_SECONDS).toBe(5);
    expect(DEFAULT_VALIDITY_LEDGERS * LEDGER_SECONDS).toBe(120);
    expect(MAX_VALIDITY_LEDGERS * LEDGER_SECONDS).toBe(600);
  });

  it.each([1, DEFAULT_VALIDITY_LEDGERS, MAX_VALIDITY_LEDGERS])("accepts a validity of %d ledgers", async (ledgers) => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer(), validForLedgers: ledgers });
    expect(prepared.validUntilLedger).toBe(LATEST_LEDGER + ledgers);
    expect(prepared.preparedAtLedger).toBe(LATEST_LEDGER);
  });

  it.each([MAX_VALIDITY_LEDGERS + 1, 720, 17_280, 3_110_400, Number.MAX_SAFE_INTEGER])(
    "refuses a validity of %d ledgers, naming the maximum, before the network is contacted",
    async (ledgers) => {
      const attempt = prepare(transfer, { ...options, server: unreachableServer, validForLedgers: ledgers });
      await expect(attempt).rejects.toThrow(/validForLedgers/);
      await expect(attempt).rejects.toThrow(/at most 120 ledgers/);
      await expect(attempt).rejects.toThrow(/about 10 minutes/);
    },
  );

  it.each([0, -1, -120, 1.5, 23.999, Number.NaN, Number.POSITIVE_INFINITY, "30", 24n, [24]])(
    "refuses a validity of %s ledgers, which is not a positive whole number",
    async (ledgers) => {
      const validForLedgers = ledgers as unknown as number;
      await expect(prepare(transfer, { ...options, server: unreachableServer, validForLedgers })).rejects.toThrow(
        /validForLedgers must be a whole number, at least 1 and at most 120 ledgers/,
      );
    },
  );

  it("refuses a validity that is too long before it asks Circle for an exit fee", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("the network must not be reached");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const exit: Action = { kind: "exit", amount: 10_000_000n, recipient: EVM_RECIPIENT };
      await expect(
        prepare(exit, { ...options, server: unreachableServer, validForLedgers: MAX_VALIDITY_LEDGERS + 1 }),
      ).rejects.toThrow(/at most 120 ledgers/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses a muxed recipient before the network is contacted", async () => {
    await expect(
      prepare({ kind: "transfer", to: MUXED_RECIPIENT, amount: 1n }, { ...options, server: unreachableServer }),
    ).rejects.toThrow(/muxed address.*not accepted.*G… address it stands for/s);
  });

  it("never asks the network to simulate a transfer to a muxed address", async () => {
    const server = recordingServer();
    const muxed: Action = { kind: "transfer", to: MUXED_RECIPIENT, amount: 1n };
    await expect(prepare(muxed, { ...options, server })).rejects.toThrow(/muxed address/);
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("hands the wallet a String that starts with a byte-order mark byte for byte", async () => {
    const bytes = fromHex("ef bb bf 68 69");
    const memo: Action = { kind: "invoke", contract: USDC, fn: "note", args: [xdr.ScVal.scvString(bytes)] };
    const prepared = await prepare(memo, { ...options, server: recordingServer() });

    const [shown] = prepared.typedData.message.calls[0]!.args;
    expect(hex(new TextEncoder().encode(shown))).toBe(hex(bytes));
    expect(prepared.calls[0]!.args).toEqual([shown]);
  });

  it("refuses a String that is not UTF-8, which no wallet could be shown", async () => {
    const broken: Action = {
      kind: "invoke",
      contract: USDC,
      fn: "note",
      args: [xdr.ScVal.scvString(fromHex("68 69 ff"))],
    };
    await expect(prepare(broken, { ...options, server: recordingServer() })).rejects.toThrow(
      "String is not valid UTF-8 and cannot be shown in a wallet",
    );
  });

  it("refuses a call that needs the source account's authorisation as well", async () => {
    const failure = await prepare(transfer, { ...options, server: recordingServer([sourceAccountEntry()]) }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthorizationEntriesError);
    expect((failure as Error).message).toMatch(/source account/);
  });

  it("refuses a call that needs the authorisation of another address", async () => {
    await expect(prepare(transfer, { ...options, server: recordingServer([addressEntry(ISSUER)]) })).rejects.toThrow(
      new RegExp(`authorisation from ${ISSUER}`),
    );
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
    expect(signed.preparedAtLedger).toBe(LATEST_LEDGER);
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

  it("returns the deployment hash when the relayer had to deploy the account first", async () => {
    const signed = await signedTransfer();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hash: "abc123", deployHash: "def456" }))));

    expect(await relay(signed, "https://paso.example/api/relay")).toEqual({ hash: "abc123", deployHash: "def456" });
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

describe("a signed call that carries more than the account's entry", () => {
  const fetchMock = vi.fn(async () => {
    throw new Error("the network must not be reached");
  });
  const source = Keypair.random();
  const submitOptions = { network: testNetwork, server: unreachableServer };

  afterEach(() => vi.unstubAllGlobals());

  async function signedWith(extra: xdr.SorobanAuthorizationEntry[]): Promise<Signed> {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    const signed = await sign(prepared, privateKeyToAccount(OWNER_KEY));
    return { ...signed, entries: [...extra.map((entry) => entry.toXdr("base64")), ...signed.entries] };
  }

  it("is not submitted when an entry would spend the fee payer's own authority", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const signed = await signedWith([sourceAccountEntry()]);

    await expect(submitWith(signed, source, submitOptions)).rejects.toThrow(AuthorizationEntriesError);
    await expect(submitWith(signed, source, submitOptions)).rejects.toThrow(/source account/);
    await expect(simulateSigned(signed, submitOptions)).rejects.toThrow(AuthorizationEntriesError);
    expect(() => relayRequest(signed)).toThrow(AuthorizationEntriesError);
    await expect(relay(signed, "https://paso.example/api/relay")).rejects.toThrow(AuthorizationEntriesError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not submitted when the source-account entry is the only one", async () => {
    const signed = await signedWith([]);
    const only: Signed = { ...signed, entries: [sourceAccountEntry().toXdr("base64")] };

    await expect(submitWith(only, source, submitOptions)).rejects.toThrow(/source account/);
    expect(() => relayRequest(only)).toThrow(/source account/);
  });

  it("is not submitted when an entry belongs to another address", async () => {
    const signed = await signedWith([addressEntry(ISSUER)]);

    await expect(submitWith(signed, source, submitOptions)).rejects.toThrow(new RegExp(`authorisation from ${ISSUER}`));
    expect(() => relayRequest(signed)).toThrow(AuthorizationEntriesError);
  });

  it("is not submitted when the account's entry appears twice", async () => {
    const signed = await signedWith([]);
    const twice: Signed = { ...signed, entries: [...signed.entries, ...signed.entries] };

    await expect(submitWith(twice, source, submitOptions)).rejects.toThrow(/2 separate authorisations/);
    expect(() => relayRequest(twice)).toThrow(/2 separate authorisations/);
  });

  it("is checked against the account derived from the owner, not the one the call names", async () => {
    const signed = await signedWith([]);
    const stranger = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const renamed: Signed = { ...signed, owner: stranger };

    await expect(submitWith(renamed, source, submitOptions)).rejects.toThrow(
      new RegExp(`not the owner's account ${twinAddress(stranger, testNetwork)}`),
    );
  });

  it("is not submitted when it uploads code instead of calling a contract", async () => {
    const signed = await signedWith([]);
    const tx = TransactionBuilder.fromXdr(signed.txXdr, testNetwork.stellar.networkPassphrase) as Transaction;
    const upload = new TransactionBuilder(new Account(tx.source, "0"), {
      fee: "100",
      networkPassphrase: testNetwork.stellar.networkPassphrase,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: Buffer.from("00", "hex") }))
      .setTimeout(60)
      .build();
    const uploading: Signed = { ...signed, txXdr: upload.toEnvelope().toXdr("base64") };

    await expect(submitWith(uploading, source, submitOptions)).rejects.toThrow(/Only contract calls/);
    expect(() => relayRequest(uploading)).toThrow(/Only contract calls/);
  });
});

describe("signedFromRelayRequest", () => {
  async function signedTransfer() {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    return sign(prepared, privateKeyToAccount(OWNER_KEY));
  }

  it("reads a request back into the signed call it was built from", async () => {
    const signed = await signedTransfer();
    const read = signedFromRelayRequest(relayRequest(signed), testNetwork);

    // The carrier transaction is rebuilt, with time bounds of its own, and a request does not say when it
    // was prepared; everything else is the same.
    const { preparedAtLedger, ...carried } = signed;
    expect(preparedAtLedger).toBe(LATEST_LEDGER);
    expect(read).not.toHaveProperty("preparedAtLedger");
    expect({ ...read, txXdr: "" }).toEqual({ ...carried, txXdr: "" });
    expect(relayRequest(read)).toEqual(relayRequest(signed));
    expect(sourceOf(read.txXdr)).toBe(sourceOf(signed.txXdr));
  });

  it("derives the account from the owner and refuses an entry for any other", async () => {
    const request = relayRequest(await signedTransfer());
    const stranger = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    expect(() => signedFromRelayRequest({ ...request, owner: stranger }, testNetwork)).toThrow(
      new RegExp(`not the owner's account ${twinAddress(stranger, testNetwork)}`),
    );
  });

  it("refuses a request that would spend the fee payer's authority", async () => {
    const request = relayRequest(await signedTransfer());
    const borrowed = { ...request, auth: [sourceAccountEntry().toXdr("base64")] };
    const both = { ...request, auth: [...request.auth, sourceAccountEntry().toXdr("base64")] };

    expect(() => signedFromRelayRequest(borrowed, testNetwork)).toThrow(AuthorizationEntriesError);
    expect(() => signedFromRelayRequest(both, testNetwork)).toThrow(/source account/);
  });

  it("refuses a second entry, even for the same account", async () => {
    const request = relayRequest(await signedTransfer());

    expect(() => signedFromRelayRequest({ ...request, auth: [...request.auth, ...request.auth] }, testNetwork)).toThrow(
      /2 separate authorisations/,
    );
    expect(() =>
      signedFromRelayRequest({ ...request, auth: [...request.auth, addressEntry(ISSUER).toXdr("base64")] }, testNetwork),
    ).toThrow(new RegExp(`authorisation from ${ISSUER}`));
  });

  it("refuses a host function that uploads code or creates a contract", async () => {
    const request = relayRequest(await signedTransfer());
    const upload = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from("0061736d", "hex"));

    expect(() => signedFromRelayRequest({ ...request, func: upload.toXdr("base64") }, testNetwork)).toThrow(
      /Only contract calls can be relayed/,
    );
  });

  it("refuses an entry that was never signed", async () => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    const request = { ...relayRequest(await signedTransfer()), auth: prepared.entries };

    expect(() => signedFromRelayRequest(request, testNetwork)).toThrow(/not signed/);
  });

  it("refuses anything that is not a well-formed request", async () => {
    const request = relayRequest(await signedTransfer());

    expect(() => signedFromRelayRequest({ ...request, func: "not xdr" }, testNetwork)).toThrow(/not valid XDR/);
    expect(() => signedFromRelayRequest({ ...request, owner: "nobody" as `0x${string}` }, testNetwork)).toThrow(
      /Ethereum address/,
    );
    expect(() => signedFromRelayRequest({ ...request, network: "mainnet" }, testNetwork)).toThrow(/not for testnet/);
    expect(() => signedFromRelayRequest({ ...request, auth: "x" as unknown as string[] }, testNetwork)).toThrow(
      /list of authorisation entries/,
    );
  });
});

describe("withArgument", () => {
  async function signedTransfer() {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    return sign(prepared, privateKeyToAccount(OWNER_KEY));
  }
  const larger = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 9_000_000_000n }));

  it("changes the argument in the call and in the entry, and keeps the signature", async () => {
    const signed = await signedTransfer();
    const changed = withArgument(signed, 2, larger);

    const func = xdr.HostFunction.fromXdr(relayRequest(changed).func, "base64");
    if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
    expect(func.invokeContract.args.map(renderArg)).toEqual([TWIN, ISSUER, "9000000000"]);

    const entry = xdr.SorobanAuthorizationEntry.fromXdr(changed.entries[0]!, "base64");
    const original = xdr.SorobanAuthorizationEntry.fromXdr(signed.entries[0]!, "base64");
    expect(entry.credentials.toXdr("base64")).toBe(original.credentials.toXdr("base64"));
    const authorised = entry.rootInvocation.function;
    if (authorised.type !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("not a contract call");
    expect(authorised.contractFn.args.map(renderArg)).toEqual([TWIN, ISSUER, "9000000000"]);

    expect(changed.signature).toBe(signed.signature);
    expect(changed.calls).toEqual(signed.calls);
    expect(sourceOf(changed.txXdr)).toBe(sourceOf(signed.txXdr));
  });

  it("produces a call the signature no longer matches", async () => {
    const signed = await signedTransfer();
    const changed = withArgument(signed, 2, larger);
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(changed.entries[0]!, "base64");

    const signedBy = await recoverTypedDataAddress({ ...entryTypedData(entry, testNetwork), signature: signed.signature });
    expect(signedBy).not.toBe(OWNER);
  });

  it("refuses an argument the call does not have", async () => {
    const signed = await signedTransfer();
    expect(() => withArgument(signed, 3, larger)).toThrow(/no argument 3/);
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

describe("validForSeconds", () => {
  const signature = { validUntilLedger: LATEST_LEDGER + DEFAULT_VALIDITY_LEDGERS };

  it.each([
    [LATEST_LEDGER, 120],
    [LATEST_LEDGER + 1, 115],
    [LATEST_LEDGER + 12, 60],
    [LATEST_LEDGER + 23, 5],
    [LATEST_LEDGER + 24, 0],
    [LATEST_LEDGER + 25, 0],
    [LATEST_LEDGER + 10_000, 0],
  ])("at ledger %d there are about %d seconds left", (latestLedger, seconds) => {
    expect(validForSeconds(signature, latestLedger)).toBe(seconds);
  });

  it("gives a freshly prepared call the whole window", async () => {
    const prepared = await prepare(transfer, { ...options, server: recordingServer() });
    expect(validForSeconds(prepared, prepared.preparedAtLedger!)).toBe(DEFAULT_VALIDITY_LEDGERS * LEDGER_SECONDS);

    const longest = await prepare(transfer, {
      ...options,
      server: recordingServer(),
      validForLedgers: MAX_VALIDITY_LEDGERS,
    });
    expect(validForSeconds(longest, longest.preparedAtLedger!)).toBe(600);
  });

  it("is zero exactly when the signature is expired", () => {
    for (let latestLedger = LATEST_LEDGER - 5; latestLedger <= signature.validUntilLedger + 5; latestLedger++) {
      expect(validForSeconds(signature, latestLedger) === 0, `ledger ${latestLedger}`).toBe(
        isExpired(signature, latestLedger),
      );
    }
  });
});
