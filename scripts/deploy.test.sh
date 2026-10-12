#!/usr/bin/env bash
#
# Checks that scripts/deploy.sh never spends on mainnet beyond a confirmed
# limit, and never spends at all when it cannot tell what it would spend.
#
#   scripts/deploy.test.sh
#
# The script under test runs in a throwaway copy of the repository layout,
# with stand-ins for `stellar` and `pnpm` on the PATH: the stand-ins record
# every call and hand back a plan chosen by the test. Nothing touches a
# network, a key or the real deployment files.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

ACCOUNT_HASH="$(printf 'a%.0s' {1..64})"
HUB_HASH="$(printf 'b%.0s' {1..64})"

mkdir -p "$SANDBOX/bin" "$SANDBOX/scripts" "$SANDBOX/deployments"
cp "$ROOT/scripts/deploy.sh" "$SANDBOX/scripts/deploy.sh"

cat > "$SANDBOX/bin/stellar" <<'STAND_IN'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
case "$1 $2" in
  "keys public-key") echo GDEPLOYER ;;
  "contract upload") if [[ "$*" == *paso_account* ]]; then echo "$ACCOUNT_HASH"; else echo "$HUB_HASH"; fi ;;
  "contract deploy") echo CNEWHUB ;;
esac
STAND_IN

# `pnpm exec tsx scripts/deploy-plan.ts <network> <deployer> <plan file>` writes
# the next plan of the test; the word FAIL in its place makes the plan fail.
cat > "$SANDBOX/bin/pnpm" <<'STAND_IN'
#!/usr/bin/env bash
[[ "$1" == exec ]] || exit 0
count="$(($(cat "$PLAN_COUNT") + 1))"
echo "$count" > "$PLAN_COUNT"
plan="PLAN_$count"
[[ "${!plan:-FAIL}" != FAIL ]] || exit 1
printf '%s\n' "${!plan}" > "${@: -1}"
STAND_IN
chmod +x "$SANDBOX/bin/stellar" "$SANDBOX/bin/pnpm"

export CALLS="$SANDBOX/calls" PLAN_COUNT="$SANDBOX/plan-count" ACCOUNT_HASH HUB_HASH

# A plan as scripts/deploy-plan.ts writes it. Arguments: the two upload fees
# and the hub fee in stroops, then any lines that replace or follow the rest.
a_plan() {
  local account_fee="$1" hub_upload_fee="$2" hub_fee="$3" total rounded
  shift 3
  total=$((account_fee + hub_upload_fee + hub_fee))
  rounded=$(((total + 9999999) / 10000000))
  printf '%s\n' \
    "ACCOUNT_WASM_HASH=$ACCOUNT_HASH" "HUB_WASM_HASH=$HUB_HASH" \
    "ACCOUNT_ON_CHAIN=$([[ "$account_fee" == 0 ]] && echo yes || echo no)" \
    "HUB_ON_CHAIN=$([[ "$hub_upload_fee" == 0 ]] && echo yes || echo no)" \
    "ACCOUNT_UPLOAD_FEE=$account_fee" "HUB_UPLOAD_FEE=$hub_upload_fee" "HUB_FEE=$hub_fee" \
    "TOTAL=$total" "TOTAL_XLM_ROUNDED_UP=$rounded" "FUNDED=yes" "SETTLED=no" "$@"
}

# The plan of a fresh mainnet deployment: 17.8733583 XLM, confirmed as 18.
FIRST="$(a_plan 107738021 68495562 2500000)"
AFTER_UPLOADS="$(a_plan 0 0 618814)"

failures=0

# check <name> <uploads and deployments expected> <exit status expected> <network> [VAR=value…]
check() {
  local name="$1" expected_sends="$2" expected_status="$3" target="$4" sends status=0
  shift 4
  : > "$CALLS"
  echo 0 > "$PLAN_COUNT"
  printf '{"rpcUrl":"http://rpc.invalid","networkPassphrase":"sandbox","usdc":"CUSDC","tokenMessenger":"CTM","hub":""}\n' \
    > "$SANDBOX/deployments/$target.json"
  env -u PASO_CONFIRM_MAINNET -u PASO_DEPLOYER PATH="$SANDBOX/bin:$PATH" "$@" \
    "$SANDBOX/scripts/deploy.sh" "$target" > "$SANDBOX/output" 2>&1 || status=$?
  sends="$(grep -cE '^contract (upload|deploy)' "$CALLS" || true)"
  if [[ "$sends" == "$expected_sends" && "$status" == "$expected_status" ]]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: sent $sends (expected $expected_sends), exit $status (expected $expected_status)"
    sed 's/^/        /' "$SANDBOX/output"
    failures=$((failures + 1))
  fi
}

check "mainnet without a confirmation sends nothing" 0 3 mainnet \
  PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "mainnet with the wrong number sends nothing" 0 3 mainnet \
  PASO_CONFIRM_MAINNET=17 PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "mainnet with a larger number than the plan sends nothing" 0 3 mainnet \
  PASO_CONFIRM_MAINNET=1000 PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "mainnet with a confirmation that is not a number sends nothing" 0 3 mainnet \
  PASO_CONFIRM_MAINNET=yes PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "mainnet with an empty confirmation sends nothing" 0 3 mainnet \
  PASO_CONFIRM_MAINNET= PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "a plan that fails sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1=FAIL
check "an empty plan sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1=""
check "a plan without a total sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$(grep -v '^TOTAL=' <<< "$FIRST")"
check "a plan with a fee that is not a number sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="${FIRST/HUB_UPLOAD_FEE=68495562/HUB_UPLOAD_FEE=unknown}"
check "a plan whose total is not the sum of its steps sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="${FIRST/ACCOUNT_UPLOAD_FEE=107738021/ACCOUNT_UPLOAD_FEE=9107738021}"
check "a plan whose total in XLM is below its total sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=1 PLAN_1="${FIRST/TOTAL_XLM_ROUNDED_UP=18/TOTAL_XLM_ROUNDED_UP=1}"
check "an underfunded deployer sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="${FIRST/FUNDED=yes/FUNDED=no}"
check "a hub that is deployed already sends nothing and is not an error" 0 0 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="${FIRST/SETTLED=no/SETTLED=yes}"
check "a plan that does not say whether a hub exists sends nothing" 0 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$(grep -v '^SETTLED=' <<< "$FIRST")"
check "a hub fee past the confirmed limit stops after the uploads" 2 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$FIRST" PLAN_2="$(a_plan 0 0 50000000)"
check "a second plan that fails stops after the uploads" 2 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$FIRST"
check "a second plan without a hub fee stops after the uploads" 2 1 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$FIRST" PLAN_2="$(grep -v '^HUB_FEE=' <<< "$AFTER_UPLOADS")" \
  PLAN_3=FAIL PLAN_4=FAIL PLAN_5=FAIL PLAN_6=FAIL PLAN_7=FAIL
check "a confirmed mainnet plan uploads twice and deploys once" 3 0 mainnet \
  PASO_CONFIRM_MAINNET=18 PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "code that is on chain is not uploaded again" 1 0 mainnet \
  PASO_CONFIRM_MAINNET=1 PLAN_1="$AFTER_UPLOADS" PLAN_2="$AFTER_UPLOADS"
check "testnet needs no confirmation" 3 0 testnet \
  PLAN_1="$FIRST" PLAN_2="$AFTER_UPLOADS"
check "testnet stops on a plan that fails all the same" 0 1 testnet \
  PLAN_1=FAIL

if ((failures > 0)); then
  echo
  echo "$failures failed"
  exit 1
fi
echo
echo "all passed"
