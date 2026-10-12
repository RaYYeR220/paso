#!/usr/bin/env bash
#
# Deploys Paso to Stellar testnet. The same as `scripts/deploy.sh testnet`.
#
#   scripts/deploy-testnet.sh [identity]
#
# `identity` is a funded stellar-cli identity (default: paso-deployer). Create
# one with `stellar keys generate <name> --network testnet --fund`.

set -euo pipefail

if [[ $# -gt 0 ]]; then
  export PASO_DEPLOYER="$1"
fi

exec "$(dirname "$0")/deploy.sh" testnet
