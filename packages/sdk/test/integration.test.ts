import { Account, Address, BASE_FEE, Contract, Keypair, rpc, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { prepare, sign, submitWith } from "../src/actions";
import { NETWORKS } from "../src/networks";
import { twinAddress } from "../src/twin";

const { hub, usdc, rpcUrl, networkPassphrase } = NETWORKS.testnet.stellar;
const offline = process.env.PASO_OFFLINE === "1";
const deployed = hub !== "" && !offline;

const OWNERS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x000000000000000000000000000000000000dEaD",
] as const;

describe.skipIf(!deployed)("against the testnet hub", () => {
  const server = new rpc.Server(rpcUrl);
  const placeholder = new Account(StrKey.encodeEd25519PublicKey(new Uint8Array(32)), "0");

  async function addressOf(owner: `0x${string}`): Promise<string> {
    const tx = new TransactionBuilder(placeholder, { fee: BASE_FEE, networkPassphrase })
      .addOperation(new Contract(hub).call("address_of", xdr.ScVal.scvBytes(hexToBytes(owner))))
      .setTimeout(60)
      .build();
    const simulation = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new Error(`address_of did not simulate: ${JSON.stringify(simulation)}`);
    }
    return Address.fromScVal(simulation.result.retval).toString();
  }

  it.each(OWNERS)("derives the same twin as hub.address_of for %s", async (owner) => {
    expect(twinAddress(owner, "testnet")).toBe(await addressOf(owner));
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

const ownerKey = process.env.PASO_E2E_OWNER_KEY as `0x${string}` | undefined;
const sourceSecret = process.env.PASO_E2E_SOURCE_SECRET;

describe.skipIf(!deployed || !ownerKey || !sourceSecret)("with a funded twin and a fee-paying account", () => {
  it("moves USDC out of the twin on a wallet signature", async () => {
    const owner = privateKeyToAccount(ownerKey!);
    const source = Keypair.fromSecret(sourceSecret!);
    const prepared = await prepare(
      { kind: "transfer", to: OWNERS[1], amount: 100_000n },
      { owner: owner.address, network: "testnet", source: source.publicKey() },
    );
    const signed = await sign(prepared, owner);
    const { hash } = await submitWith(signed, source);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
