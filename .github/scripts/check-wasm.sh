#!/usr/bin/env bash
#
# Compares the contracts with the code that is deployed.
#
#   .github/scripts/check-wasm.sh          the build in target/ against .github/deployed-wasm.sha256
#   .github/scripts/check-wasm.sh chain    .github/deployed-wasm.sha256 against the networks in deployments/
#
# The first form needs `stellar contract build` to have run. For every listed
# file it prints the size, the SHA-256, the metadata the Stellar CLI wrote into
# it and its wasm sections. It exits 1 when a hash differs, unless
# PASO_ALLOW_WASM_DRIFT is 1 or true. For a file that differs it also fetches
# the deployed code and prints the same about it, so the two can be compared
# section by section.
#
# The second form asks each network for the code hash of its hub and looks the
# account code up by its hash. It exits 1 only when a network answers with
# another hash. A network that does not answer is reported and does not count.

set -euo pipefail

cd "$(dirname "$0")/../.."

EXPECTED=.github/deployed-wasm.sha256
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
NETWORKS="deployments/mainnet.json deployments/testnet.json"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# The lines of the expected file as "hash path".
expected() {
  grep -Ev '^[[:space:]]*(#|$)' "$EXPECTED" | awk '{ print $1, $2 }'
}

field() {
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}

# One line per wasm section: name, size in bytes, start of the SHA-256 of its content.
sections() {
  python3 - "$1" <<'PY'
import hashlib, sys

NAMES = ["custom", "type", "import", "function", "table", "memory", "global",
         "export", "start", "element", "code", "data", "datacount"]

def leb(data, at):
    value = shift = 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, at

wasm = open(sys.argv[1], "rb").read()
if wasm[:4] != b"\0asm":
    sys.exit("  not a wasm file")
at = 8
while at < len(wasm):
    kind = wasm[at]
    size, start = leb(wasm, at + 1)
    content = wasm[start:start + size]
    name = NAMES[kind] if kind < len(NAMES) else str(kind)
    if kind == 0:
        length, begin = leb(content, 0)
        name = content[begin:begin + length].decode("utf-8", "replace")
    print(f"    {name:<20} {size:>6}  {hashlib.sha256(content).hexdigest()[:16]}")
    at = start + size
PY
}

describe() {
  echo "  size      $(wc -c < "$1" | tr -d ' ') bytes"
  echo "  sha256    $(sha256 "$1")"
  echo "  metadata"
  { stellar --quiet contract info meta --wasm "$1" && stellar --quiet contract info env-meta --wasm "$1"; } |
    sed -e '/^[[:space:]]*$/d' -e 's/^/    /'
  echo "  sections  (name, bytes, sha256 prefix)"
  sections "$1"
}

# Writes the code with the given hash to a file and prints the network it came from.
fetch_deployed() {
  local file
  for file in $NETWORKS; do
    [ -f "$file" ] || continue
    if stellar --quiet contract fetch --wasm-hash "$1" --out-file "$2" \
      --rpc-url "$(field "$file" rpcUrl)" --network-passphrase "$(field "$file" networkPassphrase)" \
      >/dev/null 2>&1 && [ "$(sha256 "$2")" = "$1" ]; then
      field "$file" network
      return 0
    fi
  done
  return 1
}

check_build() {
  local differs=0 hash path actual verdict deployed network

  {
    echo "### This build against the deployed code"
    echo
    echo "| File | Bytes | SHA-256 | Deployed |"
    echo "|---|---:|---|---|"
  } >> "$SUMMARY"

  while read -r hash path; do
    echo
    echo "== $path"
    if [ ! -f "$path" ]; then
      echo "  missing: run 'stellar contract build' first"
      echo "| \`$(basename "$path")\` | | missing | \`$hash\` |" >> "$SUMMARY"
      differs=1
      continue
    fi

    actual="$(sha256 "$path")"
    describe "$path"
    if [ "$actual" = "$hash" ]; then
      verdict="same"
      echo "  result    the same bytes as the deployed code"
    else
      verdict="differs: \`$hash\`"
      differs=1
      echo "  result    DIFFERS from the deployed code, $hash"
      deployed="$(mktemp)"
      if network="$(fetch_deployed "$hash" "$deployed")"; then
        echo
        echo "-- the deployed code, read from $network"
        describe "$deployed"
      else
        echo "  The deployed code could not be read from the networks in deployments/ to compare."
      fi
      rm -f "$deployed"
    fi
    echo "| \`$(basename "$path")\` | $(wc -c < "$path" | tr -d ' ') | \`$actual\` | $verdict |" >> "$SUMMARY"
  done < <(expected)

  echo
  if [ "$differs" -eq 0 ]; then
    echo "Every contract builds to the deployed code."
    return 0
  fi

  case "${PASO_ALLOW_WASM_DRIFT:-}" in
    1 | true)
      echo "::warning::The build differs from the deployed code. PASO_ALLOW_WASM_DRIFT is set, so the job does not fail."
      echo "PASO_ALLOW_WASM_DRIFT is set: the difference did not fail the job." >> "$SUMMARY"
      return 0
      ;;
  esac
  echo "::error::This build is not the deployed code listed in $EXPECTED."
  return 1
}

check_chain() {
  local wrong=0 file network rpc passphrase hub account_hash hub_hash onchain fetched

  account_hash="$(expected | awk '/paso_account\.wasm$/ { print $1 }')"
  hub_hash="$(expected | awk '/paso_hub\.wasm$/ { print $1 }')"

  {
    echo "### The listed hashes against the chain"
    echo
    echo "| Network | Hub code | Account code |"
    echo "|---|---|---|"
  } >> "$SUMMARY"

  for file in $NETWORKS; do
    [ -f "$file" ] || continue
    network="$(field "$file" network)"
    rpc="$(field "$file" rpcUrl)"
    passphrase="$(field "$file" networkPassphrase)"
    hub="$(field "$file" hub)"
    echo
    echo "== $network"

    onchain="$(stellar --quiet contract info hash --id "$hub" --rpc-url "$rpc" --network-passphrase "$passphrase" 2>/dev/null | tr -d '[:space:]' || true)"
    if ! [[ "$onchain" =~ ^[0-9a-f]{64}$ ]]; then
      onchain="not read"
      echo "::warning::$network did not return the code hash of the hub $hub."
    elif [ "$onchain" = "$hub_hash" ]; then
      echo "  hub $hub runs $onchain, as listed"
      onchain="as listed"
    else
      echo "::error::On $network the hub $hub runs $onchain, not the listed $hub_hash."
      onchain="differs: \`$onchain\`"
      wrong=1
    fi

    fetched="$(mktemp)"
    if stellar --quiet contract fetch --wasm-hash "$account_hash" --out-file "$fetched" \
      --rpc-url "$rpc" --network-passphrase "$passphrase" >/dev/null 2>&1 &&
      [ "$(sha256 "$fetched")" = "$account_hash" ]; then
      echo "  account code $account_hash is on chain"
      echo "| $network | $onchain | on chain |" >> "$SUMMARY"
    else
      echo "::warning::$network did not return the account code $account_hash."
      echo "| $network | $onchain | not read |" >> "$SUMMARY"
    fi
    rm -f "$fetched"
  done

  return "$wrong"
}

case "${1:-build}" in
  build) check_build ;;
  chain) check_chain ;;
  *)
    echo "Usage: $0 [build|chain]" >&2
    exit 2
    ;;
esac
