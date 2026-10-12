import { concat, keccak256, recoverTypedDataAddress, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { networkId, NETWORKS } from "../src/networks";
import type { Call } from "../src/render";
import { digest, typedData } from "../src/typedData";
import { OWNER, OWNER_KEY, sha256, USDC } from "./helpers";

const text = (value: string): Hex => keccak256(stringToBytes(value));

const DOMAIN_TYPE = "EIP712Domain(string name,string version,bytes32 salt)";
const CALL_TYPE = "Call(string contract,string fn,string[] args)";
const AUTHORIZATION_TYPE = `Authorization(string account,Call[] calls,bytes32 payload)${CALL_TYPE}`;

function hashCall(call: Call): Hex {
  const args = call.args.length === 0 ? "0x" : concat(call.args.map(text));
  return keccak256(concat([text(CALL_TYPE), text(call.contract), text(call.fn), keccak256(args)]));
}

/** EIP-712 by hand: every field here is one 32-byte word, so encoding is plain concatenation. */
function handRolledDigest(account: string, calls: Call[], payload: Hex, salt: Hex): Hex {
  const domainSeparator = keccak256(concat([text(DOMAIN_TYPE), text("Paso"), text("1"), salt]));
  const callsHash = keccak256(calls.length === 0 ? "0x" : concat(calls.map(hashCall)));
  const structHash = keccak256(concat([text(AUTHORIZATION_TYPE), text(account), callsHash, payload]));
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

const account = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
const payload = `0x${"5a".repeat(32)}` as Hex;
const calls: Call[] = [
  { contract: USDC, fn: "exit", args: [account, "5000000", "6", `0x${"00".repeat(12)}${"ab".repeat(20)}`, "0", "1000"] },
  { contract: USDC, fn: "transfer", args: [account, USDC, "5000000"] },
  { contract: USDC, fn: "ping", args: [] },
];

describe("typedData", () => {
  it("uses the Paso domain salted with the network id and no chain id", () => {
    const data = typedData({ account, calls, payload, network: "testnet" });
    const salt = toHex(sha256(stringToBytes("Test SDF Network ; September 2015")));

    expect(networkId("testnet")).toBe(salt);
    expect(data.domain).toEqual({ name: "Paso", version: "1", salt });
    expect(data.primaryType).toBe("Authorization");
    expect(data.types).toEqual({
      Authorization: [
        { name: "account", type: "string" },
        { name: "calls", type: "Call[]" },
        { name: "payload", type: "bytes32" },
      ],
      Call: [
        { name: "contract", type: "string" },
        { name: "fn", type: "string" },
        { name: "args", type: "string[]" },
      ],
    });
    expect(data.message).toEqual({ account, calls, payload });
  });

  it("hashes to the digest computed by hand", () => {
    const salt = networkId("testnet");
    expect(digest({ account, calls, payload, network: "testnet" })).toBe(
      handRolledDigest(account, calls, payload, salt),
    );
    expect(digest({ account, calls: [], payload, network: "testnet" })).toBe(
      handRolledDigest(account, [], payload, salt),
    );
  });

  it("changes with the account, the calls, the payload and the network", () => {
    const base = { account, calls, payload, network: "testnet" } as const;
    const tampered = calls.map((call, i) => (i === 1 ? { ...call, args: [account, USDC, "5000001"] } : call));
    const digests = new Set([
      digest(base),
      digest({ ...base, account: USDC }),
      digest({ ...base, calls: tampered }),
      digest({ ...base, calls: calls.slice(0, 2) }),
      digest({ ...base, payload: `0x${"5b".repeat(32)}` }),
      digest({ ...base, network: "mainnet" }),
    ]);
    expect(digests.size).toBe(6);
  });

  it("accepts a network given as a config with its own passphrase", () => {
    const custom = { ...NETWORKS.testnet, stellar: { ...NETWORKS.testnet.stellar, networkPassphrase: "Standalone Network ; February 2017" } };
    const salt = toHex(sha256(stringToBytes("Standalone Network ; February 2017")));
    expect(digest({ account, calls, payload, network: custom })).toBe(handRolledDigest(account, calls, payload, salt));
  });

  it("is signed by a wallet and recovers to the signer", async () => {
    const signer = privateKeyToAccount(OWNER_KEY);
    const data = typedData({ account, calls, payload, network: "testnet" });
    const signature = await signer.signTypedData(data);

    expect(signer.address).toBe(OWNER);
    expect(await recoverTypedDataAddress({ ...data, signature })).toBe(OWNER);
  });
});
