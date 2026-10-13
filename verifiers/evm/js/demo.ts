/**
 * Ethereum keys sign for an OpenZeppelin smart account, on Stellar testnet.
 *
 *   npm run demo
 *
 * The run:
 *
 * 1. uploads and deploys the verifier built by `stellar contract build`, or
 *    finds the instance an earlier run deployed from the same wasm;
 * 2. creates an OpenZeppelin smart account with an Ethereum signer from the
 *    start. A signer's key data names its account, so the account's address
 *    is computed from the deployer and a salt before anything is deployed.
 *    The account code is the wasm `stellar/smart-account-kit` publishes on
 *    testnet;
 * 3. sends the account 10 XLM;
 * 4. has the Ethereum key authorise a transfer of 1 XLM out of the account.
 *    Two wrong signatures are simulated first and have to be refused: one by
 *    another key, and one by the right key made for another account;
 * 5. adds a second Ethereum signer to the account, which now exists. The
 *    first key authorises the call;
 * 6. has both keys authorise another transfer. One signature alone is
 *    simulated first and has to be refused.
 *
 * The Ethereum keys are generated here, live for this run only and are
 * never printed. Every transaction is sent and paid by a stellar-cli
 * identity, which signs the envelopes itself: `PASO_DEPLOYER`, default
 * `paso-deployer`. Create one with
 * `stellar keys generate <name> --network testnet --fund`. This script reads
 * no key from disk. Testnet only.
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
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { hashTypedData, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { contractId, keyData, NETWORK_PASSPHRASES, signPayload, typedData } from "./src/index";
import {
  attachSignatures,
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

/** The account's errors a refusal is expected to carry. */
const EXTERNAL_VERIFICATION_FAILED = 3003;
const UNVALIDATED_CONTEXT = 3002;

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

/** Deploys `wasmHash` with `salt` from the fee payer and checks it landed where `contractId` said. */
async function deploy(
  payer: string,
  what: string,
  wasmHash: Uint8Array,
  salt: Uint8Array,
  constructorArgs: xdr.ScVal[],
): Promise<string> {
  const expected = contractId(payer, salt, NETWORK);
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
  if (id !== expected) {
    throw new Error(`Deployed ${id}, expected ${expected}`);
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

type ListedSigner = [kind: string, verifier: string, keyData: Uint8Array];

/** Reads the account's default rule and checks it holds exactly these Ethereum signers, in this order. */
async function showRule(payer: string, account: string, verifier: string, signers: PrivateKeyAccount[]): Promise<void> {
  const rule = scValToNative(
    await read(payer, account, "get_context_rule", xdr.ScVal.scvU32(DEFAULT_CONTEXT_RULE)),
  ) as { name: string; context_type: unknown[]; signers: ListedSigner[]; policies: string[] };
  const expected = signers.map((signer) => keyData(signer.address, account));
  const listed = rule.signers.map(([, , data]) => toHex(data));
  if (
    rule.policies.length !== 0 ||
    rule.signers.some(([kind, by]) => kind !== "External" || by !== verifier) ||
    listed.length !== expected.length ||
    listed.some((data, index) => data !== expected[index])
  ) {
    throw new Error("The account does not hold the signers it was given");
  }
  line(`rule ${DEFAULT_CONTEXT_RULE}`, `"${rule.name}", ${String(rule.context_type[0])}, no policies, signers:`);
  for (const data of listed) {
    line("", `External(verifier, ${data.slice(0, 42)} ‖ ${data.slice(42)})`);
  }
}

/**
 * The one entry simulation asks `account` to sign for `operation`, and the
 * ledger its signatures will be valid until.
 */
async function entryFor(
  payer: string,
  account: string,
  operation: xdr.Operation,
): Promise<{ entry: xdr.SorobanAuthorizationEntry; validUntilLedger: number }> {
  const simulation = await server.simulateTransaction(transaction(await server.getAccount(payer), operation));
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error("Could not simulate the call the account is to authorise");
  }
  const entries = simulation.result?.auth ?? [];
  const [entry] = entries;
  if (!entry || entries.length !== 1 || entryAddress(entry) !== account) {
    throw new Error("Expected exactly one authorisation entry, for the account");
  }
  return { entry, validUntilLedger: simulation.latestLedger + SIGNATURE_VALIDITY_LEDGERS };
}

/** Simulates `operation` and requires the account to refuse it with `code`. Nothing is sent. */
async function expectRefusal(payer: string, operation: xdr.Operation, code: number, what: string): Promise<void> {
  const simulation = await server.simulateTransaction(transaction(await server.getAccount(payer), operation));
  if (!rpc.Api.isSimulationError(simulation) || !simulation.error.includes(`Error(Contract, #${code})`)) {
    throw new Error(`Not refused by the account with error ${code}: ${what}`);
  }
  line("refused", `${what}: account error #${code} in simulation, nothing sent`);
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
  const verifier = contractId(payer, wasmHash, NETWORK);
  if (await exists(new Contract(verifier).getFootprint())) {
    line("deploy", "already deployed by this identity from this wasm");
  } else {
    await deploy(payer, "deploy", wasmHash, wasmHash, []);
  }
  line("contract", verifier);
  line("", contractUrl(verifier));

  console.log("\n2. Account created with its signer");
  const first = privateKeyToAccount(generatePrivateKey());
  line("Ethereum signer", `${first.address} (key generated for this run)`);
  line("account wasm", OZ_ACCOUNT_WASM_HASH);
  if (!(await exists(codeKey(Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"))))) {
    throw new Error(`The OpenZeppelin account wasm ${OZ_ACCOUNT_WASM_HASH} is not on testnet`);
  }
  const salt = randomBytes(32);
  const account = contractId(payer, salt, NETWORK);
  line("account", `${account} (computed from the deployer and a salt; not deployed yet)`);
  line("key data", `${first.address.toLowerCase()} ‖ ${keyData(first.address, account).slice(42)}`);
  const deployed = await deploy(payer, "deploy", Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"), salt, [
    xdr.ScVal.scvVec([ethereumSigner(verifier, first.address, account)]),
    xdr.ScVal.scvMap([]),
  ]);
  line("contract", `${deployed}, as computed`);
  line("", contractUrl(deployed));
  await showRule(payer, account, verifier, [first]);

  console.log("\n3. Funding");
  await send(payer, `${xlm(FUNDING)} in`, transfer(payer, account, FUNDING));
  line("account holds", xlm(await balance(payer, account)));

  /** The signature of each key over `payload`, made for this account. */
  const signatures = (payload: Hex, keys: PrivateKeyAccount[], madeFor = account) =>
    Promise.all(
      keys.map(async (key) => ({ address: key.address, signature: await signPayload(key, madeFor, payload, NETWORK) })),
    );

  console.log("\n4. Transfer authorised by the Ethereum key");
  {
    const { entry, validUntilLedger } = await entryFor(payer, account, transfer(account, payer, PAYMENT));
    const payload = entryPayload(entry, validUntilLedger, NETWORK);
    const message = typedData(account, payload, NETWORK);
    const attach = (signed: { address: `0x${string}`; signature: Hex }[]) =>
      transfer(account, payer, PAYMENT, [attachSignatures(entry, validUntilLedger, verifier, signed)]);
    line("call", `transfer(${account}, ${payer}, ${PAYMENT}) on ${XLM}`);
    line("entry", `${entry.credentials.type}, valid until ledger ${validUntilLedger}`);
    line("Soroban payload", signaturePayload(entry, validUntilLedger, NETWORK));
    line("account digest", `${payload} (what the account hands the verifier)`);
    line("wallet is shown", JSON.stringify({ domain: message.domain, message: message.message }));
    line("EIP-712 digest", hashTypedData(message));

    const stranger = privateKeyToAccount(generatePrivateKey());
    const [byStranger] = await signatures(payload, [stranger]);
    await expectRefusal(
      payer,
      attach([{ address: first.address, signature: byStranger!.signature }]),
      EXTERNAL_VERIFICATION_FAILED,
      "the same message signed by another key",
    );
    const elsewhere = contractId(payer, randomBytes(32), NETWORK);
    await expectRefusal(
      payer,
      attach(await signatures(payload, [first], elsewhere)),
      EXTERNAL_VERIFICATION_FAILED,
      `the same payload signed by the right key for another account, ${elsewhere}`,
    );

    const signed = await signatures(payload, [first]);
    line("signature", signed[0]!.signature);
    const before = await balance(payer, account);
    await send(payer, `${xlm(PAYMENT)} out`, attach(signed));
    const after = await balance(payer, account);
    if (before - after !== PAYMENT) {
      throw new Error(`The account's balance moved by ${before - after}, expected ${PAYMENT}`);
    }
    line("account holds", `${xlm(after)}, was ${xlm(before)}`);
  }

  console.log("\n5. Second signer added to the existing account");
  const second = privateKeyToAccount(generatePrivateKey());
  {
    line("Ethereum signer", `${second.address} (key generated for this run)`);
    line("key data", `${second.address.toLowerCase()} ‖ ${keyData(second.address, account).slice(42)}`);
    const addSigner = (auth?: xdr.SorobanAuthorizationEntry[]) =>
      Operation.invokeContractFunction({
        contract: account,
        function: "add_signer",
        args: [xdr.ScVal.scvU32(DEFAULT_CONTEXT_RULE), ethereumSigner(verifier, second.address, account)],
        auth,
      });
    const { entry, validUntilLedger } = await entryFor(payer, account, addSigner());
    const payload = entryPayload(entry, validUntilLedger, NETWORK);
    line("call", `add_signer(${DEFAULT_CONTEXT_RULE}, External(verifier, key data)) on the account itself`);
    line("account digest", payload);
    const attach = (signed: { address: `0x${string}`; signature: Hex }[]) =>
      addSigner([attachSignatures(entry, validUntilLedger, verifier, signed)]);

    // The key being added cannot let itself in.
    const [bySecond] = await signatures(payload, [second]);
    await expectRefusal(
      payer,
      attach([{ address: first.address, signature: bySecond!.signature }]),
      EXTERNAL_VERIFICATION_FAILED,
      "signed by the key being added",
    );
    await send(payer, "add_signer", attach(await signatures(payload, [first])));
    await showRule(payer, account, verifier, [first, second]);
  }

  console.log("\n6. Transfer authorised by both keys");
  {
    const { entry, validUntilLedger } = await entryFor(payer, account, transfer(account, payer, PAYMENT));
    const payload = entryPayload(entry, validUntilLedger, NETWORK);
    const attach = (signed: { address: `0x${string}`; signature: Hex }[]) =>
      transfer(account, payer, PAYMENT, [attachSignatures(entry, validUntilLedger, verifier, signed)]);
    line("account digest", payload);

    // The rule has no policy, so it takes every signer it lists.
    await expectRefusal(
      payer,
      attach(await signatures(payload, [first])),
      UNVALIDATED_CONTEXT,
      "signed by the first key alone",
    );
    const before = await balance(payer, account);
    await send(payer, `${xlm(PAYMENT)} out`, attach(await signatures(payload, [first, second])));
    const after = await balance(payer, account);
    if (before - after !== PAYMENT) {
      throw new Error(`The account's balance moved by ${before - after}, expected ${PAYMENT}`);
    }
    line("account holds", `${xlm(after)}, was ${xlm(before)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
