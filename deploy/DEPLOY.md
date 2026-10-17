# FootFive VPS deployment (PocketBase 0.28.4)

Do **not** upgrade PocketBase. Do **not** wipe `pb_data`.

## Production (confirmed 2026-07-25)

| Item | Value |
|---|---|
| Host | `<vps-host>` (operator SSH alias; see repository secrets) |
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
2. Install the PB 0.28.4 binary with `bash scripts/fetch-pocketbase.sh <dir>` (linux amd64/arm64;
   refuses any archive whose SHA-256 differs from `scripts/pocketbase-release.sha256`, the
   official release checksums) + empty `pb_data` OR existing data.
3. Copy `pb_hooks` + `pb_migrations` from release.
4. Install systemd unit; `systemctl enable --now pocketbase`.
5. Create superuser: `./pocketbase superuser upsert … --dir=pb_data`.
6. Deploy the frontend through the deploy workflow or the gated manual `apply` below, so it is
   built with the correct `VITE_POCKETBASE_URL` from a tested main commit; never from an
   arbitrary local build.
7. Install Nginx config; enable HTTPS; reload Nginx.
8. Promote / create app admin (not PB superuser):

```bash
export FOOTFIVE_PB_URL=http://127.0.0.1:8091
export FOOTFIVE_SUPERUSER_EMAIL=...
export FOOTFIVE_SUPERUSER_PASSWORD=...
export FOOTFIVE_ADMIN_EMAIL=...   # operator admin email (required for --username admin)
export FOOTFIVE_ADMIN_PASSWORD=...   # stdin/env only; never commit
node /home/jd/footfive/scripts/footfive-admin.mjs ensure-admin --username admin --confirm
```

Weak bootstrap passwords force `must_change_password=true`.

### Between-round timing

- World field `between_round_minutes` (default **3** for testing).
- Admin UI: save interval; **Apply to waiting round** only when not live.
- Daily backups: `footfive-backup.timer` → `/var/backups/footfive/`. `pb_data` is an online, verified
  SQLite snapshot (`scripts/pb-data-backup.py`; PocketBase keeps running). A failed backup is marked
  `STATUS` failed and `LATEST` stays on the last good one. Each deploy installs `footfive-backup.sh` and
  its helper in `/home/jd/footfive/scripts/`.

### Match speed

- World field `match_minute_real_seconds` (default **15**).
- 90′ ≈ 22m30s wall clock; admin range 1–60.
- Snapshotted onto fixtures/match_states at kickoff; live matches keep snapshot.
- Admin UI: “Real seconds per match minute”.

### App admin account

```bash
export FOOTFIVE_ADMIN_EMAIL=...   # operator-chosen admin email; required for --username admin
export FOOTFIVE_ADMIN_PASSWORD=...   # never commit
node scripts/footfive-admin.mjs ensure-admin --username admin --confirm
```

Forces `must_change_password=true` on bootstrap.

### Trusted proxy (rate limits)

PocketBase rate limits (`1750000015_rate_limits.js`) are per client IP. Behind nginx
PocketBase only sees `127.0.0.1` unless it trusts a forwarding header, so every player
would share one budget (playtest symptom: "Too many requests", Offline banner, bet panel gone).

- nginx must send `proxy_set_header X-Real-IP $remote_addr;` on the `/api/` locations
  (`deploy/nginx.example.conf`). PocketBase is configured to trust exactly that header.
- New and existing servers get it from `pb_migrations/1750000018_trusted_proxy.js` on the
  next deploy. To check or set it by hand: Admin UI → Settings → Trusted proxy → headers
  `X-Real-IP` ("Use leftmost IP" off; it only applies to `X-Forwarded-For`).
- If you change the nginx header (e.g. to `X-Forwarded-For`), change the PocketBase setting
  to match. Only trust a header nginx overwrites, or clients can spoof their IP.
- PocketBase must only listen on localhost (`127.0.0.1:8090`) so the header can't be forged
  by bypassing nginx.

### Playtest bots and load tests

Never point bots or load tests at the live server: they spend the same per-IP budget as
real players (and, before the trusted-proxy fix, the same single bucket). Run them against
a local isolated instance instead — `npm run test:e2e` already starts its own PocketBase on
`127.0.0.1:8091` with a scratch `pb_data_test` (binary via `scripts/setup-local.sh`). If
bots need more headroom there, raise the limits on that instance only (Admin UI → Settings →
Rate limits), not in a migration. Note the account-security e2e step deliberately exhausts
the login 429 budget, so it runs last.

## CI/CD (GitHub Actions → VPS)

Repo: https://github.com/jdwd40/footfive  
Workflow: `.github/workflows/deploy.yml` — runs only for a commit that **FootFive CI fully tested**:

- **Automatic:** after a `FootFive CI` run for a push to `main` in this repository completes
  successfully (`workflow_run`). Failed or cancelled CI never deploys.
- **Manual:** *Run workflow* on `main` with the full 40-character `sha` of the main head. Tick
  `rollback` only for an emergency rollback to an older main commit; it is gated the same way.

0. Gate (before any secret or SSH): `scripts/verify-deploy-ci.mjs` requires the latest
   `.github/workflows/footfive-ci.yml` push run on `main` for exactly that SHA to have passed
   *Unit / type / lint / build*, *PocketBase API E2E* and *Playwright Chromium*, and (unless
   `rollback`) that SHA to still be the main head. Every later job checks out, builds, deploys and
   records that SHA, never the latest main.
1. Unit tests + typecheck + lint  
2. Production build (`VITE_BASE_PATH=/footfive/`, `VITE_POCKETBASE_URL=https://jdwd40.com/footfive-pb`)  
3. SSH deploy: first a verified `pb_data` snapshot (`scripts/pb-data-backup.py` from the tested checkout, piped to `sudo -n python3`) plus hooks/migrations/web/scripts backups to root-owned `/var/backups/footfive/<stamp>/`; any backup failure aborts before production changes. Then SPA release under `/home/jd/footfive/releases/<stamp>/`, rsync to nginx web root, update hooks/migrations, restart `footfive-pocketbase`
4. Health verification: app health JSON validated on the runner (`status == "ok"` and `worldAvailable == true`, via `scripts/validate-health.mjs`); only then provenance markers `DEPLOYED_STAMP` + `DEPLOYED_SHA` (the exact tested commit) are written in `/home/jd/footfive/`
5. Public smoke: SPA + PB health + app health JSON validated the same way + unauth world = 401

**Never** deploys or wipes `pb_data`. Binary stays on the VPS.

### Required repository secrets

| Secret | Example |
|---|---|
| `VPS_HOST` | `<vps-ip-or-hostname>` |
| `VPS_PORT` | `<ssh-port>` |
| `VPS_USER` | `<deploy-user>` |
| `VPS_SSH_PRIVATE_KEY` | ed25519 private key (pubkey in VPS `authorized_keys`) |
| `VPS_KNOWN_HOSTS` | Trusted host-key lines for `[<vps-host>]:<ssh-port>` (see below) |

`VPS_KNOWN_HOSTS` pins the VPS host identity; the deploy workflow refuses to
run without it and never falls back to runtime `ssh-keyscan`
(trust-on-first-use). Provision it out-of-band by an operator who already
trusts the host — e.g. from an existing verified SSH session or the VPS
console, run `ssh-keyscan -p "$VPS_PORT" "$VPS_HOST"` and cross-check the
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

SHA=<full 40-character main head whose FootFive CI push run passed>
cd $FOOTFIVE_ROOT && git fetch origin && git checkout --detach "$SHA"
npm ci
VITE_POCKETBASE_URL=https://your.domain ./deploy/deploy.sh apply "$SHA"
./deploy/smoke-prod.sh
```

`apply` sequence: gate → tests → build → timestamped backup (verified `pb_data` snapshot; a failure stops here) → stop PB → rsync hooks/migrations/frontend → start PB → health.
The gate refuses unless the checkout is clean and exactly at `SHA`, and `SHA` is the main head whose
FootFive CI push run passed all three required jobs (same `scripts/verify-deploy-ci.mjs` as the
workflow; needs an authenticated `gh`). Never deploy a floating `git pull`, a dirty checkout or an
untested commit.

Migrations apply automatically on PocketBase start.

## Rollback

Emergency rollback is not a new release:

- **Previous files:** `deploy/deploy.sh rollback` restores the last backup taken by `apply`; it
  deploys no new code, so it is not CI-gated.
- **Older tested commit:** run the deploy workflow manually with that main commit's `sha` and
  `rollback` ticked. It must still have passed FootFive CI; only the main-head rule is relaxed.
  Commits older than `a9aa8f4` lack `scripts/validate-health.mjs`, so their deploy fails closed.

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
2. Replace the whole `pb_data` directory with the backup copy (snapshots carry no `-wal`/`-shm`; never
   copy a backup `data.db` over a live directory's sidecar files)
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
