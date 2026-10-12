import { StrKey } from "@stellar/stellar-sdk";
import { stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../src/networks";
import { twinAddress, twinContractId } from "../src/twin";
import { concat, fromHex, hex, HUB, OWNER, sha256, testNetwork, u32 } from "./helpers";

/** The contract-id preimage, field by field, as the ledger hashes it. */
function expectedTwin(owner: string, hub: string, passphrase: string): string {
  const salt = concat(new Uint8Array(12), fromHex(owner.slice(2)));
  const preimage = concat(
    u32(8), // ENVELOPE_TYPE_CONTRACT_ID
    sha256(stringToBytes(passphrase)),
    u32(0), // CONTRACT_ID_PREIMAGE_FROM_ADDRESS
    u32(1), // SC_ADDRESS_TYPE_CONTRACT
    StrKey.decodeContract(hub),
    salt,
  );
  return StrKey.encodeContract(sha256(preimage));
}

describe("twinAddress", () => {
  it("is the contract id the hub deploys for that owner", () => {
    const twin = twinAddress(OWNER, testNetwork);
    expect(twin).toBe(expectedTwin(OWNER, HUB, "Test SDF Network ; September 2015"));
    expect(StrKey.isValidContract(twin)).toBe(true);
  });

  it("ignores the letter case of the owner", () => {
    const lower = OWNER.toLowerCase() as `0x${string}`;
    expect(twinAddress(lower, testNetwork)).toBe(twinAddress(OWNER, testNetwork));
  });

  it("differs per owner, per hub and per network", () => {
    const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const otherHub = { ...testNetwork, stellar: { ...testNetwork.stellar, hub: NETWORKS.testnet.stellar.usdc } };
    const otherNetwork = {
      ...testNetwork,
      stellar: { ...testNetwork.stellar, networkPassphrase: "Public Global Stellar Network ; September 2015" },
    };
    const twins = new Set([
      twinAddress(OWNER, testNetwork),
      twinAddress(other, testNetwork),
      twinAddress(OWNER, otherHub),
      twinAddress(OWNER, otherNetwork),
    ]);
    expect(twins.size).toBe(4);
  });

  it("exposes the same id as 32 bytes of hex", () => {
    const twin = twinAddress(OWNER, testNetwork);
    expect(twinContractId(OWNER, testNetwork)).toBe(`0x${hex(StrKey.decodeContract(twin))}`);
  });

  it("rejects anything that is not a 20-byte address", () => {
    expect(() => twinAddress("0x1234" as `0x${string}`, testNetwork)).toThrow(/not an Ethereum address/);
    expect(() => twinAddress("vitalik.eth" as `0x${string}`, testNetwork)).toThrow(/not an Ethereum address/);
  });

  it("says so when the hub is not deployed on the network", () => {
    const undeployed = { ...testNetwork, stellar: { ...testNetwork.stellar, hub: "" } };
    expect(() => twinAddress(OWNER, undeployed)).toThrow(/no hub.*testnet/i);
  });
});
