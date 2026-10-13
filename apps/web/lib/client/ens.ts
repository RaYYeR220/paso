import { createPublicClient, fallback, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";

/** Public Ethereum mainnet endpoints. ENS lives on mainnet whichever network the app works on. */
export const MAINNET_RPC_URLS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://eth.llamarpc.com",
];

const REQUEST_TIMEOUT_MS = 8_000;

let client: PublicClient | undefined;

function mainnetClient(): PublicClient {
  client ??= createPublicClient({
    chain: mainnet,
    transport: fallback(MAINNET_RPC_URLS.map((url) => http(url, { timeout: REQUEST_TIMEOUT_MS }))),
  });
  return client;
}

/** Raised when a name is valid and resolves to nothing. */
export class NameNotFoundError extends Error {
  constructor(readonly ensName: string) {
    super(`${ensName} does not resolve to an Ethereum address`);
    this.name = "NameNotFoundError";
  }
}

const resolved = new Map<string, Promise<Address | null>>();

/** The address an ENS name points to, or `null` when it points to none. Answers are remembered for the session. */
export function resolveEnsName(name: string): Promise<Address | null> {
  const key = normalize(name);
  let answer = resolved.get(key);
  if (!answer) {
    answer = mainnetClient()
      .getEnsAddress({ name: key })
      .then((address) => address ?? null);
    resolved.set(key, answer);
    // A failed lookup says nothing about the name: the next question asks again.
    answer.catch(() => resolved.delete(key));
  }
  return answer;
}
