/**
 * Checks, from public chain data alone, that a Stellar transaction was
 * authorised by an Ethereum key.
 *
 *   pnpm verify <stellar transaction hash> [--network testnet|mainnet]
 *
 * The network decides which RPC endpoint is asked, which passphrase the
 * signature is checked against and where the explorer links point. It
 * defaults to testnet.
 *
 * It fetches the transaction, takes the authorisation entry of the Paso
 * account in it, rebuilds the EIP-712 message a wallet displays for that
 * entry, recovers the signer from the 65-byte signature and checks that
 *
 *   1. the signer is the owner stored in the account contract,
 *   2. the account is the address derived from that owner,
 *   3. the account runs the published account code.
 *
 * Exits with 0 when every check passes and with 1 otherwise. A transaction
 * the account refused fails check 1 by construction: its signature does not
 * match the calls it tried to run.
 */
import { rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { hashTypedData, isAddressEqual, recoverTypedDataAddress, size, toHex } from "viem";
import {
  entryAddress,
  entrySignature,
  entryTypedData,
  ownerOf,
  renderCalls,
  requireHub,
  resolveNetwork,
  stellarAddressUrl,
  stellarTxUrl,
  twinAddress,
  type NetworkName,
} from "../packages/sdk/src/index";

interface Check {
  claim: string;
  passed: boolean;
  evidence: string;
}

function usage(): never {
  console.error("Usage: pnpm verify <stellar transaction hash> [--network testnet|mainnet]");
  process.exit(2);
}

function parseArgs(argv: string[]): { hash: string; network: NetworkName } {
  let network: NetworkName = "testnet";
  let hash: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--network") {
      const value = argv[(i += 1)];
      if (value !== "testnet" && value !== "mainnet") usage();
      network = value;
    } else if (/^[0-9a-fA-F]{64}$/.test(arg)) {
      hash = arg.toLowerCase();
    } else {
      usage();
    }
  }
  if (!hash) usage();
  return { hash, network };
}

/** Who paid for a transaction and which entries it carried, looking inside a fee bump when there is one. */
function read(envelope: xdr.TransactionEnvelope, passphrase: string) {
  const parsed = TransactionBuilder.fromXdr(envelope, passphrase);
  const tx = "innerTransaction" in parsed ? parsed.innerTransaction : parsed;
  const entries = tx.operations.flatMap((operation) =>
    operation.type === "invokeHostFunction" ? (operation.auth ?? []) : [],
  );
  return { source: tx.source, entries };
}

async function accountCodeHash(server: rpc.Server, account: string): Promise<string | null> {
  const { executable } = await server.getContractInstance(account);
  return executable.type === "contractExecutableWasm" ? toHex(executable.wasmHash.toBytes()).slice(2) : null;
}

async function main(): Promise<number> {
  const { hash, network } = parseArgs(process.argv.slice(2));
  const config = resolveNetwork(network);
  // Without a hub there are no Paso accounts on the network, so nothing to check a transaction against.
  requireHub(config);
  const server = new rpc.Server(config.stellar.rpcUrl);

  const tx = await server.getTransaction(hash);
  if (tx.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    console.error(`${hash} is not known to ${config.stellar.rpcUrl}. The RPC keeps about a week of history.`);
    return 1;
  }
  const { source, entries } = read(tx.envelopeXdr, config.stellar.networkPassphrase);

  console.log(`Transaction  ${hash}`);
  console.log(`             ${stellarTxUrl(hash, config)}`);
  console.log(`Status       ${tx.status}, ledger ${tx.ledger}`);
  console.log(`Fee paid by  ${source}`);

  // A Paso account is a contract that names an Ethereum address as its owner.
  const candidates = entries.filter((entry) => {
    const { type } = entry.credentials;
    return type === "sorobanCredentialsAddress" || type === "sorobanCredentialsAddressV2";
  });
  let found: { entry: xdr.SorobanAuthorizationEntry; account: string; owner: `0x${string}` } | undefined;
  for (const entry of candidates) {
    const account = entryAddress(entry);
    if (!account?.startsWith("C")) continue;
    const owner = await ownerOf(account, config, server).catch(() => null);
    if (owner) {
      found = { entry, account, owner };
      break;
    }
  }
  if (!found) {
    console.error("\nNo authorisation by a Paso account in this transaction.");
    return 1;
  }
  const { entry, account, owner } = found;

  const typedData = entryTypedData(entry, config);
  const calls = renderCalls(entry);
  const signature = entrySignature(entry);

  console.log(`\nAccount      ${account}`);
  console.log(`             ${stellarAddressUrl(account, config)}`);
  console.log(`Owner        ${owner}   (read from the account contract)`);

  console.log("\nWhat the wallet showed (EIP-712, domain Paso v1, salt = network id)");
  console.log(`  account   ${typedData.message.account}`);
  calls.forEach((call, index) => {
    console.log(`  call ${index + 1}`);
    console.log(`    contract  ${call.contract}`);
    console.log(`    fn        ${call.fn}`);
    call.args.forEach((arg, position) => console.log(`    args[${position}]   ${arg}`));
  });
  console.log(`  payload   ${typedData.message.payload}`);
  console.log(`\nDigest       ${hashTypedData(typedData)}`);

  if (!signature || size(signature) !== 65) {
    console.error("\nThe entry carries no 65-byte signature.");
    return 1;
  }
  console.log(`Signature    ${signature}`);
  const signer = await recoverTypedDataAddress({ ...typedData, signature });
  console.log(`Signer       ${signer}   (recovered from the signature over that digest)`);

  const derived = twinAddress(owner, config);
  const codeHash = await accountCodeHash(server, account);
  const checks: Check[] = [
    {
      claim: "the signer is the owner stored in the account",
      passed: isAddressEqual(signer, owner),
      evidence: `recovered ${signer}, owner() ${owner}`,
    },
    {
      claim: "the account is the address derived from the owner",
      passed: derived === account,
      evidence: `twinAddress(${owner}) = ${derived}`,
    },
    {
      claim: "the account runs the published account code",
      passed: codeHash !== null && codeHash === config.stellar.accountWasmHash,
      evidence: `wasm ${codeHash ?? "none"}`,
    },
  ];

  console.log("\nChecks");
  for (const { claim, passed, evidence } of checks) {
    console.log(`  ${passed ? "PASS" : "FAIL"}  ${claim}`);
    console.log(`        ${evidence}`);
  }

  const passed = checks.every((check) => check.passed);
  if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    console.log(
      passed
        ? "\nThe signature is the owner's, yet the transaction did not succeed: it failed for another reason."
        : "\nThe transaction failed on chain, as it must: the signature does not cover the calls it tried to run.",
    );
  }
  console.log(passed ? "\nVerified." : "\nNOT verified.");
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
