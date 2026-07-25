# Prompt 7 completion report — Release Candidate

**Date:** 2026-07-25  
**PocketBase:** 0.28.4  
**Status:** Complete — release candidate

---

## Summary of completed work

Turned FootFive into a dependable release candidate:

- **Browser E2E green** on Linux (Chromium mobile 390 + desktop 1366) via vendored nss/nspr + Playwright container CI.
- **Password-change gate** for admin temp passwords (`must_change_password` → `/change-password`).
- **Observability:** structured JSON logs, public + admin health routes, admin health panel.
- **Resilience:** live poll backoff + connection warning; catch-up health recording; restart recovery smoke.
- **Perf:** route-level lazy loading (main JS ~290 kB gzip ~90 kB).
- **Rehearsal:** isolated `pb_data_rehearsal` + backup + API/recovery/perf smoke.
- Deployment docs updated; open bugs triaged.

---

## Browser E2E results

| Suite | Result |
|---|---|
| `npm run test:e2e` (API + Playwright) | **API 21 + Playwright 62 = green** |
| Unit vitest | **40 passed** |
| typecheck / production build | pass |

Playwright projects (default run): `chromium-mobile` (390×844), `chromium-desktop` (1366×768).  
Viewport-only projects available for 320/360/430/tablet via full project list / `E2E_ALL`.

**Covered flows:** auth, password change, admin health, two-user scoreboard, live match open/switch, coaching panel, security negatives, shared claim, viewport overflow, shootout archive API.

---

## Viewports and browsers tested

- Chromium 390×844 (mobile) — full suite  
- Chromium 1366×768 (desktop) — full suite  
- Overflow routes also exercised on those viewports  
- Optional Firefox via `E2E_FIREFOX=1`  
- CI image: `mcr.microsoft.com/playwright` with chromium install  

Local without root: `scripts/ensure-playwright-libs.sh` vendors `libnspr4`/`libnss3` into `e2e/.browser-libs` and sets `LD_LIBRARY_PATH`.

---

## CI workflow

`.github/workflows/footfive-ci.yml`:

1. Unit + typecheck + lint (soft) + build + bundle note  
2. API E2E with isolated PB 0.28.4 on 8091  
3. Playwright job in official browser container  
4. Artifacts on failure (reports, logs)  
5. No caching of `pb_data_test`

---

## Observability features

- `pocketbase/pb_hooks/lib/logger.js` — structured `[footfive-json]` lines (no secrets)  
- Catch-up cron logs start/complete/error + duration  
- World fields: `last_catchup_*`, health status (migration `1750000010`)  

### Health routes

| Route | Scope |
|---|---|
| `GET /api/footfive/health` | Public safe: status, time, world available, tournament summary |
| `GET /api/footfive/admin/health` | Admin: stalls, live FX, last catch-up/retention/recovery, errors |

Admin UI dashboard: **System health** panel (`data-testid=admin-health`).

---

## Password-change flow

1. Admin resets password with `mustChange: true`  
2. User logs in with temporary password  
3. App redirects to `/change-password` (blocked from other routes)  
4. `POST /api/footfive/account/change-password` validates current password, sets new, clears flag, rotates tokenKey  
5. Audit `password_change` without storing passwords  
6. Client re-auths and lands on dashboard  

Also: `GET /api/footfive/me` exposes `must_change_password`.

---

## Production rehearsal results

`scripts/rehearsal.sh` (verified exit 0):

- Unit + typecheck + build  
- Local backup  
- Isolated `pb_data_rehearsal` on :8092 (port freed first)  
- Seed + API e2e + restart-recovery + perf sample  
- Production preview + `/api/footfive/health`  

Does **not** touch production `pb_data`.

---

## Performance and resilience findings

| Metric | Finding |
|---|---|
| Main JS after lazy routes | ~290 kB (~90 kB gzip) vs ~357 kB monolithic P6 |
| Scoreboard / world | ~50 ms local (prior sample) |
| Live poll offline | Exponential backoff to 15s; non-destructive connection banner |
| Double catch-up | Idempotent (unique event seqs) — recovery smoke |

---

## Files changed (highlights)

**New:**  
`logger.js`, `healthService.js`, migration `1750000010`, `ChangePasswordPage`, CI workflow, `ensure-playwright-libs.sh`, `restart-recovery.mjs`, `rehearsal.sh`, e2e `live-gameplay.spec.ts`, expanded auth/viewport specs  

**Updated:**  
`main.pb.js` (health, change-password, me, catch-up logging), `auth.tsx`, `App.tsx` (lazy routes + password gate), `useLiveMatch` (backoff), Live/Admin/Login testids, Playwright config/e2e-run, docs  

---

## Tests run and results

| Command | Result |
|---|---|
| `npm run test` | 40 pass |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `node tests/integration/e2e-api.mjs` | 21 pass |
| `bash scripts/e2e-run.sh` | **62 Playwright + API green** |
| Password/health smoke | pass |
| `node scripts/restart-recovery.mjs` | pass |

---

## Remaining limitations

- Full multi-round browser tournament sim not one single long test (covered by API + live open/switch/coach).  
- Firefox optional; not default CI.  
- Deterministic in-match penalty/shootout UI still leans on engine unit + archive API (dev-pace world timing is variable).  
- CI must download PocketBase binary if not vendored in repo.  

---

## Confirmed unresolved bugs

- None release-blocking.  
- Global management lock while round is live = **documented design rule** (not a bug).  

---

## Deployment recommendation

**Ready for controlled VPS deploy** of this RC:

1. Backup production `pb_data`  
2. Deploy hooks + migrations + frontend build with correct `VITE_POCKETBASE_URL`  
3. Start PB 0.28.4; confirm `/api/footfive/health`  
4. Run `deploy/smoke-prod.sh`  
5. Smoke admin login + health panel  
6. Keep rollback path from `deploy/DEPLOY.md`  

Do not upgrade PocketBase. Do not wipe `pb_data`.
