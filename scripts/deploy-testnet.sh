#!/usr/bin/env bash
#
# Deploys Paso to Stellar testnet: builds both contracts, uploads the account
# code, deploys the hub and records the result in deployments/testnet.json.
#
#   scripts/deploy-testnet.sh [identity]
#
# `identity` is a funded stellar-cli identity (default: paso-deployer). Create
# one with `stellar keys generate <name> --network testnet --fund`.
#
# Every account address is derived from the hub's address, so a new hub means
# new addresses for everyone. Run this once per network.

set -euo pipefail

cd "$(dirname "$0")/.."

SOURCE="${1:-paso-deployer}"
DEPLOYMENT=deployments/testnet.json
WASM_DIR=target/wasm32v1-none/release

field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' \
    "$DEPLOYMENT" "$1"
}

RPC_URL="$(field rpcUrl)"
NETWORK_PASSPHRASE="$(field networkPassphrase)"
USDC="$(field usdc)"
TOKEN_MESSENGER="$(field tokenMessenger)"

network=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

# The build already optimises both files, so they are uploaded as built.
echo "Building contracts"
stellar contract build

echo "Uploading the account code as $SOURCE"
ACCOUNT_WASM_HASH="$(
  stellar contract upload \
    --wasm "$WASM_DIR/paso_account.wasm" \
    --optimize=false \
    --source-account "$SOURCE" \
    "${network[@]}"
)"
echo "  account wasm hash: $ACCOUNT_WASM_HASH"

echo "Deploying the hub"
HUB="$(
  stellar contract deploy \
    --wasm "$WASM_DIR/paso_hub.wasm" \
    --optimize=false \
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
