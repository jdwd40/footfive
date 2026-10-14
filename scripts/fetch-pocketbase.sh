#!/usr/bin/env bash
# Install the pinned PocketBase release binary for this Linux machine (amd64 or
# arm64). The archive must match the SHA-256 in pocketbase-release.sha256, copied
# from the official v0.28.4 release checksums.txt, before anything is extracted,
# run or installed. Download, checksum, version or architecture failures exit
# non-zero and leave the destination untouched.
#
# Usage: bash scripts/fetch-pocketbase.sh [DEST_DIR]   # default: pocketbase/
# PB_VERSION may only name the pinned version; other versions are refused.
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
pins="$script_dir/pocketbase-release.sha256"
dest=${1:-$script_dir/../pocketbase}

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported architecture for the pinned PocketBase release: $machine" >&2; exit 1 ;;
esac

pin=$(grep -E "^[0-9a-f]{64}  pocketbase_[0-9]+\.[0-9]+\.[0-9]+_linux_${arch}\.zip$" "$pins" || true)
if [[ -z $pin || $pin == *$'\n'* ]]; then
  echo "Expected exactly one pinned PocketBase checksum for linux_${arch} in $pins" >&2
  exit 1
fi
read -r expected asset <<<"$pin"
version=${asset#pocketbase_}
version=${version%%_*}
if [[ -n ${PB_VERSION:-} && $PB_VERSION != "$version" ]]; then
  echo "PB_VERSION=$PB_VERSION is not verified; only the pinned PocketBase $version is supported" >&2
  exit 1
fi

tmp=$(mktemp -d)
stage=
trap 'rm -rf "$tmp"; if [[ -n $stage ]]; then rm -f "$stage"; fi' EXIT
url="https://github.com/pocketbase/pocketbase/releases/download/v${version}/${asset}"
echo "Downloading PocketBase v${version} (linux_${arch})..."
curl -fsSL --retry 3 -o "$tmp/$asset" "$url"
actual=$(sha256sum "$tmp/$asset")
actual=${actual%% *}
if [[ $actual != "$expected" ]]; then
  echo "Refusing $asset: SHA-256 $actual does not match the pinned $expected" >&2
  exit 1
fi

mkdir "$tmp/x"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o -j "$tmp/$asset" pocketbase -d "$tmp/x"
else
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract("pocketbase", sys.argv[2])' "$tmp/$asset" "$tmp/x"
fi
chmod +x "$tmp/x/pocketbase"
reported=$("$tmp/x/pocketbase" --version)
if [[ $reported != "pocketbase version $version" ]]; then
  echo "Refusing $asset: binary reports '$reported', expected PocketBase $version" >&2
  exit 1
fi

mkdir -p "$dest"
# Stage a complete copy beside the target, then rename it into place: a failed or
# partial write is removed on exit and never replaces the existing binary.
stage=$(mktemp "$dest/.pocketbase.XXXXXX")
install -m 755 "$tmp/x/pocketbase" "$stage"
mv -f "$stage" "$dest/pocketbase"
stage=
echo "Installed $reported (linux_${arch}, sha256 $expected) at $dest/pocketbase"
