import { createConfig, http } from "wagmi";
import { getAccount } from "wagmi/actions";
import { baseSepolia } from "wagmi/chains";
import { mock } from "wagmi/connectors";
import { describe, expect, it } from "vitest";
import { connectWallet, signerState } from "@/lib/client/signer";
import { owner } from "./helpers";

type MockFeatures = NonNullable<Parameters<typeof mock>[0]["features"]>;

function configWith(features: MockFeatures = {}) {
  return createConfig({
    chains: [baseSepolia],
    connectors: [mock({ accounts: [owner.address], features })],
    transports: { [baseSepolia.id]: http() },
  });
}

/** Every value `connectingId` takes while `run` is under way. */
async function watching(run: () => Promise<unknown>): Promise<(string | null)[]> {
  const seen: (string | null)[] = [];
  let last = signerState.get().connectingId;
  const stop = signerState.subscribe(() => {
    const { connectingId } = signerState.get();
    if (connectingId !== last) seen.push(connectingId);
    last = connectingId;
  });
  try {
    await run();
  } finally {
    stop();
  }
  return seen;
}

describe("connecting a wallet", () => {
  it("names the wallet being opened while it is pending, and clears it once connected", async () => {
    const config = configWith();
    expect(signerState.get().connectingId).toBeNull();
    const seen = await watching(() => connectWallet(config, "mock"));
    expect(seen).toEqual(["mock", null]);
    expect(getAccount(config)).toMatchObject({ status: "connected", address: owner.address });
    expect(signerState.get()).toMatchObject({ chosen: "wallet", connectingId: null, error: null });
  });

  it("opens one wallet for two clicks", async () => {
    const config = configWith();
    const seen = await watching(() => Promise.all([connectWallet(config, "mock"), connectWallet(config, "mock")]));
    expect(seen).toEqual(["mock", null]);
  });

  it("clears the pending wallet and reports nothing when the owner declines", async () => {
    const config = configWith({ connectError: Object.assign(new Error("User rejected the request."), { code: 4001 }) });
    const seen = await watching(() => connectWallet(config, "mock"));
    expect(seen).toEqual(["mock", null]);
    expect(getAccount(config).status).toBe("disconnected");
    expect(signerState.get()).toMatchObject({ connectingId: null, error: null });
  });

  it("clears the pending wallet and says why when the wallet fails", async () => {
    const config = configWith({ connectError: new Error("The wallet is locked") });
    await connectWallet(config, "mock");
    expect(signerState.get()).toMatchObject({ connectingId: null, error: "The wallet is locked" });
  });

  it("does not open some other wallet when the one asked for is not there", async () => {
    const config = configWith();
    const seen = await watching(() => connectWallet(config, "io.not.installed"));
    expect(seen).toEqual([]);
    expect(getAccount(config).status).toBe("disconnected");
    expect(signerState.get().error).toMatch(/No wallet is available/);
  });
});
