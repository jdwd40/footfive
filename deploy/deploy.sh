#!/usr/bin/env bash
# Safe deployment helper — review env vars; does not wipe pb_data.
# Intended for VPS operators. Run from repo root or set FOOTFIVE_ROOT.
#
# Required env (production):
#   FOOTFIVE_ROOT=/opt/footfive/app          (git checkout / release)
#   PB_ROOT=/opt/pocketbase
#   WEB_ROOT=/var/www/footfive
#   SERVICE_NAME=pocketbase
#
# Usage:
#   ./deploy/deploy.sh check     # tests + build only
#   ./deploy/deploy.sh backup    # backup only
#   ./deploy/deploy.sh apply     # backup, stop, copy, start, smoke
#   ./deploy/deploy.sh rollback  # restore last backup paths
set -euo pipefail

ROOT="${FOOTFIVE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PB_ROOT="${PB_ROOT:-$ROOT/pocketbase}"
WEB_ROOT="${WEB_ROOT:-$ROOT/dist}"
SERVICE_NAME="${SERVICE_NAME:-}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_DIR/$STAMP"

cmd="${1:-check}"

check() {
  cd "$ROOT"
  npm run test
  npm run typecheck
  npm run build
  echo "check OK"
}

backup() {
  mkdir -p "$DEST"
  if [[ -d "$PB_ROOT/pb_data" ]]; then
    cp -a "$PB_ROOT/pb_data" "$DEST/pb_data"
  fi
  if [[ -d "$WEB_ROOT" ]]; then
    cp -a "$WEB_ROOT" "$DEST/web_dist" 2>/dev/null || true
  fi
  if [[ -d "$ROOT/dist" ]]; then
    cp -a "$ROOT/dist" "$DEST/dist"
  fi
  cp -a "$PB_ROOT/pb_hooks" "$DEST/pb_hooks" 2>/dev/null || cp -a "$ROOT/pocketbase/pb_hooks" "$DEST/pb_hooks"
  cp -a "$PB_ROOT/pb_migrations" "$DEST/pb_migrations" 2>/dev/null || cp -a "$ROOT/pocketbase/pb_migrations" "$DEST/pb_migrations"
  echo "$DEST" >"$BACKUP_DIR/LATEST"
  echo "backup at $DEST"
}

apply() {
  check
  backup
  if [[ -n "$SERVICE_NAME" ]]; then
    sudo systemctl stop "$SERVICE_NAME"
  fi
  # hooks + migrations
  mkdir -p "$PB_ROOT"
  rsync -a --delete "$ROOT/pocketbase/pb_hooks/" "$PB_ROOT/pb_hooks/"
  rsync -a --delete "$ROOT/pocketbase/pb_migrations/" "$PB_ROOT/pb_migrations/"
  # frontend
  mkdir -p "$WEB_ROOT"
  rsync -a --delete "$ROOT/dist/" "$WEB_ROOT/"
  # NEVER delete pb_data
  if [[ -n "$SERVICE_NAME" ]]; then
    sudo systemctl start "$SERVICE_NAME"
    sleep 2
    sudo systemctl is-active --quiet "$SERVICE_NAME"
  fi
  echo "apply done — run deploy/smoke-prod.sh"
}

rollback() {
  local latest
  latest=$(cat "$BACKUP_DIR/LATEST" 2>/dev/null || true)
  if [[ -z "$latest" || ! -d "$latest" ]]; then
    echo "No LATEST backup"
    exit 1
  fi
  echo "Rolling back from $latest"
  if [[ -n "$SERVICE_NAME" ]]; then
    sudo systemctl stop "$SERVICE_NAME"
  fi
  if [[ -d "$latest/pb_hooks" ]]; then
    rsync -a --delete "$latest/pb_hooks/" "$PB_ROOT/pb_hooks/"
  fi
  if [[ -d "$latest/pb_migrations" ]]; then
    rsync -a --delete "$latest/pb_migrations/" "$PB_ROOT/pb_migrations/"
  fi
  if [[ -d "$latest/dist" ]]; then
    rsync -a --delete "$latest/dist/" "$WEB_ROOT/"
  fi
  # pb_data restore is DESTRUCTIVE to current live state — require confirm
  if [[ "${RESTORE_PB_DATA:-}" == "1" && -d "$latest/pb_data" ]]; then
    echo "Restoring pb_data (RESTORE_PB_DATA=1)"
    rsync -a --delete "$latest/pb_data/" "$PB_ROOT/pb_data/"
  else
    echo "Skipped pb_data restore (set RESTORE_PB_DATA=1 to include)"
  fi
  if [[ -n "$SERVICE_NAME" ]]; then
    sudo systemctl start "$SERVICE_NAME"
  fi
  echo "rollback complete"
}

case "$cmd" in
  check) check ;;
  backup) backup ;;
  apply) apply ;;
  rollback) rollback ;;
  *)
    echo "Usage: $0 check|backup|apply|rollback"
    exit 1
    ;;
esac
