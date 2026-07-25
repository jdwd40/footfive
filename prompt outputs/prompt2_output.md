# Prompt 2 completion report — Shared 24/7 Proball

**Date:** 2026-07-25  
**PocketBase target:** 0.28.4  
**Status:** Complete (implementation + tests + docs)

---

## Summary

Replaced Phase 1 **private per-user careers/tournaments** with **one shared global Proball**:

- Global 16 teams; atomic **team claim** (one manager/team, one team/user); **spectators** allowed.
- Shared tournament, fixtures, scoreboard, and match views for every user.
- **Incremental** match simulation (segments of ~5 match minutes), not full pre-generation at kickoff.
- **Live coaching** Defend / Balanced / Attack (applies from next unsimulated segment).
- **Winner betting** with lock at kickoff and once-only settlement; **1000** starting fictional credits.
- Cron + route **catch-up** keep the championship progressing offline.
- `project_plan.md` updated to v3.0 as source of truth for the shared world.

## Architecture changes

| Before (Phase 1) | After (Phase 2) |
|---|---|
| Career per user + private 16 AI copies | One `world` + 16 `proball_teams` |
| Full match timeline at round generation | `match_states` advanced in segments |
| Career-scoped scoreboard routes | Shared `/world`, `/scoreboard`, `/match` |
| No live intervention | Coaching commands + stance on match state |
| Bets scaffold only | `shared_bets` + `credit_ledger` placement/settle |

### Simulation

- `createMatchState` at kickoff (scores 0–0, no final).
- `advanceSegment` generates only due minutes (~5), appends events, updates cursor.
- Segment real time ≈ `segmentMinutes × matchMinuteRealMs` (normal: 5×4s = 20s).
- Idempotency: `last_segment_key` + `processing_version` inside short transactions.
- Coaching modifiers from central `balance.js` (modest attack/defence shifts).

## Collections & migrations

**New migration:** `pocketbase/pb_migrations/1750000001_shared_world.js`

- `world`, `proball_teams`, `proball_players`
- `shared_tournaments`, `shared_rounds`, `shared_fixtures`
- `match_states`, `coaching_commands`
- `shared_bets`, `credit_ledger`, `global_team_records`
- Users: `credits`

**Phase 1 leftovers (unused):** `careers`, `career_*`, old `matches` / `fixtures` / `tournaments` — not deleted; product path no longer uses them.

## Routes, hooks, jobs

**Hooks:** `pb_hooks/main.pb.js`, `lib/worldService.js`, `lib/matchEngine.js` (incremental), `balance.js`, `teams.js`, `tournament.js`

**Cron:** `footfive_catchup` every minute → `catchUpWorld`

**Routes:**

- `GET /api/footfive/server-time|world|teams|tournament|scoreboard|match/{id}`
- `POST /api/footfive/teams/{id}/claim|lineup`
- `POST /api/footfive/catch-up`
- `POST /api/footfive/matches/{id}/coaching`
- `GET /api/footfive/betting/fixtures`, `POST /bets`, `GET /bets/mine`
- `POST /api/footfive/admin/teams/{id}/release`, `GET /admin/ping`
- Legacy `POST /career` rejected; `GET /career` deprecated wrapper

## Files created / changed / removed

### Created

- `pocketbase/pb_migrations/1750000001_shared_world.js`
- `pocketbase/pb_hooks/lib/worldService.js`
- `src/pages/BettingPage.tsx`
- `src/domain/sharedWorld.test.ts`
- `prompt outputs/prompt2_output.md`

### Major rewrites

- `pocketbase/pb_hooks/lib/matchEngine.js` — incremental
- `pocketbase/pb_hooks/lib/balance.js` — coaching, segments, starting credits
- `pocketbase/pb_hooks/main.pb.js` — shared routes
- `src/lib/pocketbase.ts`, dashboard, team select, scoreboard, live match, landing
- `project_plan.md`, `README.md`, `changelog.md`, `new_features.md`, `bugs.md`

### Not removed

- `careerService.js` (orphaned Phase 1 helper; unused by main.pb.js)
- Old migration `1750000000_init_footfive.js` (still applies base collections)

## Development data reset

- Local **`pocketbase/pb_data` wiped** so Phase 2 migrations + seed run clean.
- Phase 1 private careers/fixtures **not preserved** (per prompt).
- Auth users recreated in testing; production would need a deliberate migration plan.

## Tests & results

| Suite | Result |
|---|---|
| Unit (`vitest`) | **11 passed** (incremental engine, coaching, draw, balance) |
| `tsc -b` | **pass** |
| `vite build` | **pass** |
| Manual two-user | **pass** — same round id & 8 fixtures; claim conflict “Team already claimed”; second user claims other team; live minutes advance |

## Known limitations

- Lineup **API only** (no full squad UI).
- Bets only while fixtures are **scheduled** (lock at kickoff).
- AI always **Balanced** coaching.
- Orphan Phase 1 collections remain in DB.
- No CI multi-user integration suite yet.

## Confirmed unresolved bugs

See `bugs.md` (legacy collections, lineup UI gap, optional unique-index dialect, lint peers).

## Remaining Phase 1 private-world code

- Unused: `careerService.js`, Phase 1 collections/names in migration 0.
- Product routes no longer create private R16s or careers.

## Documentation updates

- `project_plan.md` v3.0 — shared world, incremental sim, coaching, betting, 1000 credits.
- `README.md`, `changelog.md`, `new_features.md`, `bugs.md` aligned with Phase 2.

## Recommended Prompt 3 scope

1. Full **lineup/intensity UI** + energy/condition display  
2. **Rewards** after matches + credit ledger types  
3. **Upgrades / batteries / repairs** with server validation  
4. **Command Charge** gauge + spend actions  
5. **Records** screens from `global_team_records`  
6. **Admin** assign/remove managers, credit adjust, soft-delete users  
7. Drop or archive Phase 1 collections cleanly  
8. Integration tests (two users, claim race, bet settle, coaching cooldown)

---

*End of Prompt 2 report.*
