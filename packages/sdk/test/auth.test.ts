import { Address, xdr } from "@stellar/stellar-sdk";
import { recoverTypedDataAddress, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  accountEntryIndex,
  attachSignature,
  authPayload,
  entryTypedData,
  setExpiration,
  signEntry,
} from "../src/auth";
import { renderCalls } from "../src/render";
import { digest } from "../src/typedData";
import { concat, hex, i64, ISSUER, OWNER, OWNER_KEY, sha256, testNetwork, u32, USDC } from "./helpers";

const ACCOUNT = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
const NONCE = 3960317771751520764n;
const VALID_UNTIL = 5_159_507;
const PASSPHRASE = "Test SDF Network ; September 2015";

type CredentialsKind = "sorobanCredentialsAddress" | "sorobanCredentialsAddressV2";

function transferInvocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(USDC).toScAddress(),
        functionName: "transfer",
        args: [
          new Address(ACCOUNT).toScVal(),
          new Address(ISSUER).toScVal(),
          xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 1_000_000n })),
        ],
      }),
    ),
    subInvocations: [],
  });
}

function unsignedEntry(kind: CredentialsKind, address = ACCOUNT): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(address).toScAddress(),
    nonce: NONCE,
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      kind === "sorobanCredentialsAddress"
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: transferInvocation(),
  });
}

function sourceAccountEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: transferInvocation(),
  });
}

function credentialsOf(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const { credentials } = entry;
  if (credentials.type === "sorobanCredentialsAddress") return credentials.address;
  if (credentials.type === "sorobanCredentialsAddressV2") return credentials.addressV2;
  throw new Error(`unexpected credentials ${credentials.type}`);
}

const networkIdBytes = sha256(stringToBytes(PASSPHRASE));
const invocationXdr = transferInvocation().toXdr();
const accountXdr = new Address(ACCOUNT).toScAddress().toXdr();

describe("authPayload", () => {
  it("hashes the original authorisation preimage for address credentials", () => {
    const preimage = concat(
      u32(9), // ENVELOPE_TYPE_SOROBAN_AUTHORIZATION
      networkIdBytes,
      i64(NONCE),
      u32(VALID_UNTIL),
      invocationXdr,
    );
    expect(authPayload(unsignedEntry("sorobanCredentialsAddress"), VALID_UNTIL, "testnet")).toBe(
      `0x${hex(sha256(preimage))}`,
    );
  });

  it("hashes the address-bound preimage for v2 address credentials", () => {
    const preimage = concat(
      u32(10), // ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS
      networkIdBytes,
      i64(NONCE),
      u32(VALID_UNTIL),
      accountXdr,
      invocationXdr,
    );
    expect(authPayload(unsignedEntry("sorobanCredentialsAddressV2"), VALID_UNTIL, "testnet")).toBe(
      `0x${hex(sha256(preimage))}`,
    );
  });

  it("depends on the expiration ledger and the network", () => {
    const entry = unsignedEntry("sorobanCredentialsAddressV2");
    const base = authPayload(entry, VALID_UNTIL, "testnet");
    expect(authPayload(entry, VALID_UNTIL + 1, "testnet")).not.toBe(base);
    expect(authPayload(entry, VALID_UNTIL, "mainnet")).not.toBe(base);
  });

  it("refuses credentials that carry no address", () => {
    expect(() => authPayload(sourceAccountEntry(), VALID_UNTIL, "testnet")).toThrow(/address credentials/);
  });
});

describe.each<CredentialsKind>(["sorobanCredentialsAddress", "sorobanCredentialsAddressV2"])(
  "signing %s",
  (kind) => {
    it("sets the expiration ledger and nothing else", () => {
      const entry = unsignedEntry(kind);
      const updated = setExpiration(entry, VALID_UNTIL);

      expect(updated.credentials.type).toBe(kind);
      expect(credentialsOf(updated).signatureExpirationLedger).toBe(VALID_UNTIL);
      expect(credentialsOf(updated).nonce).toBe(NONCE);
      expect(credentialsOf(updated).signature.type).toBe("scvVoid");
      expect(hex(updated.rootInvocation.toXdr())).toBe(hex(invocationXdr));
      expect(credentialsOf(entry).signatureExpirationLedger).toBe(0);
    });

    it("attaches the signature as 65 bytes", () => {
      const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
      const signed = attachSignature(setExpiration(unsignedEntry(kind), VALID_UNTIL), signature);
      const value = credentialsOf(signed).signature;

      expect(signed.credentials.type).toBe(kind);
      expect(hex(value.toXdr())).toBe(`0000000d00000041${"11".repeat(32)}${"22".repeat(32)}1b000000`);
      expect(credentialsOf(signed).signatureExpirationLedger).toBe(VALID_UNTIL);
      expect(credentialsOf(signed).nonce).toBe(NONCE);
    });

    it("produces typed data whose payload matches the entry", () => {
      const entry = setExpiration(unsignedEntry(kind), VALID_UNTIL);
      const data = entryTypedData(entry, testNetwork);

      expect(data.message.account).toBe(ACCOUNT);
      expect(data.message.calls).toEqual(renderCalls(entry));
      expect(data.message.payload).toBe(authPayload(entry, VALID_UNTIL, testNetwork));
    });

    it("signs with a wallet and recovers to the owner", async () => {
      const signer = privateKeyToAccount(OWNER_KEY);
      const signed = await signEntry(signer, unsignedEntry(kind), VALID_UNTIL, testNetwork);
      const credentials = credentialsOf(signed);

      expect(credentials.signatureExpirationLedger).toBe(VALID_UNTIL);
      if (credentials.signature.type !== "scvBytes") throw new Error("signature is not bytes");
      const signature = `0x${hex(credentials.signature.bytes.toBytes())}` as Hex;
      expect(signature.length).toBe(2 + 130);

      const data = entryTypedData(signed, testNetwork);
      expect(await recoverTypedDataAddress({ ...data, signature })).toBe(OWNER);
      expect(digest({ ...data.message, network: testNetwork })).toMatch(/^0x[0-9a-f]{64}$/);
    });
  },
);

describe("attachSignature", () => {
  const entry = setExpiration(unsignedEntry("sorobanCredentialsAddressV2"), VALID_UNTIL);

  it("refuses a signature that is not 65 bytes", () => {
    expect(() => attachSignature(entry, `0x${"11".repeat(64)}`)).toThrow(/65 bytes/);
    expect(() => attachSignature(entry, `0x${"11".repeat(96)}`)).toThrow(/65 bytes/);
  });

  it("refuses a high-s signature", () => {
    const highS = `0x${"11".repeat(32)}${"ff".repeat(32)}1b` as Hex;
    expect(() => attachSignature(entry, highS)).toThrow(/low-s/);
  });

  it("refuses a recovery byte the account does not accept", () => {
    const badV = `0x${"11".repeat(32)}${"22".repeat(32)}02` as Hex;
    expect(() => attachSignature(entry, badV)).toThrow(/recovery/);
    for (const v of ["00", "01", "1b", "1c"]) {
      expect(() => attachSignature(entry, `0x${"11".repeat(32)}${"22".repeat(32)}${v}` as Hex)).not.toThrow();
    }
  });

  it("refuses an entry with no expiration set", () => {
    const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
    expect(() => attachSignature(unsignedEntry("sorobanCredentialsAddress"), signature)).toThrow(/expiration/);
  });
});

describe("accountEntryIndex", () => {
  it("finds the entry that carries the account's address credentials", () => {
    const entries = [
      sourceAccountEntry(),
      unsignedEntry("sorobanCredentialsAddressV2", ISSUER),
      unsignedEntry("sorobanCredentialsAddress"),
    ];
    expect(accountEntryIndex(entries, ACCOUNT)).toBe(2);
  });

  it("fails when the account has nothing to authorise", () => {
    expect(() => accountEntryIndex([sourceAccountEntry()], ACCOUNT)).toThrow(/does not need.*authoris/i);
  });

  it("fails when the account would have to sign more than once", () => {
    const entries = [unsignedEntry("sorobanCredentialsAddress"), unsignedEntry("sorobanCredentialsAddressV2")];
    expect(() => accountEntryIndex(entries, ACCOUNT)).toThrow(/2 separate authorisations/);
  });
});
