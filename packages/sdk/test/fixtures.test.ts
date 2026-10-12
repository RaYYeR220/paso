import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Address, xdr } from "@stellar/stellar-sdk";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { attachSignature, entrySignature, recoverEntrySigner, signEntry } from "../src/auth";
import { networkId, NETWORKS, type NetworkConfig } from "../src/networks";
import { renderArg, renderCalls } from "../src/render";
import { digest, typedData } from "../src/typedData";

interface Vector {
  name: string;
  /** Present when a vector is signed for a network other than the file's default. */
  networkPassphrase?: string;
  networkId?: string;
  owner: Hex;
  privateKey: Hex;
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

    describe.each(["sorobanCredentialsAddress", "sorobanCredentialsAddressV2"] as const)("as an entry with %s", (kind) => {
      const VALID_UNTIL = 5_000_120;
      const other = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

      /** The vector's calls as an authorisation entry of the vector's account: the first call at the root, the rest under it. */
      function entryOf(calls: Vector["calls"]): xdr.SorobanAuthorizationEntry {
        const invocation = (call: Vector["calls"][number], subInvocations: xdr.SorobanAuthorizedInvocation[]) =>
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: new Address(call.contract).toScAddress(),
                functionName: call.fn,
                args: call.argsXdr.map((encoded) => xdr.ScVal.fromXdr(encoded, "base64")),
              }),
            ),
            subInvocations,
          });
        const [root, ...nested] = calls;
        const credentials = new xdr.SorobanAddressCredentials({
          address: new Address(vector.account).toScAddress(),
          nonce: 77n,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        });
        return new xdr.SorobanAuthorizationEntry({
          credentials:
            kind === "sorobanCredentialsAddress"
              ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
              : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
          rootInvocation: invocation(root!, nested.map((call) => invocation(call, []))),
        });
      }
      const signedEntry = () => signEntry(privateKeyToAccount(vector.privateKey), entryOf(vector.calls), VALID_UNTIL, network);

      it("shows the vector's calls, and its signer is recovered as the owner", async () => {
        const signed = await signedEntry();

        expect(renderCalls(signed)).toEqual(input.calls);
        expect(await recoverEntrySigner(signed, network)).toBe(getAddress(vector.owner));
      });

      it("does not recover the owner once anything the signature covers is changed", async () => {
        const signed = await signedEntry();
        const signature = entrySignature(signed)!;
        const owner = getAddress(vector.owner);

        // Another call tree under the same signature.
        const extra = { ...vector.calls[0]!, fn: "another" };
        const changed = attachSignature(
          new xdr.SorobanAuthorizationEntry({ credentials: signed.credentials, rootInvocation: entryOf([...vector.calls, extra]).rootInvocation }),
          signature,
        );
        expect(await recoverEntrySigner(changed, network)).not.toBe(owner);

        // Another network.
        expect(await recoverEntrySigner(signed, withPassphrase("Some Other Network ; 2026"))).not.toBe(owner);

        // Another key.
        const theirs = await signEntry(privateKeyToAccount(other), entryOf(vector.calls), VALID_UNTIL, network);
        expect(await recoverEntrySigner(theirs, network)).not.toBe(owner);
      });

      it("has no signer before it is signed", async () => {
        await expect(recoverEntrySigner(entryOf(vector.calls), network)).rejects.toThrow(/not signed/);
      });
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
