import { StrKey } from "@stellar/stellar-sdk";
import { getAddress, isAddress, pad, toHex } from "viem";
import { arbitrum, arbitrumSepolia, arc, arcTestnet, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { defaultFinalityOf } from "../src/evm";
import {
  CCTP_DOMAINS,
  DEFAULT_EVM_CHAIN,
  EVM_CHAIN_NAMES,
  evmAddressUrl,
  evmChain,
  evmChainForDomain,
  evmChainForId,
  evmTxUrl,
  isEvmChainName,
  listEvmChains,
  NETWORKS,
  type EvmChainName,
  type NetworkConfig,
  type NetworkName,
} from "../src/networks";
import evidence from "./fixtures/cctp-routes.json";

interface RouteEvidence {
  network: NetworkName;
  chain: EvmChainName;
  label: string;
  chainId: number;
  cctpDomain: number;
  usdc: string;
  tokenMessenger: string;
  messageTransmitter: string;
  evm: {
    chainId: number;
    localDomain: number;
    localMessageTransmitter: string;
    tokenMinter: string;
    remoteTokenMessenger: string;
    localTokenForStellarUsdc: string;
    usdcDecimals: number;
    codeBytes: Record<string, number>;
  };
  stellar: { remoteTokenMessenger: string; localToken: string };
  fees: { toStellar: Record<string, number>; fromStellar: Record<string, number> };
  inboundFinality: number;
}

const NETWORK_NAMES: NetworkName[] = ["testnet", "mainnet"];
const routes = (network: NetworkName): RouteEvidence[] => evidence.networks[network].routes as RouteEvidence[];
const table = NETWORK_NAMES.flatMap((network) => routes(network).map((route) => [network, route.chain, route] as const));

describe("the chains Paso lists", () => {
  it("are Base, Ethereum, Arbitrum, OP Mainnet and Arc, Base first", () => {
    expect(EVM_CHAIN_NAMES).toEqual(["base", "ethereum", "arbitrum", "optimism", "arc"]);
    expect(DEFAULT_EVM_CHAIN).toBe("base");
    for (const network of NETWORK_NAMES) {
      expect(listEvmChains(network).map((chain) => chain.name)).toEqual(EVM_CHAIN_NAMES);
    }
  });

  it("use Circle's domain numbers", () => {
    expect(CCTP_DOMAINS).toEqual({ ethereum: 0, optimism: 2, arbitrum: 3, base: 6, arc: 26 });
  });

  it.each([
    ["testnet", [baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, arcTestnet]],
    ["mainnet", [base, mainnet, arbitrum, optimism, arc]],
  ] as const)("on %s are viem's own chain definitions", (network, chains) => {
    expect(listEvmChains(network).map((chain) => chain.chain)).toEqual(chains);
  });

  it.each([
    ["testnet", ["Base Sepolia", "Ethereum Sepolia", "Arbitrum Sepolia", "OP Sepolia", "Arc Testnet"]],
    ["mainnet", ["Base", "Ethereum", "Arbitrum", "OP Mainnet", "Arc"]],
  ] as const)("on %s carry the names a person reads", (network, labels) => {
    expect(listEvmChains(network).map((chain) => chain.label)).toEqual(labels);
    expect(listEvmChains(network).map((chain) => chain.shortLabel)).toEqual(["Base", "Ethereum", "Arbitrum", "OP Mainnet", "Arc"]);
  });

  it("keep the default chain as the network's own `evm`", () => {
    for (const network of NETWORK_NAMES) {
      expect(evmChain(network)).toBe(NETWORKS[network].evm);
      expect(evmChain(network, "base")).toBe(NETWORKS[network].evm);
      expect(NETWORKS[network].evmChains?.base).toBe(NETWORKS[network].evm);
    }
  });
});

describe.each(NETWORK_NAMES)("every chain of %s", (network) => {
  const chains = listEvmChains(network);

  it("has checksummed addresses, 6-decimal USDC and Circle's one pair of contracts", () => {
    for (const chain of chains) {
      for (const address of [chain.usdc, chain.tokenMessenger, chain.messageTransmitter]) {
        expect(isAddress(address, { strict: true }), `${chain.label} ${address}`).toBe(true);
        expect(getAddress(address)).toBe(address);
      }
      expect(chain.usdcDecimals).toBe(6);
    }
    expect(new Set(chains.map((chain) => chain.tokenMessenger)).size).toBe(1);
    expect(new Set(chains.map((chain) => chain.messageTransmitter)).size).toBe(1);
  });

  it("has public https endpoints and an explorer", () => {
    for (const chain of chains) {
      expect(chain.rpcUrls.length, chain.label).toBeGreaterThan(0);
      for (const url of chain.rpcUrls) expect(url).toMatch(/^https:\/\/[^/]+/);
      expect(chain.explorerUrl).toMatch(/^https:\/\/[^/]+[^/]$/);
    }
  });

  it("has distinct domains and chain ids, and is found by either", () => {
    expect(new Set(chains.map((chain) => chain.cctpDomain)).size).toBe(chains.length);
    expect(new Set(chains.map((chain) => chain.chain.id)).size).toBe(chains.length);
    for (const chain of chains) {
      expect(evmChainForDomain(network, chain.cctpDomain)).toBe(chain);
      expect(evmChainForId(network, chain.chain.id)).toBe(chain);
    }
    expect(evmChainForDomain(network, 27)).toBeUndefined();
    expect(evmChainForDomain(network, 5)).toBeUndefined();
    expect(evmChainForId(network, 137)).toBeUndefined();
  });

  it("pays gas in ETH everywhere but Arc, where gas is USDC in 18 decimals", () => {
    for (const chain of chains) {
      const onArc = chain.name === "arc";
      expect(chain.gasToken).toEqual(onArc ? { symbol: "USDC", decimals: 18, isUsdc: true } : { symbol: "ETH", decimals: 18, isUsdc: false });
      expect(chain.gasToken.decimals).toBe(chain.chain.nativeCurrency.decimals);
      expect(chain.fastTransfer).toBe(!onArc);
    }
  });

  it(network === "testnet" ? "names Circle's faucet for USDC and a faucet for gas" : "names no faucet", () => {
    for (const chain of chains) {
      if (network === "mainnet") {
        expect(chain.faucets).toBeUndefined();
        continue;
      }
      expect(chain.faucets?.usdc).toBe("https://faucet.circle.com");
      expect(chain.faucets?.gas).toMatch(/^https:\/\//);
      if (chain.name === "arc") expect(chain.faucets?.gas).toBe("https://faucet.circle.com");
    }
  });
});

describe("the evidence each listed chain was checked against", () => {
  it("covers every chain listed, and lists no chain without it", () => {
    for (const network of NETWORK_NAMES) {
      expect(routes(network).map((route) => route.chain).sort()).toEqual([...EVM_CHAIN_NAMES].sort());
    }
  });

  it.each(table)("%s %s: the config says what the chains said", (network, name, route) => {
    const config = NETWORKS[network];
    const chain = evmChain(network, name);
    const stellarTokenMessenger = toHex(StrKey.decodeContract(config.stellar.tokenMessenger));
    const stellarUsdc = config.stellar.usdc;

    expect(evidence.networks[network].stellarTokenMessenger).toBe(config.stellar.tokenMessenger);
    expect({
      label: route.label,
      chainId: route.chainId,
      cctpDomain: route.cctpDomain,
      usdc: route.usdc,
      tokenMessenger: route.tokenMessenger,
      messageTransmitter: route.messageTransmitter,
    }).toEqual({
      label: chain.label,
      chainId: chain.chain.id,
      cctpDomain: chain.cctpDomain,
      usdc: chain.usdc,
      tokenMessenger: chain.tokenMessenger,
      messageTransmitter: chain.messageTransmitter,
    });

    // On the EVM chain.
    expect(route.evm.chainId).toBe(chain.chain.id);
    expect(route.evm.localDomain).toBe(chain.cctpDomain);
    expect(getAddress(route.evm.localMessageTransmitter)).toBe(chain.messageTransmitter);
    expect(route.evm.remoteTokenMessenger.toLowerCase()).toBe(stellarTokenMessenger);
    expect(getAddress(route.evm.localTokenForStellarUsdc)).toBe(chain.usdc);
    expect(route.evm.usdcDecimals).toBe(chain.usdcDecimals);
    for (const [contract, bytes] of Object.entries(route.evm.codeBytes)) expect(bytes, contract).toBeGreaterThan(0);

    // On Stellar.
    expect(route.stellar.remoteTokenMessenger.toLowerCase()).toBe(pad(chain.tokenMessenger).toLowerCase());
    expect(route.stellar.localToken).toBe(stellarUsdc);

    // At Circle's attestation service.
    expect(route.inboundFinality).toBe(defaultFinalityOf(chain));
    expect(route.fees.toStellar[String(route.inboundFinality)]).toBeTypeOf("number");
    expect(route.fees.fromStellar["1000"]).toBe(0);
  });

  it("was checked with the Stellar CLI too, and every line agreed", () => {
    for (const network of NETWORK_NAMES) {
      const lines = evidence.stellarCli[network];
      expect(lines).toContain(`${network} MT.get_local_domain = 27`);
      const domains = lines.filter((line) => /domain \d+:/.test(line));
      expect(domains).toHaveLength(EVM_CHAIN_NAMES.length);
      for (const line of domains) expect(line).toMatch(/\[OK\];.*\[OK\]$/);
    }
  });
});

describe("evmChain", () => {
  it.each(["polygon", "solana", "stellar", "", "Base", "ARC", "toString", "__proto__"])("refuses %j, which is no chain Paso lists", (name) => {
    expect(isEvmChainName(name)).toBe(false);
    expect(() => evmChain("testnet", name as EvmChainName)).toThrow(/Unknown EVM chain/);
    expect(() => evmTxUrl("0x00", "testnet", name as EvmChainName)).toThrow(/Unknown EVM chain/);
  });

  it("refuses a value that is not text", () => {
    for (const value of [null, 6, {}, ["base"]]) {
      expect(isEvmChainName(value)).toBe(false);
      expect(() => evmChain("mainnet", value as unknown as EvmChainName)).toThrow(/Unknown EVM chain/);
    }
  });

  it("offers the `evm` of a config that lists no chains, and nothing else", () => {
    const { evmChains: _listed, ...bare } = NETWORKS.testnet;
    const config: NetworkConfig = bare;
    const only = evmChain(config);
    expect(only).toMatchObject({ ...config.evm, name: "base", label: "Base Sepolia", usdcDecimals: 6, explorerUrl: "https://sepolia.basescan.org" });
    expect(listEvmChains(config)).toEqual([only]);
    expect(() => evmChain(config, "arc")).toThrow(/offers no EVM chain "arc"; it offers base/);
  });

  it("lets a config that replaces `evm` replace the default chain with it", () => {
    const usdc = "0x0000000000000000000000000000000000000001";
    const config: NetworkConfig = { ...NETWORKS.testnet, evm: { ...NETWORKS.testnet.evm, usdc } };
    expect(evmChain(config).usdc).toBe(usdc);
    expect(evmChain(config, "base").usdc).toBe(usdc);
    expect(evmChain(config).label).toBe("Base Sepolia");
    expect(evmChain(config, "arc")).toBe(NETWORKS.testnet.evmChains?.arc);
  });
});

describe("explorer links per chain", () => {
  const hash = `0x${"ab".repeat(32)}`;
  const address = "0xEe67130Fa530c04b88D6Fd99fcc7D1D1494841f8";

  it.each([
    ["testnet", "base", "https://sepolia.basescan.org"],
    ["testnet", "ethereum", "https://sepolia.etherscan.io"],
    ["testnet", "arbitrum", "https://sepolia.arbiscan.io"],
    ["testnet", "optimism", "https://sepolia-optimism.etherscan.io"],
    ["testnet", "arc", "https://explorer.testnet.arc.io"],
    ["mainnet", "base", "https://basescan.org"],
    ["mainnet", "ethereum", "https://etherscan.io"],
    ["mainnet", "arbitrum", "https://arbiscan.io"],
    ["mainnet", "optimism", "https://optimistic.etherscan.io"],
    ["mainnet", "arc", "https://explorer.arc.io"],
  ] as const)("%s %s points at %s", (network, chain, explorer) => {
    expect(evmTxUrl(hash, network, chain)).toBe(`${explorer}/tx/${hash}`);
    expect(evmAddressUrl(address, network, chain)).toBe(`${explorer}/address/${address}`);
  });

  it("points at Base when no chain is named", () => {
    expect(evmTxUrl(hash, "testnet")).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    expect(evmAddressUrl(address, "mainnet")).toBe(`https://basescan.org/address/${address}`);
  });
});
