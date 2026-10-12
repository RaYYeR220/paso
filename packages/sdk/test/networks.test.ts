import { StrKey } from "@stellar/stellar-sdk";
import { isAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  evmAddressUrl,
  evmTxUrl,
  NETWORKS,
  networkId,
  requireHub,
  resolveNetwork,
  stellarAddressUrl,
  stellarTxUrl,
} from "../src/networks";
import { twinAddress } from "../src/twin";
import mainnetDeployment from "../../../deployments/mainnet.json";
import testnetDeployment from "../../../deployments/testnet.json";

describe.each(Object.values(NETWORKS))("$name", (network) => {
  it("lists valid Stellar contract ids", () => {
    const { usdc, tokenMessenger, messageTransmitter, forwarder, hub } = network.stellar;
    for (const id of [usdc, tokenMessenger, messageTransmitter, forwarder]) {
      expect(StrKey.isValidContract(id), id).toBe(true);
    }
    expect(hub === "" || StrKey.isValidContract(hub)).toBe(true);
  });

  it("lists checksummed Base addresses", () => {
    const { usdc, tokenMessenger, messageTransmitter } = network.evm;
    for (const address of [usdc, tokenMessenger, messageTransmitter]) {
      expect(isAddress(address, { strict: true }), address).toBe(true);
    }
  });

  it("uses Circle's domain numbers", () => {
    expect(network.stellar.cctpDomain).toBe(27);
    expect(network.evm.cctpDomain).toBe(6);
  });
});

describe("networks", () => {
  it("pairs Stellar testnet with Base Sepolia and the Iris sandbox", () => {
    const { stellar, evm, irisUrl } = NETWORKS.testnet;
    expect(stellar.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(stellar.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(stellar.usdc).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(evm.chain.id).toBe(84532);
    expect(evm.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(evm.tokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(irisUrl).toBe("https://iris-api-sandbox.circle.com");
  });

  it("pairs Stellar mainnet with Base and production Iris", () => {
    const { stellar, evm, irisUrl } = NETWORKS.mainnet;
    expect(stellar.networkPassphrase).toBe("Public Global Stellar Network ; September 2015");
    expect(evm.chain.id).toBe(8453);
    expect(evm.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(irisUrl).toBe("https://iris-api.circle.com");
  });

  it("keeps both deployment files in one shape", () => {
    expect(Object.keys(mainnetDeployment)).toEqual(Object.keys(testnetDeployment));
    expect(mainnetDeployment.network).toBe("mainnet");
    expect(testnetDeployment.network).toBe("testnet");
  });

  it("reads Stellar mainnet from its deployment file", () => {
    const { stellar } = NETWORKS.mainnet;
    expect(stellar.rpcUrl).toBe(mainnetDeployment.rpcUrl);
    expect(stellar.hub).toBe(mainnetDeployment.hub);
    expect(stellar.accountWasmHash).toBe(mainnetDeployment.accountWasmHash);
    expect(stellar.explorerUrl).toBe("https://stellar.expert/explorer/public");
    expect(stellar.usdc).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
    expect(stellar.tokenMessenger).toBe("CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL");
    expect(stellar.messageTransmitter).toBe("CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV");
    expect(stellar.forwarder).toBe("CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T");
  });

  it("pairs mainnet with Circle's contracts on Base", () => {
    const { evm } = NETWORKS.mainnet;
    expect(evm.tokenMessenger).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
    expect(evm.messageTransmitter).toBe("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
  });

  it.each(Object.values(NETWORKS))("records the hub and the account code of $name together", ({ stellar }) => {
    const { hub, accountWasmHash } = stellar;
    if (hub === "") {
      expect(accountWasmHash).toBe("");
    } else {
      expect(StrKey.isValidContract(hub)).toBe(true);
      expect(accountWasmHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("derives mainnet accounts once a hub is recorded, and says so until then", () => {
    const owner = "0x000000000000000000000000000000000000dEaD";
    if (NETWORKS.mainnet.stellar.hub === "") {
      expect(() => requireHub("mainnet")).toThrow("Paso has no hub on mainnet yet");
      expect(() => twinAddress(owner, "mainnet")).toThrow("Paso has no hub on mainnet yet");
    } else {
      expect(StrKey.isValidContract(twinAddress(owner, "mainnet"))).toBe(true);
    }

    // The same hub on another network is another account: the network id is part of the address.
    const hub = NETWORKS.testnet.stellar.hub;
    const deployed = { ...NETWORKS.mainnet, stellar: { ...NETWORKS.mainnet.stellar, hub } };
    expect(requireHub(deployed)).toBe(hub);
    expect(StrKey.isValidContract(twinAddress(owner, deployed))).toBe(true);
    expect(twinAddress(owner, deployed)).not.toBe(twinAddress(owner, "testnet"));
  });

  it("resolves a name or passes a config through", () => {
    expect(resolveNetwork("testnet")).toBe(NETWORKS.testnet);
    expect(resolveNetwork(NETWORKS.mainnet)).toBe(NETWORKS.mainnet);
    expect(() => resolveNetwork("futurenet" as "testnet")).toThrow(/unknown network/i);
  });

  it("derives the network id from the passphrase", () => {
    expect(networkId("testnet")).toBe("0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472");
    expect(networkId("mainnet")).toBe("0x7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979");
  });

  it("builds explorer links for both chains", () => {
    const hash = "ab".repeat(32);
    expect(stellarTxUrl(hash, "testnet")).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(stellarTxUrl(hash, "mainnet")).toBe(`https://stellar.expert/explorer/public/tx/${hash}`);
    expect(stellarAddressUrl(NETWORKS.testnet.stellar.usdc, "testnet")).toBe(
      "https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
    expect(stellarAddressUrl("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "testnet")).toBe(
      "https://stellar.expert/explorer/testnet/account/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
    expect(evmTxUrl(`0x${hash}`, "testnet")).toBe(`https://sepolia.basescan.org/tx/0x${hash}`);
    expect(evmTxUrl(`0x${hash}`, "mainnet")).toBe(`https://basescan.org/tx/0x${hash}`);
    expect(evmAddressUrl("0x036CbD53842c5426634e7929541eC2318f3dCF7e", "testnet")).toBe(
      "https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
  });
});
