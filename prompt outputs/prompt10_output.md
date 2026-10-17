# Prompt 10 completion report — Tournament start, connection stability, countdown

**Date:** 2026-07-25  
**Status:** **Complete — deployed to production**  
**PocketBase:** **0.28.4** (not upgraded)

---

## Production state before work

| Item | Value |
|---|---|
| Service | `footfive-pocketbase` active |
| Health | ok · tournament #1 r16 active |
| World | `main`, pace `dev`, round_interval_ms 25000 |
| Round | r16 **live** (started 16:14:59Z) |
| Fixtures | 7 live + 1 finished (later all stuck near sim_minute 95) |
| Match states | `state_json` / `events_json` **null** for live rows |
| Users | 1 (operator admin, email redacted) |
| between_round_minutes | missing |

---

## Root cause — championship not starting / not progressing

**Primary:** Live matches **stuck at sim_minute ≥ 90** without completing.

1. `match_states.state_json` / `events_json` were empty in production for live matches, so phase flags (`fullTimeDone`, `halfTimeDone`, `etStarted`) reset every segment.
2. Full-time transition only ran when `nextMin === 91` exactly. Once `sim_minute` was already 95, the loop hit `nextMin > 90 && !etStarted → break` and **never finalised**.
3. Catch-up kept advancing segment_index (700+) with no progress; round progression waited forever.
4. Scoreboard reconstructed scores only from events → empty events → UI looked dead (0–0, no progress).

**Secondary (scheduler path):** missing/invalid `scheduled_at` and no `between_round_minutes` made waiting-round timing hard to control; new rounds now use admin minutes (default **3**).

**Not causes:** cron was registered; progression not paused; world/tournament not duplicated.

---

## Root cause — intermittent connection warnings

`useLiveMatch` / `useRoundStore` treated **one** failed poll (or stale/aborted navigation) as a user-facing error. Hidden-tab pauses and single timeouts looked like “connection issue”.

**Fix:** shared connection state — ignore aborts & hidden-tab; reconnecting at 2 fails; warning at 3+; clear on success; keep last scoreboard/match state.

---

## Tournament scheduler changes

- Recover missed phase transitions in `advanceSegment` when flags lost.
- `safeJson()` before saving `state_json` / `events_json` / `stats_json`.
- hydrateState repairs corrupt player lists; reconstructs flags from sim minute.
- Scoreboard/match view fall back to DB scores when events empty.
- `kickOffRound` more idempotent (unique match_state safe).
- `between_round_minutes` (default 3) drives next-round schedule via `effectiveRoundIntervalMs`.
- `repairRoundSchedule` for missing `scheduled_at`.
- Admin `apply-between-round` for waiting rounds only.
- Round announce fields `announce_key` / `announced_at`.

---

## Countdown / warnings / announcements

- Shared `useRoundTiming` + `RoundCountdownBanner` on all authenticated layouts.
- Server offset from scoreboard `serverTimeMs`.
- 60s warning toast once per round; 10s critical countdown.
- Round-start toast once per `announceKey`.
- No negative countdown; prep state when no schedule.

---

## Admin timing setting

- World field `between_round_minutes` (1–1440), default **3**.
- Admin dashboard panel: view/save interval; apply to waiting round.
- Routes: `PATCH .../admin/world/settings`, `POST .../admin/world/apply-between-round`.
- Audit entries without passwords.

---

## Administrator account setup

| Field | Result |
|---|---|
| Username | `admin` |
| Email | `admin@footfive.local` (login identity: **admin**) |
| Role | `admin` |
| must_change_password | **true** |
| Initial password | set via env on server only (not in git/logs) |
| Login verified | `/api/footfive/auth/login` + admin overview 200 |
| Password min | temporarily 7 on users.password for bootstrap |

Existing operator account (email redacted) remains admin.

CLI: `scripts/footfive-admin.mjs ensure-admin --username admin --confirm` with `FOOTFIVE_ADMIN_PASSWORD`.

---

## Production after deploy

| Check | Result |
|---|---|
| Backup | `/var/backups/footfive/20260725T165255Z` ok |
| Deploy stamp | `20260725T165252Z` |
| Health | ok |
| R16 | completed after stuck-match recovery |
| QF | **scheduled** with 3 min wait → **auto live** at due time |
| QF fixtures | 4 live; scoreboard minutes advancing |
| between_round_minutes | 3 |
| Worlds / tournaments | still one each |
| Frontend | https://jdwd40.com/footfive/ |
| Secrets in dist | none |

**Verified automatic QF start:** catch-up after `scheduled_at` set QF live; 4 fixtures live; announceKey present.

---

## Files changed (high level)

**Backend:** `matchEngine.js`, `worldService.js`, `adminService.js`, `main.pb.js`, migration `1750000011_round_timing_username.js`, `scripts/footfive-admin.mjs`

**Frontend:** `useConnectionStatus.ts`, `useRoundTiming.ts`, `RoundCountdownBanner.tsx`, `Layout.tsx`, `useRoundStore.ts`, `useLiveMatch.ts`, `LoginPage.tsx`, `auth.tsx`, `AdminPage.tsx`, `pocketbase.ts`

**Tests:** match recovery, connection thresholds, countdown helpers

**Docs:** this report; `bugs.md`, `changelog.md`, `project_plan.md`, `README.md`, `deploy/DEPLOY.md`

---

## Tests run

| Suite | Result |
|---|---|
| Unit (vitest) | **49 pass** |
| Typecheck | pass |
| Lint `src/` | 0 errors (2 prior warnings) |
| Production build | pass |
| Production smoke | health ok; QF live; admin login ok |
| Controlled restart | during deploy; service healthy |

---

## Known limitations

- Production world still `pace=dev` (fast match minutes) — intentional not to retarget mid-live; interval between rounds now 3 min via setting.
- One R16 score (18–0) was anomalous from pre-fix stuck state; not rewritten.
- Password field min set to 7 for bootstrap; force change on first admin login.
- No git remote push in this phase.

---

## Confirmed unresolved bugs

None release-blocking for scheduler/connection. Optional: set production pace to `normal` after current tournament settles (operator action).

---

## Recommended next product step

Operator: log in as `admin`, change password, confirm countdown banner + admin timing UI; leave QF running; optionally set pace to `normal` after a clean between-round window.
