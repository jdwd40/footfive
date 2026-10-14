#!/usr/bin/env bash
# FootFive production backup. pb_data is an online, verified SQLite snapshot
# (pb-data-backup.py beside this script), so PocketBase keeps running. Any failure
# marks this backup STATUS=failed and leaves LATEST on the previous good backup.
# Env overrides:
#   FOOTFIVE_HOME=/home/jd/footfive
#   FOOTFIVE_BACKUP_ROOT=/var/backups/footfive
#   FOOTFIVE_SERVICE=footfive-pocketbase
#   FOOTFIVE_KEEP_DAILY=14
set -euo pipefail

HOME_DIR="${FOOTFIVE_HOME:-/home/jd/footfive}"
BACKUP_ROOT="${FOOTFIVE_BACKUP_ROOT:-/var/backups/footfive}"
SERVICE="${FOOTFIVE_SERVICE:-footfive-pocketbase}"
KEEP_DAILY="${FOOTFIVE_KEEP_DAILY:-14}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_ROOT/$STAMP"
WEB="${FOOTFIVE_WEB:-/var/www/jdwd40.com/html/footfive}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$BACKUP_ROOT"
mkdir "$DEST" # fails on a same-second collision instead of merging into another backup
trap 'status=$?; if [[ $status -ne 0 ]]; then echo "failed" >"$DEST/STATUS"; echo "backup FAILED $DEST" >&2; fi' EXIT
echo "backup start $STAMP"

python3 -I "$SCRIPT_DIR/pb-data-backup.py" "$HOME_DIR/pb_data" "$DEST/pb_data"

cp -a "$HOME_DIR/pocketbase/pb_hooks" "$DEST/pb_hooks"
cp -a "$HOME_DIR/pocketbase/pb_migrations" "$DEST/pb_migrations"
if [[ -L "$HOME_DIR/current" ]]; then
  readlink -f "$HOME_DIR/current" >"$DEST/frontend_release.path"
  cp -a "$(readlink -f "$HOME_DIR/current")" "$DEST/frontend_release" 2>/dev/null || true
fi
if [[ -d "$WEB" ]]; then
  cp -a "$WEB" "$DEST/web"
fi
[[ -f /etc/nginx/snippets/footfive.conf ]] && cp -a /etc/nginx/snippets/footfive.conf "$DEST/"
[[ -f /etc/systemd/system/${SERVICE}.service ]] && cp -a "/etc/systemd/system/${SERVICE}.service" "$DEST/"
[[ -f "$HOME_DIR/DEPLOYED_STAMP" ]] && cp -a "$HOME_DIR/DEPLOYED_STAMP" "$DEST/"

{
  echo "stamp=$STAMP"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "service=$SERVICE"
  echo "pb_version=$("$HOME_DIR/pocketbase/pocketbase" --version 2>/dev/null || echo unknown)"
  du -sb "$DEST/pb_data" 2>/dev/null | awk '{print "pb_data_bytes="$1}'
  echo "status=ok"
} >"$DEST/MANIFEST.txt"

( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum ) >"$DEST/SHA256SUMS"
echo "ok" >"$DEST/STATUS"
echo "$DEST" >"$BACKUP_ROOT/LATEST.tmp"
mv -f "$BACKUP_ROOT/LATEST.tmp" "$BACKUP_ROOT/LATEST"
trap - EXIT # published: a later retention error must not relabel this good backup
chmod 700 "$BACKUP_ROOT" 2>/dev/null || true
chmod -R go-rwx "$DEST" 2>/dev/null || true

# Retention: keep newest KEEP_DAILY successful backups; never delete marked keep or first-prod
mapfile -t DIRS < <(ls -1dt "$BACKUP_ROOT"/20* 2>/dev/null || true)
count=0
for d in "${DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  [[ -f "$d/keep" ]] && continue
  [[ -f "$d/KEEP" ]] && continue
  # protect known first-production stamps
  base=$(basename "$d")
  if [[ "$base" == "20260725T161542Z" || "$base" == "20260725T161319Z" ]]; then
    continue
  fi
  if [[ -f "$d/STATUS" ]] && grep -q ok "$d/STATUS"; then
    count=$((count + 1))
    if [[ $count -gt $KEEP_DAILY ]]; then
      echo "prune $d"
      rm -rf "$d"
    fi
  fi
done

echo "backup ok $DEST"
