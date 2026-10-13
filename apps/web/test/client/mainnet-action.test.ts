import { networkId, NETWORKS, prepare, twinAddress, type Prepared, type PrepareOptions, type RelayResult, type Signed } from "paso-sdk";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { createActionController, type ActionDeps } from "@/lib/client/action/controller";
import { panelsOf, type ActionRequest } from "@/lib/client/action/machine";
import { contractName } from "@/lib/client/config";
import { owner, RECIPIENT, recordingServer, scripted, STELLAR_HASH } from "./helpers";

const mainnet = NETWORKS.mainnet;
const testnet = NETWORKS.testnet;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const transferRequest: ActionRequest = { kind: "transfer", to: RECIPIENT, amount: "5" };

/** Prepares on the network it is asked for, against a scripted Stellar. */
const offlinePrepare: typeof prepare = (action, options: PrepareOptions) => {
  const config = typeof options.network === "string" ? NETWORKS[options.network] : options.network;
  return prepare(action, { ...options, server: recordingServer(owner.address, config) });
};

function harness(overrides: Partial<ActionDeps> = {}, network = mainnet) {
  const relay = scripted<RelayResult>([{ hash: STELLAR_HASH }]);
  const controller = createActionController(owner.address, {
    network,
    relayUrl: "/api/relay",
    resolveName: async () => null,
    prepare: offlinePrepare,
    relay: relay as unknown as ActionDeps["relay"],
    ...overrides,
  });
  const signTypedData = vi.fn(owner.signTypedData);
  return { controller, relay, signer: { signTypedData } };
}

describe("the outbound flow on mainnet", () => {
  it("prepares for mainnet: its account, its USDC, its network id in what the wallet signs", async () => {
    const { controller, relay, signer } = harness();

    await controller.prepare(transferRequest);
    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", network: "mainnet" });
    if (review.phase !== "review") return;
    const account = twinAddress(owner.address, mainnet);
    expect(review.message.account).toBe(account);
    expect(review.calls).toEqual([{ contract: mainnet.stellar.usdc, fn: "transfer", args: [account, RECIPIENT, "50000000"] }]);
    expect(review.prepared.typedData.domain.salt).toBe(networkId(mainnet));
    expect(review.prepared.typedData.domain.salt).not.toBe(networkId(testnet));
    expect(panelsOf(review, (address) => contractName(address, mainnet)).wallet[2]).toMatchObject({ label: "contract", name: "USDC" });

    await controller.sign(signer);
    expect(controller.getState()).toMatchObject({ phase: "done", network: "mainnet", hash: STELLAR_HASH });
    expect((relay.calls[0]?.[0] as Signed).network).toBe("mainnet");
  });

  it("pays the mainnet account of an Ethereum address, which is not its testnet account", async () => {
    const { controller } = harness();

    await controller.prepare({ kind: "transfer", to: OTHER, amount: "1" });

    const review = controller.getState();
    expect(review).toMatchObject({ phase: "review", recipient: { kind: "evm", evm: OTHER, stellar: twinAddress(OTHER, mainnet) } });
    expect(twinAddress(OTHER, mainnet)).not.toBe(twinAddress(OTHER, testnet));
  });
});

describe("a call prepared for another network than the page is on", () => {
  const wrongNetwork = {
    phase: "failed",
    stage: "prepare",
    error: { code: "wrong_network", retryable: false, message: expect.stringMatching(/prepared for testnet.*page is on mainnet.*Nothing was signed/) },
  };

  it("is never put in front of the wallet: it says so and stops", async () => {
    const forTestnet: typeof prepare = (action, options) => offlinePrepare(action, { ...options, network: testnet });
    const { controller, signer, relay } = harness({ prepare: forTestnet });

    await controller.prepare(transferRequest);

    expect(controller.getState()).toMatchObject(wrongNetwork);
    await controller.sign(signer);
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(relay.calls).toHaveLength(0);
  });

  it("is recognised by the network id in the message itself, whatever the request calls itself", async () => {
    const mislabelled: typeof prepare = async (action, options) => {
      const prepared = await offlinePrepare(action, { ...options, network: testnet });
      return { ...prepared, network: "mainnet" } satisfies Prepared;
    };
    const { controller } = harness({ prepare: mislabelled });

    await controller.prepare(transferRequest);

    expect(controller.getState()).toMatchObject({ phase: "failed", stage: "prepare", error: { code: "wrong_network" } });
  });

  it("is refused the same way on testnet, for a call that is mainnet's", async () => {
    const forMainnet: typeof prepare = (action, options) => offlinePrepare(action, { ...options, network: mainnet });
    const { controller } = harness({ prepare: forMainnet }, testnet);

    await controller.prepare(transferRequest);

    expect(controller.getState()).toMatchObject({
      phase: "failed",
      error: { code: "wrong_network", message: expect.stringMatching(/prepared for mainnet.*page is on testnet/) },
    });
  });
});

describe("the demonstration that alters a call after signing", () => {
  it("does not exist on mainnet: nothing is signed and nothing is sent", async () => {
    const { controller, signer, relay } = harness();
    await controller.prepare(transferRequest);

    await controller.sign(signer, { tamper: true });
    await controller.sign(signer, { tamper: { index: 2, value: nativeToScVal(1n, { type: "i128" }) } });

    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(relay.calls).toHaveLength(0);
    expect(controller.getState()).toMatchObject({ phase: "review" });

    // The honest call still goes through.
    await controller.sign(signer);
    expect(controller.getState()).toMatchObject({ phase: "done", tampered: false });
  });

  it("is still there on testnet", async () => {
    const { controller, signer, relay } = harness({}, testnet);
    await controller.prepare(transferRequest);

    await controller.sign(signer, { tamper: true });

    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(relay.calls).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ tampered: true });
  });
});
