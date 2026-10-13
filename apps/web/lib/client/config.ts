import { NETWORKS, type NetworkConfig, type NetworkName } from "paso-sdk";
import { rpc } from "@stellar/stellar-sdk";

/**
 * Nothing in the client is tied to one network. The page chooses one, and
 * everything that depends on it, from an account's address to an explorer
 * link, is handed that choice: a `NetworkConfig`, or its name where the name
 * is all that is needed.
 */

/** Everything the SDK knows about a network: its contracts, its endpoints, its side of Base. */
export function networkConfig(name: NetworkName): NetworkConfig {
  return NETWORKS[name];
}

/** A network's name as the app writes it. */
export function networkLabel(name: NetworkName): "Testnet" | "Mainnet" {
  return name === "mainnet" ? "Mainnet" : "Testnet";
}

/**
 * The app's own API routes that the browser uses. The network a request is
 * for goes in its body. The browser never asks for an account to be
 * deployed on its own: the relayer deploys it with its owner's first signed
 * call.
 */
export const ROUTES = {
  relay: "/api/relay",
  deliver: "/api/cctp/deliver",
  complete: "/api/cctp/complete",
  demoFund: "/api/demo/fund",
  health: "/api/health",
} as const;

/** Contracts worth naming next to their address. */
export function contractName(address: string, network: NetworkConfig): string | undefined {
  const { usdc, hub, forwarder, tokenMessenger, messageTransmitter } = network.stellar;
  switch (address) {
    case usdc:
      return "USDC";
    case hub:
      return "Paso hub";
    case forwarder:
      return "Circle forwarder";
    case tokenMessenger:
      return "Circle TokenMessenger";
    case messageTransmitter:
      return "Circle MessageTransmitter";
    default:
      return undefined;
  }
}

const servers = new Map<string, rpc.Server>();

/** One Stellar RPC client per network for every read the browser makes there. */
export function stellarServer(network: NetworkConfig): rpc.Server {
  const { rpcUrl } = network.stellar;
  let server = servers.get(rpcUrl);
  if (!server) {
    server = new rpc.Server(rpcUrl);
    servers.set(rpcUrl, server);
  }
  return server;
}
