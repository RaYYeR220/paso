/**
 * Compile-time checks only: real viem clients must be accepted where the SDK
 * asks for a wallet, a reader or a signer. Type-checked by `pnpm typecheck`,
 * never run.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { fundFromEvm, sign, type Prepared, type TypedDataSigner } from "../src";

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

export function acceptsAWalletWithoutAHoistedAccount(prepared: Prepared): Promise<unknown> {
  const walletClient = createWalletClient({ chain: baseSepolia, transport: http() });
  const signer: TypedDataSigner = {
    signTypedData: (data) => walletClient.signTypedData({ ...data, account: account.address }),
  };
  return sign(prepared, signer);
}
