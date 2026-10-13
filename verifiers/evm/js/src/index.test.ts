/**
 * The helper against `../../vectors/vectors.json`, the same vectors the
 * contract tests run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Address as StellarAddress, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { hashDomain, hexToBytes, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertUsableSignature,
  contractId,
  digest,
  keyData,
  networkId,
  recoverSigner,
  signPayload,
  typedData,
  type TypedDataSigner,
} from "./index";
import {
  attachSignatures,
  authDigest,
  authPayload,
  entryAddress,
  entryPayload,
  ethereumSigner,
  signaturePayload,
} from "./openzeppelin";

interface Vector {
  name: string;
  networkPassphrase: string;
  networkId: Hex;
  signer: Address;
  privateKey: Hex;
  account: string;
  keyData: Hex;
  payload: Hex;
  openZeppelin?: { signaturePayload: Hex; contextRuleIds: number[] };
  domainSeparator: Hex;
  digest: Hex;
  signature: Hex;
}

interface AuthPayloadVector {
  name: string;
  verifier: string;
  account: string;
  contextRuleIds: number[];
  signers: { address: Address; signature: Hex }[];
  xdr: Hex;
}

const { vectors, authPayloads } = JSON.parse(
  readFileSync(new URL("../../vectors/vectors.json", import.meta.url), "utf8"),
) as { vectors: Vector[]; authPayloads: AuthPayloadVector[] };

const network = (v: Vector) => ({ networkPassphrase: v.networkPassphrase });
const named = (name: string): Vector => {
  const found = vectors.find((v) => v.name === name);
  assert.ok(found, name);
  return found;
};

const domainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

test("typed data hashes to the digest of every vector", () => {
  assert.equal(vectors.length, 9);
  for (const v of vectors) {
    assert.equal(networkId(network(v)), v.networkId, v.name);
    assert.equal(
      hashDomain({ domain: typedData(v.account, v.payload, network(v)).domain, types: domainTypes }),
      v.domainSeparator,
    );
    assert.equal(digest(v.account, v.payload, network(v)), v.digest, v.name);
  }
});

test("named networks are the two public ones", () => {
  assert.equal(networkId("testnet"), named("testnet").networkId);
  assert.equal(networkId("mainnet"), named("mainnet").networkId);
});

test("key data is the address followed by the account's contract id", () => {
  for (const v of vectors) {
    assert.equal(keyData(v.signer, v.account), v.keyData, v.name);
    assert.equal(keyData(v.signer.toLowerCase() as Address, v.account), v.keyData, v.name);
  }
  const v = named("testnet");
  assert.notEqual(keyData(v.signer, v.account), keyData(v.signer, named("another_account").account));
  assert.throws(() => keyData("0x1234", v.account), /Ethereum address/);
  // An account, not a contract.
  assert.throws(() => keyData(v.signer, "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"), /contract/);
  assert.throws(() => keyData(v.signer, `${v.account.slice(0, -1)}A`), /contract/);
});

test("the message names the account", () => {
  const v = named("testnet");
  const other = named("another_account");
  assert.equal(v.signer, other.signer);
  assert.equal(v.payload, other.payload);
  assert.deepEqual(typedData(v.account, v.payload, "testnet").message, { account: v.account, payload: v.payload });
  assert.notEqual(digest(v.account, v.payload, "testnet"), digest(other.account, v.payload, "testnet"));
  assert.throws(() => typedData("not an account", v.payload, "testnet"), /contract/);
});

test("signPayload reproduces the signature of every vector", async () => {
  for (const v of vectors) {
    const signer = privateKeyToAccount(v.privateKey);
    assert.equal(signer.address, v.signer, v.name);
    assert.equal(await signPayload(signer, v.account, v.payload, network(v)), v.signature, v.name);
    assert.equal(await recoverSigner(v.account, v.payload, network(v), v.signature), v.signer, v.name);
  }
});

test("a signature made for one account recovers to someone else on another", async () => {
  const v = named("testnet");
  const other = named("another_account");
  assert.notEqual(await recoverSigner(other.account, v.payload, network(v), v.signature), v.signer);
});

test("signPayload refuses a signature made by another key", async () => {
  const v = named("testnet");
  const second = named("second_signer");
  assert.notEqual(v.signer, second.signer);
  const impostor: TypedDataSigner = {
    address: v.signer,
    signTypedData: (data) => privateKeyToAccount(second.privateKey).signTypedData(data),
  };
  await assert.rejects(signPayload(impostor, v.account, v.payload, network(v)), /not by/);
});

test("a payload must be 32 bytes", () => {
  const { account } = named("testnet");
  assert.throws(() => typedData(account, "0x1234", "testnet"), /32 bytes/);
  assert.throws(() => typedData(account, `0x${"00".repeat(33)}`, "testnet"), /32 bytes/);
});

test("only 65-byte low-s signatures with a known recovery byte are usable", () => {
  const v = named("testnet");
  assertUsableSignature(v.signature);

  const bytes = hexToBytes(v.signature);
  assert.throws(() => assertUsableSignature(toHex(bytes.subarray(0, 64))), /65 bytes/);

  const badRecovery = Uint8Array.from(bytes);
  badRecovery[64] = 2;
  assert.throws(() => assertUsableSignature(toHex(badRecovery)), /recovery byte 2/);

  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = Uint8Array.from(bytes);
  highS.set(hexToBytes(toHex(order - BigInt(toHex(bytes.subarray(32, 64))), { size: 32 })), 32);
  assert.throws(() => assertUsableSignature(toHex(highS)), /low-s/);
});

test("contractId is the address a deployer and a salt give", () => {
  // A contract that exists on testnet: this deployer created it with this salt.
  const deployer = "GDTU3U4XNKNRTUIZM42ZFQYHVJQMNETPUSA7MU3RTL4H5YVGHVSJ7XII";
  const salt = "0x9777e395f8a643bac49ff7fa5936964987ac50d8e58f94f7b87bab0f29f6b840";
  const deployed = "CCNKAWI477PYRBW5O7NVYE7UBMDXB4OG74SXLQBJNVXZH4S3P7H7FVX5";
  assert.equal(contractId(deployer, salt, "testnet"), deployed);
  assert.equal(contractId(deployer, hexToBytes(salt), "testnet"), deployed);
  assert.notEqual(contractId(deployer, salt, "mainnet"), deployed);
  assert.notEqual(contractId(deployer, `0x${"00".repeat(32)}`, "testnet"), deployed);
  assert.throws(() => contractId(deployer, "0x1234", "testnet"), /32 bytes/);
});

test("authDigest follows stellar-accounts 0.7.2", () => {
  const derived = vectors.filter((v) => v.openZeppelin);
  assert.equal(derived.length, 2);
  for (const v of derived) {
    assert.equal(authDigest(v.openZeppelin!.signaturePayload, v.openZeppelin!.contextRuleIds), v.payload, v.name);
  }
});

test("the account's signature value matches the vectors, signers in key order", () => {
  assert.equal(authPayloads.length, 2);
  for (const p of authPayloads) {
    const value = authPayload(p.verifier, p.account, p.signers, p.contextRuleIds);
    assert.equal(`0x${value.toXDR("hex")}`, p.xdr, p.name);
    const reversed = authPayload(p.verifier, p.account, [...p.signers].reverse(), p.contextRuleIds);
    assert.equal(`0x${reversed.toXDR("hex")}`, p.xdr, p.name);
  }

  const [two] = authPayloads.filter((p) => p.signers.length === 2);
  assert.ok(two);
  assert.throws(
    () => authPayload(two.verifier, two.account, [two.signers[0]!, two.signers[0]!], two.contextRuleIds),
    /Two signatures/,
  );
});

test("the signature value of one signer has the shape the account decodes", () => {
  const v = named("testnet");
  const verifier = "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3";
  const value = authPayload(verifier, v.account, [{ address: v.signer, signature: v.signature }], [0]);

  // AuthPayload { context_rule_ids: Vec<u32>, signers: Map<Signer, Bytes> }, fields in key order,
  // with Signer::External(Address, Bytes) as [Symbol, Address, Bytes].
  assert.equal(
    value.toXDR("hex"),
    [
      "00000011" + "00000001" + "00000002",
      "0000000f" + "00000010" + toHex("context_rule_ids").slice(2),
      "00000010" + "00000001" + "00000001" + "00000003" + "00000000",
      "0000000f" + "00000007" + toHex("signers").slice(2) + "00",
      "00000011" + "00000001" + "00000001",
      "00000010" + "00000001" + "00000003",
      "0000000f" + "00000008" + toHex("External").slice(2),
      "00000012" + "00000001" + "c3".repeat(32),
      "0000000d" + "00000034" + v.signer.slice(2).toLowerCase() + "a1".repeat(32),
      "0000000d" + "00000041" + v.signature.slice(2) + "000000",
    ].join(""),
  );
  assert.equal(
    ethereumSigner(verifier, v.signer, v.account).toXDR("hex"),
    [
      "00000010" + "00000001" + "00000003",
      "0000000f" + "00000008" + toHex("External").slice(2),
      "00000012" + "00000001" + "c3".repeat(32),
      "0000000d" + "00000034" + v.signer.slice(2).toLowerCase() + "a1".repeat(32),
    ].join(""),
  );
});

test("an entry is signed over its own payload and keeps everything else", () => {
  const v = named("testnet");
  const account = v.account;
  const otherAccount = named("another_account").account;
  const verifier = "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3";
  const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const validUntilLedger = 1_000;

  // A call that names neither account, so that only the credentials can.
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: StellarAddress.fromString(token).toScAddress(),
        functionName: "open",
        args: [nativeToScVal(250n, { type: "i128" })],
      }),
    ),
    subInvocations: [],
  });
  const unsigned = (of: string) =>
    new xdr.SorobanAddressCredentials({
      address: StellarAddress.fromString(of).toScAddress(),
      nonce: xdr.Int64.fromString("7"),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    });
  const legacy = (of: string) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(unsigned(of)),
      rootInvocation,
    });
  const addressBound = (of: string) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(unsigned(of)),
      rootInvocation,
    });
  const payloadOf = (entry: xdr.SorobanAuthorizationEntry, until = validUntilLedger) =>
    signaturePayload(entry, until, network(v));

  // The legacy payload, built by hand: network, nonce, expiry and the call.
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(v.networkPassphrase)),
      nonce: xdr.Int64.fromString("7"),
      signatureExpirationLedger: validUntilLedger,
      invocation: rootInvocation,
    }),
  );
  const legacyPayload = toHex(hash(preimage.toXDR()));
  assert.equal(payloadOf(legacy(account)), legacyPayload);
  assert.notEqual(payloadOf(legacy(account), validUntilLedger + 1), legacyPayload);

  // It is the same for another account; the address-bound payload is not.
  // What a signer signs differs between the accounts either way, because
  // the message names the account.
  assert.equal(payloadOf(legacy(otherAccount)), legacyPayload);
  assert.notEqual(payloadOf(addressBound(account)), legacyPayload);
  assert.notEqual(payloadOf(addressBound(account)), payloadOf(addressBound(otherAccount)));
  for (const encoding of [legacy, addressBound]) {
    const payload = entryPayload(encoding(account), validUntilLedger, network(v));
    assert.equal(payload, authDigest(payloadOf(encoding(account)), [0]));
    assert.notEqual(
      digest(account, payload, network(v)),
      digest(otherAccount, entryPayload(encoding(otherAccount), validUntilLedger, network(v)), network(v)),
    );
  }

  const signatures = [{ address: v.signer, signature: v.signature }];
  for (const entry of [legacy(account), addressBound(account)]) {
    const signed = attachSignatures(entry, validUntilLedger, verifier, signatures);
    assert.equal(signed.credentials.type, entry.credentials.type);
    assert.equal(entryAddress(signed), account);
    assert.equal(signed.rootInvocation.toXDR("hex"), rootInvocation.toXDR("hex"));
    // Signing changes neither the nonce nor the payload.
    assert.equal(payloadOf(signed), payloadOf(entry));

    const credentials =
      signed.credentials.type === "sorobanCredentialsAddress"
        ? signed.credentials.address
        : signed.credentials.type === "sorobanCredentialsAddressV2"
          ? signed.credentials.addressV2
          : undefined;
    assert.equal(credentials?.signatureExpirationLedger, validUntilLedger);
    // The key data names the account the entry is for.
    assert.equal(credentials?.signature.toXDR("hex"), authPayload(verifier, account, signatures, [0]).toXDR("hex"));
  }
});
