import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { NETWORKS, type NetworkConfig } from "../src/networks";

export const HUB = StrKey.encodeContract(new Uint8Array(32).fill(0x11));

/** Testnet with a hub id filled in, so derivation can be exercised without a deployment. */
export const testNetwork: NetworkConfig = {
  ...NETWORKS.testnet,
  stellar: { ...NETWORKS.testnet.stellar, hub: HUB },
};

export const USDC = NETWORKS.testnet.stellar.usdc;
export const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** First account of the well-known `test test … junk` mnemonic. */
export const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "hex"));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

export function u32(value: number): Uint8Array {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return new Uint8Array(out);
}

export function i64(value: bigint): Uint8Array {
  const out = Buffer.alloc(8);
  out.writeBigInt64BE(value);
  return new Uint8Array(out);
}
