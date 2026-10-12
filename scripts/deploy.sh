#!/usr/bin/env bash
#
# Deploys Paso to a Stellar network: builds both contracts, uploads their code,
# deploys the hub and records the result in deployments/<network>.json.
#
#   scripts/deploy.sh <testnet|mainnet>
#
# Before anything is sent, every step is simulated and the fees are printed in
# XLM. Code that is on chain already is not uploaded again, so a run that
# stopped half way can be repeated without paying twice. Once mainnet has a
# hub on record the script reads it back from the chain, prints what it found
# and sends nothing.
#
#   PASO_DEPLOYER          stellar-cli identity that pays and deploys. Defaults to
#                          paso-deployer on testnet and paso-mainnet on mainnet.
#   PASO_CONFIRM_MAINNET   Mainnet only: the printed total in whole XLM, rounded
#                          up. Without it the script stops after printing the
#                          plan.
#
# On mainnet the confirmed number is a limit on everything the run sends: both
# uploads and the hub deployment are counted against it, each right before it
# is sent, at its simulated fee. A step whose fee is unknown, a plan that could
# not be worked out, a limit that is missing or not a number: each of these
# stops the script before the next thing is sent.
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

die() {
  echo >&2
  echo "$*" >&2
  exit 1
}

field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' \
    "$DEPLOYMENT" "$1"
}

RPC_URL="$(field rpcUrl)"
NETWORK_PASSPHRASE="$(field networkPassphrase)"
USDC="$(field usdc)"
TOKEN_MESSENGER="$(field tokenMessenger)"

network=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

DEPLOYER="$(stellar keys public-key "$SOURCE")"

# The build already optimises both files, so they are uploaded as built.
echo "Building contracts"
stellar contract build

PLAN="$(mktemp)"
trap 'rm -f "$PLAN"' EXIT

# Works the plan out afresh. A plan that fails leaves an empty file behind,
# never the figures of an earlier one.
plan() {
  : > "$PLAN"
  pnpm exec tsx scripts/deploy-plan.ts "$NETWORK" "$DEPLOYER" "$PLAN"
}

planned() {
  sed -n "s/^$1=//p" "$PLAN"
}

# A figure of the plan in stroops. Anything but a whole number stops the script.
stroops() {
  local value
  value="$(planned "$1")"
  [[ "$value" =~ ^[0-9]{1,15}$ ]] || die "The plan has no usable $1 (\"$value\"). Nothing more is sent."
  printf '%s' "$value"
}

# The limit on what a mainnet run may send, in stroops. Empty until confirmed.
LIMIT=""
SENT=0

# Stands right before every command that spends, with the simulated fee of
# that command. On anything but testnet it stops the script unless the limit
# was confirmed, is a number, and covers what was sent so far plus this step.
authorise() {
  local what="$1" fee="$2"
  [[ "$fee" =~ ^[0-9]{1,15}$ ]] || die "The fee of $what is not known. Nothing more is sent."
  if [[ "$NETWORK" != testnet ]]; then
    [[ "${PASO_CONFIRM_MAINNET:-}" =~ ^[1-9][0-9]{0,5}$ ]] ||
      die "PASO_CONFIRM_MAINNET is not set to a whole number of XLM. Nothing more is sent."
    [[ "$LIMIT" =~ ^[1-9][0-9]{0,14}$ ]] || die "No spending limit was confirmed. Nothing more is sent."
    ((SENT + fee <= LIMIT)) ||
      die "$what would take the run past the $PASO_CONFIRM_MAINNET XLM that were confirmed. Nothing more is sent."
  fi
  SENT=$((SENT + fee))
}

plan || die "The plan could not be worked out. Nothing was sent."

if [[ "$(planned SETTLED)" == yes ]]; then
  echo
  echo "Paso is deployed on $NETWORK and matches $DEPLOYMENT. Nothing was sent."
  exit 0
fi
[[ "$(planned SETTLED)" == no ]] || die "The plan does not say whether $NETWORK has a hub already. Nothing was sent."

ACCOUNT_WASM_HASH="$(planned ACCOUNT_WASM_HASH)"
HUB_WASM_HASH="$(planned HUB_WASM_HASH)"
[[ "$ACCOUNT_WASM_HASH" =~ ^[0-9a-f]{64}$ && "$HUB_WASM_HASH" =~ ^[0-9a-f]{64}$ ]] ||
  die "The plan names no contract code. Nothing was sent."
ACCOUNT_UPLOAD_FEE="$(stroops ACCOUNT_UPLOAD_FEE)"
HUB_UPLOAD_FEE="$(stroops HUB_UPLOAD_FEE)"
HUB_FEE="$(stroops HUB_FEE)"
TOTAL="$(stroops TOTAL)"
((ACCOUNT_UPLOAD_FEE + HUB_UPLOAD_FEE + HUB_FEE == TOTAL)) || die "The plan does not add up. Nothing was sent."

if [[ "$NETWORK" != testnet ]]; then
  CONFIRM="$(stroops TOTAL_XLM_ROUNDED_UP)"
  ((CONFIRM >= 1 && CONFIRM * STROOPS_PER_XLM >= TOTAL)) || die "The plan's total in XLM is not usable. Nothing was sent."
  if [[ "${PASO_CONFIRM_MAINNET:-}" != "$CONFIRM" ]]; then
    echo
    echo "Nothing was sent. This spends real XLM: to go ahead, run"
    echo
    echo "    PASO_CONFIRM_MAINNET=$CONFIRM scripts/deploy.sh $NETWORK"
    exit 3
  fi
  LIMIT=$((CONFIRM * STROOPS_PER_XLM))
fi

[[ "$(planned FUNDED)" == yes ]] ||
  die "Nothing was sent: $DEPLOYER ($SOURCE) does not hold enough XLM for the plan above."

upload() {
  local name="$1" expected="$2" fee="$3" uploaded
  echo "Uploading the $name code as $SOURCE"
  authorise "Uploading the $name code" "$fee"
  uploaded="$(
    stellar contract upload \
      --wasm "$WASM_DIR/paso_$name.wasm" \
      --optimize=false \
      --source-account "$SOURCE" \
      "${network[@]}"
  )"
  [[ "$uploaded" == "$expected" ]] || die "The network stored $uploaded, not the $expected that was built."
}

echo
case "$(planned ACCOUNT_ON_CHAIN)" in
  yes) echo "The account code is on chain already" ;;
  no) upload account "$ACCOUNT_WASM_HASH" "$ACCOUNT_UPLOAD_FEE" ;;
  *) die "The plan does not say whether the account code is on chain. Nothing was sent." ;;
esac
case "$(planned HUB_ON_CHAIN)" in
  yes) echo "The hub code is on chain already" ;;
  no) upload hub "$HUB_WASM_HASH" "$HUB_UPLOAD_FEE" ;;
  *) die "The plan does not say whether the hub code is on chain. Nothing more is sent." ;;
esac

# With its code on chain the hub deployment can be simulated exactly. The
# endpoint can take a few ledgers to show code that was just uploaded, or to
# simulate against it.
for _ in 1 2 3 4 5 6; do
  if plan && [[ "$(planned HUB_ON_CHAIN)" == yes && "$(planned ACCOUNT_ON_CHAIN)" == yes ]]; then
    break
  fi
  sleep 5
done
[[ "$(planned HUB_ON_CHAIN)" == yes && "$(planned ACCOUNT_ON_CHAIN)" == yes ]] ||
  die "The hub deployment could not be planned against the uploaded code. Run the script again: nothing is uploaded twice."
[[ "$(planned ACCOUNT_WASM_HASH)" == "$ACCOUNT_WASM_HASH" && "$(planned HUB_WASM_HASH)" == "$HUB_WASM_HASH" ]] ||
  die "The contract code changed while the script ran. Nothing more is sent."
HUB_FEE="$(stroops HUB_FEE)"

echo
echo "Deploying the hub"
authorise "Deploying the hub" "$HUB_FEE"
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
