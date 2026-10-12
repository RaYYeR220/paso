import { NETWORKS, type NetworkConfig, type NetworkName } from "@paso/sdk";
import { rpc } from "@stellar/stellar-sdk";

/** The network the app works on. Only its name is public; everything else comes from the SDK. */
export const NETWORK_NAME: NetworkName = process.env.NEXT_PUBLIC_PASO_NETWORK === "mainnet" ? "mainnet" : "testnet";

export const NETWORK: NetworkConfig = NETWORKS[NETWORK_NAME];

/** The app's own API routes. */
export const ROUTES = {
  relay: "/api/relay",
  deploy: "/api/deploy",
  deliver: "/api/cctp/deliver",
  demoFund: "/api/demo/fund",
  health: "/api/health",
} as const;

/** Contracts worth naming next to their address. */
export function contractName(address: string, network: NetworkConfig = NETWORK): string | undefined {
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

let server: rpc.Server | undefined;

/** One Stellar RPC client for every read the browser makes. */
export function stellarServer(): rpc.Server {
  server ??= new rpc.Server(NETWORK.stellar.rpcUrl);
  return server;
}
