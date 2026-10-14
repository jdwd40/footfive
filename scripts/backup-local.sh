#!/usr/bin/env bash
# Local timestamped backup of pb_data + frontend dist + hooks/migrations.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="${BACKUP_DIR:-$ROOT/backups}/$STAMP"
mkdir -p "$DEST"

echo "Backup -> $DEST"

if [[ -d "$ROOT/pocketbase/pb_data" ]]; then
  # Online, verified SQLite snapshot: consistent even while PocketBase runs.
  python3 -I "$ROOT/scripts/pb-data-backup.py" "$ROOT/pocketbase/pb_data" "$DEST/pb_data"
  echo "  pb_data snapshot verified"
else
  echo "  warn: no pb_data"
fi

if [[ -d "$ROOT/dist" ]]; then
  cp -a "$ROOT/dist" "$DEST/dist"
  echo "  dist copied"
fi

cp -a "$ROOT/pocketbase/pb_hooks" "$DEST/pb_hooks"
cp -a "$ROOT/pocketbase/pb_migrations" "$DEST/pb_migrations"
echo "  hooks + migrations copied"

cat >"$DEST/MANIFEST.txt" <<EOF
created: $STAMP
host: $(hostname)
git: $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
pb_version: $($ROOT/pocketbase/pocketbase --version 2>/dev/null || echo unknown)
EOF

echo "Done. Restore: stop PB, replace pb_data from $DEST/pb_data, restore dist if needed, start PB 0.28.4"
