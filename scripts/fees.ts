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
): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: INCLUSION_FEE.toString(),
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }
  return BigInt(simulation.minResourceFee) + INCLUSION_FEE;
}
