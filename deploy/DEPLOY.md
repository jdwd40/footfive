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
8. Promote / create app admin (not PB superuser):

```bash
export FOOTFIVE_PB_URL=http://127.0.0.1:8091
export FOOTFIVE_SUPERUSER_EMAIL=...
export FOOTFIVE_SUPERUSER_PASSWORD=...
export FOOTFIVE_ADMIN_PASSWORD=...   # stdin/env only; never commit
node /home/jd/footfive/scripts/footfive-admin.mjs ensure-admin --username admin --confirm
```

Weak bootstrap passwords force `must_change_password=true`.

### Between-round timing

- World field `between_round_minutes` (default **3** for testing).
- Admin UI: save interval; **Apply to waiting round** only when not live.
- Daily backups: `footfive-backup.timer` → `/var/backups/footfive/`.

### Match speed

- World field `match_minute_real_seconds` (default **15**).
- 90′ ≈ 22m30s wall clock; admin range 1–60.
- Snapshotted onto fixtures/match_states at kickoff; live matches keep snapshot.
- Admin UI: “Real seconds per match minute”.

### App admin account

```bash
export FOOTFIVE_ADMIN_EMAIL=admin@admin.com
export FOOTFIVE_ADMIN_PASSWORD=...   # never commit
node scripts/footfive-admin.mjs ensure-admin --username admin --confirm
```

Forces `must_change_password=true` on bootstrap.

## CI/CD (GitHub Actions → VPS)

Repo: https://github.com/jdwd40/footfive  
Workflow: `.github/workflows/deploy.yml` — on **push to `main`** (and `workflow_dispatch`):

1. Unit tests + typecheck + lint  
2. Production build (`VITE_BASE_PATH=/footfive/`, `VITE_POCKETBASE_URL=https://jdwd40.com/footfive-pb`)  
3. SSH deploy: code-only backup to root-owned `/var/backups/footfive/<stamp>/` via scoped `sudo -n`, SPA release under `/home/jd/footfive/releases/<stamp>/`, rsync to nginx web root, update hooks/migrations, restart `footfive-pocketbase`
4. Health verification: app health JSON validated on the runner (`status == "ok"` and `worldAvailable == true`, via `scripts/validate-health.mjs`); only then provenance markers `DEPLOYED_STAMP` + `DEPLOYED_SHA` (exact commit) are written in `/home/jd/footfive/`
5. Public smoke: SPA + PB health + app health JSON validated the same way + unauth world = 401

**Never** deploys or wipes `pb_data`. Binary stays on the VPS.

### Required repository secrets

| Secret | Example |
|---|---|
| `VPS_HOST` | `213.165.91.221` |
| `VPS_PORT` | `4020` |
| `VPS_USER` | `jd` |
| `VPS_SSH_PRIVATE_KEY` | ed25519 private key (pubkey in VPS `authorized_keys`) |
| `VPS_KNOWN_HOSTS` | Trusted host-key lines for `[213.165.91.221]:4020` (see below) |

`VPS_KNOWN_HOSTS` pins the VPS host identity; the deploy workflow refuses to
run without it and never falls back to runtime `ssh-keyscan`
(trust-on-first-use). Provision it out-of-band by an operator who already
trusts the host — e.g. from an existing verified SSH session or the VPS
console, run `ssh-keyscan -p 4020 213.165.91.221` and cross-check the
fingerprints against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on
the VPS, then store the verified lines (hashed or plain, one per line) as the
secret value. Never commit the value to the repo; rotate it if the VPS host
keys are ever regenerated.

One-shot helper for the first four secrets (after `gh auth login`):

```bash
./scripts/setup-github-deploy-secrets.sh
```

### Manual deploy (operator on VPS / local with SSH)

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
