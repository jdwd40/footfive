# FootFive VPS deployment (PocketBase 0.28.4)

Do **not** upgrade PocketBase. Do **not** wipe `pb_data`.

## Production (confirmed 2026-07-25)

| Item | Value |
|---|---|
| Host | `dwarf-vps` / `my-vps` |
| SPA | https://jdwd40.com/footfive/ |
| API | https://jdwd40.com/footfive-pb/ → `127.0.0.1:8091` |
| App root | `/home/jd/footfive` |
| `pb_data` | `/home/jd/footfive/pb_data` |
| Hooks / migrations | `/home/jd/footfive/pocketbase/pb_{hooks,migrations}` |
| Web files | `/var/www/jdwd40.com/html/footfive/` |
| systemd | `footfive-pocketbase.service` |
| Nginx | `/etc/nginx/snippets/footfive.conf` (included from `jdwd40.com`) |
| Backups | `/var/backups/footfive/<stamp>/` (root, mode 700) |
| Build flags | `VITE_BASE_PATH=/footfive/` `VITE_POCKETBASE_URL=https://jdwd40.com/footfive-pb` |

**Note:** math-sprint uses PB on `:8090` + `/ms` — do not reuse those paths.

## Generic layout (template)

| Path | Content |
|---|---|
| `/home/jd/footfive/pocketbase/pocketbase` | Binary 0.28.4 |
| `/home/jd/footfive/pb_data` | Database + storage (persistent) |
| `/home/jd/footfive/pocketbase/pb_hooks` | JS hooks |
| `/home/jd/footfive/pocketbase/pb_migrations` | JS migrations |
| `/var/www/jdwd40.com/html/footfive` | Vite production build |
| `/etc/nginx/snippets/footfive.conf` | SPA + PB proxy |
| `/etc/systemd/system/footfive-pocketbase.service` | systemd unit |

Frontend `VITE_POCKETBASE_URL` at **build time** must be the public API origin (`https://jdwd40.com/footfive-pb`).

## First-time setup

1. Install Nginx, certbot, create user `pocketbase`.
2. Copy PB 0.28.4 binary + empty `pb_data` OR existing data.
3. Copy `pb_hooks` + `pb_migrations` from release.
4. Install systemd unit; `systemctl enable --now pocketbase`.
5. Create superuser: `./pocketbase superuser upsert … --dir=pb_data`.
6. Build frontend with correct `VITE_POCKETBASE_URL`; rsync to `/var/www/footfive/dist`.
7. Install Nginx config; enable HTTPS; reload Nginx.
8. Promote first admin: set `users.role='admin'` via superuser UI or SQL once.

## Deploy update

```bash
export FOOTFIVE_ROOT=/opt/footfive/app
export PB_ROOT=/opt/pocketbase
export WEB_ROOT=/var/www/footfive/dist
export SERVICE_NAME=pocketbase

cd $FOOTFIVE_ROOT && git pull   # or unpack release
npm ci
VITE_POCKETBASE_URL=https://your.domain ./deploy/deploy.sh apply
./deploy/smoke-prod.sh
```

`apply` sequence: tests → build → timestamped backup → stop PB → rsync hooks/migrations/frontend → start PB → health.

Migrations apply automatically on PocketBase start.

## Rollback

```bash
./deploy/deploy.sh rollback
# include data only if necessary:
RESTORE_PB_DATA=1 ./deploy/deploy.sh rollback
```

**Warning:** Restoring old `pb_data` after newer migrations may be incompatible. Prefer forward-fix + code rollback first.

## Backup / restore

```bash
./scripts/backup-local.sh   # local
# or deploy/deploy.sh backup
```

Restore:

1. `systemctl stop pocketbase`
2. Replace `pb_data` from backup
3. Optionally restore `pb_hooks` / `dist`
4. `systemctl start pocketbase`
5. Smoke checklist

Retention jobs **never** delete backups.

## Health checks

- `curl https://domain/api/health` (PocketBase)
- `curl https://domain/api/footfive/health` (app; public safe status)
- Frontend loads `/`
- Login page loads
- `GET /api/footfive/world` → 401 unauthenticated
- Admin route rejects normal user (`Admin only`)
- Admin `/admin` shows System health when role=admin
- Journal: `journalctl -u pocketbase -f`
- Cron: catch-up + retention — look for `[footfive-json]` structured lines

## Release candidate checklist

1. Backup `pb_data`  
2. Deploy hooks + migrations + `dist` with correct `VITE_POCKETBASE_URL`  
3. Restart PocketBase 0.28.4 only  
4. Confirm migrations applied (new health fields)  
5. `./deploy/smoke-prod.sh`  
6. Login as admin → health panel OK  
7. Spot-check scoreboard + one live match  
8. Keep prior release `dist` + hooks for rollback  

## Management window rule (final)

While **any fixture in the current shared round is live**, **all managers** share a global management lock (lineup/upgrades locked). This matches simultaneous round kickoffs. Eliminated teams wait for the next tournament interval; no per-team mid-tournament prep window. **Design rule**, not a bug.

## Security notes

- PocketBase listens on localhost only; Nginx terminates TLS.
- Collection create/update for scores, treasury, credits, records locked to hooks.
- Admin routes require `users.role === admin`.
- Temporary password reset must use `mustChange` for untrusted channels.
- Never commit `pb_data` or secrets.
- Never log passwords or tokens (`logger.js` redacts known fields).
