# Prompt 8 completion report — Controlled VPS Production Deployment

**Date:** 2026-07-25  
**Status:** **Deployed (first production install)**  
**PocketBase:** **0.28.4** (not upgraded)

---

## Deployment status

**SUCCESS** — FootFive release candidate is live on the existing VPS (`dwarf-vps` / `my-vps`), isolated from other apps (including math-sprint PocketBase on `:8090`).

This was a **greenfield FootFive install** (no prior FootFive `pb_data` on the VPS). Existing VPS services and data were left intact.

| Check | Result |
|---|---|
| Local unit tests | 40 pass |
| Typecheck | pass |
| Lint (app `src/`) | 0 errors (3 warnings documented) |
| Production build | pass |
| API e2e (local) | 21 pass |
| PB version on VPS | 0.28.4 |
| Service active | `footfive-pocketbase` active |
| Public frontend | https://jdwd40.com/footfive/ → 200 |
| Public health | https://jdwd40.com/footfive-pb/api/footfive/health → world + tournament |
| Auth world/scoreboard | 8 fixtures, tournament #1 r16 |
| Admin as normal user | 403 |
| Role self-promote | blocked (role stays `user`) |
| math-sprint PB | still healthy on 8090 |

---

## VPS paths used

| Item | Path |
|---|---|
| App root | `/home/jd/footfive` |
| PB binary | `/home/jd/footfive/pocketbase/pocketbase` |
| `pb_data` | `/home/jd/footfive/pb_data` |
| Hooks | `/home/jd/footfive/pocketbase/pb_hooks` |
| Migrations | `/home/jd/footfive/pocketbase/pb_migrations` |
| Frontend releases | `/home/jd/footfive/releases/<stamp>/` |
| Current symlink | `/home/jd/footfive/current` |
| Nginx web root | `/var/www/jdwd40.com/html/footfive/` |
| Nginx snippet | `/etc/nginx/snippets/footfive.conf` |
| systemd unit | `footfive-pocketbase.service` |
| Logs | `/home/jd/footfive/logs/` |
| Backups | `/var/backups/footfive/<stamp>/` (mode 700, root) |

---

## Domain and API routes

| URL | Role |
|---|---|
| https://jdwd40.com/footfive/ | React SPA |
| https://jdwd40.com/footfive-pb/ | PocketBase reverse proxy → `127.0.0.1:8091` |
| https://jdwd40.com/footfive-pb/api/health | PB health |
| https://jdwd40.com/footfive-pb/api/footfive/health | App health |
| https://jdwd40.com/footfive-pb/api/realtime | Realtime/SSE (proxied, buffering off, 3600s timeouts) |

Frontend build env:

```text
VITE_BASE_PATH=/footfive/
VITE_POCKETBASE_URL=https://jdwd40.com/footfive-pb
```

No superuser/password/test credentials in `dist/`.

---

## Backup created

| Backup | Contents |
|---|---|
| `/var/backups/footfive/20260725T161319Z/` | Pre-deploy nginx config |
| `/var/backups/footfive/20260725T161542Z/` | Post-deploy `pb_data`, hooks, migrations, web, nginx snippet, systemd unit (~7.5M) |

Disk: ~38G free on `/` before/after (healthy).

---

## Git commit and branch deployed

**Local tree is not a Git repository** (no `.git` in `/home/jd/projects/grok/grokball`).

Deployed from the local workspace release candidate (Prompt 7 + deploy fixes: basename, asset paths, eslint scope).

**Tag not pushed** (no git remote/repo). Suggested when git is initialised:

```bash
git tag -a footfive-rc1 -m "FootFive production RC1 on jdwd40.com"
```

Deploy stamp on VPS: `20260725T161542Z` (`/home/jd/footfive/DEPLOYED_STAMP`).

---

## PocketBase service status

```text
systemctl is-active footfive-pocketbase  → active
Listen: 127.0.0.1:8091 only
User: jd
Restart: on-failure
```

Bootstrap note: first start logged a one-time world bootstrap race before migrations finished; restart after superuser create succeeded with `shared world ready`.

---

## Migrations applied

All additive migrations `1750000000` … `1750000010` applied on first start of empty `pb_data`. Phase-1 drop migrations logged expected relation noise then cleaned shells (same as local P5/P6 history). Shared world collections created; **no production wipe**.

---

## Nginx changes

- Added `/etc/nginx/snippets/footfive.conf` (SPA + PB proxy + SSE-friendly settings).
- Included from `jdwd40.com` site (after math-sprint include).
- `nginx -t` passed; reloaded.
- Pre-change site config backed up under `/var/backups/footfive/…`.
- **Did not** replace the full site config; **did not** alter math-sprint or other apps.

---

## Health and smoke-test results

| Probe | Result |
|---|---|
| Frontend HTML title | FootFive — Proball Manager |
| Main JS asset | HTTP 200 |
| PB `/api/health` | healthy |
| App `/api/footfive/health` | `worldAvailable: true`, tournament #1 `r16` |
| Authenticated world | tournament id present |
| Scoreboard | **8 fixtures** |
| Catch-up | accepted for auth user |
| Admin overview as user | **403** |
| Unauth world/admin | **401** |
| Service restart | health restored; tournament still active |
| math-sprint `:8090` | still healthy |

---

## Shared-world verification

- Single world key `main` available after bootstrap.
- Active tournament **#1**, round **r16**, status **active**.
- Scoreboard returns **8** shared fixtures (R16).
- No second world/tournament from deploy.
- math-sprint data untouched.

---

## Rollback location

### Frontend only

```bash
# list releases
ls /home/jd/footfive/releases/
# point current + web to previous stamp
ln -sfn /home/jd/footfive/releases/<PREV> /home/jd/footfive/current
sudo rsync -a --delete /home/jd/footfive/releases/<PREV>/ /var/www/jdwd40.com/html/footfive/
sudo systemctl reload nginx
```

### PocketBase code (hooks/migrations)

```bash
sudo systemctl stop footfive-pocketbase
rsync -a --delete /var/backups/footfive/20260725T161542Z/pb_hooks/ /home/jd/footfive/pocketbase/pb_hooks/
rsync -a --delete /var/backups/footfive/20260725T161542Z/pb_migrations/ /home/jd/footfive/pocketbase/pb_migrations/
sudo systemctl start footfive-pocketbase
```

### Full data rollback (only if DB corrupted)

```bash
sudo systemctl stop footfive-pocketbase
# preserve failed state
sudo mv /home/jd/footfive/pb_data /home/jd/footfive/pb_data.failed-$(date -u +%Y%m%dT%H%M%SZ)
sudo cp -a /var/backups/footfive/20260725T161542Z/pb_data /home/jd/footfive/pb_data
chown -R jd:jd /home/jd/footfive/pb_data
# restore matching hooks if needed
sudo systemctl start footfive-pocketbase
curl -sf http://127.0.0.1:8091/api/footfive/health
```

### Disable site paths (emergency)

```bash
sudo rm /etc/nginx/snippets/footfive.conf   # or comment include in jdwd40.com
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl stop footfive-pocketbase
```

---

## Problems encountered and fixes

| Issue | Resolution |
|---|---|
| No prior FootFive on VPS | First install on isolated paths/ports |
| Port 8090 used by math-sprint | FootFive on **8091** only |
| Not a git repo locally | Deployed from workspace; tag deferred |
| ESLint scanned generated PB types / hooks | Scoped eslint to `src/**` |
| SPA under `/footfive/` | `VITE_BASE_PATH`, `BrowserRouter` basename, asset `BASE_URL` |
| Initial nginx `root` path confusion | Switched to `alias` pattern; verified FootFive HTML |
| Bootstrap race on first empty DB start | Restart after superuser; world ready |
| Lint treated as optional in P7 | App lint now **0 errors** (3 non-blocking warnings) |

---

## Remaining risks

1. **First install empty history** — new world; no legacy FootFive users/bets to migrate (none existed).  
2. **App admin role** — first app admin must be promoted (`users.role=admin`) after register; PB superuser is separate (credentials only on server, mode 600).  
3. **CSP** on jdwd40.com is site-wide; currently allows `connect-src` to same host (OK for `/footfive-pb`).  
4. **No git tag** until repo is initialised/pushed.  
5. **Smoke user accounts** created during verification remain in production DB (disable/delete via admin when an app admin exists).  
6. Cron catch-up will fully exercise only as wall-clock minutes elapse post-deploy.

---

## Final recommendation

**Production is live and usable** at:

**https://jdwd40.com/footfive/**

Recommended next operator steps:

1. Register the first real operator account.  
2. Promote to app admin (SQL or PB admin UI field `role=admin`).  
3. Optional: disable/delete temporary `deploy_smoke_*` users.  
4. Initialise git remote and tag `footfive-rc1`.  
5. Monitor `journalctl -u footfive-pocketbase -f` and `/home/jd/footfive/logs/` for catch-up lines.  
6. Keep backups under `/var/backups/footfive/` (root-only).

**Do not** point this deploy at math-sprint `pb_data`. **Do not** upgrade PocketBase past 0.28.4 without a separate plan.
