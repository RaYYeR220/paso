#!/usr/bin/env bash
#
# Says what a vitest run left out.
#
#   .github/scripts/skipped-tests.sh <report.json> <title>
#
# Reads the JSON report of a run and prints the totals and every suite with
# skipped tests, to the log and to the job summary. A suite is skipped when it
# needs a network or a key that the run did not have.

set -euo pipefail

REPORT="$1"
TITLE="$2"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
ROOT="${GITHUB_WORKSPACE:-$PWD}/"

if [ ! -f "$REPORT" ]; then
  echo "$TITLE: the run left no report."
  exit 0
fi

totals="$(jq -r '"\(.numPassedTests) passed, \(.numFailedTests) failed, \(.numPendingTests + .numTodoTests) skipped"' "$REPORT")"

skipped="$(jq -r --arg root "$ROOT" '
  [ .testResults[]
    | (.name | ltrimstr($root)) as $file
    | .assertionResults[]
    | select(.status != "passed" and .status != "failed")
    | { file: $file, suite: (.ancestorTitles[0] // "(no suite)") } ]
  | group_by([.file, .suite])[]
  | "| \(.[0].file) | \(.[0].suite) | \(length) |"' "$REPORT")"

{
  echo "### $TITLE: $totals"
  if [ -n "$skipped" ]; then
    echo
    echo "Skipped, because they need a network or a key this job does not have:"
    echo
    echo "| File | Suite | Tests |"
    echo "|---|---|---:|"
    echo "$skipped"
  fi
  echo
} | tee -a "$SUMMARY"
