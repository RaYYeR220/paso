/**
 * XLM on a Stellar network: what an account holds and what a transaction
 * would cost, both read without a key and without sending anything.
 */
import { Account, Keypair, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { formatAmount } from "../packages/sdk/src/index";

export const STROOPS_PER_XLM = 10_000_000n;
/** What each transaction bids to be included, on top of its resource fee. */
export const INCLUSION_FEE = 100n;
/** Two base reserves: what an account has to keep and cannot pay fees with. */
export const MINIMUM_BALANCE = 1n * STROOPS_PER_XLM;

export const formatXlm = (stroops: bigint): string => `${formatAmount(stroops, 7)} XLM`;

/** XLM held by a classic account in stroops, or `null` when the account does not exist. */
export async function xlmBalance(server: rpc.Server, address: string): Promise<bigint | null> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const data = entries[0]?.val;
  return data?.type === "account" ? data.account.balance : null;
}

/**
 * The most a transaction with this one operation would cost `source`, in
 * stroops. Simulation needs neither a signature nor an existing account;
 * part of the fee is returned when the transaction uses less than it declares.
 */
export async function simulatedFee(
  server: rpc.Server,
  networkPassphrase: string,
  source: string,
  operation: xdr.Operation,
  bid: bigint = INCLUSION_FEE,
): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: bid.toString(),
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(describe(simulation.error));
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error("ledger entries this transaction needs are archived and have to be restored first");
  }
  const fee = BigInt(simulation.minResourceFee);
  if (fee <= 0n) {
    throw new Error(`the simulation returned no resource fee (${describe(simulation.minResourceFee)})`);
  }
  return fee + bid;
}

/**
 * The text of whatever was thrown or returned as an error. An RPC endpoint
 * rejects with plain objects as often as with `Error`s, and printing those
 * as they are says nothing.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const { message, error: inner, code } = error as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof message === "string" && message !== "") return code === undefined ? message : `${message} (code ${String(code)})`;
    if (inner !== undefined) return describe(inner);
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
