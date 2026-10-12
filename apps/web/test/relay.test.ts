import { isDeployed, relayRequest, twinAddress, withArgument, type RelayRequest, type Signed } from "@paso/sdk";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as deployRoute } from "@/app/api/deploy/route";
import { POST as relayRoute } from "@/app/api/relay/route";
import { loadConfig } from "@/lib/server/config";
import { ApiError } from "@/lib/server/errors";
import { getRelayer, Relayer } from "@/lib/server/relayer";
import { live, post, server, signedApprove, usdc, xlmBalance } from "./helpers";

/** The native asset's contract on testnet: what a relayer's XLM would leave through. */
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const ownerKey = process.env.PASO_E2E_OWNER_KEY as `0x${string}` | undefined;

async function relay(body: unknown): Promise<{ status: number; body: Record<string, string> }> {
  const response = await relayRoute(post("/api/relay", body));
  return { status: response.status, body: await response.json() };
}

function i128(value: number): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

function contractCall(contract: string, fn: string, args: xdr.ScVal[]): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args });
}

function sourceAccountEntry(call: xdr.InvokeContractArgs): string {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  }).toXdr("base64");
}

describe.skipIf(!live || !ownerKey)("POST /api/relay, for an account that exists", () => {
  const owner = privateKeyToAccount(ownerKey!);
  const relayer = live ? getRelayer() : (undefined as unknown as Relayer);
  let signed: Signed;
  let request: RelayRequest;

  beforeAll(async () => {
    signed = await signedApprove(owner, 1);
    request = relayRequest(signed);
  });

  it("relays a signed call and pays for it", async () => {
    const { status, body } = await relay(relayRequest(await signedApprove(owner, 7)));

    expect(status).toBe(200);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.deployHash).toBeUndefined();

    const applied = await server.getTransaction(body.hash!);
    expect(applied.status).toBe("SUCCESS");
    if (applied.status !== "SUCCESS") return;
    const envelope = applied.envelopeXdr;
    expect(envelope.type === "envelopeTypeTx" && envelope.v1.tx.sourceAccount.type).toBe("keyTypeEd25519");
  });

  it("answers expired once the signature's last ledger has passed, without simulating", async () => {
    const stale = await signedApprove(owner, 1, { validForLedgers: -2 });
    const { status, body } = await relay(relayRequest(stale));

    expect(status).toBe(409);
    expect(body.error).toBe("expired");
    expect(body.detail).toContain(String(stale.validUntilLedger));
    expect(body.diagnostic).toBeUndefined();
  });

  it("answers bad_signature when an argument was changed after signing", async () => {
    const tampered = withArgument(signed, 2, i128(1_000_000_0000000));
    const { status, body } = await relay(relayRequest(tampered));

    expect(status).toBe(422);
    expect(body.error).toBe("bad_signature");
    expect(body.detail).toMatch(/BadSignature \(account error #2\)/);
    expect(body.diagnostic).toContain("failed account authentication");
    expect(body.diagnostic).toContain("__check_auth");
    // Decided before anything was sent, and checked against the chain: the call has not run.
    expect(body.sent as unknown).toBe(false);
  });

  it("answers a repeat of a relayed call with its transaction, on record or found on chain", async () => {
    const once = relayRequest(await signedApprove(owner, 11));
    const before = await xlmBalance(relayer.address);

    const first = await relay(once);
    expect(first.status).toBe(200);
    const paid = before - (await xlmBalance(relayer.address));
    expect(paid > BigInt(0)).toBe(true);

    // The same bytes again: the same answer, and nothing more is paid for.
    const again = await relay(once);
    expect(again).toEqual(first);

    // A server that has never seen the call finds the transaction that carried it, instead of calling it refused.
    const stranger = new Relayer(loadConfig());
    expect(await stranger.relay(once)).toEqual({ hash: first.body.hash });
    expect(before - (await xlmBalance(relayer.address))).toBe(paid);
  });

  it("answers bad_signature when the call differs from the entry that was signed", async () => {
    const changed = relayRequest(withArgument(signed, 2, i128(5)));
    const { status, body } = await relay({ ...changed, auth: request.auth });

    expect(status).toBe(422);
    expect(body.error).toBe("bad_signature");
    expect(body.detail).toMatch(/does not cover the call/);
  });

  it("refuses an entry for an account that is not the owner's", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const { status, body } = await relay({ ...request, owner: stranger });

    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(body.detail).toContain(`not the owner's account ${twinAddress(stranger, "testnet")}`);
  });

  it("refuses a second entry for another address", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const theirs = await signedApprove(other, 1);
    const { status, body } = await relay({ ...request, auth: [...request.auth, ...theirs.entries] });

    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(body.detail).toContain(`authorisation from ${twinAddress(other.address, "testnet")}`);
  });

  it("never lends the relayer's authority: a transfer of its XLM with a source-account entry is refused", async () => {
    const stranger = Keypair.random().publicKey();
    const drain = contractCall(XLM, "transfer", [
      new Address(relayer.address).toScVal(),
      new Address(stranger).toScVal(),
      i128(1),
    ]);
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(drain).toXdr("base64");
    const before = await xlmBalance(relayer.address);

    const alone = await relay({ ...request, func, auth: [sourceAccountEntry(drain)] });
    expect(alone.status).toBe(400);
    expect(alone.body.error).toBe("bad_request");
    expect(alone.body.detail).toMatch(/source account/);

    const beside = await relay({ ...request, func, auth: [...request.auth, sourceAccountEntry(drain)] });
    expect(beside.status).toBe(400);
    expect(beside.body.detail).toMatch(/source account/);

    // Even with nothing but the owner's genuine entry, the network finds no authorisation for the relayer.
    const withoutEntry = await relay({ ...request, func });
    expect(withoutEntry.status).toBe(422);
    expect(withoutEntry.body.error).toBe("bad_signature");

    expect(await xlmBalance(relayer.address)).toBe(before);
  });

  it("refuses a host function that uploads code or creates a contract", async () => {
    const upload = xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from("0061736d01000000", "hex"));
    const { status, body } = await relay({ ...request, func: upload.toXdr("base64") });

    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(body.detail).toMatch(/Only contract calls can be relayed/);
  });

  it("refuses a call that does not use the signed authorisation", async () => {
    const read = contractCall(usdc, "balance", [new Address(signed.account).toScVal()]);
    const before = await xlmBalance(relayer.address);
    const { status, body } = await relay({
      ...request,
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(read).toXdr("base64"),
    });

    expect(status).toBe(400);
    expect(body.error).toBe("bad_request");
    expect(body.detail).toMatch(/does not need .* to authorise anything/);
    expect(await xlmBalance(relayer.address)).toBe(before);
  });

  it("refuses a call that costs more than the relayer pays for, naming the cap", async () => {
    const frugal = new Relayer(loadConfig({ ...process.env, RELAYER_MAX_RESOURCE_FEE: "1000" }));
    const before = await xlmBalance(relayer.address);
    const failure = await frugal.relay(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("simulation_failed");
    expect((failure as ApiError).status).toBe(422);
    expect((failure as ApiError).detail).toMatch(/up to 1000 stroops \(0\.0001 XLM\)/);
    expect(await xlmBalance(relayer.address)).toBe(before);
  });

  it("refuses a request for another network, a missing signature and anything that is not JSON", async () => {
    expect((await relay({ ...request, network: "mainnet" })).body.error).toBe("bad_request");
    expect((await relay({ ...request, network: undefined })).body.error).toBe("bad_request");
    expect((await relay({ ...request, auth: [...request.auth, ...request.auth, ...request.auth] })).status).toBe(400);
    expect((await relay({ ...request, auth: [] })).body.detail).toMatch(/does not need/);
    expect((await relay({ ...request, func: "AAAA" })).body.error).toBe("bad_request");

    const response = await relayRoute(post("/api/relay", "not json"));
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toMatch(/must be JSON/);
  });
});

describe.skipIf(!live)("POST /api/relay, for an account that does not exist yet", () => {
  it("deploys the account, then relays its first call", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    expect(await isDeployed(owner.address, "testnet")).toBe(false);

    const { status, body } = await relay(relayRequest(await signedApprove(owner, 3)));

    expect(status).toBe(200);
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.deployHash).not.toBe(body.hash);
    expect(await isDeployed(owner.address, "testnet")).toBe(true);
  });

  it("deploys nothing for a first call the owner did not sign, and pays nothing", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const relayerAddress = getRelayer().address;
    const before = await xlmBalance(relayerAddress);
    const tampered = withArgument(await signedApprove(owner, 1), 2, i128(1_000_000));

    const { status, body } = await relay(relayRequest(tampered));

    expect(status).toBe(422);
    expect(body.error).toBe("bad_signature");
    expect(body.sent as unknown).toBe(false);
    expect(body.detail).toMatch(/not the owner's signature/);
    expect(await isDeployed(owner.address, "testnet")).toBe(false);
    expect(await xlmBalance(relayerAddress)).toBe(before);
  });

  it("handles two first calls at once with a single deployment", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const other = twinAddress(privateKeyToAccount(generatePrivateKey()).address, "testnet");
    const [first, second] = await Promise.all([
      signedApprove(owner, 1),
      signedApprove(owner, 2, { spender: other }),
    ]);

    const results = await Promise.all([relay(relayRequest(first)), relay(relayRequest(second))]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const [a, b] = results.map((result) => result.body);
    expect(a!.hash).not.toBe(b!.hash);
    expect(a!.deployHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b!.deployHash).toBe(a!.deployHash);
    expect(await isDeployed(owner.address, "testnet")).toBe(true);
  });
});

describe.skipIf(!live)("POST /api/deploy", () => {
  async function deploy(body: unknown) {
    const response = await deployRoute(post("/api/deploy", body));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("deploys an account once and reports it as already deployed after that", async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const address = twinAddress(owner, "testnet");

    const first = await deploy({ network: "testnet", owner });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ address, hash: expect.stringMatching(/^[0-9a-f]{64}$/), alreadyDeployed: false });

    const second = await deploy({ network: "testnet", owner: owner.toLowerCase() });
    expect(second.body).toEqual({ address, alreadyDeployed: true });
  });

  it("deploys once when two requests for the same owner arrive together", async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const [a, b] = await Promise.all([deploy({ network: "testnet", owner }), deploy({ network: "testnet", owner })]);

    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(a.body.alreadyDeployed).toBe(false);
  });

  it("refuses anything that is not an Ethereum address, and other networks", async () => {
    expect((await deploy({ network: "testnet", owner: "GABC" })).status).toBe(400);
    expect((await deploy({ network: "mainnet", owner: "0x000000000000000000000000000000000000dEaD" })).status).toBe(400);
    expect((await deploy([])).status).toBe(400);
  });
});
