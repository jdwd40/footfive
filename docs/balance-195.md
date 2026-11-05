# #195: 6-second minutes and recommended goal tuning

This change intentionally changes outcomes, scorelines and odds. Only the official
minute default (8s → 6s), on-target base (0.45 → 0.50) and save base (0.57 → 0.48)
change. Sequence/shot rates, engine code, RNG, cosmetic generation, tactical and
fitness policies, and all fixed result/goal/penalty/kickoff holds remain unchanged.
The target is about 3 goals per 90 match minutes.

## Calibration

`node scripts/engine-calibrate.mjs 3000`, same 3,000 seeded inputs, 2026-11-02:

| Metric | Before | Recommended |
|---|---:|---:|
| Goals/90 | 2.16 | 2.95 |
| Extra time | 26.3% | 21.9% |
| Shootouts | 10.2% | 6.7% |
| Favourite wins | 79.0% | 82.0% |
| Shots/match | 16.5 | 16.2 |
| On target/match | 6.1 | 6.7 |

The calibration script uses an explicit 15s snapshot: speeding the real-time default
does not increase goals per 90. The increase above comes from the two goal-model
constants. A default 90-minute match takes about 9 real minutes before unchanged
holds and breaks; live Admin overrides still support 1–60 seconds.

## Migration and deployment

`pocketbase/pb_migrations/1750000020_match_speed_6s.js` paginates all world rows
in stable id order, sets both seconds=6 and milliseconds=6000, and skips rows
already holding both values. Existing custom world speeds are deliberately reset
per the issue. The read-only live Admin preflight on 2026-11-02 found a 5s override:
this migration explicitly moves it to 6s too, while the code default moves 8s → 6s.
Save errors propagate so a partial update cannot be silently marked
applied. Kicked-off rounds, fixtures, match states, event history and RNG snapshots
are untouched. New worlds use the updated balance default.

Down is best-effort: rows still at exactly 6s/6000ms return to 8s/8000ms. Earlier
custom values were not recorded. Later overrides are preserved. The disposable
world-setup suite runs the actual PocketBase up/down/reapply commands, compares all
played rows byte-for-byte, and verifies idempotence including world timestamps.
Unit checks additionally cover more than one page, missing/inconsistent values,
no-op saves, later overrides, and surfaced save errors.

Use the normal independent review, green exact-head CI and merge wrapper. Immediately
before merging, require a non-live public round and more than 45 minutes until
next kickoff; main CI and automatic verified-backup deployment must finish first.
The pending migration applies on the workflow's PocketBase restart. No manual
Admin speed change or deployment is needed.

## Deliberate assertion updates

- Match-speed assertions: 8s/8000ms → 6s/6000ms, 90-minute estimate 720s → 540s.
- Five-minute segment estimate: 40s → 30s. Explicit legacy 8s/15s timing inputs
  stay in place to test snapshot overrides; replay adds 6s alongside 8s/15s/1s.
- Admin fallback is 6s; a returned 8s override remains an override.
- Outcome hashes below are re-pinned because the recommended tuning deliberately
  changes scoring, continuation paths, event/RNG counts and winners. Seeds, timing,
  projection and strict equality assertions are unchanged. The 200-seed pin keeps
  its explicit 8s snapshot to isolate goal tuning from default-speed changes.
- The existing-data upgrade comparison now expects exactly the two migrated world
  speed values and permits a monotonic save timestamp only for rows needing the
  change. All other world fields, business rows and security assertions stay exact.
- The extra-time/shootout projection fixture and gameplay/movement assertions
  passed unchanged. Statistical balance thresholds remain unchanged.

The regeneration probe used the test files' exact helper declarations/projection
and first reproduced all old constants with main's balance.js. It then regenerated
the same manifests with only the recommended balance changes.

| 200-seed manifest | Before SHA-256 | After SHA-256 |
|---|---|---|
| Authoritative tuple/final | `ea5b06fd2b4bc44fcc5e49d375da92d0738b8ded6ae5feaa5afd21ed20a97ab8` | `2d0870bfb62a6539a7119bc42088cddf863c1161e62a108fc2ba6c03e8f9da80` |
| Full real payload/final | `318ca545ec6e9230092ad924fc05dcb2fb2c64ac71aadf36188d3da5b9844992` | `b0c4a0049e34b0efed664c369944db95012815119a6c7c21dce74a126423398c` |
| Every persisted step | `617b66e621fc3d8a20dc7577f98d2df0c6731cc200257d5c6009037fb6bba90f` | `ccee40cdb59cbcf17e9b775bb61f33fbb090841ac40a121c7ee5990e08c4ce9d` |

| Manual balanced seed | Before score / RNG / events | After score / RNG / events | After event SHA-256 |
|---|---|---|---|
| 11 | [2, 1] / 2254 / 409 | [5, 2] / 2265 / 423 | `2e8a828f43125a52d168ef85fafffcb37dbe24f5d688b76c76174fc185649eae` |
| 12 | [2, 0] / 2068 / 367 | [2, 0] / 2068 / 367 | `283e19375049323e703ae1b7b51de620be4ae70832b8b3bf2f19619fe6c95b61` |
| 13 | [0, 2] / 2096 / 367 | [2, 1] / 2668 / 475 | `0c3c21d38d4a29b626c4a4fc5a1e659cd2a81d8f90c3eaa49bcde6a84c437fc4` |
