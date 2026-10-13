import { hashTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { describeError } from "@/lib/client/errors";
import { isKeyProven, keyProofStorageKey, keyProofTypedData, markKeyProven, proveKey } from "@/lib/client/keyProof";
import { memoryStorage } from "@/lib/client/storage";
import { NETWORKS, typedData as authorization } from "@paso/sdk";
import { owner } from "./helpers";

describe("showing that a wallet signs with a key", () => {
  it("asks for one message that moves nothing, and passes when the signature is the wallet's own", async () => {
    const sign = vi.fn((data: ReturnType<typeof keyProofTypedData>) => owner.signTypedData(data));

    await expect(proveKey(owner.address, sign)).resolves.toBeUndefined();

    expect(sign).toHaveBeenCalledTimes(1);
    const asked = sign.mock.calls[0]![0];
    expect(asked.primaryType).toBe("KeyCheck");
    expect(asked.domain).toEqual({ name: "Paso key check", version: "1" });
    expect(asked.message.wallet).toBe(owner.address);
    expect(asked.message.statement).toMatch(/moves nothing/);
  });

  it("can never be mistaken for an authorisation: another domain, another type, another digest", () => {
    const proof = keyProofTypedData(owner.address);
    const real = authorization({ account: "C", calls: [], payload: `0x${"00".repeat(32)}`, network: NETWORKS.mainnet });

    expect(proof.domain.name).not.toBe(real.domain.name);
    expect(Object.keys(proof.types)).toEqual(["KeyCheck"]);
    expect(hashTypedData(proof)).not.toBe(hashTypedData(real));
  });

  it("fails for a signature made by another key", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const refusal = await proveKey(owner.address, (data) => other.signTypedData(data)).catch((error: unknown) => error);

    expect(describeError(refusal)).toMatchObject({ kind: "error", code: "wrong_signer" });
  });

  it("fails for what a smart-contract wallet returns: not 65 bytes of signature", async () => {
    const long: Hex = `0x${"ab".repeat(320)}`;
    const refusal = await proveKey(owner.address, async () => long).catch((error: unknown) => error);

    expect(describeError(refusal)).toMatchObject({
      kind: "error",
      code: "smart_wallet",
      message: expect.stringMatching(/signs as a smart contract/),
      retryable: false,
    });
  });

  it("passes a refusal in the wallet on as a refusal", async () => {
    const declined = Object.assign(new Error("User rejected the request."), { code: 4001 });
    const refusal = await proveKey(owner.address, async () => Promise.reject(declined)).catch((error: unknown) => error);

    expect(describeError(refusal)).toEqual({ kind: "rejected" });
  });
});

describe("what the browser remembers of it", () => {
  it("is kept per network and per address", () => {
    const storage = memoryStorage();
    expect(isKeyProven(storage, "mainnet", owner.address)).toBe(false);

    markKeyProven(storage, "mainnet", owner.address);

    expect(isKeyProven(storage, "mainnet", owner.address)).toBe(true);
    expect(isKeyProven(storage, "mainnet", owner.address.toLowerCase() as typeof owner.address)).toBe(true);
    expect(isKeyProven(storage, "testnet", owner.address)).toBe(false);
    expect(isKeyProven(storage, "mainnet", `0x${"11".repeat(20)}`)).toBe(false);
    expect(keyProofStorageKey("mainnet", owner.address)).toBe(`paso.keyproof.mainnet.${owner.address.toLowerCase()}`);
    expect(isKeyProven(null, "mainnet", owner.address)).toBe(false);
  });
});
