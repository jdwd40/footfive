#!/usr/bin/env bash
# Non-destructive production smoke checks.
# Env: BASE_URL=https://footfive.example.com  PB_URL=https://footfive.example.com
set -euo pipefail
BASE="${BASE_URL:-http://127.0.0.1:5173}"
PB="${PB_URL:-http://127.0.0.1:8090}"

echo "Frontend $BASE"
curl -sfI "$BASE/" | head -1

echo "PB health $PB"
curl -sf "$PB/api/health" | head -c 200
echo

echo "Login page"
curl -sf "$BASE/login" | head -c 80
echo

echo "Registration collection reachable"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PB/api/collections/users/records" \
  -H 'Content-Type: application/json' -d '{}')
echo "  empty register status=$code (expect 400)"

echo "World requires auth"
code=$(curl -s -o /dev/null -w "%{http_code}" "$PB/api/footfive/world")
echo "  world status=$code (expect 401)"

echo "Admin requires auth"
code=$(curl -s -o /dev/null -w "%{http_code}" "$PB/api/footfive/admin/overview")
echo "  admin status=$code (expect 401)"

echo "Smoke complete (non-destructive)"
