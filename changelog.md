# Changelog

## 2026-07-25 — Phase 8: production deployment

- First production install on VPS `my-vps` (host `dwarf-vps`).
- URLs: https://jdwd40.com/footfive/ (SPA), https://jdwd40.com/footfive-pb/ (PB 0.28.4 on 127.0.0.1:8091).
- systemd `footfive-pocketbase`; nginx snippet; backups under `/var/backups/footfive/`.
- Isolated from math-sprint PB on :8090. Shared world tournament #1 R16 verified.
- Details: `prompt outputs/prompt8_output.md`.

---

## 2026-07-25 — Phase 7: release candidate

### E2E / CI

- GitHub Actions `footfive-ci.yml` (unit, API e2e, Playwright container).
- Local E2E green: **62** browser tests + **21** API checks.
- Vendored nss/nspr for Chromium without root (`scripts/ensure-playwright-libs.sh`).

### Auth

- Forced password change when `must_change_password` set by admin reset.
- Routes block management/betting until password updated.

### Observability

- Structured logs (`logger.js`); catch-up metrics on `world`.
- `GET /api/footfive/health` and `/api/footfive/admin/health`.
- Admin System health panel.

### Resilience / perf

- Live match poll backoff + connection warning.
- Lazy-loaded routes; main bundle ~290 kB.
- `scripts/rehearsal.sh` + `restart-recovery.mjs`.

---

## 2026-07-25 — Phase 6: production hardening

### E2E

- Playwright suite + `scripts/e2e-run.sh` with `pb_data_test`.
- API E2E `tests/integration/e2e-api.mjs` (21 critical checks).
- Viewport projects configured; UI needs host chromium libs.

### Backfill & recovery

- Admin backfill preview/run for match/player/tournament summaries.
- Stall detection + recovery; catch-up cron recovers stale locks.

### Admin / records

- Password reset route; team/tournament/match detail pages.
- Stronger credit/role protection on user updates.

### Deploy

- `deploy/` Nginx, systemd, deploy/rollback/smoke scripts.
- Local `backup-local.sh` verified.

---

## 2026-07-25 — Phase 5: records, admin, retention

### Records

- Mobile records centre: overview, teams, players, tournaments, match archive, own bets.
- Permanent `match_summaries` + `tournament_summaries`; compact when events purged.
- `global_player_records` settled once per completed fixture (with match summary).
- Team records: W/D/L, SO, finals, championships, NT/ET wins.

### Admin

- Protected `/api/footfive/admin/*` (role check server-side).
- Users: list, create, disable/enable, delete (releases team), credit adjust + ledger.
- Teams: treasury adjust, assign/release, operational reset modes.
- World: catch-up, pause/resume, retention days, intervals.
- Audit log on sensitive actions.

### Retention

- Policy: 7 / 30 / 90 days or Never (0).
- Daily cron `footfive_retention_daily` ~03:00; preview + manual run.
- Purges detailed `events_json` only when summary exists, tournament complete, past cutoff.
- Never deletes accounts, ledgers, summaries, audit, active fixtures.

### Shootout

- Authoritative `shootoutKicks[]` on match state/view (team, kick #, outcome, mustScore, decisive).
- Shootout board uses kick list (not score-only inference).

### Cleanup

- Phase 1 private collections dropped (migrations 1750000004–0008).
- Shared world collections retained.

### Tests

- Unit: shootout kicks, retention Never/preview, board markers (34 tests).
- Integration smoke: `node tests/integration/prompt5-api.smoke.mjs`.

### Backup

- Documented: copy `pocketbase/pb_data/` while stopped; never commit `pb_data`.

---

## 2026-07-25 — Phase 4: flagship live match + scoreboard

### Live UX

- Shared `useRoundStore` for scoreboard / ticker / switcher.
- Event reveal queue with dedupe, late-open catch-up, Catch up to Live.
- Score reconstruction from revealed events only.
- Penalty focus panel; shootout board with kick markers.
- Polished fixture cards (live chip, countdown, managed-team mark).
- Match switcher strip; coaching pending state; collapsible stats.
- Reduced-motion and aria-live for major events.

### Balance report

- Sample script `scripts/shootout-sample.mjs` (80 matches): ~18.8% shootouts, ~32.5% ET.

### Tests

- Event queue + score unit tests (27 total unit tests).

---

## 2026-07-25 — Phase 3: management economy

Squad UI, treasury, Command Charge, rewards, AI maintain.

---

## 2026-07-25 — Phase 2: shared Proball

Shared world, claims, incremental sim, coaching, betting.

---

## Phase 1 (historical)

Private careers — superseded.
