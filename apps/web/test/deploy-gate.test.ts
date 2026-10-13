import { attachSignature, prepare, relayRequest, sign, twinAddress, withArgument, type RelayRequest, type Signed } from "@paso/sdk";
import { Account, Address, Keypair, nativeToScVal, SorobanDataBuilder, xdr, type rpc } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as deployRoute } from "@/app/api/deploy/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { getRelayer, Relayer } from "@/lib/server/relayer";
import { hub, post, usdc } from "./helpers";

const LATEST = 5_000_000;
const freshOwner = () => privateKeyToAccount(generatePrivateKey());

function invocation(tx: { toEnvelope(): xdr.TransactionEnvelope }) {
  const envelope = tx.toEnvelope();
  const body = envelope.type === "envelopeTypeTx" ? envelope.v1.tx.operations[0]?.body : undefined;
  if (body?.type !== "invokeHostFunction") throw new Error("not a contract call");
  const func = body.invokeHostFunctionOp.hostFunction;
  if (func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return { call: func.invokeContract, auth: body.invokeHostFunctionOp.auth };
}

function recorded(account: string, call: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(account).toScAddress(),
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

/** A USDC approval from the account of `owner`, prepared without the network and signed by `signer`. */
/** With `preparedAgo`, a call prepared that many ledgers back: one whose single ledger of validity has passed. */
async function approval(owner: PrivateKeyAccount, signer: PrivateKeyAccount = owner, validForLedgers = 120, preparedAgo = 0): Promise<Signed> {
  const account = twinAddress(owner.address, "testnet");
  const server = {
    simulateTransaction: async (tx: never) => ({ ...simulated([recorded(account, invocation(tx).call)]), latestLedger: LATEST - preparedAgo }),
  } as unknown as rpc.Server;
  const prepared = await prepare(
    {
      kind: "invoke",
      contract: usdc,
      fn: "approve",
      args: [
        new Address(account).toScVal(),
        new Address(hub).toScVal(),
        nativeToScVal(BigInt(1), { type: "i128" }),
        nativeToScVal(LATEST + 1_000, { type: "u32" }),
      ],
    },
    { owner: owner.address, network: "testnet", server, validForLedgers },
  );
  // `sign` refuses a signature that is not the owner's, which is the point of asking the wallet directly here.
  const signature = await signer.signTypedData(prepared.typedData);
  const entry = attachSignature(xdr.SorobanAuthorizationEntry.fromXdr(prepared.entries[0]!, "base64"), signature);
  return signer === owner ? sign(prepared, owner) : { ...prepared, entries: [entry.toXdr("base64")], signature };
}

/** The same request under 65 bytes that are a signature in form only. */
function withGarbage(signed: Signed): RelayRequest {
  const bytes = new Uint8Array(65).fill(0x11);
  bytes[32] = 0x01;
  bytes[64] = 27;
  const entry = xdr.SorobanAuthorizationEntry.fromXdr(signed.entries[0]!, "base64");
  const garbage = attachSignature(entry, `0x${Buffer.from(bytes).toString("hex")}`);
  return { ...relayRequest(signed), auth: [garbage.toXdr("base64")] };
}

/** A relayer on a scripted network where no account exists until its deployment has been sent. */
function undeployed(relayer = new Relayer(loadConfig({ RELAYER_SECRET: Keypair.random().secret() }))) {
  let sequence = 100;
  const accounts = new Set<string>();
  const sent: string[] = [];
  const server = {
    getLatestLedger: vi.fn(async () => ({ sequence: LATEST })),
    getLedgerEntries: vi.fn(async (key: xdr.LedgerKey) => {
      if (key.type !== "contractData" || key.contractData.key.type === "scvLedgerKeyNonce") return { entries: [], latestLedger: LATEST };
      const exists = accounts.has(Address.fromScAddress(key.contractData.contract).toString());
      return { entries: exists ? [{}] : [], latestLedger: LATEST };
    }),
    simulateTransaction: vi.fn(async (tx: { toEnvelope(): xdr.TransactionEnvelope }) => {
      const { call, auth } = invocation(tx);
      if (call.functionName.toString() === "deploy") return simulated([]);
      return simulated(auth.length ? auth : [recorded(Address.fromScVal(call.args[0]!).toString(), call)]);
    }),
    getAccount: vi.fn(async (address: string) => new Account(address, String(sequence))),
    sendTransaction: vi.fn(async (tx: { toEnvelope(): xdr.TransactionEnvelope }) => {
      sequence += 1;
      const { call } = invocation(tx);
      const fn = call.functionName.toString();
      sent.push(fn);
      const [owner] = call.args;
      if (fn === "deploy" && owner?.type === "scvBytes") {
        accounts.add(twinAddress(`0x${Buffer.from(owner.bytes.toBytes()).toString("hex")}`, "testnet"));
      }
      return { status: "PENDING", hash: "" };
    }),
    pollTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    getTransaction: vi.fn(async () => ({ status: "NOT_FOUND" })),
    getTransactions: vi.fn(async () => ({ transactions: [], cursor: "c1" })),
  };
  (relayer as unknown as { server: unknown }).server = server;
  return { relayer, server, sent };
}

const refusalOf = async (relayer: Relayer, body: unknown) => (await relayer.relay(body).catch((error: unknown) => error)) as ApiError;
const notSigned = { code: "bad_signature", status: 422, extra: { sent: false } };

afterEach(() => vi.restoreAllMocks());

describe("the first call from an account that does not exist yet", () => {
  it("deploys the account and relays the call when the owner signed it", async () => {
    const { relayer, sent } = undeployed();

    const result = await relayer.relay(relayRequest(await approval(freshOwner())));

    expect(sent).toEqual(["deploy", "approve"]);
    expect(result.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.hash).not.toBe(result.deployHash);
  });

  it("deploys nothing for 65 bytes that are not a signature", async () => {
    const { relayer, server, sent } = undeployed();

    const refused = await refusalOf(relayer, withGarbage(await approval(freshOwner())));

    expect(refused).toMatchObject(notSigned);
    expect(refused.detail).toMatch(/not the owner's signature .*BadSignature.*not deployed/);
    expect(sent).toEqual([]);
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
    expect(relayer.state.fees.spent()).toBe(BigInt(0));
  });

  it("deploys nothing for a request with no signature at all", async () => {
    const { relayer, server } = undeployed();
    const signed = await approval(freshOwner());
    const unsigned = xdr.SorobanAuthorizationEntry.fromXdr(signed.entries[0]!, "base64");
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: new Address(signed.account).toScAddress(),
          nonce: BigInt(77),
          signatureExpirationLedger: signed.validUntilLedger,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: unsigned.rootInvocation,
    });

    const refused = await refusalOf(relayer, { ...relayRequest(signed), auth: [entry.toXdr("base64")] });

    expect(refused).toMatchObject({ code: "bad_request", extra: { sent: false } });
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("deploys nothing when another key signed, however well", async () => {
    const { relayer, server } = undeployed();
    const owner = freshOwner();

    const refused = await refusalOf(relayer, relayRequest(await approval(owner, freshOwner())));

    expect(refused).toMatchObject(notSigned);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("deploys nothing when the call was changed after the owner signed it", async () => {
    const { relayer, server } = undeployed();
    const tampered = withArgument(await approval(freshOwner()), 2, nativeToScVal(BigInt(1_000_000), { type: "i128" }));

    const refused = await refusalOf(relayer, relayRequest(tampered));

    expect(refused).toMatchObject(notSigned);
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("deploys nothing for a signature that has expired, genuine or not", async () => {
    const { relayer, server } = undeployed();
    const owner = freshOwner();

    for (const stale of [await approval(owner, owner, 1, 4), await approval(owner, freshOwner(), 1, 4)]) {
      expect(await refusalOf(relayer, relayRequest(stale))).toMatchObject({ code: "expired", status: 409 });
    }
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("gives the same refusal again without checking again", async () => {
    const { relayer, server } = undeployed();
    const body = withGarbage(await approval(freshOwner()));

    const first = await refusalOf(relayer, body);
    const reads = server.getLedgerEntries.mock.calls.length;

    expect(await refusalOf(relayer, body)).toBe(first);
    expect(server.getLedgerEntries).toHaveBeenCalledTimes(reads);
  });
});

describe("a call from an account that exists", () => {
  it("is judged by the account itself, not by the relayer on its behalf", async () => {
    const { relayer, server, sent } = undeployed();
    const owner = freshOwner();
    await relayer.relay(relayRequest(await approval(owner)));
    const explanation = `HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", ${twinAddress(owner.address, "testnet")}, Error(Contract, #2)]`;
    const enforce = server.simulateTransaction.getMockImplementation()!;
    server.simulateTransaction.mockImplementation(async (tx) =>
      invocation(tx).auth.length ? ({ id: "1", latestLedger: LATEST, events: [], _parsed: true, error: explanation } as never) : enforce(tx),
    );

    const refused = await refusalOf(relayer, relayRequest(await approval(owner, freshOwner())));

    expect(refused).toMatchObject(notSigned);
    expect(refused.detail).toMatch(/BadSignature \(account error #2\)/);
    expect(refused.extra.diagnostic).toContain("failed account authentication");
    expect(sent).toEqual(["deploy", "approve"]);
  });
});

describe("what a caller can make the relayer spend on deployments", () => {
  it("is nothing through unsigned requests, and every one of them counts against the caller", async () => {
    process.env.RELAYER_SECRET ??= Keypair.random().secret();
    const { relayer, server } = undeployed(getRelayer());
    const statuses: number[] = [];

    for (let i = 0; i < 30; i += 1) {
      const response = await relayRoute(post("/api/relay", withGarbage(await approval(freshOwner()))));
      statuses.push(response.status);
      if (i === 0) expect(await response.json()).toMatchObject({ error: "bad_signature", sent: false });
    }
    const limited = await relayRoute(post("/api/relay", withGarbage(await approval(freshOwner()))));

    expect(statuses).toEqual(new Array(30).fill(422));
    expect(limited.status).toBe(429);
    expect(server.sendTransaction).not.toHaveBeenCalled();
    expect(relayer.state.fees.spent()).toBe(BigInt(0));
  });

  it("is bounded for the deployment route by a limit per caller, and every deployment is set against the day's budget", async () => {
    const { relayer, server } = undeployed(getRelayer());
    const statuses: number[] = [];

    for (let i = 0; i < 11; i += 1) {
      statuses.push((await deployRoute(post("/api/deploy", { network: "testnet", owner: freshOwner().address }))).status);
    }

    expect(statuses).toEqual([...new Array(10).fill(200), 429]);
    expect(server.sendTransaction).toHaveBeenCalledTimes(10);
    // Each deployment: 1000 stroops to be included and 100 in resources, on this scripted network.
    expect(relayer.state.fees.spent()).toBe(BigInt(11_000));
  });
});
