/**
 * Sending a Stellar transaction so that it lands, from any funded account.
 */
import { rpc, TransactionBuilder, type Account, type Keypair, type Transaction, type xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";
import { SimulationError, type NetworkName } from "../packages/sdk/src/index";
import { formatXlm } from "./fees";

/**
 * What a Stellar transaction bids to get into a ledger, in stroops, on top of
 * its resource fee. The network charges the going rate, never more than the
 * bid. When mainnet ledgers are full, a transaction bidding the 100-stroop
 * minimum is dropped without a trace, so on mainnet the bid is 0.01 XLM, and
 * it doubles each time a transaction has to be sent again.
 */
export const INCLUSION_BID: Record<NetworkName, bigint> = { testnet: 100n, mainnet: 100_000n };
/** How long a submitted transaction can still be applied. After that it is dead and can be sent again. */
export const VALIDITY_SECONDS = 60;
/** How many times a transaction is sent before giving up on it. */
export const SUBMISSIONS = 3;
const POLL_MS = 2000;

export type Applied = rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse;

/** Where progress is reported: a label and a value, one line each. */
export type Report = (label: string, value: string) => void;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Sends a transaction from `source` and waits until the network has applied
 * it, whether it succeeded or failed there.
 *
 * `build` makes the transaction for the source's current sequence number and
 * the given bid. A transaction no ledger took before its time bound passed
 * can never be applied, so it is built again with twice the bid and sent
 * again. Both carry the same sequence number, so at most one of them is ever
 * applied; whatever is sent this way has to be harmless to repeat or guarded
 * by a nonce that can be used once.
 */
export async function sendAndWait(
  server: rpc.Server,
  source: Keypair,
  network: NetworkName,
  what: string,
  build: (account: Account, bid: bigint) => Promise<Transaction>,
  report: Report,
): Promise<Applied> {
  let bid = INCLUSION_BID[network];
  for (let attempt = 1; ; attempt += 1) {
    const tx = await build(await server.getAccount(source.publicKey()), bid);
    tx.sign(source);
    const hash = toHex(tx.hash()).slice(2);
    const expires = Number(tx.timeBounds?.maxTime ?? 0);

    let sent = await server.sendTransaction(tx);
    // A busy node asks to be offered the same transaction again.
    while (sent.status === "TRY_AGAIN_LATER" && Date.now() / 1000 < expires) {
      await sleep(POLL_MS);
      sent = await server.sendTransaction(tx);
    }
    if (sent.status === "ERROR") {
      const reason = sent.errorResult?.result.type ?? "no reason given";
      // Someone else sent from the same account in the meantime: the transaction is built on the new sequence number.
      if (reason === "txBadSeq" && attempt < SUBMISSIONS) {
        report("again", `the sequence number of ${source.publicKey()} moved under ${hash}; building the transaction again`);
        continue;
      }
      throw new Error(`The network did not take the transaction ${what}: ${reason} (${hash})`);
    }

    // Until a ledger closes after the time bound, the transaction can still be applied.
    for (;;) {
      const result = await server.getTransaction(hash).catch((error: unknown) => {
        if (Date.now() / 1000 > expires + 2 * VALIDITY_SECONDS) throw error;
        return undefined;
      });
      if (result && result.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return result;
      if (result && result.latestLedgerCloseTime > expires) break;
      await sleep(POLL_MS);
    }

    if (attempt === SUBMISSIONS) {
      throw new Error(
        `The transaction ${what} was sent ${SUBMISSIONS} times and no ledger took it before it expired (last: ${hash}). ` +
          "Nothing was charged for it; the network is busy, try again later",
      );
    }
    bid *= 2n;
    report("expired", `${hash} was not applied before its time ran out, and never will be`);
    report("", `sending it again, bidding ${formatXlm(bid)} to be included (attempt ${attempt + 1} of ${SUBMISSIONS})`);
  }
}

/**
 * A transaction with one operation from `account`, simulated and ready to
 * sign, and the most it can cost in stroops: its resource fee and the bid.
 * Throws a `SimulationError` when the network would refuse the operation.
 */
export async function simulated(
  server: rpc.Server,
  networkPassphrase: string,
  account: Account,
  operation: xdr.Operation,
  bid: bigint,
): Promise<{ tx: Transaction; fee: bigint }> {
  const tx = new TransactionBuilder(account, { fee: bid.toString(), networkPassphrase })
    .addOperation(operation)
    .setTimeout(VALIDITY_SECONDS)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new SimulationError(simulation.error);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new SimulationError("ledger entries this call needs are archived and have to be restored first");
  }
  return { tx: rpc.assembleTransaction(tx, simulation).build(), fee: BigInt(simulation.minResourceFee) + bid };
}
