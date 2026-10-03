# FootFive broadcast overhaul

## What changed (base `main` @ a9aa8f4)

| Area | Before | Now |
|---|---|---|
| Match engine | 5-minute pre-simulated segments; JSON event blob revealed by offset | `matchEngine.js` v2: advances step by step on the server; one ordered `match_events` row per event, public only once `at ≤ now` |
| Scores | reconstructed in the browser | every event carries the published state (score, shootout, phase, clock, stats) |
| Results | `winner_team` written before the reveal | written only after the final whistle is public |
| Substitutions | in-match auto-subs | none — reserves rotate between matches |
| Betting | one market, one bet per fixture, float payout | 7 markets (`markets.js`), Poisson odds (`odds.js`), integer ledger, idempotency, stale-price and incident suspension (`bettingService.js`) |
| Management | locked while any match was live | always open; changes apply at the team's next kick-off; My settings / Full AI |
| UI | mobile dashboard / scoreboard / live pages | Live · Match · Betting · My Team · History, SVG highlights |

## Rules worth knowing

- One tick (`worldService.tick`) advances the whole championship to "now". It is idempotent and runs on reads (throttled) plus a one-minute cron.
- Shootout goals live only in `st.so`; they never touch the football score, goal stats or goal markets.
- Markets close while `st.d` (danger) is set: attacks, penalties, goal celebrations and the whole shootout.
- The next championship is drawn when the final ends but stays hidden (no fixtures, no markets) until the fixture window opens.
- Managers can't bet on their own fixtures or on championship futures; users with a pending bet involving a team can't claim it.

## Timing (Admin → Dashboard)

| Setting | Field | Default |
|---|---|---|
| Real seconds per match minute | `world.match_minute_real_seconds` | 15 |
| Break between rounds | `world.between_round_minutes` | 1 |
| Next championship after the final | `world.championship_gap_minutes` | 10 |
| Fixtures shown before kick-off | `world.fixtures_window_minutes` | 5 |

The gap must be ≥ the fixture window. `FOOTFIVE_TIME_SCALE` (env, tests only) divides every wall-clock duration.

## Verification

- `npm test` — engine, odds, markets, highlight scenes, management.
- `tests/integration/championship-cycle.mjs` against a server started with `FOOTFIVE_TIME_SCALE=60` — several championships unattended, betting/claim rules, late join, schedule.
- `scripts/audit-db.py <data.db>` — scores = events, shootout correctness, exactly-once summaries/rewards/payouts, balances = ledger.
