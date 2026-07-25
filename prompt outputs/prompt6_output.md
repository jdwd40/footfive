# Prompt 6 completion report — Production Hardening & Deployment Readiness

**Date:** 2026-07-25  
**PocketBase:** 0.28.4 (not upgraded)  
**Status:** Complete

---

## Summary of work completed

Production-hardening for shared Proball: Playwright + isolated API E2E, historical backfill, team/tournament/match detail pages, admin password reset, stall recovery, expanded security locks, performance sampling, local backup test, and VPS deploy pack (Nginx, systemd, scripts, DEPLOY.md). Live gameplay systems preserved.

---

## Bugs fixed

| Issue | Fix |
|---|---|
| Credits self-edit possible via user record PATCH | Hook reloads DB user and force-restores credits/role/disabled |
| Admin password reset missing | `POST .../admin/users/{id}/password` + audit (no password logged) |
| No player/summary backfill path | Admin backfill preview/run + `backfill_runs` |
| No stall recovery | `recoveryService` + admin tools + catch-up cron enhancement |
| List-only records | Detail pages for team / tournament / match |
| Phase 5 open bugs on Playwright/backfill/password/detail | Addressed (UI Playwright needs OS libs) |

---

## E2E tests added

| Suite | Location | Notes |
|---|---|---|
| API e2e (preferred CI) | `tests/integration/e2e-api.mjs` | Auth, shared world, claim conflict, security negatives, admin, retention preview, backfill preview, password reset, records detail |
| Playwright browser | `e2e/*.spec.ts` | Auth UI, viewport matrix, security, shared world |
| Runner | `scripts/e2e-run.sh` | Isolated `pb_data_test`, seed, preview server; **API always**; UI if chromium libs present |
| Unit | vitest domain tests | security contracts, backfill, recovery stubs |

**API e2e result:** **21 passed, 0 failed** against local PB 0.28.4.

**Playwright UI:** Chromium fails on this host without `libnspr4` (needs `npx playwright install-deps chromium` as root). Suite is present; runner skips UI and reports warning when libs missing.

---

## Viewports tested

Configured in `playwright.config.ts`:

- 320×700, 360×800, 390×844, 430×932, tablet 768×1024, desktop 1366×768

Automated UI overflow checks exist; full matrix runs when browser deps installed. Default runner uses mobile-390 + desktop when UI available.

---

## Data backfilled

- `GET/POST /api/footfive/admin/backfill/{status,preview,run}`
- Creates missing `match_summaries` from finalised `match_states` (idempotent)
- Settles `global_player_records` only when summary newly created
- Tournament summaries for complete tournaments without summary
- Preview mode writes only `backfill_runs` metadata; no fabrication of unnamed scorers
- Admin UI: Tools → Backfill

---

## Administrator changes

- Password reset with temp password, optional `must_change_password`, tokenKey rotation
- Backfill status/preview/run + audit
- Stall recovery status, clear lock, global recovery + audit
- Tools tab in admin UI

---

## Deployment files and instructions

| Path | Purpose |
|---|---|
| `deploy/DEPLOY.md` | Full VPS guide |
| `deploy/nginx.example.conf` | SPA + API + SSE |
| `deploy/pocketbase.service.example` | systemd unit |
| `deploy/deploy.sh` | check/backup/apply/rollback |
| `deploy/smoke-prod.sh` | Non-destructive smoke |
| `scripts/backup-local.sh` | Local timestamped backup |
| `scripts/perf-sample.mjs` | Timing sample |

Local backup verified: `backups/<stamp>/` with pb_data, dist, hooks, migrations.

---

## PocketBase hooks, routes and migrations changed

**Migration:** `1750000009_production_hardening.js`  
- `users.must_change_password`  
- `world.last_recovery_*`, `stall_threshold_ms`  
- `backfill_runs`  
- indexes on match_states, fixtures, summaries, bets, ledger  

**New services:** `backfillService.js`, `recoveryService.js`  

**Routes:**  
- Records detail: teams/tournaments/matches `/{id}`  
- Admin password, backfill, recovery  

**Hooks:** stronger user update protection; write locks on records/ledgers/players/tournaments/rounds  

**Cron:** catch-up detects stalls and recovers before normal catch-up  

---

## Production security checks

Negative tests (API e2e):

- Cannot self-promote to admin  
- Cannot self-set credits  
- Cannot call admin/retention/backfill as user  
- Admin password reset does not return password  
- Collection write locks on match_states etc.  

Audited: list/create/update rules remain server-side for sensitive data.

---

## Backup and recovery checks

- `scripts/backup-local.sh` created timestamped copy successfully  
- Restore procedure documented (stop → replace pb_data → start 0.28.4)  
- Rollback script warns before `RESTORE_PB_DATA=1`  

---

## Performance findings

Sample on local PB (dev data, cold-ish):

| Endpoint | ~ms |
|---|---|
| health | 1–2 |
| world | ~49 |
| scoreboard | ~50 |
| records/overview | ~6 |
| records/teams | ~3 |
| catch-up | ~43 |

Actions: indexes added; detail endpoints scoped; list caps retained. No N+1 explosion observed on overview. Full event histories not loaded on scoreboard.

---

## Tests run and results

| Command | Result |
|---|---|
| `npm run test` | **40 passed** |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `node tests/integration/e2e-api.mjs` | **21 passed** |
| `bash scripts/backup-local.sh` | pass |
| `node scripts/perf-sample.mjs` | pass |
| Playwright UI | **skipped** (missing libnspr4 on host) |

---

## Remaining limitations

- Playwright browser needs OS packages (`libnspr4` et al.) on this VPS/dev host  
- Not every gameplay flow (live coaching mid-match, full SO browser) is UI-automated  
- Management window remains **global** while a shared round is live (by design — simultaneous kickoffs)  
- Historical player backfill only when events contain player names  

---

## Confirmed unresolved bugs

- Browser E2E blocked without system chromium deps (env, not app)  
- Global management lock intentional (see DEPLOY.md / bugs.md)  

---

## Recommended Prompt 7 scope

1. Install Playwright deps in CI image; full viewport matrix green.  
2. Expand UI E2E for live match coaching + betting settlement with dev-pace world.  
3. Observability: structured logs / health for cron last success.  
4. Optional soft “must change password” gate in frontend.  
5. Read-replica or caching only if load requires.  

---

## Management window (final rule)

While any fixture in the **current shared round** is live, **all managers** share a global management lock. Matches the simultaneous round schedule. Eliminated teams wait for the next tournament interval. No per-team mid-tournament prep for MVP.
