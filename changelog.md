# Changelog

## 2026-10-05 — Live match polish

- Failed attacks show what happened (WIDE / OVER / BLOCKED / SAVED! / WOODWORK badges) instead of a generic NO GOAL; badge and commentary read the same engine outcome.
- Possession resolves on screen: blocker collects, keeper catches or parries then gathers, keeper launches the saving side's own distribution; engine tracks the ball holder (`st.bs`, `turn` flag on turnovers) so a turnover is drawn as a clearance, not an attacker in the keeper's hands.
- Engine authoritative outcomes preserved: a 200-seed regression (`engine.test.ts`) pins event tuples, final score/winner and RNG draw count to base 33dc1b8 (a long-dribble → through-ball conversion that changed 17/200 seeded results was removed after review). Period restarts reset the ball to the centre; livelier dwell (client lay-offs, nearest opponent closes) means passing is seen slightly more often; restart/kick-off/dribble scenes slightly shorter. Engine goal/penalty/shootout holds unchanged.
- Smaller players (r 1.45, ref 1.15); pitch capped to the viewport; on-pitch HUD (score, clock, PENS, "<ABB> to kick") fed from the same reveal-gated state as the scoreboard.
- Referee trails play without the centre-line flip and holds the box corner during penalties and shootouts.
- QA harness `scripts/live-watch.mjs` (+ `live-watch-snapshot.mjs`): frames, video, console errors and chronological score/clock/HUD snapshots from a real backend match or a labelled offline-engine replay.
- Verified by independent QA on isolated backend matches (normal play, goals, cards, saves, blocks, misses, FT, knockout progression at 1440x900 / 1280x720 / 390x844) plus labelled offline-engine fixture replays for in-match penalties and shootouts incl. sudden death. Visual feel approval still JD's.

---

## 2026-10-04 — Full live simulation

- Engine narrates every minute (passes, tackles, shots); `bounce` off the boards replaces corners; 8 s match minutes.
- Match page is a server-timeline player: full 5-v-5 on the pitch, commentary in sync with the frame; Quick highlights pref removed.
- Big GOOOAL banner (goal + celebration), shootout banners (sudden death, score to go through, must score, winner through).
- Other-match ticker on the match page; 20 s auto-return to the round after full time with a countdown (tap to stay).

---

## 2026-07-26 — GitHub Actions deploy on main

- `.github/workflows/deploy.yml` — test, production build, SSH deploy to VPS on push to `main`.
- Deploy key + repo secrets (`VPS_HOST` / `PORT` / `USER` / `SSH_PRIVATE_KEY`).
- Helper: `scripts/setup-github-deploy-secrets.sh`.
- Repo: https://github.com/jdwd40/footfive

---

## 2026-07-25 — Phase 12: admin screen + team abbreviations

- Admin post-login routing to `/admin` (or `/change-password` first); Admin nav + dashboard link.
- `RequireAdmin` guard with loading/forbidden states; admin shell + retry on API errors.
- Official 3-letter team abbreviations (MET, MC1, … DOG) on teams + APIs.
- Compact tickers / match switcher use abbreviations; main scoreboard keeps full names.
- Details: `prompt outputs/prompt12_output.md`.

---

## 2026-07-25 — Phase 11: match pacing 15s/min + admin login repair

- Official default: **1 match minute = 15 real seconds** (`world.match_minute_real_seconds`).
- Kickoff speed snapshots on fixtures/match_states; live matches keep snapshot.
- Admin control for match speed; applies to unstarted matches only.
- Live event holds slowed (readable minor/medium/major/goal pacing); catch-up no longer default.
- Repaired app admin `admin@admin.com` (must_change_password); password via env only.
- Details: `prompt outputs/prompt11_output.md`.

---

## 2026-07-25 — Phase 10: tournament start, countdown, connection stability

- **Root fix:** stuck matches past 90' when phase flags lost with empty `state_json` — recovery in match engine + safe JSON persist + score fallback.
- Production R16 recovered and completed; **QF auto-started** on 3-minute schedule.
- `between_round_minutes` (default **3**); admin save + apply-to-waiting-round.
- Global countdown banner, 60s / 10s warnings, once-per-round start announcement.
- Connection state: no warning on single failure; reconnecting @2; offline @3+; ignore abort/hidden-tab.
- App admin user `admin` (username login) with forced password change; `ensure-admin` CLI.
- Migration `1750000011_round_timing_username.js`.
- Details: `prompt outputs/prompt10_output.md`.

---

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
