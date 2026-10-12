/**
 * An Ethereum key spends from an OpenZeppelin smart account, on Stellar testnet.
 *
 *   npm run demo
 *
 * The run:
 *
 * 1. uploads and deploys the verifier built by `stellar contract build`, or
 *    finds the instance an earlier run deployed from the same wasm;
 * 2. deploys a fresh OpenZeppelin smart account whose only signer is
 *    `External(verifier, <Ethereum address>)`. The account code is the wasm
 *    `stellar/smart-account-kit` publishes on testnet; the Ethereum key is
 *    generated here, lives for this run only and is never printed;
 * 3. sends the account 10 XLM;
 * 4. has the Ethereum key authorise a transfer of 1 XLM out of the account.
 *    The same entry signed by another key is simulated first and has to be
 *    refused.
 *
 * Every transaction is sent and paid by a stellar-cli identity, which signs
 * the envelopes itself: `PASO_DEPLOYER`, default `paso-deployer`. Create one
 * with `stellar keys generate <name> --network testnet --fund`. This script
 * reads no key from disk. Testnet only.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  hash,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { hashTypedData, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { NETWORK_PASSPHRASES, signPayload, typedData } from "./src/index";
import {
  attachSignature,
  DEFAULT_CONTEXT_RULE,
  entryAddress,
  entryPayload,
  ethereumSigner,
  signaturePayload,
} from "./src/openzeppelin";

const NETWORK = "testnet";
const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = NETWORK_PASSPHRASES[NETWORK];
const EXPLORER = "https://stellar.expert/explorer/testnet";
const IDENTITY = process.env.PASO_DEPLOYER ?? "paso-deployer";

/**
 * `multisig-account-example` of OpenZeppelin/stellar-contracts at 1e513890,
 * uploaded to testnet by stellar/smart-account-kit
 * (docs/deployments-protocol-27-2026-07-09.md).
 */
const OZ_ACCOUNT_WASM_HASH = "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";

const VERIFIER_WASM = fileURLToPath(
  new URL("../../target/wasm32v1-none/release/paso_evm_verifier.wasm", import.meta.url),
);

const XLM = Asset.native().contractId(PASSPHRASE);
const STROOPS_PER_XLM = 10_000_000n;
const FUNDING = 10n * STROOPS_PER_XLM;
const PAYMENT = 1n * STROOPS_PER_XLM;

const VALIDITY_SECONDS = 60;
const SIGNATURE_VALIDITY_LEDGERS = 120;
const SUBMISSIONS = 3;

const server = new rpc.Server(RPC_URL);

function cli(args: string[], input?: string): string {
  return execFileSync("stellar", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const line = (label: string, text: string) => console.log(`  ${label.padEnd(18)}${text}`);
const txUrl = (txHash: string) => `${EXPLORER}/tx/${txHash}`;
const contractUrl = (id: string) => `${EXPLORER}/contract/${id}`;
const xlm = (stroops: bigint) => `${Number(stroops) / Number(STROOPS_PER_XLM)} XLM`;
const address = (strkey: string) => Address.fromString(strkey).toScVal();

function transaction(source: Account, operation: xdr.Operation): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(VALIDITY_SECONDS)
    .build();
}

/** Has the identity sign the envelope. The secret key stays with stellar-cli. */
function signEnvelope(tx: Transaction): Transaction {
  const signed = cli(["tx", "sign", "--sign-with-key", IDENTITY, "--network", NETWORK, "--quiet"], tx.toXDR());
  return TransactionBuilder.fromXDR(signed, PASSPHRASE) as Transaction;
}

/** Simulates, signs, sends and waits for one operation from the fee payer. Prints the transaction. */
async function send(
  payer: string,
  what: string,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const tx = transaction(await server.getAccount(payer), operation);
    const simulation = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed (${what}): ${simulation.error}`);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new Error(`Ledger entries this call needs are archived and have to be restored first (${what})`);
    }

    const ready = signEnvelope(rpc.assembleTransaction(tx, simulation).build());
    const sent = await server.sendTransaction(ready);
    if (sent.status === "ERROR") {
      const reason = sent.errorResult?.result.type ?? "no reason given";
      // Someone else sent from the fee payer's account in the meantime.
      if (reason === "txBadSeq" && attempt < SUBMISSIONS) continue;
      throw new Error(`The network did not take the transaction (${what}): ${reason}`);
    }

    const result = await server.pollTransaction(sent.hash, { attempts: 45, sleepStrategy: rpc.BasicSleepStrategy });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`The transaction failed (${what}): ${result.status} ${txUrl(sent.hash)}`);
    }
    line(what, `tx ${sent.hash}`);
    line("", txUrl(sent.hash));
    return result;
  }
}

/** Calls a read-only contract function through simulation. */
async function read(payer: string, contract: string, fn: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const simulation = await server.simulateTransaction(
    transaction(new Account(payer, "0"), new Contract(contract).call(fn, ...args)),
  );
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`Could not read ${fn} of ${contract}`);
  }
  return simulation.result.retval;
}

async function exists(key: xdr.LedgerKey): Promise<boolean> {
  return (await server.getLedgerEntries(key)).entries.length > 0;
}

const codeKey = (wasmHash: Uint8Array) =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash) }));

/** Id of the contract `deployer` creates with `salt`. */
function contractId(deployer: string, salt: Uint8Array): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(PASSPHRASE)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt: Buffer.from(salt),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

async function deploy(
  payer: string,
  what: string,
  wasmHash: Uint8Array,
  salt: Uint8Array,
  constructorArgs: xdr.ScVal[],
): Promise<string> {
  const result = await send(
    payer,
    what,
    Operation.createCustomContract({
      address: Address.fromString(payer),
      wasmHash: Buffer.from(wasmHash),
      salt: Buffer.from(salt),
      constructorArgs,
    }),
  );
  const id = Address.fromScVal(result.returnValue!).toString();
  if (id !== contractId(payer, salt)) {
    throw new Error(`Deployed ${id}, expected ${contractId(payer, salt)}`);
  }
  return id;
}

/** `transfer(from, to, amount)` on the native asset contract. */
function transfer(from: string, to: string, amount: bigint, auth?: xdr.SorobanAuthorizationEntry[]): xdr.Operation {
  return Operation.invokeContractFunction({
    contract: XLM,
    function: "transfer",
    args: [address(from), address(to), nativeToScVal(amount, { type: "i128" })],
    auth,
  });
}

async function balance(payer: string, of: string): Promise<bigint> {
  return scValToNative(await read(payer, XLM, "balance", address(of))) as bigint;
}

async function main(): Promise<void> {
  const { passphrase } = await server.getNetwork();
  if (passphrase !== PASSPHRASE) {
    throw new Error(`${RPC_URL} is not Stellar testnet`);
  }
  const payer = cli(["keys", "public-key", IDENTITY]);

  console.log("Stellar testnet");
  line("fee payer", `${payer} (stellar-cli identity ${IDENTITY})`);

  console.log("\n1. Verifier");
  const wasm = readFileSync(VERIFIER_WASM);
  const wasmHash = hash(wasm);
  line("wasm", `${wasm.length} bytes, hash ${Buffer.from(wasmHash).toString("hex")}`);
  if (await exists(codeKey(wasmHash))) {
    line("upload", "this wasm is already on the network");
  } else {
    await send(payer, "upload", Operation.uploadContractWasm({ wasm }));
  }
  // One instance per deployer and build: the salt is the wasm hash.
  let verifier = contractId(payer, wasmHash);
  if (await exists(new Contract(verifier).getFootprint())) {
    line("deploy", "already deployed by this identity from this wasm");
  } else {
    verifier = await deploy(payer, "deploy", wasmHash, wasmHash, []);
  }
  line("contract", verifier);
  line("", contractUrl(verifier));

  console.log("\n2. OpenZeppelin smart account");
  const ethereum = privateKeyToAccount(generatePrivateKey());
  line("Ethereum signer", `${ethereum.address} (key generated for this run)`);
  line("account wasm", OZ_ACCOUNT_WASM_HASH);
  if (!(await exists(codeKey(Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"))))) {
    throw new Error(`The OpenZeppelin account wasm ${OZ_ACCOUNT_WASM_HASH} is not on testnet`);
  }
  const signer = ethereumSigner(verifier, ethereum.address);
  const account = await deploy(payer, "deploy", Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"), randomBytes(32), [
    xdr.ScVal.scvVec([signer]),
    xdr.ScVal.scvMap([]),
  ]);
  line("contract", account);
  line("", contractUrl(account));

  const rule = scValToNative(
    await read(payer, account, "get_context_rule", xdr.ScVal.scvU32(DEFAULT_CONTEXT_RULE)),
  ) as { name: string; context_type: unknown[]; signers: [string, string, Uint8Array][]; policies: string[] };
  const [listed] = rule.signers;
  if (
    rule.signers.length !== 1 ||
    rule.policies.length !== 0 ||
    listed?.[0] !== "External" ||
    listed[1] !== verifier ||
    toHex(listed[2]) !== ethereum.address.toLowerCase()
  ) {
    throw new Error("The account does not hold the signer it was deployed with");
  }
  line(
    `rule ${DEFAULT_CONTEXT_RULE}`,
    `"${rule.name}", ${String(rule.context_type[0])}, no policies, one signer: ` +
      `${listed[0]}(${listed[1]}, ${toHex(listed[2])})`,
  );

  console.log("\n3. Funding");
  await send(payer, `${xlm(FUNDING)} in`, transfer(payer, account, FUNDING));
  line("account holds", xlm(await balance(payer, account)));

  console.log("\n4. Transfer authorised by the Ethereum key");
  const unsigned = await server.simulateTransaction(
    transaction(await server.getAccount(payer), transfer(account, payer, PAYMENT)),
  );
  if (!rpc.Api.isSimulationSuccess(unsigned)) {
    throw new Error("Could not simulate the transfer out of the account");
  }
  const entries = unsigned.result?.auth ?? [];
  const [entry] = entries;
  if (!entry || entries.length !== 1 || entryAddress(entry) !== account) {
    throw new Error("Expected exactly one authorisation entry, for the account");
  }
  const validUntilLedger = unsigned.latestLedger + SIGNATURE_VALIDITY_LEDGERS;
  const payload = entryPayload(entry, validUntilLedger, NETWORK);
  const message = typedData(payload, NETWORK);
  line("call", `transfer(${account}, ${payer}, ${PAYMENT}) on ${XLM}`);
  line("entry", `${entry.credentials.type}, valid until ledger ${validUntilLedger}`);
  line("Soroban payload", signaturePayload(entry, validUntilLedger, NETWORK));
  line("account digest", `${payload} (what the account hands the verifier)`);
  line("wallet is shown", JSON.stringify({ domain: message.domain, message: message.message }));
  line("EIP-712 digest", hashTypedData(message));

  const as = { verifier, address: ethereum.address };
  const stranger = privateKeyToAccount(generatePrivateKey());
  const forged = attachSignature(entry, validUntilLedger, await signPayload(stranger, payload, NETWORK), as);
  const refusal = await server.simulateTransaction(
    transaction(await server.getAccount(payer), transfer(account, payer, PAYMENT, [forged])),
  );
  // 3003 is the account's ExternalVerificationFailed: its verifier answered no.
  if (!rpc.Api.isSimulationError(refusal) || !refusal.error.includes("Error(Contract, #3003)")) {
    throw new Error("A signature by another key was not refused by the account's signature check");
  }
  line("another key", "refused in simulation with the account's error #3003, nothing sent");

  const signature = await signPayload(ethereum, payload, NETWORK);
  line("signature", signature);
  const signed = attachSignature(entry, validUntilLedger, signature, as);

  const before = await balance(payer, account);
  await send(payer, `${xlm(PAYMENT)} out`, transfer(account, payer, PAYMENT, [signed]));
  const after = await balance(payer, account);
  if (before - after !== PAYMENT) {
    throw new Error(`The account's balance moved by ${before - after}, expected ${PAYMENT}`);
  }
  line("account holds", `${xlm(after)}, was ${xlm(before)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
