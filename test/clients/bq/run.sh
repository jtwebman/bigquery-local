#!/usr/bin/env bash
#
# bq CLI conformance test.
#
# The `bq` CLI (part of the Google Cloud SDK) is discovery-driven: it builds
# its entire API client from the document served at /$discovery/rest. This
# suite spawns the emulator, points `bq --api` at it, and exercises the core
# verbs (query, mk, ls, show, insert, head, rm) the way an operator scripting
# against BigQuery would.
#
# Auth is bypassed the same way every emulator setup does it: a fake static
# access token (CLOUDSDK_AUTH_ACCESS_TOKEN) that the emulator ignores.
#
# Run locally:  bash test/clients/bq/run.sh
# Exits nonzero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT="bq-test"

# Isolate gcloud/bq config so we never touch the developer's real auth, and
# fake the access token so bq doesn't try to mint a real one.
CLOUDSDK_CONFIG="$(mktemp -d)"
export CLOUDSDK_CONFIG
export CLOUDSDK_AUTH_ACCESS_TOKEN="fake-emulator-token"
export CLOUDSDK_CORE_DISABLE_USAGE_REPORTING="true"

emu_pid=""
cleanup() {
  [[ -n "$emu_pid" ]] && kill "$emu_pid" 2>/dev/null || true
  rm -rf "$CLOUDSDK_CONFIG"
}
trap cleanup EXIT

# --- spawn the emulator on a random port, capture its URL ------------------
emu_log="$(mktemp)"
(
  cd "$REPO_ROOT"
  exec node --conditions=src src/cli.ts --port=0 --grpc-port=0 --database=:memory:
) >"$emu_log" 2>&1 &
emu_pid=$!

API=""
for _ in $(seq 1 100); do
  line="$(grep -o 'listening on http://[^ ]*' "$emu_log" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then
    API="${line#listening on }"
    break
  fi
  if ! kill -0 "$emu_pid" 2>/dev/null; then
    echo "emulator exited before listening:" >&2
    cat "$emu_log" >&2
    exit 1
  fi
  sleep 0.1
done
rm -f "$emu_log"
if [[ -z "$API" ]]; then
  echo "emulator did not print a listening URL within timeout" >&2
  exit 1
fi
echo "emulator listening at $API"

# `bq` wrapper: always pass the emulator endpoint + project. (Don't redirect
# stdin here — `bq insert` reads its rows from stdin.)
bqx() { bq --api="$API" --project_id="$PROJECT" "$@"; }

# --- tiny assert harness ---------------------------------------------------
pass=0
fail=0
check() { # check <name> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then
    pass=$((pass + 1))
    echo "ok   - $1"
  else
    fail=$((fail + 1))
    echo "FAIL - $1"
    echo "       expected to contain: $2"
    echo "       actual: $3"
  fi
}
refute() { # refute <name> <unexpected-substring> <actual>
  if [[ "$3" != *"$2"* ]]; then
    pass=$((pass + 1))
    echo "ok   - $1"
  else
    fail=$((fail + 1))
    echo "FAIL - $1"
    echo "       expected NOT to contain: $2"
    echo "       actual: $3"
  fi
}

# --- 1. scalar query -------------------------------------------------------
out="$(bqx query --nouse_legacy_sql --format=csv 'SELECT 1 + 1 AS two')"
check "scalar query" $'two\n2' "$out"

# --- 2. parameterized query ------------------------------------------------
out="$(bqx query --nouse_legacy_sql --parameter='n:INT64:21' --format=csv 'SELECT @n * 2 AS doubled')"
check "parameterized query" $'doubled\n42' "$out"

# --- 3. create dataset, list it --------------------------------------------
bqx mk -d sales >/dev/null
out="$(bqx ls --datasets --format=prettyjson)"
check "ls shows new dataset" '"datasetId": "sales"' "$out"

# --- 4. CREATE TABLE AS SELECT into the fresh dataset, then read it back ----
# (regression: a brand-new dataset must be queryable without first creating a
#  table via the REST API)
bqx query --nouse_legacy_sql --format=none 'CREATE TABLE `sales.totals` AS SELECT 100 AS amount, "usd" AS currency' >/dev/null
out="$(bqx query --nouse_legacy_sql --format=csv 'SELECT amount, currency FROM `sales.totals`')"
check "CTAS into fresh dataset round-trips" $'amount,currency\n100,usd' "$out"

# --- 5. mk --table with an explicit schema, show it ------------------------
bqx mk --table "${PROJECT}:sales.people" id:INTEGER,name:STRING >/dev/null
out="$(bqx show --format=prettyjson sales.people)"
check "show table reports id field" '"name": "id"' "$out"
check "show table reports name field" '"name": "name"' "$out"

# --- 6. streaming insert (tabledata.insertAll), then query back ------------
# (regression: bq sends templateSuffix / skipInvalidRows / ignoreUnknownValues
#  as explicit null — the emulator must tolerate that)
printf '{"id":1,"name":"alice"}\n{"id":2,"name":"bob"}\n' | bqx insert sales.people
out="$(bqx query --nouse_legacy_sql --format=csv 'SELECT id, name FROM `sales.people` ORDER BY id')"
check "insert + query round-trip" $'id,name\n1,alice\n2,bob' "$out"

# --- 7. head (tabledata.list) ----------------------------------------------
out="$(bqx head --format=csv sales.people)"
check "head returns rows" "alice" "$out"

# --- 8. rm table + dataset -------------------------------------------------
bqx rm -f -t sales.people >/dev/null
bqx rm -f -t sales.totals >/dev/null
bqx rm -f -d sales >/dev/null
out="$(bqx ls --datasets --format=prettyjson 2>&1 || true)"
refute "dataset removed" '"datasetId": "sales"' "$out"

# --- summary ---------------------------------------------------------------
echo
echo "bq CLI tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
