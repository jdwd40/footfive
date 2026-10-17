# Prompt 11 completion report — Slow match pacing & admin login repair

**Date:** 2026-07-25  
**Status:** **Complete — deployed**  
**PocketBase:** **0.28.4** (not upgraded)

---

## Root cause — fast event presentation

1. **Server clock turbo:** production world used `pace=dev` with `match_minute_real_ms ≈ 200` (0.2s per match minute). Event `offsetMs` are derived from that clock, so many events became “due” almost immediately.
2. **Frontend hold times too short:** `eventDisplay.ts` held minor events ~0.6–0.9s and majors ~1.5–2.2s — unreadable even at sane server speed.
3. **Catch-up path:** late-open / bulk ingest treated ordinary backlog as catch-up and shortened holds further.

Not primarily a poll-interval bug.

---

## Match-speed changes

| Setting | Value |
|---|---|
| Default | **15 real seconds per match minute** |
| Field | `world.match_minute_real_seconds` (+ `match_minute_real_ms`) |
| Range | 1–60 |
| 90′ wall time | ~22m 30s |
| ET 30′ wall | ~7m 30s |

- Kickoff snapshots speed onto `shared_rounds` / `shared_fixtures` / `match_states.match_minute_real_ms`.
- Live matches keep snapshot (current live QF still on legacy **200ms** snapshot so mid-match clock does not jump).
- Next unstarted matches use global **15s**.
- Admin-only `PATCH /api/footfive/admin/world/settings` with `match_minute_real_seconds`.

---

## Event-queue changes

- Central holds raised (minor ~4s, medium ~6s, major ~9s, goals ~11s).
- Live polling uses **live** mode; catch-up only when late-open or large backlog / user “Catch up”.
- Catch-up never collapses majors below floors; order preserved; score from revealed only.
- One event at a time; no simultaneous multi-message replace.

---

## Administrator-account repair

| Item | Result |
|---|---|
| Before | No `<admin-email>` (only `admin@footfive.local` / legacy operator) |
| Root cause of login fail | Account did not exist under that email |
| After | Single user `<admin-email>`, role `admin`, enabled |
| Password | Set via env on server only (not in git/logs/audit body) |
| `must_change_password` | **true** |
| Login verified | `auth-with-password` success |
| Admin overview | **200** |
| Unauth admin | **401** |

Legacy `admin@footfive.local` record **rebound** to `<admin-email>` (idempotent, no duplicate).

---

## Auth / migrations / routes

- Migration `1750000012_match_speed_snapshot.js`
- Hooks: `balance.js`, `worldService.js`, `adminService.js`, `matchEngine.js`
- CLI: `scripts/footfive-admin.mjs ensure-admin` uses `FOOTFIVE_ADMIN_EMAIL` (required for `--username admin`)

---

## Frontend files

- `eventDisplay.ts`, `eventQueue.ts`, `useLiveMatch.ts`
- `AdminPage.tsx` (match-speed control)
- Types in `pocketbase.ts`
- Tests: `eventPacing.test.ts`, `matchSpeed.test.ts`, queue tests

---

## Tests

| Suite | Result |
|---|---|
| Unit | **59 pass** |
| Typecheck | pass |
| Lint `src/` | 0 errors |
| Production build | pass |
| Dist secret scan | clean |
| Prod login <admin-email> | OK |
| Prod set speed 15 | OK |

---

## Production deployment

| Item | Value |
|---|---|
| Backup | `/var/backups/footfive/20260725T172822Z` ok |
| Deploy stamp | `20260725T172815Z` |
| Service | active / healthy |
| World speed | `match_minute_real_seconds=15` |
| Live snapshot | 4 live matches at **200** ms (legacy kickoff) |
| Tournament | #2 QF active |
| Worlds | 1 |

---

## Remaining limitations

- Current live QF still finishes at legacy turbo snapshot until those fixtures complete; **future** rounds use 15s/min.
- World `pace` field still `dev` for other intervals; match minute overridden by `match_minute_real_seconds`.
- Audit create for CLI ensure-admin still sometimes skipped (role/password update succeeded).

---

## Confirmed unresolved bugs

None release-blocking for speed or admin login.

---

## Recommended next step

Log in as `<admin-email>`, complete password change, confirm admin match-speed panel and slower live commentary on the **next** scheduled round after current QF ends.
