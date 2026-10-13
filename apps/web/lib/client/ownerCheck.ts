import { NETWORKS, ownerKind, type OwnerChain, type OwnerCheck } from "paso-sdk";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { MAINNET_RPC_URLS } from "./ens";

/**
 * Whether an Ethereum address is a wallet with a key or a contract.
 *
 * It matters because a Paso account obeys one thing, a signature from the
 * key of its owner address, and a contract has no key: the account derived
 * from a Safe or a smart wallet can receive USDC and never move it. The
 * address is looked up on Ethereum and on both Bases, since a smart account
 * is often deployed on one chain and not on another.
 *
 * "wallet" means that no code was found. A smart account that has not been
 * deployed anywhere yet has none either, and cannot be told apart.
 */
const CHAINS: readonly OwnerChain[] = [
  { chain: mainnet, rpcUrls: MAINNET_RPC_URLS },
  { chain: NETWORKS.mainnet.evm.chain },
  { chain: NETWORKS.testnet.evm.chain },
];

const UNKNOWN: OwnerCheck = { kind: "unknown", chains: [] };

/**
 * Asks once per address. An answer that settles the question is kept for as
 * long as the page is open; one that does not, because a chain could not be
 * reached, is asked for again next time. Never rejects.
 */
export function createOwnerChecker(ask: (address: Address) => Promise<OwnerCheck>): (address: Address) => Promise<OwnerCheck> {
  const asked = new Map<string, Promise<OwnerCheck>>();
  return (address) => {
    const key = address.toLowerCase();
    let answer = asked.get(key);
    if (!answer) {
      answer = ask(address).catch(() => UNKNOWN);
      asked.set(key, answer);
      void answer.then((check) => {
        if (check.kind === "unknown") asked.delete(key);
      });
    }
    return answer;
  };
}

/** The app's own checker, over public endpoints. */
export const checkOwner = createOwnerChecker((address) => ownerKind(address, { chains: CHAINS }));
