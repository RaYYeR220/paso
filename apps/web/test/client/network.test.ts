import { NETWORKS, twinAddress } from "@paso/sdk";
import { describe, expect, it } from "vitest";
import { activityLogKey } from "@/lib/client/activity/log";
import { DEMO_KEY_STORAGE, ensureDemoKey, loadDemoKey } from "@/lib/client/demoKey";
import { exitStorageKey } from "@/lib/client/exit";
import { fundingStorageKey } from "@/lib/client/funding/controller";
import {
  createChoiceStore,
  networkHref,
  parseNetworkName,
  resolveChoice,
  withNetworkParam,
} from "@/lib/client/network";
import { chosenSignerKey } from "@/lib/client/signer";
import { deliverCommand } from "@/components/app/site";
import { memoryStorage, migrateStorage } from "@/lib/client/storage";
import { owner } from "./helpers";

describe("which network the page is on", () => {
  const nothing = { param: null, remembered: null, acknowledged: false, demo: false };

  it("is testnet when nothing says otherwise", () => {
    expect(resolveChoice(nothing)).toEqual({ network: "testnet", confirming: false });
    expect(resolveChoice({ ...nothing, param: "futurenet" })).toEqual({ network: "testnet", confirming: false });
    expect(resolveChoice({ ...nothing, param: "" })).toEqual({ network: "testnet", confirming: false });
  });

  it("is mainnet only once that was confirmed in this browser", () => {
    expect(resolveChoice({ ...nothing, param: "mainnet" })).toEqual({ network: "testnet", confirming: true });
    expect(resolveChoice({ ...nothing, remembered: "mainnet" })).toEqual({ network: "testnet", confirming: true });
    expect(resolveChoice({ ...nothing, param: "mainnet", acknowledged: true })).toEqual({ network: "mainnet", confirming: false });
    expect(resolveChoice({ ...nothing, remembered: "mainnet", acknowledged: true })).toEqual({ network: "mainnet", confirming: false });
  });

  it("follows the address bar before what the browser remembers", () => {
    expect(resolveChoice({ ...nothing, param: "testnet", remembered: "mainnet", acknowledged: true })).toEqual({
      network: "testnet",
      confirming: false,
    });
    expect(resolveChoice({ ...nothing, param: "mainnet", remembered: "testnet", acknowledged: true }).network).toBe("mainnet");
  });

  it("takes the no-wallet link to mean testnet, whatever the browser remembers", () => {
    expect(resolveChoice({ ...nothing, demo: true, remembered: "mainnet", acknowledged: true })).toEqual({
      network: "testnet",
      confirming: false,
    });
    // Named in so many words next to it, mainnet still wins: the demo itself then has to say no.
    expect(resolveChoice({ ...nothing, demo: true, param: "mainnet", acknowledged: true }).network).toBe("mainnet");
  });

  it("reads a network's name and nothing else", () => {
    expect(parseNetworkName("mainnet")).toBe("mainnet");
    expect(parseNetworkName("testnet")).toBe("testnet");
    for (const other of ["Mainnet", " mainnet", "public", "", null, undefined, 1]) expect(parseNetworkName(other)).toBeNull();
  });
});

describe("the choice a browser remembers", () => {
  it("starts with nothing, and keeps the network and the confirmation apart", () => {
    const storage = memoryStorage();
    const store = createChoiceStore(storage);
    expect(store.get()).toEqual({ remembered: null, acknowledged: false });

    store.remember("mainnet");
    expect(store.get()).toEqual({ remembered: "mainnet", acknowledged: false });
    store.acknowledge();
    expect(store.get()).toEqual({ remembered: "mainnet", acknowledged: true });

    store.remember("testnet");
    expect(createChoiceStore(storage).get()).toEqual({ remembered: "testnet", acknowledged: true });
  });

  it("tells whoever is watching, and works without storage", () => {
    const store = createChoiceStore(null);
    let told = 0;
    const stop = store.subscribe(() => (told += 1));
    store.remember("mainnet");
    store.remember("mainnet");
    stop();
    store.remember("testnet");
    expect(told).toBe(1);
    expect(store.get().remembered).toBe("testnet");
  });

  it("ignores stored text that is not a network", () => {
    const store = createChoiceStore(memoryStorage({ "paso.network": "futurenet", "paso.mainnet.acknowledged": "yes" }));
    expect(store.get()).toEqual({ remembered: null, acknowledged: false });
  });
});

describe("links between the app's pages", () => {
  it("carry mainnet in the address, and say nothing for testnet", () => {
    expect(networkHref("/proof", "testnet")).toBe("/proof");
    expect(networkHref("/proof", "mainnet")).toBe("/proof?network=mainnet");
    expect(networkHref("/app?to=vitalik.eth", "mainnet")).toBe("/app?to=vitalik.eth&network=mainnet");
    expect(networkHref("/proof#mainnet", "mainnet")).toBe("/proof?network=mainnet#mainnet");
  });

  it("change only the network in the address bar", () => {
    expect(withNetworkParam("to=0xabc&demo=1", "mainnet")).toBe("to=0xabc&demo=1&network=mainnet");
    expect(withNetworkParam("network=mainnet&to=0xabc", "testnet")).toBe("to=0xabc");
    expect(withNetworkParam("network=testnet", "mainnet")).toBe("network=mainnet");
    expect(withNetworkParam("", "testnet")).toBe("");
  });
});

describe("what the browser keeps, per network", () => {
  it("never shares a key between networks", () => {
    const twins = { testnet: twinAddress(owner.address, NETWORKS.testnet), mainnet: twinAddress(owner.address, NETWORKS.mainnet) };
    expect(twins.testnet).not.toBe(twins.mainnet);

    const keysOf = (network: "testnet" | "mainnet") => [
      fundingStorageKey(network, owner.address),
      exitStorageKey(network, owner.address),
      activityLogKey(network, twins[network]),
      chosenSignerKey(network),
    ];
    const testnet = keysOf("testnet");
    const mainnet = keysOf("mainnet");
    for (const key of testnet) {
      expect(key).toContain("testnet");
      expect(mainnet).not.toContain(key);
    }
    for (const key of mainnet) expect(key).toContain("mainnet");
  });

  it("moves what was stored before networks had names of their own to testnet, once", () => {
    const key = `0x${"11".repeat(32)}`;
    const storage = memoryStorage({ "paso.signer": "demo", "paso.demo.key": key, "paso.unrelated": "kept" });

    migrateStorage(storage);

    expect(storage.getItem("paso.signer")).toBeNull();
    expect(storage.getItem("paso.demo.key")).toBeNull();
    expect(storage.getItem(chosenSignerKey("testnet"))).toBe("demo");
    expect(storage.getItem(chosenSignerKey("mainnet"))).toBeNull();
    expect(storage.getItem(DEMO_KEY_STORAGE)).toBe(key);
    expect(loadDemoKey("testnet", storage)).toBe(key);
    expect(storage.getItem("paso.unrelated")).toBe("kept");
  });

  it("does not write over what the browser has stored since", () => {
    const older = `0x${"11".repeat(32)}`;
    const newer = `0x${"22".repeat(32)}`;
    const storage = memoryStorage({ "paso.demo.key": older, [DEMO_KEY_STORAGE]: newer, "paso.signer": "demo", [chosenSignerKey("testnet")]: "wallet" });

    migrateStorage(storage);
    migrateStorage(storage);

    expect(storage.getItem(DEMO_KEY_STORAGE)).toBe(newer);
    expect(storage.getItem(chosenSignerKey("testnet"))).toBe("wallet");
    expect(storage.getItem("paso.demo.key")).toBeNull();
  });

  it("keeps the throwaway key off mainnet: none is found there and none is made", () => {
    const storage = memoryStorage();
    const key = ensureDemoKey("testnet", storage);

    expect(loadDemoKey("mainnet", storage)).toBeNull();
    expect(() => ensureDemoKey("mainnet", storage)).toThrow(/testnet only/);
    expect(() => ensureDemoKey("mainnet", null)).toThrow(/testnet only/);
    expect(loadDemoKey("testnet", storage)).toBe(key);
  });
});

describe("the command that delivers a burn without the hosted relayer", () => {
  it("names the burn and the network, and nothing the owner holds", () => {
    const burn = `0x${"9b".repeat(32)}`;
    expect(deliverCommand(burn, "mainnet")).toBe(`pnpm deliver ${burn} --network mainnet`);
    expect(deliverCommand(burn, "testnet")).toBe(`pnpm deliver ${burn} --network testnet`);
  });
});
