#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PB_DIR="$ROOT/pocketbase"
if [[ ! -x "$PB_DIR/pocketbase" ]]; then
  # Checksum-pinned PocketBase 0.28.4 for linux amd64/arm64; refuses other PB_VERSIONs.
  bash "$ROOT/scripts/fetch-pocketbase.sh" "$PB_DIR"
fi
"$PB_DIR/pocketbase" --version
if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created .env from .env.example"
fi
echo "Next: cd pocketbase && ./pocketbase superuser upsert YOU@example.com 'pass'"
echo "Then: npm run pb:serve && npm run dev"
