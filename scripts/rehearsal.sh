#!/usr/bin/env bash
# Local production-style rehearsal — never uses production pb_data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REH_DATA="$ROOT/pocketbase/pb_data_rehearsal"
PB="$ROOT/pocketbase/pocketbase"
PORT="${REHEARSAL_PB_PORT:-8092}"
WEB="${REHEARSAL_WEB_PORT:-4173}"

echo "== Rehearsal start =="

cd "$ROOT"
npm run test
npm run typecheck
npm run build

bash "$ROOT/scripts/backup-local.sh"

# Free port if leftover rehearsal process
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
rm -rf "$REH_DATA"
mkdir -p "$REH_DATA"
cd "$ROOT/pocketbase"
"$PB" serve --http="127.0.0.1:${PORT}" --dir="$REH_DATA" >"$ROOT/rehearsal-pb.log" 2>&1 &
PB_PID=$!
WEB_PID=""
cleanup() {
  [[ -n "${WEB_PID}" ]] && kill "$WEB_PID" 2>/dev/null || true
  kill "$PB_PID" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    break
  fi
  sleep 0.25
done
curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null

export E2E_PB_URL="http://127.0.0.1:${PORT}"
export PB_URL="http://127.0.0.1:${PORT}"
export E2E_PB_DATA="$REH_DATA"
node "$ROOT/scripts/e2e-seed.mjs"
node "$ROOT/tests/integration/e2e-api.mjs"
node "$ROOT/scripts/restart-recovery.mjs"
node "$ROOT/scripts/perf-sample.mjs"

# Frontend preview
cd "$ROOT"
VITE_POCKETBASE_URL="http://127.0.0.1:${PORT}" npm run build
WEB_PID=""
npx vite preview --host 127.0.0.1 --port "$WEB" >"$ROOT/rehearsal-web.log" 2>&1 &
WEB_PID=$!
sleep 1
curl -sf "http://127.0.0.1:${WEB}/" >/dev/null
curl -sf "http://127.0.0.1:${PORT}/api/footfive/health" | head -c 200
echo
echo "== Rehearsal OK =="
