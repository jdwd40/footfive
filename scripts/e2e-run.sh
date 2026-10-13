#!/usr/bin/env bash
# Start isolated PocketBase test instance + Vite preview, run API + Playwright, cleanup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PB_BIN="$ROOT/pocketbase/pocketbase"
PB_DATA="$ROOT/pocketbase/pb_data_test"
PB_PORT="${E2E_PB_PORT:-8091}"
WEB_PORT="${E2E_WEB_PORT:-5173}"
export E2E_PB_URL="http://127.0.0.1:${PB_PORT}"
export E2E_BASE_URL="http://127.0.0.1:${WEB_PORT}"
export VITE_POCKETBASE_URL="$E2E_PB_URL"

# Vendor browser libs when system packages missing (local dev without root)
if bash "$ROOT/scripts/ensure-playwright-libs.sh" >"$ROOT/.pw-lib-env" 2>/dev/null; then
  # shellcheck disable=SC1091
  source "$ROOT/.pw-lib-env"
  export LD_LIBRARY_PATH
fi

if [[ ! -x "$PB_BIN" ]]; then
  echo "Missing pocketbase binary at $PB_BIN"
  exit 1
fi

rm -rf "$PB_DATA"
mkdir -p "$PB_DATA"

cd "$ROOT/pocketbase"
"$PB_BIN" superuser upsert e2e-super@test.local 'e2esuper99' --dir="$PB_DATA" >/dev/null 2>&1 || true

"$PB_BIN" serve --http="127.0.0.1:${PB_PORT}" --dir="$PB_DATA" >"$ROOT/e2e-pb.log" 2>&1 &
PB_PID=$!
WEB_PID=""
cleanup() {
  [[ -n "${WEB_PID}" ]] && kill "$WEB_PID" 2>/dev/null || true
  kill "$PB_PID" 2>/dev/null || true
  wait "$PB_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PB_PORT}/api/health" >/dev/null; then
    break
  fi
  sleep 0.25
done
curl -sf "http://127.0.0.1:${PB_PORT}/api/health" >/dev/null

node "$ROOT/scripts/e2e-seed.mjs"

cd "$ROOT"
# Build with test API URL baked in
VITE_POCKETBASE_URL="$E2E_PB_URL" npm run build
npx vite preview --host 127.0.0.1 --port "$WEB_PORT" >"$ROOT/e2e-web.log" 2>&1 &
WEB_PID=$!
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${WEB_PORT}/" >/dev/null; then
    break
  fi
  sleep 0.25
done

API_FAIL=0
UI_FAIL=0

node "$ROOT/tests/integration/e2e-api.mjs" || API_FAIL=1

# Browser tests
if npx playwright test --list >/dev/null 2>&1; then
  if [[ "${E2E_ALL:-}" == "1" ]]; then
    npx playwright test "$@" || UI_FAIL=1
  else
    # Core gameplay + layout
    npx playwright test --project=chromium-mobile --project=chromium-desktop "$@" || UI_FAIL=1
  fi
else
  echo "Playwright not available"
  UI_FAIL=1
fi

if [[ "$API_FAIL" == "1" || "$UI_FAIL" == "1" ]]; then
  echo "FAIL api=$API_FAIL ui=$UI_FAIL"
  exit 1
fi

# Account-security regression runs last: its 429 checks deliberately exhaust the
# login rate-limit bucket, which would otherwise poison UI/API logins above.
SEC_FAIL=0
node "$ROOT/tests/integration/account-security.mjs" || SEC_FAIL=1
if [[ "$SEC_FAIL" == "1" ]]; then
  echo "FAIL sec=$SEC_FAIL"
  exit 1
fi

# Existing-data upgrade regression (review F3): spawns its own PB pair on
# UPGRADE_PB_PORT against a scratch DB; no shared state with the e2e instance.
UPG_FAIL=0
UPGRADE_PB_PORT="${UPGRADE_PB_PORT:-8293}" node "$ROOT/tests/integration/upgrade-legacy-disabled.mjs" || UPG_FAIL=1
if [[ "$UPG_FAIL" == "1" ]]; then
  echo "FAIL upgrade=$UPG_FAIL"
  exit 1
fi

# Settlement atomicity/idempotency/recovery (issue #15): own PB on SETTLE_PB_PORT
# against a scratch DB, failures injected per settlement stage via SQLite triggers.
SET_FAIL=0
SETTLE_PB_PORT="${SETTLE_PB_PORT:-8294}" node "$ROOT/tests/integration/settlement-recovery.mjs" || SET_FAIL=1
if [[ "$SET_FAIL" == "1" ]]; then
  echo "FAIL settlement=$SET_FAIL"
  exit 1
fi
# Live event latency (live carrier dribbling back and forth): own PB on LIVE_PB_PORT at
# normal pace; the cron alone must publish live events in near real time.
LIVE_FAIL=0
LIVE_PB_PORT="${LIVE_PB_PORT:-8297}" node "$ROOT/tests/integration/live-latency.mjs" || LIVE_FAIL=1
if [[ "$LIVE_FAIL" == "1" ]]; then
  echo "FAIL live-latency=$LIVE_FAIL"
  exit 1
fi
echo "E2E OK"
