/**
 * What deploying Paso to a network costs, worked out without sending anything.
 *
 *   tsx scripts/deploy-plan.ts <testnet|mainnet> <deployer G…> [plan file]
 *
 * It checks the built contracts, looks up which of them are on chain already,
 * simulates every step that is left and prints the fees in XLM. When the
 * network has a hub on record it reads that hub back from the chain and says
 * whether it is what the record claims. Simulation needs no key and no funded
 * account, so the plan can be read before the deployer holds anything.
 *
 * `scripts/deploy.sh` runs this first and reads the figures back from the
 * plan file, one `NAME=value` per line. The file is written only when every
 * figure in it is known: a plan that could not be worked out leaves none.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Address, Contract, hash, Operation, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";
import { NETWORKS, renderArg, type NetworkName } from "../packages/sdk/src/index";
import { describe, formatXlm, MINIMUM_BALANCE, simulatedFee, STROOPS_PER_XLM, xlmBalance } from "./fees";

const WASM_DIR = "target/wasm32v1-none/release";
/**
 * Creating the hub cannot be simulated until its code is on chain. Until then
 * the plan counts this much for it, and the deployment is simulated exactly
 * before it is sent.
 */
const HUB_DEPLOYMENT_CEILING = STROOPS_PER_XLM / 4n;
/** An endpoint that has just taken an upload can refuse a simulation for a moment. */
const ATTEMPTS = 4;
const RETRY_MS = 3000;

interface Step {
  label: string;
  /** Fee in stroops; zero when there is nothing to send. */
  fee: bigint;
  note: string;
}

const hex = (bytes: Uint8Array): string => toHex(bytes).slice(2);

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Asks the endpoint again when it fails, and reports the last failure in words when it keeps failing. */
async function asking<T>(what: string, ask: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await ask();
    } catch (error) {
      last = error;
      if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, RETRY_MS));
    }
  }
  throw new Error(`Could not ${what}: ${describe(last)}`);
}

async function codeOnChain(server: rpc.Server, wasmHash: Uint8Array): Promise<boolean> {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  const { entries } = await asking("look the contract code up", () => server.getLedgerEntries(key));
  return entries.length > 0;
}

/** The code a deployed hub runs and the three settings it was constructed with, read from its ledger entry. */
async function hubOnChain(server: rpc.Server, hub: string): Promise<{ code: string; config: Record<string, string> } | null> {
  if (!StrKey.isValidContract(hub)) fail(`${hub} is not a contract id`);
  const { entries } = await asking("look the hub up", () => server.getLedgerEntries(new Contract(hub).getFootprint()));
  const data = entries[0]?.val;
  if (data?.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") return null;
  const { executable, storage } = data.contractData.val.instance;
  const config: Record<string, string> = {};
  for (const { key, val } of storage ?? []) {
    if (renderArg(key) !== "config" || val.type !== "scvMap") continue;
    for (const field of val.map ?? []) {
      config[renderArg(field.key)] = renderArg(field.val);
    }
  }
  return {
    code: executable.type === "contractExecutableWasm" ? hex(executable.wasmHash.toBytes()) : "none",
    config,
  };
}

async function main(): Promise<void> {
  const [name, deployer, planFile] = process.argv.slice(2);
  if ((name !== "testnet" && name !== "mainnet") || !deployer || !StrKey.isValidEd25519PublicKey(deployer)) {
    console.error("Usage: tsx scripts/deploy-plan.ts <testnet|mainnet> <deployer G…> [plan file]");
    process.exit(2);
  }
  const network: NetworkName = name;
  const { stellar } = NETWORKS[network];
  const server = new rpc.Server(stellar.rpcUrl);

  const accountWasm = readFileSync(`${WASM_DIR}/paso_account.wasm`);
  const hubWasm = readFileSync(`${WASM_DIR}/paso_hub.wasm`);
  const accountWasmHash = hash(accountWasm);
  const hubWasmHash = hash(hubWasm);

  console.log(`\nPaso on ${network}, deployed by ${deployer}\n`);
  console.log(`    account code   ${hex(accountWasmHash)}  (${accountWasm.length} bytes)`);
  console.log(`    hub code       ${hex(hubWasmHash)}  (${hubWasm.length} bytes)`);

  // Mainnet gets the code that runs on testnet, byte for byte, and nothing else.
  if (network === "mainnet") {
    const tested = NETWORKS.testnet.stellar;
    if (hex(accountWasmHash) !== tested.accountWasmHash) {
      fail(
        `The account code built here is not the one deployed on testnet (${tested.accountWasmHash}).\n` +
          "Mainnet takes the tested build only: check out the commit that was deployed to testnet and build again.",
      );
    }
    const testedHub = await hubOnChain(new rpc.Server(tested.rpcUrl), tested.hub);
    if (hex(hubWasmHash) !== testedHub?.code) {
      fail(
        `The hub code built here is not the one running at the testnet hub ${tested.hub} (${testedHub?.code ?? "no hub there"}).\n` +
          "Mainnet takes the tested build only: check out the commit that was deployed to testnet and build again.",
      );
    }
    console.log("                   both are the build that runs on testnet");
  }

  // A hub on record is read back: the record is only worth what the chain says.
  let recordedHub = "";
  if (stellar.hub !== "") {
    const hub = await hubOnChain(server, stellar.hub);
    const expected: Record<string, string> = {
      account_wasm: `0x${stellar.accountWasmHash}`,
      usdc: stellar.usdc,
      token_messenger: stellar.tokenMessenger,
    };
    console.log(`\n    hub on record  ${stellar.hub}`);
    if (!hub) {
      fail(`deployments/${network}.json names the hub ${stellar.hub}, and there is no contract at that address on ${network}.`);
    }
    const wrong = Object.keys(expected).filter((field) => hub.config[field] !== expected[field]);
    console.log(`                   runs ${hub.code}${hub.code === hex(hubWasmHash) ? ", the hub code built here" : ", which is NOT the hub code built here"}`);
    for (const field of Object.keys(expected)) {
      console.log(`                   ${field.padEnd(15)} ${hub.config[field] ?? "missing"}${wrong.includes(field) ? `   NOT the ${expected[field]} on record` : ""}`);
    }
    if (wrong.length > 0 || stellar.accountWasmHash !== hex(accountWasmHash)) {
      fail(`The hub at ${stellar.hub} is not what deployments/${network}.json and this build describe. Nothing can be deployed over it.`);
    }
    recordedHub = stellar.hub;
  }

  const simulate = (what: string, operation: xdr.Operation): Promise<bigint> =>
    asking(`simulate ${what}`, () => simulatedFee(server, stellar.networkPassphrase, deployer, operation));

  const upload = async (label: string, wasm: Buffer, onChain: boolean): Promise<Step> =>
    onChain
      ? { label, fee: 0n, note: "on chain already, nothing to send" }
      : { label, fee: await simulate(label.replace("upload", "the upload of"), Operation.uploadContractWasm({ wasm })), note: "simulated" };

  const accountOnChain = await codeOnChain(server, accountWasmHash);
  const hubCodeOnChain = await codeOnChain(server, hubWasmHash);
  const steps: Step[] = [
    await upload("upload the account code", accountWasm, accountOnChain),
    await upload("upload the hub code", hubWasm, hubCodeOnChain),
  ];

  // On mainnet a hub on record is final: every account address follows from it.
  const settled = network === "mainnet" && recordedHub !== "";
  let hubFee = HUB_DEPLOYMENT_CEILING;
  let hubNote = "ceiling: simulated exactly once the hub code is on chain";
  if (settled) {
    hubFee = 0n;
    hubNote = "deployed already, nothing to send";
  } else if (hubCodeOnChain) {
    hubFee = await simulate(
      "the deployment of the hub",
      Operation.createCustomContract({
        address: new Address(deployer),
        wasmHash: hubWasmHash,
        constructorArgs: [
          xdr.ScVal.scvBytes(accountWasmHash),
          new Address(stellar.usdc).toScVal(),
          new Address(stellar.tokenMessenger).toScVal(),
        ],
      }),
    );
    hubNote = recordedHub ? "simulated: a new hub, which replaces the one on record" : "simulated";
  }
  steps.push({ label: "deploy the hub", fee: hubFee, note: hubNote });

  const total = steps.reduce((sum, step) => sum + step.fee, 0n);
  const width = Math.max(...steps.map((step) => step.label.length));
  console.log("");
  for (const { label, fee, note } of steps) {
    console.log(`    ${label.padEnd(width)}  ${formatXlm(fee).padStart(16)}   ${note}`);
  }
  console.log(`    ${"total".padEnd(width)}  ${formatXlm(total).padStart(16)}`);

  const needed = total + MINIMUM_BALANCE;
  const balance = await asking("read the deployer's balance", () => xlmBalance(server, deployer));
  const holds = balance === null ? "does not exist on chain yet" : `holds ${formatXlm(balance)}`;
  console.log(`\n    ${deployer} ${holds}.`);
  console.log(
    total === 0n
      ? "    Nothing is left to send."
      : `    It needs ${formatXlm(needed)}: the total, and the ${formatXlm(MINIMUM_BALANCE)} every account keeps.`,
  );

  if (planFile) {
    const plan = {
      ACCOUNT_WASM_HASH: hex(accountWasmHash),
      HUB_WASM_HASH: hex(hubWasmHash),
      ACCOUNT_ON_CHAIN: accountOnChain ? "yes" : "no",
      HUB_ON_CHAIN: hubCodeOnChain ? "yes" : "no",
      ACCOUNT_UPLOAD_FEE: steps[0]!.fee,
      HUB_UPLOAD_FEE: steps[1]!.fee,
      HUB_FEE: hubFee,
      TOTAL: total,
      TOTAL_XLM_ROUNDED_UP: (total + STROOPS_PER_XLM - 1n) / STROOPS_PER_XLM,
      FUNDED: balance !== null && balance >= needed ? "yes" : "no",
      SETTLED: settled ? "yes" : "no",
    };
    writeFileSync(planFile, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => fail(describe(error)),
);
