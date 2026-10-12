import { prepare, sign, twinAddress, NETWORKS, type Signed } from "@paso/sdk";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { PrivateKeyAccount } from "viem/accounts";

export const { hub, usdc, rpcUrl } = NETWORKS.testnet.stellar;

/** True when the tests may reach testnet and the relayer account is configured. */
export const live = process.env.PASO_OFFLINE !== "1" && Boolean(process.env.RELAYER_SECRET);

export const server = new rpc.Server(rpcUrl);

export function post(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function approveArgs(owner: `0x${string}`, amount: number, untilLedger: number, spender = hub) {
  return [
    new Address(twinAddress(owner, "testnet")).toScVal(),
    new Address(spender).toScVal(),
    nativeToScVal(BigInt(amount), { type: "i128" }),
    nativeToScVal(untilLedger, { type: "u32" }),
  ];
}

/**
 * A signed USDC `approve(account, spender, amount, expiration_ledger)`: it
 * needs the account's signature and no balance, so any owner can make it.
 */
export async function signedApprove(
  owner: PrivateKeyAccount,
  amount: number,
  options: { validForLedgers?: number; spender?: string } = {},
): Promise<Signed> {
  const { sequence } = await server.getLatestLedger();
  const prepared = await prepare(
    { kind: "invoke", contract: usdc, fn: "approve", args: approveArgs(owner.address, amount, sequence + 1000, options.spender) },
    { owner: owner.address, network: "testnet", validForLedgers: options.validForLedgers },
  );
  return sign(prepared, owner);
}

export async function xlmBalance(address: string): Promise<bigint> {
  const entry = await server.getAccountEntry(address);
  return BigInt(entry.balance.toString());
}
