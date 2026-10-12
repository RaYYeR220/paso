import { Account, Address, BASE_FEE, Contract, Keypair, rpc, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  isDeployed,
  prepare,
  sign,
  simulateSigned,
  SimulationError,
  submitWith,
  type Prepared,
  type Signed,
} from "../src/actions";
import { accountEntryIndex, attachSignature } from "../src/auth";
import { NETWORKS } from "../src/networks";
import { ownerOf, usdcBalance } from "../src/read";
import { twinAddress } from "../src/twin";
import { OWNER_KEY } from "./helpers";

const { hub, usdc, rpcUrl, networkPassphrase } = NETWORKS.testnet.stellar;
const offline = process.env.PASO_OFFLINE === "1";
const deployed = hub !== "" && !offline;

const OWNERS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x000000000000000000000000000000000000dEaD",
] as const;

/** An account that exists on testnet under this hub. A new hub means new addresses, so the checks follow the hub. */
const LIVE_ACCOUNT = {
  hub: "CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO",
  owner: "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C",
  account: "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME",
} as const;

const server = new rpc.Server(rpcUrl);
const placeholder = () => new Account(StrKey.encodeEd25519PublicKey(new Uint8Array(32)), "0");

async function read(contract: string, fn: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(placeholder(), { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`${fn} did not simulate: ${JSON.stringify(simulation)}`);
  }
  return simulation.result.retval;
}

/** A transfer of nothing: it needs the account's signature but no balance. */
function emptyTransfer(owner: `0x${string}`, to: string): Promise<Prepared> {
  const zero = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 0n }));
  const from = twinAddress(owner, "testnet");
  return prepare(
    {
      kind: "invoke",
      contract: usdc,
      fn: "transfer",
      args: [new Address(from).toScVal(), new Address(to).toScVal(), zero],
    },
    { owner, network: "testnet", validForLedgers: 12 },
  );
}

describe.skipIf(!deployed)("against the testnet hub", () => {
  it.each(OWNERS)("derives the same twin as hub.address_of for %s", async (owner) => {
    const onChain = await read(hub, "address_of", xdr.ScVal.scvBytes(hexToBytes(owner)));
    expect(twinAddress(owner, "testnet")).toBe(Address.fromScVal(onChain).toString());
  });

  it("prepares a call whose typed data names the twin and the real arguments", async () => {
    const [owner, other] = OWNERS;
    const twin = twinAddress(owner, "testnet");
    const spender = twinAddress(other, "testnet");
    const { sequence } = await server.getLatestLedger();
    const prepared = await prepare(
      {
        kind: "invoke",
        contract: usdc,
        fn: "approve",
        args: [
          new Address(twin).toScVal(),
          new Address(spender).toScVal(),
          xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 1n })),
          xdr.ScVal.scvU32(sequence + 1000),
        ],
      },
      { owner, network: "testnet" },
    );

    expect(prepared.account).toBe(twin);
    expect(prepared.validUntilLedger).toBeGreaterThan(sequence);
    expect(prepared.calls).toEqual([
      { contract: usdc, fn: "approve", args: [twin, spender, "1", String(sequence + 1000)] },
    ]);
    expect(prepared.typedData.message.calls).toEqual(prepared.calls);
  });
});

describe.skipIf(!deployed || hub !== LIVE_ACCOUNT.hub)("against a deployed account", () => {
  const { owner, account } = LIVE_ACCOUNT;

  it("derives the address the account lives at", async () => {
    expect(twinAddress(owner, "testnet")).toBe(account);
    expect(await isDeployed(owner, "testnet")).toBe(true);
  });

  it("finds the Ethereum address stored as its owner", async () => {
    const stored = await read(account, "owner");
    if (stored.type !== "scvBytes") throw new Error(`owner() returned ${stored.type}`);
    expect(toHex(stored.bytes.toBytes())).toBe(owner.toLowerCase());
  });

  it("reads the owner and the USDC balance without an account of its own", async () => {
    expect(await ownerOf(account, "testnet")).toBe(owner);
    expect(await usdcBalance(account, "testnet")).toBeGreaterThanOrEqual(0n);
    expect(await ownerOf(twinAddress("0x00000000000000000000000000000000000000A1", "testnet"), "testnet")).toBeNull();
  });

  it("is refused by the account when someone else signs", async () => {
    const stranger = privateKeyToAccount(OWNER_KEY);
    const prepared = await emptyTransfer(owner, twinAddress(OWNERS[1], "testnet"));

    const signature = await stranger.signTypedData(prepared.typedData);
    const entries = prepared.entries.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64"));
    const index = accountEntryIndex(entries, account);
    const forged: Signed = {
      ...prepared,
      signature,
      entries: prepared.entries.map((entry, i) =>
        i === index ? attachSignature(entries[index]!, signature).toXdr("base64") : entry,
      ),
    };

    const refusal = await simulateSigned(forged).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SimulationError);
    expect((refusal as SimulationError).expired).toBe(false);
    expect((refusal as SimulationError).detail).toContain("failed account authentication");
    expect((refusal as SimulationError).detail).toContain("Error(Contract, #2)");
  });
});

const ownerKey = process.env.PASO_E2E_OWNER_KEY as `0x${string}` | undefined;
const sourceSecret = process.env.PASO_E2E_SOURCE_SECRET;

describe.skipIf(!deployed || !ownerKey)("with the key of a deployed account", () => {
  it("passes the account's signature check, and fails it once the call is changed", async () => {
    const owner = privateKeyToAccount(ownerKey!);
    expect(await isDeployed(owner.address, "testnet"), "the account must be deployed first").toBe(true);

    const signed = await sign(await emptyTransfer(owner.address, twinAddress(OWNERS[1], "testnet")), owner);
    await expect(simulateSigned(signed)).resolves.toBeUndefined();

    const other = await emptyTransfer(owner.address, twinAddress(OWNERS[2], "testnet"));
    const index = accountEntryIndex(
      other.entries.map((entry) => xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64")),
      other.account,
    );
    const changed: Signed = {
      ...other,
      signature: signed.signature,
      entries: other.entries.map((entry, i) =>
        i === index
          ? attachSignature(xdr.SorobanAuthorizationEntry.fromXdr(entry, "base64"), signed.signature).toXdr("base64")
          : entry,
      ),
    };
    const refusal = await simulateSigned(changed).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SimulationError);
    expect((refusal as SimulationError).detail).toContain("Error(Contract, #2)");
  });
});

describe.skipIf(!deployed || !ownerKey || !sourceSecret)("with a funded twin and a fee-paying account", () => {
  it("moves USDC out of the twin on a wallet signature", async ({ skip }) => {
    const owner = privateKeyToAccount(ownerKey!);
    const source = Keypair.fromSecret(sourceSecret!);
    // Nothing to move until USDC has been delivered to the twin.
    skip((await usdcBalance(twinAddress(owner.address, "testnet"), "testnet")) < 100_000n);
    const prepared = await prepare(
      { kind: "transfer", to: OWNERS[1], amount: 100_000n },
      { owner: owner.address, network: "testnet", source: source.publicKey() },
    );
    const signed = await sign(prepared, owner);
    const { hash } = await submitWith(signed, source);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
