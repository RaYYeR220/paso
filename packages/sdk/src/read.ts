import { Account, Address as StellarAddress, BASE_FEE, Contract, rpc, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getAddress, toHex, type Address } from "viem";
import { resolveNetwork, type Network } from "./networks";

const NULL_ACCOUNT = StrKey.encodeEd25519PublicKey(new Uint8Array(32));

/**
 * Calls a contract function that only reads, and returns its result.
 *
 * The call is simulated, never submitted: it costs nothing and needs no
 * account.
 */
export async function readContract(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  network: Network,
  server?: rpc.Server,
): Promise<xdr.ScVal> {
  const config = resolveNetwork(network);
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
    fee: BASE_FEE,
    networkPassphrase: config.stellar.networkPassphrase,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(60)
    .build();

  const simulation = await (server ?? new rpc.Server(config.stellar.rpcUrl)).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${fn} on ${contract} could not be read: ${simulation.error}`);
  }
  if (!simulation.result) {
    throw new Error(`${fn} on ${contract} returned nothing`);
  }
  return simulation.result.retval;
}

/** USDC held by a Stellar address (`G…` or `C…`), in 7-decimal units. An address that never held any has zero. */
export async function usdcBalance(address: string, network: Network, server?: rpc.Server): Promise<bigint> {
  const { usdc } = resolveNetwork(network).stellar;
  const value = await readContract(usdc, "balance", [new StellarAddress(address).toScVal()], network, server);
  if (value.type !== "scvI128") {
    throw new Error(`USDC answered a balance of type ${value.type}`);
  }
  return (value.i128.hi << 64n) | value.i128.lo;
}

/**
 * The Ethereum address that controls the account contract at `account`, read
 * from the contract itself, or `null` when nothing is deployed there.
 */
export async function ownerOf(account: string, network: Network, server?: rpc.Server): Promise<Address | null> {
  const config = resolveNetwork(network);
  const rpcServer = server ?? new rpc.Server(config.stellar.rpcUrl);
  const { entries } = await rpcServer.getLedgerEntries(new Contract(account).getFootprint());
  if (entries.length === 0) return null;

  const value = await readContract(account, "owner", [], config, rpcServer);
  if (value.type !== "scvBytes" || value.bytes.toBytes().length !== 20) {
    throw new Error(`${account} did not answer with an Ethereum address; it is not a Paso account`);
  }
  return getAddress(toHex(value.bytes.toBytes()));
}
