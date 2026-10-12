/**
 * What deploying Paso to a network costs, worked out without sending anything.
 *
 *   tsx scripts/deploy-plan.ts <testnet|mainnet> <deployer G…> [plan file]
 *
 * It checks the built contracts, looks up which of them are on chain already,
 * simulates every step that is left and prints the fees in XLM. Simulation
 * needs no key and no funded account, so the plan can be read before the
 * deployer holds anything.
 *
 * `scripts/deploy.sh` runs this first and reads the figures back from the
 * plan file, one `NAME=value` per line.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Address, hash, Operation, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";
import { NETWORKS, type NetworkName } from "../packages/sdk/src/index";
import { formatXlm, MINIMUM_BALANCE, simulatedFee, STROOPS_PER_XLM, xlmBalance } from "./fees";

const WASM_DIR = "target/wasm32v1-none/release";
/**
 * Creating the hub cannot be simulated until its code is on chain. Until then
 * the plan counts this much for it, and the deployment is simulated exactly
 * before it is sent.
 */
const HUB_DEPLOYMENT_CEILING = STROOPS_PER_XLM / 4n;

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

async function codeOnChain(server: rpc.Server, wasmHash: Uint8Array): Promise<boolean> {
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  const { entries } = await server.getLedgerEntries(key);
  return entries.length > 0;
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
    const { executable } = await new rpc.Server(tested.rpcUrl).getContractInstance(tested.hub);
    const testedHub = executable.type === "contractExecutableWasm" ? hex(executable.wasmHash.toBytes()) : "none";
    if (hex(hubWasmHash) !== testedHub) {
      fail(
        `The hub code built here is not the one running at the testnet hub ${tested.hub} (${testedHub}).\n` +
          "Mainnet takes the tested build only: check out the commit that was deployed to testnet and build again.",
      );
    }
    console.log("                   both are the build that runs on testnet");
  }

  const simulate = (operation: xdr.Operation): Promise<bigint> =>
    simulatedFee(server, stellar.networkPassphrase, deployer, operation);

  const upload = async (label: string, wasm: Buffer, onChain: boolean): Promise<Step> =>
    onChain
      ? { label, fee: 0n, note: "on chain already, nothing to send" }
      : { label, fee: await simulate(Operation.uploadContractWasm({ wasm })), note: "simulated" };

  const accountOnChain = await codeOnChain(server, accountWasmHash);
  const hubOnChain = await codeOnChain(server, hubWasmHash);
  const steps: Step[] = [
    await upload("upload the account code", accountWasm, accountOnChain),
    await upload("upload the hub code", hubWasm, hubOnChain),
  ];

  let hubFee = HUB_DEPLOYMENT_CEILING;
  if (hubOnChain) {
    hubFee = await simulate(
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
  }
  steps.push({
    label: "deploy the hub",
    fee: hubFee,
    note: hubOnChain ? "simulated" : "ceiling: simulated exactly once the hub code is on chain",
  });

  const total = steps.reduce((sum, step) => sum + step.fee, 0n);
  const width = Math.max(...steps.map((step) => step.label.length));
  console.log("");
  for (const { label, fee, note } of steps) {
    console.log(`    ${label.padEnd(width)}  ${formatXlm(fee).padStart(16)}   ${note}`);
  }
  console.log(`    ${"total".padEnd(width)}  ${formatXlm(total).padStart(16)}`);

  const needed = total + MINIMUM_BALANCE;
  const balance = await xlmBalance(server, deployer);
  const holds = balance === null ? "does not exist on chain yet" : `holds ${formatXlm(balance)}`;
  console.log(`\n    ${deployer} ${holds}.`);
  console.log(`    It needs ${formatXlm(needed)}: the total, and the ${formatXlm(MINIMUM_BALANCE)} every account keeps.`);

  if (planFile) {
    const plan = {
      ACCOUNT_WASM_HASH: hex(accountWasmHash),
      HUB_WASM_HASH: hex(hubWasmHash),
      ACCOUNT_ON_CHAIN: accountOnChain ? "yes" : "no",
      HUB_ON_CHAIN: hubOnChain ? "yes" : "no",
      HUB_FEE: hubFee,
      TOTAL: total,
      TOTAL_XLM_ROUNDED_UP: (total + STROOPS_PER_XLM - 1n) / STROOPS_PER_XLM,
      FUNDED: balance !== null && balance >= needed ? "yes" : "no",
    };
    writeFileSync(planFile, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
);
