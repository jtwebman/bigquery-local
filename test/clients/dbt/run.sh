#!/usr/bin/env bash
#
# dbt-bigquery conformance test.
#
# dbt is one of the most common ways teams touch BigQuery. dbt-bigquery has no
# native custom-endpoint support (dbt-labs/dbt-bigquery#358), so we point it at
# the emulator with the monkeypatch shim in `sitecustomize.py` (auto-imported
# via PYTHONPATH). This runs a real project — table, view, and incremental
# (MERGE) models plus `dbt test` — twice, so the incremental's second-run MERGE
# path is exercised.
#
# Requires `dbt` on PATH (pip install -r requirements.txt). Run locally:
#   pip install -r test/clients/dbt/requirements.txt
#   bash test/clients/dbt/run.sh
# Exits nonzero if any dbt command fails.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PROJECT_DIR="$HERE/project"

export BIGQUERY_EMULATOR_PROJECT="dbt-emu"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"   # picks up sitecustomize.py
export DBT_PROFILES_DIR="$PROJECT_DIR"

emu_pid=""
cleanup() {
  [[ -n "$emu_pid" ]] && kill "$emu_pid" 2>/dev/null || true
  rm -rf "$PROJECT_DIR/target" "$PROJECT_DIR/logs" "$PROJECT_DIR/dbt_packages"
}
trap cleanup EXIT

# --- spawn the emulator on a random port, capture its URL ------------------
emu_log="$(mktemp)"
(
  cd "$REPO_ROOT"
  exec node --conditions=src src/cli.ts --port=0 --grpc-port=0 --database=:memory:
) >"$emu_log" 2>&1 &
emu_pid=$!

url=""
for _ in $(seq 1 100); do
  line="$(grep -o 'listening on http://[^ ]*' "$emu_log" 2>/dev/null || true)"
  if [[ -n "$line" ]]; then
    url="${line#listening on }"
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
if [[ -z "$url" ]]; then
  echo "emulator did not print a listening URL within timeout" >&2
  exit 1
fi
export BIGQUERY_EMULATOR_HOST="$url"
echo "emulator listening at $url"

dbt_cmd() {
  echo "+ dbt $*"
  dbt "$@" --project-dir "$PROJECT_DIR" 2>&1 | grep -viE "FutureWarning|warnings\.warn|NotOpenSSL|urllib3 v2"
  return "${PIPESTATUS[0]}"
}

# Run table/view/incremental, then dbt test, then run again to exercise the
# incremental MERGE path. dbt exits nonzero if any model/test fails.
dbt_cmd run
dbt_cmd test
dbt_cmd run

echo
echo "dbt conformance: OK"
