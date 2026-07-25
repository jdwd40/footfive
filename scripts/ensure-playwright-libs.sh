#!/usr/bin/env bash
# Vendor nss/nspr (and friends) for Chromium without root, for local/CI fallback.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIBDIR="$ROOT/e2e/.browser-libs"
mkdir -p "$LIBDIR"
MARKER="$LIBDIR/.ready"

if [[ -f "$MARKER" ]] && [[ -f "$LIBDIR/usr/lib/x86_64-linux-gnu/libnspr4.so" ]]; then
  echo "export LD_LIBRARY_PATH=\"$LIBDIR/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
  exit 0
fi

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
cd "$TMP"

# Core packages required by playwright chromium headless shell on Ubuntu noble
PKGS=(libnspr4 libnss3)
for p in "${PKGS[@]}"; do
  apt-get download "$p" >/dev/null 2>&1 || true
done
for deb in *.deb; do
  [[ -f "$deb" ]] || continue
  dpkg-deb -x "$deb" "$LIBDIR"
done

if [[ ! -f "$LIBDIR/usr/lib/x86_64-linux-gnu/libnspr4.so" ]]; then
  echo "WARN: could not vendor browser libs" >&2
  exit 1
fi
touch "$MARKER"
echo "export LD_LIBRARY_PATH=\"$LIBDIR/usr/lib/x86_64-linux-gnu\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
