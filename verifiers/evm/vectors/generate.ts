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

import { xdr } from "@stellar/stellar-sdk";
import { hashDomain, hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const passphrases = { testnet: TESTNET, mainnet: MAINNET };

const domainTypes = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const types = {
  Authorization: [{ name: "payload", type: "bytes32" }],
} as const;

const KEY_A: Hex = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SIGNER_A = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c";
const KEY_B: Hex = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const SIGNER_B = "0x6A9296CEb89D12e1F53b2Dd5Df45d3ADB3A814c2";

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();
const hex = (data: Uint8Array): Hex => `0x${Buffer.from(data).toString("hex")}`;

/** A stand-in for the 32 bytes an account would ask the verifier to check. */
const labelled = (label: string): Hex => hex(sha256(`paso verifier vector: ${label}`));

/**
 * The 32 bytes an OpenZeppelin smart account (stellar-accounts 0.7.2) hands
 * to a verifier: sha256 of the Soroban authorisation payload followed by the
 * XDR of the context rule ids selected for the entry.
 */
function openZeppelinAuthDigest(signaturePayload: Hex, contextRuleIds: number[]): Hex {
  const ruleIds = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
  return hex(sha256(Buffer.concat([Buffer.from(signaturePayload.slice(2), "hex"), ruleIds])));
}

interface Case {
  name: string;
  network: "testnet" | "mainnet";
  privateKey: Hex;
  signer: string;
  payload: Hex;
  /** Set when `payload` is derived the way an OpenZeppelin smart account derives it. */
  openZeppelin?: { signaturePayload: Hex; contextRuleIds: number[] };
}

const ozSignaturePayload = labelled("soroban authorisation payload");
const ozRuleIds = [0];
const ozTwoRulesPayload = labelled("soroban authorisation payload with two contexts");
const ozTwoRuleIds = [3, 0];

const cases: Case[] = [
  { name: "testnet", network: "testnet", privateKey: KEY_A, signer: SIGNER_A, payload: labelled("first") },
  { name: "another_payload", network: "testnet", privateKey: KEY_A, signer: SIGNER_A, payload: labelled("second") },
  { name: "second_signer", network: "testnet", privateKey: KEY_B, signer: SIGNER_B, payload: labelled("first") },
  { name: "mainnet", network: "mainnet", privateKey: KEY_A, signer: SIGNER_A, payload: labelled("first") },
  { name: "zero_payload", network: "testnet", privateKey: KEY_A, signer: SIGNER_A, payload: `0x${"00".repeat(32)}` },
  { name: "max_payload", network: "testnet", privateKey: KEY_B, signer: SIGNER_B, payload: `0x${"ff".repeat(32)}` },
  {
    name: "openzeppelin_auth_digest",
    network: "testnet",
    privateKey: KEY_A,
    signer: SIGNER_A,
    payload: openZeppelinAuthDigest(ozSignaturePayload, ozRuleIds),
    openZeppelin: { signaturePayload: ozSignaturePayload, contextRuleIds: ozRuleIds },
  },
  {
    name: "openzeppelin_auth_digest_two_rules",
    network: "testnet",
    privateKey: KEY_B,
    signer: SIGNER_B,
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
  const domain = { name: "Paso verifier", version: "1", salt: networkId } as const;
  const typedData = {
    domain,
    types,
    primaryType: "Authorization",
    message: { payload: c.payload },
  } as const;

  return {
    name: c.name,
    network: c.network,
    networkPassphrase,
    networkId,
    signer: c.signer,
    privateKey: c.privateKey,
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

const out = {
  domain: { name: "Paso verifier", version: "1" },
  domainType: "EIP712Domain(string name,string version,bytes32 salt)",
  authorizationType: "Authorization(bytes32 payload)",
  vectors,
};

const target = fileURLToPath(new URL("./vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${vectors.length} vectors written to ${target}`);
