#!/usr/bin/env bash
#
# Deploys Paso to a Stellar network: builds both contracts, uploads their code,
# deploys the hub and records the result in deployments/<network>.json.
#
#   scripts/deploy.sh <testnet|mainnet>
#
# Before anything is sent, every step is simulated and the fees are printed in
# XLM. Code that is on chain already is not uploaded again, so a run that
# stopped half way can be repeated without paying twice.
#
#   PASO_DEPLOYER          stellar-cli identity that pays and deploys. Defaults to
#                          paso-deployer on testnet and paso-mainnet on mainnet.
#   PASO_CONFIRM_MAINNET   Mainnet only: the printed total in whole XLM, rounded
#                          up. Without it the script stops after printing the
#                          plan, and it never spends more than this.
#
# Mainnet takes only the build that runs on testnet: the account code has to
# hash to the value in deployments/testnet.json and the hub code to the code of
# the testnet hub. Anything else stops the script before a single upload.
#
# Every account address is derived from the hub's address, so a new hub means
# new addresses for everyone. Run this once per network.

set -euo pipefail

cd "$(dirname "$0")/.."

NETWORK="${1:-}"
case "$NETWORK" in
  testnet) DEFAULT_DEPLOYER=paso-deployer ;;
  mainnet) DEFAULT_DEPLOYER=paso-mainnet ;;
  *)
    echo "Usage: scripts/deploy.sh <testnet|mainnet>" >&2
    exit 2
    ;;
esac

SOURCE="${PASO_DEPLOYER:-$DEFAULT_DEPLOYER}"
DEPLOYMENT="deployments/$NETWORK.json"
WASM_DIR=target/wasm32v1-none/release
STROOPS_PER_XLM=10000000

field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' \
    "$DEPLOYMENT" "$1"
}

RPC_URL="$(field rpcUrl)"
NETWORK_PASSPHRASE="$(field networkPassphrase)"
USDC="$(field usdc)"
TOKEN_MESSENGER="$(field tokenMessenger)"
RECORDED_HUB="$(field hub)"

network=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

if [[ "$NETWORK" == mainnet && -n "$RECORDED_HUB" ]]; then
  echo "$DEPLOYMENT already names the hub $RECORDED_HUB." >&2
  echo "A second hub would give every owner a different address, so there is nothing to deploy." >&2
  exit 1
fi

DEPLOYER="$(stellar keys public-key "$SOURCE")"

# The build already optimises both files, so they are uploaded as built.
echo "Building contracts"
stellar contract build

PLAN="$(mktemp)"
trap 'rm -f "$PLAN"' EXIT

plan() {
  pnpm exec tsx scripts/deploy-plan.ts "$NETWORK" "$DEPLOYER" "$PLAN"
}

planned() {
  sed -n "s/^$1=//p" "$PLAN"
}

plan
ACCOUNT_WASM_HASH="$(planned ACCOUNT_WASM_HASH)"
HUB_WASM_HASH="$(planned HUB_WASM_HASH)"
UPLOADS=$(($(planned TOTAL) - $(planned HUB_FEE)))

LIMIT=""
if [[ "$NETWORK" == mainnet ]]; then
  CONFIRM="$(planned TOTAL_XLM_ROUNDED_UP)"
  if [[ "${PASO_CONFIRM_MAINNET:-}" != "$CONFIRM" ]]; then
    echo
    echo "Nothing was sent. This spends real XLM: to go ahead, run"
    echo
    echo "    PASO_CONFIRM_MAINNET=$CONFIRM scripts/deploy.sh mainnet"
    exit 3
  fi
  LIMIT=$((CONFIRM * STROOPS_PER_XLM))
fi

if [[ "$(planned FUNDED)" != yes ]]; then
  echo
  echo "Nothing was sent: $DEPLOYER ($SOURCE) does not hold enough XLM for the plan above." >&2
  exit 1
fi

upload() {
  local name="$1" expected="$2" uploaded
  echo "Uploading the $name code as $SOURCE"
  uploaded="$(
    stellar contract upload \
      --wasm "$WASM_DIR/paso_$name.wasm" \
      --optimize=false \
      --source-account "$SOURCE" \
      "${network[@]}"
  )"
  if [[ "$uploaded" != "$expected" ]]; then
    echo "The network stored $uploaded, not the $expected that was built." >&2
    exit 1
  fi
}

echo
if [[ "$(planned ACCOUNT_ON_CHAIN)" == yes ]]; then
  echo "The account code is on chain already"
else
  upload account "$ACCOUNT_WASM_HASH"
fi
if [[ "$(planned HUB_ON_CHAIN)" == yes ]]; then
  echo "The hub code is on chain already"
else
  upload hub "$HUB_WASM_HASH"
fi

# With its code on chain the hub deployment can be simulated exactly. The
# endpoint can take a few ledgers to show code that was just uploaded.
for _ in 1 2 3 4 5 6; do
  plan
  if [[ "$(planned HUB_ON_CHAIN)" == yes && "$(planned ACCOUNT_ON_CHAIN)" == yes ]]; then
    break
  fi
  sleep 5
done
if [[ "$(planned HUB_ON_CHAIN)" != yes || "$(planned ACCOUNT_ON_CHAIN)" != yes ]]; then
  echo "The uploaded code is not visible on chain yet. Run the script again: nothing is uploaded twice." >&2
  exit 1
fi
if [[ -n "$LIMIT" ]] && ((UPLOADS + $(planned HUB_FEE) > LIMIT)); then
  echo "Deploying the hub would take the run past the $PASO_CONFIRM_MAINNET XLM that were confirmed." >&2
  echo "Nothing more was sent. Run the script again to see the new total and confirm it." >&2
  exit 1
fi

echo
echo "Deploying the hub"
HUB="$(
  stellar contract deploy \
    --wasm-hash "$HUB_WASM_HASH" \
    --source-account "$SOURCE" \
    "${network[@]}" \
    -- \
    --account_wasm "$ACCOUNT_WASM_HASH" \
    --usdc "$USDC" \
    --token_messenger "$TOKEN_MESSENGER"
)"
echo "  hub: $HUB"

node -e '
  const fs = require("fs");
  const [file, hub, accountWasmHash] = process.argv.slice(1);
  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(deployment, { hub, accountWasmHash, deployedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
' "$DEPLOYMENT" "$HUB" "$ACCOUNT_WASM_HASH"
echo "Wrote $DEPLOYMENT"

# The SDK carries the deployment file inside its build.
echo "Rebuilding the SDK"
pnpm build:sdk
