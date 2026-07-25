# Prompt 3 completion report — Cyborg Management, Economy, Command Charge

**Date:** 2026-07-25  
**PocketBase:** 0.28.4  
**Status:** Complete

---

## Summary

Implemented the between-round **mini-management loop** on the shared Proball:

- Squad UI (7 players, starters/subs, intensity, effective stats)
- **Team treasury** separate from **personal betting credits**
- Upgrades, batteries, mechanical repairs (transactional, window-locked)
- Energy offline regen + match drain; Condition wear + no natural regen
- Automatic substitutions (max 2) in the incremental match engine
- Match freeze snapshots with materialised Energy
- Treasury rewards (win/goals/progress/consolation/champion) exactly once
- Command Charge (5 max) with Rapid Charge, Field Repair, Tactical Scan, Overclock
- AI maintenance for unclaimed teams
- Removed orphan `careerService.js` and private career create routes
- Additive migration `1750000002` (no `pb_data` wipe)

## Architecture decisions

1. **Dual wallets:** team treasury vs `users.credits` — never cross-spend.
2. **Single effective-stat function** (`effectiveStats.js`) for server sim + UI estimates.
3. **Energy materialisation** from value + `energy_updated_at` (no per-minute writes).
4. **Reward settlements** unique key table + finance ledger idempotency.
5. **Global management window** closed while any shared round is live (simple, secure).
6. **Overclock** stored on team, consumed into match snapshot at freeze.

## Collections / migrations

**New:** `1750000002_management_economy.js`

| Collection / field | Purpose |
|---|---|
| `proball_teams.treasury`, `battery_count`, `overclock_*` | Team economy |
| `proball_players.energy_updated_at` | Energy regen |
| `world.ai_progression_enabled` | AI upgrades flag |
| `command_charge` | Per-user CC |
| `tactical_scans` | Scan reports |
| `team_finance_ledger` | Immutable team cash log |
| `reward_settlements` | Exactly-once rewards |

**Not dropped:** Phase 1 tables (still unused; documented).

## Routes / hooks / jobs

**New routes:** `/my-team`, `/my-team/squad|lineup|intensity|finances|tactical-scan`, `/players/{id}/upgrade|battery|repair`, `/team-shop/batteries/buy`, `/command-charge`, `/command-charge/spend`

**Modules:** `managementService.js`, `effectiveStats.js`; updates to `matchEngine.js`, `worldService.js`, `balance.js`, `main.pb.js`

**Cron:** unchanged name; still `catchUpWorld` (+ AI maintain after rounds)

## Files created / changed / removed

### Created
- `pb_migrations/1750000002_management_economy.js`
- `pb_hooks/lib/managementService.js`, `effectiveStats.js`
- `src/pages/SquadPage.tsx`
- `src/domain/management.test.ts`
- `prompt outputs/prompt3_output.md`

### Changed
- `matchEngine.js` (wear, auto-sub, effective stats)
- `worldService.js` (freeze, rewards, world snapshot, hydrate)
- `balance.js`, `main.pb.js`, frontend API/dashboard/App
- Docs: plan, README, changelog, new_features, bugs

### Removed
- `pb_hooks/lib/careerService.js`

## Tests & results

| Check | Result |
|---|---|
| Unit tests | **20 passed** |
| `tsc -b` | **pass** |
| `vite build` | **pass** |
| API smoke | Claim team, load squad (treasury 2500, 7 players, CC 5); upgrades correctly rejected when management closed during live round |

## Development data

- **No `pb_data` wipe** for Phase 3.
- Migration applied on serve; existing users/teams preserved.
- Existing teams backfilled treasury/batteries via SQL update in migration.

## Known limitations

- Management window is **global** (not per-team).
- Records centre UI not built.
- Admin credit-adjust UI not built.
- Phase 1 tables not dropped.
- Some older in-flight match_states may need a new round for clean player snapshots after earlier advance errors.

## Unresolved bugs

See `bugs.md` (global lock scope, residual Phase 1 tables, optional stall recovery).

## Documentation updates

- `project_plan.md` 3.1 — dual economy, Phase 3 formulas
- `README.md`, `changelog.md`, `new_features.md`, `bugs.md`

## Recommended Prompt 4 scope

1. Records / history UI  
2. Admin: credit adjust, manager reassign, team release UI  
3. Retention cleanup job  
4. Per-team management window (optional)  
5. Drop Phase 1 collections after audit  
6. Richer AI coaching + progression tuning  
7. Integration suite: full tournament rewards + resource deltas  

---

*End of Prompt 3 report.*
