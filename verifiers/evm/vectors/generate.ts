/**
 * Writes `vectors.json`: the signing vectors that the verifier contract and
 * the TypeScript helper both have to reproduce byte for byte.
 *
 * The typed data is spelled out here rather than imported from the helper, so
 * the file can catch a helper that is wrong. Digests and signatures come from
 * viem.
 *
 * The private keys below are fixed test keys. They control nothing.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { hashDomain, hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const passphrases = { testnet: TESTNET, mainnet: MAINNET };

const DOMAIN_NAME = "Paso verifier";
const DOMAIN_VERSION = "2";

const domainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const types = {
  Authorization: [
    { name: "account", type: "string" },
    { name: "payload", type: "bytes32" },
  ],
} as const;

const KEY_A: Hex = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SIGNER_A = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c";
const KEY_B: Hex = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const SIGNER_B = "0x6A9296CEb89D12e1F53b2Dd5Df45d3ADB3A814c2";

/** Smart accounts the signers are registered for. Test addresses: no contract lives there. */
const ACCOUNT_A = "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG";
const ACCOUNT_B = "CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K";
const VERIFIER = "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3";

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();
const hex = (data: Uint8Array): Hex => `0x${Buffer.from(data).toString("hex")}`;
const bytes = (data: Hex): Buffer => Buffer.from(data.slice(2), "hex");

/** A stand-in for the 32 bytes an account would ask the verifier to check. */
const labelled = (label: string): Hex => hex(sha256(`paso verifier vector: ${label}`));

/** The key data of a signer: its address, then the contract id of its account. */
const keyData = (signer: string, account: string): Buffer =>
  Buffer.concat([bytes(signer as Hex), StrKey.decodeContract(account)]);

/**
 * The 32 bytes an OpenZeppelin smart account (stellar-accounts 0.7.2) hands
 * to a verifier: sha256 of the Soroban authorisation payload followed by the
 * XDR of the context rule ids selected for the entry.
 */
function openZeppelinAuthDigest(signaturePayload: Hex, contextRuleIds: number[]): Hex {
  const ruleIds = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
  return hex(sha256(Buffer.concat([bytes(signaturePayload), ruleIds])));
}

interface Case {
  name: string;
  network: "testnet" | "mainnet";
  privateKey: Hex;
  signer: string;
  account: string;
  payload: Hex;
  /** Set when `payload` is derived the way an OpenZeppelin smart account derives it. */
  openZeppelin?: { signaturePayload: Hex; contextRuleIds: number[] };
}

const ozSignaturePayload = labelled("soroban authorisation payload");
const ozRuleIds = [0];
const ozTwoRulesPayload = labelled("soroban authorisation payload with two contexts");
const ozTwoRuleIds = [3, 0];

const a = { privateKey: KEY_A, signer: SIGNER_A };
const b = { privateKey: KEY_B, signer: SIGNER_B };

const cases: Case[] = [
  { name: "testnet", network: "testnet", ...a, account: ACCOUNT_A, payload: labelled("first") },
  { name: "another_payload", network: "testnet", ...a, account: ACCOUNT_A, payload: labelled("second") },
  { name: "second_signer", network: "testnet", ...b, account: ACCOUNT_A, payload: labelled("first") },
  { name: "another_account", network: "testnet", ...a, account: ACCOUNT_B, payload: labelled("first") },
  { name: "mainnet", network: "mainnet", ...a, account: ACCOUNT_A, payload: labelled("first") },
  { name: "zero_payload", network: "testnet", ...a, account: ACCOUNT_A, payload: `0x${"00".repeat(32)}` },
  { name: "max_payload", network: "testnet", ...b, account: ACCOUNT_B, payload: `0x${"ff".repeat(32)}` },
  {
    name: "openzeppelin_auth_digest",
    network: "testnet",
    ...a,
    account: ACCOUNT_A,
    payload: openZeppelinAuthDigest(ozSignaturePayload, ozRuleIds),
    openZeppelin: { signaturePayload: ozSignaturePayload, contextRuleIds: ozRuleIds },
  },
  {
    name: "openzeppelin_auth_digest_two_rules",
    network: "testnet",
    ...b,
    account: ACCOUNT_B,
    payload: openZeppelinAuthDigest(ozTwoRulesPayload, ozTwoRuleIds),
    openZeppelin: { signaturePayload: ozTwoRulesPayload, contextRuleIds: ozTwoRuleIds },
  },
];

async function build(c: Case) {
  const signer = privateKeyToAccount(c.privateKey);
  if (signer.address !== c.signer) {
    throw new Error(`${c.name}: signer does not match the private key`);
  }

  const networkPassphrase = passphrases[c.network];
  const networkId = hex(sha256(networkPassphrase));
  const domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, salt: networkId } as const;
  const typedData = {
    domain,
    types,
    primaryType: "Authorization",
    message: { account: c.account, payload: c.payload },
  } as const;

  return {
    name: c.name,
    network: c.network,
    networkPassphrase,
    networkId,
    signer: c.signer,
    privateKey: c.privateKey,
    account: c.account,
    keyData: hex(keyData(c.signer, c.account)),
    payload: c.payload,
    ...(c.openZeppelin ? { openZeppelin: c.openZeppelin } : {}),
    domainSeparator: hashDomain({ domain, types: domainTypes }),
    digest: hashTypedData(typedData),
    signature: await signer.signTypedData(typedData),
  };
}

const vectors = [];
for (const c of cases) {
  vectors.push(await build(c));
}

/**
 * The signature value of an OpenZeppelin smart account, `AuthPayload`, for
 * signers checked by one verifier: a map with the fields in key order, whose
 * `signers` map is ordered by key data.
 */
function authPayload(name: string, signedBy: string[], contextRuleIds: number[]) {
  const signers = signedBy.map((vector) => {
    const v = vectors.find((candidate) => candidate.name === vector);
    if (!v || v.account !== ACCOUNT_A) {
      throw new Error(`${name}: no vector ${vector} for the account`);
    }
    return { address: v.signer, signature: v.signature };
  });

  const entries = signers
    .map(({ address, signature }) => ({ key: keyData(address, ACCOUNT_A), signature: bytes(signature) }))
    .sort((left, right) => Buffer.compare(left.key, right.key))
    .map(
      ({ key, signature }) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvVec([
            xdr.ScVal.scvSymbol("External"),
            Address.fromString(VERIFIER).toScVal(),
            xdr.ScVal.scvBytes(key),
          ]),
          val: xdr.ScVal.scvBytes(signature),
        }),
    );
  const value = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: xdr.ScVal.scvMap(entries) }),
  ]);

  return { name, verifier: VERIFIER, account: ACCOUNT_A, contextRuleIds, signers, xdr: hex(value.toXDR()) };
}

const out = {
  domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION },
  domainType: "EIP712Domain(string name,string version,bytes32 salt)",
  authorizationType: "Authorization(string account,bytes32 payload)",
  vectors,
  authPayloads: [
    authPayload("one_signer", ["testnet"], [0]),
    // Listed out of order: the address of the second signer sorts first.
    authPayload("two_signers", ["testnet", "second_signer"], [0]),
  ],
};

const target = fileURLToPath(new URL("./vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${vectors.length} vectors written to ${target}`);
