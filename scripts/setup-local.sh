#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PB_DIR="$ROOT/pocketbase"
PB_VERSION="${PB_VERSION:-0.28.4}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) PB_ARCH="amd64" ;;
  aarch64|arm64) PB_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
mkdir -p "$PB_DIR"
cd "$PB_DIR"
if [[ ! -x ./pocketbase ]]; then
  echo "Downloading PocketBase v${PB_VERSION} (${PB_ARCH})..."
  ZIP="pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip"
  curl -fsSL -o "$ZIP" \
    "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${ZIP}"
  python3 -c "import zipfile; zipfile.ZipFile('$ZIP').extract('pocketbase')"
  rm -f "$ZIP"
  chmod +x ./pocketbase
fi
./pocketbase --version
if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "Created .env from .env.example"
fi
echo "Next: cd pocketbase && ./pocketbase superuser upsert YOU@example.com 'pass'"
echo "Then: npm run pb:serve && npm run dev"
