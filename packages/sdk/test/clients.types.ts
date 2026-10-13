/**
 * Compile-time checks only: real viem clients must be accepted where the SDK
 * asks for a wallet, a reader or a signer. Type-checked by `pnpm typecheck`,
 * never run.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, arcTestnet, base, baseSepolia, optimismSepolia, sepolia } from "viem/chains";
import { fundFromEvm, receiveMessageOnEvm, sign, type Prepared, type TypedDataSigner } from "../src";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

export async function acceptsBaseSepoliaClients(prepared: Prepared): Promise<void> {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

  await fundFromEvm({ walletClient, publicClient, amount: 1n, owner: account.address, network: "testnet" });
  await sign(prepared, walletClient);
  await sign(prepared, account);
}

export async function acceptsBaseClients(): Promise<void> {
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  await fundFromEvm({ walletClient, publicClient, amount: 1n, owner: account.address, network: "mainnet" });
}

export async function acceptsClientsOfEveryListedChain(prepared: Prepared): Promise<void> {
  for (const chain of [arcTestnet, sepolia, arbitrumSepolia, optimismSepolia]) {
    const publicClient = createPublicClient({ chain, transport: http() });
    const walletClient = createWalletClient({ account, chain, transport: http() });
    await fundFromEvm({ walletClient, publicClient, amount: 1n, owner: account.address, network: "testnet", chain: "arc" });
    await receiveMessageOnEvm({ walletClient, publicClient, message: "0x", attestation: "0x", network: "testnet", chain: "arc" });
    await sign(prepared, walletClient);
  }
}

export function acceptsAWalletWithoutAHoistedAccount(prepared: Prepared): Promise<unknown> {
  const walletClient = createWalletClient({ chain: baseSepolia, transport: http() });
  const signer: TypedDataSigner = {
    signTypedData: (data) => walletClient.signTypedData({ ...data, account: account.address }),
  };
  return sign(prepared, signer);
}
