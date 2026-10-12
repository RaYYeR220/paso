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
  digest,
  networkId,
  recoverSigner,
  signPayload,
  typedData,
  type TypedDataSigner,
} from "./index";
import {
  attachSignature,
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
  payload: Hex;
  openZeppelin?: { signaturePayload: Hex; contextRuleIds: number[] };
  domainSeparator: Hex;
  digest: Hex;
  signature: Hex;
}

const { vectors } = JSON.parse(readFileSync(new URL("../../vectors/vectors.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};
const network = (v: Vector) => ({ networkPassphrase: v.networkPassphrase });

const domainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

test("typed data hashes to the digest of every vector", () => {
  assert.equal(vectors.length, 8);
  for (const v of vectors) {
    assert.equal(networkId(network(v)), v.networkId, v.name);
    assert.equal(hashDomain({ domain: typedData(v.payload, network(v)).domain, types: domainTypes }), v.domainSeparator);
    assert.equal(digest(v.payload, network(v)), v.digest, v.name);
  }
});

test("named networks are the two public ones", () => {
  const byName = Object.fromEntries(vectors.map((v) => [v.name, v]));
  assert.equal(networkId("testnet"), byName.testnet?.networkId);
  assert.equal(networkId("mainnet"), byName.mainnet?.networkId);
});

test("signPayload reproduces the signature of every vector", async () => {
  for (const v of vectors) {
    const account = privateKeyToAccount(v.privateKey);
    assert.equal(account.address, v.signer, v.name);
    assert.equal(await signPayload(account, v.payload, network(v)), v.signature, v.name);
    assert.equal(await recoverSigner(v.payload, network(v), v.signature), v.signer, v.name);
  }
});

test("signPayload refuses a signature made by another key", async () => {
  const [first, , second] = vectors as [Vector, Vector, Vector];
  assert.notEqual(first.signer, second.signer);
  const impostor: TypedDataSigner = {
    address: first.signer,
    signTypedData: (data) => privateKeyToAccount(second.privateKey).signTypedData(data),
  };
  await assert.rejects(signPayload(impostor, first.payload, network(first)), /not by/);
});

test("a payload must be 32 bytes", () => {
  assert.throws(() => typedData("0x1234", "testnet"), /32 bytes/);
  assert.throws(() => typedData(`0x${"00".repeat(33)}`, "testnet"), /32 bytes/);
});

test("only 65-byte low-s signatures with a known recovery byte are usable", () => {
  const [v] = vectors as [Vector];
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

test("authDigest follows stellar-accounts 0.7.2", () => {
  const derived = vectors.filter((v) => v.openZeppelin);
  assert.equal(derived.length, 2);
  for (const v of derived) {
    assert.equal(authDigest(v.openZeppelin!.signaturePayload, v.openZeppelin!.contextRuleIds), v.payload, v.name);
  }
});

test("the account's signature value has the shape the account decodes", () => {
  const [v] = vectors as [Vector];
  const verifier = "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG";
  const value = authPayload(ethereumSigner(verifier, v.signer), v.signature, [0]);

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
      "00000012" + "00000001" + "a1".repeat(32),
      "0000000d" + "00000014" + v.signer.slice(2).toLowerCase(),
      "0000000d" + "00000041" + v.signature.slice(2) + "000000",
    ].join(""),
  );
});

test("an entry is signed over its own payload and keeps everything else", () => {
  const [v] = vectors as [Vector];
  const account = "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG";
  const otherAccount = "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3";
  const verifier = "CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K";
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

  // It is the same for another account. The address-bound payload is not.
  assert.equal(payloadOf(legacy(otherAccount)), legacyPayload);
  assert.notEqual(payloadOf(addressBound(account)), legacyPayload);
  assert.notEqual(payloadOf(addressBound(account)), payloadOf(addressBound(otherAccount)));

  // So only address-bound entries are prepared for signing.
  assert.equal(
    entryPayload(addressBound(account), validUntilLedger, network(v)),
    authDigest(payloadOf(addressBound(account)), [0]),
  );
  assert.throws(() => entryPayload(legacy(account), validUntilLedger, network(v)), /address-bound/);

  for (const entry of [legacy(account), addressBound(account)]) {
    const signed = attachSignature(entry, validUntilLedger, v.signature, { verifier, address: v.signer });
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
    assert.equal(
      credentials?.signature.toXDR("hex"),
      authPayload(ethereumSigner(verifier, v.signer), v.signature, [0]).toXDR("hex"),
    );
  }
});
