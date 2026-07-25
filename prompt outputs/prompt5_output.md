# Prompt 5 completion report — Records, Admin, Retention, Shootout kicks

**Date:** 2026-07-25  
**PocketBase:** 0.28.4 (not upgraded)  
**Status:** Complete

---

## Summary of work completed

Built the shared **records centre**, **administrator console**, **configurable retention** (7/30/90/Never), **authoritative shootout kick state**, and removed obsolete **Phase 1 private-world collections**. Shared tournament progression, live coaching, betting, and scoreboard remain operational.

---

## Records and history architecture

| Layer | Role |
|---|---|
| `global_team_records` | All-time team W/D/L, goals, SO, championships, finals, NT/ET wins |
| `global_player_records` | Appearances, goals, cards, pens, shootout kicks, championships |
| `match_summaries` | Compact permanent match row (scores, SO kicks JSON, goals/cards, stats) |
| `tournament_summaries` | Bracket snapshot, champion, totals, highlights |
| Settlement | Team stats on round complete (`progression_settled`); player stats once when match summary **created** |

UI: `/records` tabs — Overview · Teams · Players · Tournaments · Archive · My bets.

Overview highlights: titles, wins, goals, defence, SO wins, top scorer/carded when data exists, recent champions, current tournament #.

Match archive filters: tournament, team, ET, shootout. Shows compact summary if `events_purged`.

User betting history: own bets only + credit ledger + balance + net.

---

## Administrator functionality

- Role: `users.role === "admin"` enforced on every admin route (`requireAdmin`).
- Disabled accounts blocked at `onRecordAuthRequest`.
- Non-admins cannot set role, credits, disabled, or admin_note via record API.

| Area | Capabilities |
|---|---|
| Dashboard | Users, managed/available teams, live fixtures, tournament, retention, pause, recent audit |
| Users | List/search, create, disable/enable, delete (releases team), +credits |
| Teams | Treasury adjust, release manager, reset energy (full reset modes on API) |
| World | Catch-up, pause/resume, retention days, interval settings |
| Retention | Status, preview, run |
| Audit | Recent sensitive actions |

Credits and treasury: transactional, reason required, no negative balances, ledger rows, before/after audit.

---

## Retention behaviour

- Global `world.retention_days`: **0 | 7 | 30 | 90** (default 30).
- Job: `footfive_retention_daily` cron `0 3 * * *`; admin manual run + preview.
- Eligibility: completed fixture, complete tournament, completion older than cutoff, compact summary exists, not live/scheduled.
- Deletes: `match_states.events_json` → `[]`, marks `events_purged`, old coaching cmds, old tactical scans.
- Never deletes: users, current tournament/live state, summaries, scores, champions, team/player records, ledgers, bets, audit.
- Preview: `deleted` stays 0. Never policy: skip delete. Idempotent re-run safe.

---

## Collections and migrations changed

| Migration | Change |
|---|---|
| `1750000003_records_admin_retention.js` | match/tournament_summaries, retention_runs, user.disabled/admin_note, world retention fields |
| `1750000004_phase1_drop_player_records.js` | Drop obsolete Phase1 (partial), global_player_records, team record fields |
| `1750000005–0008` | Force-drop remaining Phase1 shells (circular relations + rules) |

**Removed collections:** careers, career_teams, career_players, tournaments, rounds, fixtures, matches, team_templates, and other private leftovers.

**Preserved shared:** proball_*, shared_*, match_states, world, ledgers, command_charge, etc.

---

## Routes, hooks and scheduled jobs

**Records:**  
`GET /api/footfive/records/{overview,teams,players,tournaments,matches}`  
`GET /api/footfive/bets/history`

**Admin:** overview, users CRUD-ish, credits, treasury, assign/release/reset, world catch-up/pause/resume/settings, retention status/preview/run, audit.

**Hooks:** user create forces role=user + starting credits; user update strips privilege/credit self-edit; auth blocks disabled; collection write locks on teams/fixtures/bets/match_states.

**Cron:** `footfive_catchup` `*/1`; `footfive_retention_daily` `0 3 * * *`.

**Services:** `recordsService.js`, `adminService.js`, `retentionService.js`; shootout kicks in `matchEngine.js`; summaries wired in `worldService.js`.

---

## Legacy data removed or preserved

- **Removed:** empty Phase 1 private collections (no product code references).
- **Preserved:** all shared tournament/match/team/player history structures; `pb_data` not wiped.
- Prior applied migrations never edited in place.

---

## Files created, changed, removed

**Created:**  
`pb_migrations/1750000003…0008*.js`, `pb_hooks/lib/{records,admin,retention}Service.js`, `src/pages/RecordsPage.tsx` (expanded), `src/domain/{retention,shootoutBoard}.test.ts`, `tests/integration/prompt5-api.smoke.mjs`, `prompt outputs/prompt5_output.md`

**Changed:**  
`main.pb.js`, `worldService.js`, `matchEngine.js`, `AdminPage.tsx`, `LiveMatchPage`/`ShootoutBoard`, `pocketbase.ts`, docs (`project_plan`, `changelog`, `new_features`, `bugs`, `README`)

**Removed:** Phase 1 collections from live DB (not source of historical migrations).

---

## Tests run and results

| Command | Result |
|---|---|
| `npm run test` | **34 passed** (6 files) |
| `npm run typecheck` | pass |
| `npm run build` | pass (vite production) |
| `node tests/integration/prompt5-api.smoke.mjs` | OK — shared tournament/scoreboard, records, bets history, admin denied for user |
| Admin smoke (promoted user) | overview/retention/preview/Never/credits/audit **200** |

Playwright full viewport matrix not automated (known limitation).

---

## Development data affected

- Additive migrations on existing `pb_data`.
- New empty summary/player record tables until matches complete under Phase 5 path.
- Test users created during smoke (`p5a_*`, `admin_p5_*`).
- Phase 1 empty collections deleted.

---

## Backup and recovery steps verified

1. Stop PB → copy `pocketbase/pb_data/` → restart (documented in README + Admin retention tab).
2. Restore by replacing `pb_data` with backup under same 0.28.4 binary.
3. Confirmed PB health after migrations; no automatic backup deletion in retention job.
4. Git must not track `pb_data` (existing practice).

---

## Known limitations

- No full Playwright multi-viewport CI.
- No dedicated admin password-reset endpoint (create/disable/delete workflow).
- Player stats not backfilled for pre-Phase-5 completed matches.
- Records team UI is list-centric (no full squad detail page).
- Admin assign-team UI button set is minimal (API complete).

---

## Confirmed unresolved bugs

See `bugs.md` Open: global management lock while any round live; Playwright CI; admin password reset; player backfill; team detail depth.

---

## Documentation updates

- `project_plan.md` → v3.3 Phase 5  
- `changelog.md`, `new_features.md`, `bugs.md`, `README.md`  
- This file: `prompt outputs/prompt5_output.md`

---

## Recommended Prompt 6 scope

1. Playwright (or similar) mobile viewport matrix + critical e2e flows.  
2. Records team-detail + tournament-detail pages with full bracket.  
3. Safe backfill of player/match summaries from existing finished `match_states`.  
4. Admin password reset + richer user search filters.  
5. Per-manager management windows (unlock other teams while one fixture is live).  
6. Optional: transfers / training only if plan elevates them — else keep deferred.

---

## Completion criteria checklist

- [x] Shared team/player records paths accurate for new settlements  
- [x] Tournament history browsable  
- [x] Match archive with full or compact data  
- [x] Own betting history  
- [x] Admin accounts, credits, treasury, assign/release, reset, audit  
- [x] Retention 7/30/90/Never + preview + safe cleanup  
- [x] Backup/restore documented  
- [x] Authoritative shootout kicks  
- [x] Phase 1 collections removed  
- [x] Live shared world still healthy  
- [x] Unit/type/build/integration smoke pass  
- [x] `prompt outputs/prompt5_output.md` exists  
