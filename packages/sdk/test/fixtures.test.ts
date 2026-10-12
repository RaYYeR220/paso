import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { xdr } from "@stellar/stellar-sdk";
import { recoverTypedDataAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { networkId, NETWORKS, type NetworkConfig } from "../src/networks";
import { renderArg } from "../src/render";
import { digest, typedData } from "../src/typedData";

interface Vector {
  name: string;
  /** Present when a vector is signed for a network other than the file's default. */
  networkPassphrase?: string;
  networkId?: string;
  owner: Hex;
  account: string;
  payload: Hex;
  calls: { contract: string; fn: string; argsXdr: string[]; argsText: string[] }[];
  digest: Hex;
  signature: Hex;
}

interface Fixture {
  networkPassphrase: string;
  networkId: string;
  vectors: Vector[];
}

const path = fileURLToPath(new URL("../../../fixtures/vectors.json", import.meta.url));
const fixture: Fixture | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;

const prefixed = (value: string): Hex => (value.startsWith("0x") ? value : `0x${value}`) as Hex;

function withPassphrase(networkPassphrase: string): NetworkConfig {
  return { ...NETWORKS.testnet, stellar: { ...NETWORKS.testnet.stellar, networkPassphrase } };
}

describe.skipIf(!fixture)("shared vectors", () => {
  const { networkPassphrase, vectors } = fixture ?? { networkPassphrase: "", vectors: [] };

  it("has vectors and a network id that matches its passphrase", () => {
    expect(vectors.length).toBeGreaterThan(0);
    expect(networkId(withPassphrase(networkPassphrase))).toBe(prefixed(fixture!.networkId).toLowerCase());
  });

  describe.each(vectors)("$name", (vector) => {
    const network = withPassphrase(vector.networkPassphrase ?? networkPassphrase);
    const input = {
      account: vector.account,
      calls: vector.calls.map(({ contract, fn, argsText }) => ({ contract, fn, args: argsText })),
      payload: prefixed(vector.payload),
      network,
    };

    it("renders every argument to the expected text", () => {
      for (const call of vector.calls) {
        expect(call.argsXdr).toHaveLength(call.argsText.length);
        call.argsXdr.forEach((encoded, i) => {
          expect(renderArg(xdr.ScVal.fromXdr(encoded, "base64")), `${call.fn} argument ${i}`).toBe(call.argsText[i]);
        });
      }
    });

    it("hashes to the expected digest", () => {
      if (vector.networkId) {
        expect(networkId(network)).toBe(prefixed(vector.networkId).toLowerCase());
      }
      expect(digest(input)).toBe(prefixed(vector.digest).toLowerCase());
    });

    it("carries a signature from the owner", async () => {
      const signer = await recoverTypedDataAddress({ ...typedData(input), signature: prefixed(vector.signature) });
      expect(signer.toLowerCase()).toBe(vector.owner.toLowerCase());
    });
  });
});
