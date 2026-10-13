import { NETWORKS, twinAddress, type NetworkConfig } from "paso-sdk";
import { Address, xdr, type rpc, type TransactionBuilder } from "@stellar/stellar-sdk";
import type { Address as EvmAddress, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LogEntry } from "@/lib/client/activity/log";
import type { DeliverResponse, DemoFundResponse } from "@/lib/client/api";

export const network = NETWORKS.testnet;

/** A fresh owner per test run: nothing here depends on which key it is. */
export const owner = privateKeyToAccount(generatePrivateKey());
export const twin = twinAddress(owner.address, network);

export const BURN: Hex = `0x${"ab".repeat(32)}`;
export const OTHER_BURN: Hex = `0x${"cd".repeat(32)}`;
export const STELLAR_HASH = "f0".repeat(32);
export const LATEST_LEDGER = 5_000_000;
export const RECIPIENT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Lets every promise that is ready run, a few rounds deep. */
export async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Waits until `condition` holds, or fails the test. */
export async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let round = 0; round < 200; round += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A promise that never settles: a request that stays open for as long as the test runs. */
export const forever = <T>(): Promise<T> => new Promise<T>(() => undefined);

type Scripted<T> = T | Error | (() => Promise<T>);

/** Answers calls from a script, one entry per call. When the script runs out, the call stays open. */
export function scripted<T>(script: Scripted<T>[]) {
  const calls: unknown[][] = [];
  const next = async (...args: unknown[]): Promise<T> => {
    calls.push(args);
    const entry = script.shift();
    if (entry === undefined) return forever<T>();
    if (entry instanceof Error) throw entry;
    if (typeof entry === "function") return (entry as () => Promise<T>)();
    return entry;
  };
  return Object.assign(next, { calls });
}

export const funded = (burnTxHash: Hex = BURN): DemoFundResponse => ({
  burnTxHash,
  sourceDomain: network.evm.cctpDomain,
  twin,
  amount: "1000000",
});

export const pending = (attestation: "not_found" | "pending" | "unreachable" = "pending"): DeliverResponse => ({
  status: "pending",
  attestation,
});

export const delivered = (hash?: string): DeliverResponse => ({
  status: "delivered",
  route: "forwarder",
  ...(hash ? { hash } : {}),
});

/** Collects what the flows write to an account's activity log. */
export function recordingLog() {
  const entries = new Map<string, LogEntry>();
  return {
    entries,
    for: () => ({ put: (entry: LogEntry) => void entries.set(entry.id, entry) }),
  };
}

/** Answers a simulation the way the network does in recording mode: one unsigned entry for the owner's account. */
export function recordingServer(ownerAddress: EvmAddress = owner.address, on: NetworkConfig = network): rpc.Server {
  const account = twinAddress(ownerAddress, on);
  const simulateTransaction = async (tx: ReturnType<TransactionBuilder["build"]>) => {
    const envelope = tx.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") throw new Error(`unexpected envelope ${envelope.type}`);
    const body = envelope.v1.tx.operations[0]?.body;
    if (body?.type !== "invokeHostFunction") throw new Error("not a contract call");
    const { hostFunction } = body.invokeHostFunctionOp;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: new Address(account).toScAddress(),
          nonce: 3960317771751520764n,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(hostFunction.invokeContract),
        subInvocations: [],
      }),
    });
    return {
      id: "1",
      latestLedger: LATEST_LEDGER,
      events: [],
      _parsed: true,
      minResourceFee: "1000",
      result: { auth: [entry], retval: xdr.ScVal.scvVoid() },
    };
  };
  return { simulateTransaction } as unknown as rpc.Server;
}
