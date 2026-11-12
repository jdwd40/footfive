# #218: failed attacks reach the final third

This change intentionally changes seeded outcomes and individual matches. The outcome
of an attack is still decided first, with the same draws and probabilities. What
changes is how half of the failed attacks are narrated:

- In `attack()`, a tackle or interception outcome now draws `rnd(st) < deepTurnoverRate`
  (`BALANCE.match.deepTurnoverRate = 0.5`). On a hit, `deepTurnover()` publishes a
  progression shaped like the shot path's: a dribble or through ball (tackle) or a cross
  or through ball (interception), into x 74–82. The defending side then wins the ball
  with the same event type (`tackle` / `interception`), carrying a new
  `stop` field:
  - `tackle`: a last-ditch tackle. Used after a dribble, and after 60% of tackle-outcome
    through balls. The defender slides in just past the progression spot (x ≤ 84).
  - `claim`: the keeper comes off his line. Used after half of the interception-outcome
    crosses and through balls. He catches a cross in the box, or gathers a through ball
    that runs on (x ≤ 92).
  - `clear`: a defender heads or hacks it clear to a team-mate in midfield (x 42–56).
    Used for the rest.

  The text is the matching commentary, for example "C. Amber comes for the cross and
  claims it" or "Z. Cyan gets in front of R. Chrome and heads it away".
- `st.danger` is set with the progression, so markets suspend as they do for a shot. It
  clears on the turnover row (`st.d = 0`), so markets reopen with it. The ball, `bs` and
  `counter` go to the defending side, as for any other tackle or interception.
- The other half of tackles and interceptions are as before: no progression, and they
  happen short of x 74.
- The extra draws (rate, kind, stop, positions, players, text) shift the RNG stream. This
  is why individual matches and seeded pins change. The penalty, shot, cosmetic, timing,
  stance, fitness and settlement code are unchanged, and so are `goalRates` / `pairModel`.
  All randomness still goes through `rnd(st)`, and the save/reload-every-step test still
  reproduces every stream, so the engine stays deterministic and resumable.
- Timing: the stop row follows its progression after 0.11 of a minute (through ball) or
  0.15 (cross, dribble). Those two scenes run longer, and a stop that arrived at 0.11 cut
  them short in the live view, which made the drawn ball jump about 5 units.

Live view (`src/domain/scenes.ts`, `sim.ts`):
- A `claim` scene binds the winner to the keeper. He runs from his line to the ball and
  has it at `won` (WON IT). The beaten attacker arrives late. After a cross, the ball
  comes in at head height.
- A `clear` scene has the defender meet the ball goal-side on contact (WON IT at 0.25).
  The ball is lofted upfield to an unlabelled team-mate (`col`), who collects it at the
  engine's spot.
- A last-ditch `tackle` uses the existing contest scene.
- A cross whose next row is its own claim or clearance is delivered to that row's `from`,
  the point where it is met. It works like the header look-ahead, but with no named
  runner. Every stop scene starts on the ball where the progression left it, and ends
  with the defending side on the ball.

## Calibration

Measured on 2026-11-12. Baseline: the #217 head 6e61cec (PR #221), on which this
branch is stacked. Main is b4b7467, for context.

### Production pace, all 240 pairings, 4,800 matches

```bash
node scripts/engine-calibrate.mjs 4800 --pairs all                 # in-repo, reproduces every engine figure below
node scripts/engine-calibrate.mjs 4800 --pairs all --prefix alt    # seed-robustness rows (also: zz)
node harness/engine-stats.mjs --root <root> --matches 4800 --workers 3   # external harness, same fixtures and numbers
```

`--pairs all` uses the harness's fixtures. Match `i` is seeded `hashSeed(prefix + i)`, the
fixtures walk all 240 ordered pairings with equal weight, and matches run at 6 s minutes.
Its `goalsPerMatch`, `shotsPerMatch`, `longestShotGap`, `longestChanceGap`,
`finalThirdEntries` and `modelVsSim` match the harness's figures exactly (#217: 3.37 /
21.1 / 14.76 / 13.88 / 19.45 / +2.5%; #218: 3.41 / 21.1 / 14.84 / 10.76 / 27.33 / +1.8%).

The harness lives outside the repo, in `ff-wt/harness`. For #218, the run used a copy
with one change to its definitions, which the in-repo `longestChanceGap` shares:

- **Chance gap.** The "longest gap between chances" now counts a real progression into
  the final third (through ball, dribble or cross) as a chance, as well as real shots and
  cosmetic tries. Under the old definition, a failed attack that reached the final third
  could not count, so the metric could not see this change.
- **Effect on the baselines.** Before #218, every progression was followed by its own shot
  or penalty seconds later. The new definition therefore moves the baselines only
  slightly (#217: 13.98 → 13.88, main: 16.50 → 16.41).

Both figures are reported below.

| Metric | main | #217 (before) | #218 (after) | Criterion |
|---|---:|---:|---:|---|
| Final-third entries / match (real progressions) | 15.16 | 19.45 | **27.33** | ≥ 20 |
| ...of which end in a stop (tackle / clear / claim) | 0 | 0 | 7.9 | |
| Moves with the ball in the final third / match | 21.83 | 27.99 | 32.05 | |
| Mean longest gap between chances (min) | 16.41 | 13.88 | **10.76** | ≤ 13.5 |
| ...p90 / max | 23.9 / 62.9 | 19.9 / 45.0 | 15.0 / 29.1 | |
| ...shots and cosmetic tries only (old definition) | 16.50 | 13.98 | 14.01 | |
| Goals / match (incl. ET) | 3.36 | 3.37 | **3.41** (+0.04) | ±0.1 of #217 |
| Goals / 90 | 3.11 | 3.13 | 3.15 | |
| Real shots / match (`stats.sh`) | 16.44 | 21.11 | **21.12** (+0.01) | ±0.5 of #217 |
| Mean longest gap between real shots (min) | 17.86 | 14.76 | 14.84 | |
| `pairModel` goals / 90 | 3.163 | 3.210 | 3.210 (unchanged) | |
| Simulated normal-time goals / 90 | 3.110 | 3.132 | 3.155 | |
| Model vs simulation | +1.7% | +2.5% | **+1.8%** | within ±3% |
| Penalties / match | 0.25 | 0.33 | 0.33 | |
| Cosmetic long-range tries / match | 1.71 | 1.50 | 1.47 | |

Seed robustness: 4,800 matches each, the same 240 pairings, other seed prefixes.

| Prefix | Goals/match #217 → #218 | Shots #217 → #218 | Entries after | Chance gap after | Model vs sim #217 → #218 |
|---|---|---|---:|---:|---|
| `cal` | 3.37 → 3.41 | 21.11 → 21.12 | 27.33 | 10.76 | +2.5% → +1.8% |
| `alt` | 3.42 → 3.40 | 21.10 → 21.24 | 27.42 | 10.69 | +1.7% → +1.9% |
| `zz` | 3.40 → 3.37 | 21.29 → 21.18 | 27.41 | 10.68 | +2.4% → **+3.2%** |
| pooled (14,400) | | | | | +2.2% → +2.3% |

The outcome rates per attack are unchanged, so the goal shifts (−0.03 to +0.04) are
stream noise. On the `zz` seeds, model vs simulation is +3.2%, just outside ±3%. That
comes from those 4,800 matches scoring 0.02 goals/90 less, not from the model. Over all
14,400 matches it is +2.3%, against +2.2% before. `goalRates` needed no recalibration.

### Live view: `harness/view-stats.mjs --matches 200`, 60 fps, 100 ms samples

| Metric | #217 (before) | #218 (after) |
|---|---:|---:|
| Transition jump, drawn, open → open: p50 / p99 / max | 0.34 / **5.85** / 13.05 | 0.33 / **5.80** / 14.86 |
| ...all transitions, p99 / max | 5.94 / 30.46 | 5.97 / 18.09 |
| ...backward component, p99 | 5.13 | 4.97 |
| Target discontinuity at the change tick, p99 | 6.47 | 6.45 |
| Bunching (≥ 6 players within 16 of the ball) | **9.3%** | **9.5%** |
| Forward / back / side / static / turnover | 44.3 / 11.0 / 18.6 / 16.1 / 10.1% | 45.2 / 10.9 / 17.8 / 15.8 / 10.4% |
| Ball in own half / final third | 75.0% / 4.1% | 73.1% / 5.0% |

At the progression → stop change, the unsmoothed target moves at most 1.4 units (p99
over 48 matches, every stop kind). Before the stop waited for the cross and dribble
scenes, this was up to 7.8 units. Bunching rises by 0.2 points, because the ball spends
more time in the final third.

### `node scripts/engine-calibrate.mjs 3000`

The script now also reports `goalsPerMatch`, `finalThirdEntries`, `finalThirdStops`
and `longestChanceGap` (real shots, progressions and cosmetic tries). Without
`--pairs all`, it keeps its own 16 pairings and a 15 s snapshot. The "Before" column ran
the updated script against #217's engine.

| Metric | Before (#217) | After |
|---|---:|---:|
| Goals/90 | 3.03 | 3.08 |
| Extra time | 20.4% | 21.7% |
| Shootouts | 6.3% | 7.5% |
| Favourite wins | 83% | 83% |
| Shots/match | 21.0 | 21.2 |
| Longest shot gap, mean / p90 (min) | 14.80 / 21.1 | 14.90 / 21.2 |
| Longest chance gap (min) | 13.60 | 10.59 |
| Final-third entries / stops per match | 19.37 / 0 | 27.48 / 7.96 |
| Model vs sim | +4.0% | +2.3% |

## Deliberate assertion updates

Outcome pins are re-pinned because the extra draws deliberately shift the RNG stream.
Seeds, timing, projections and strict equality assertions are unchanged.

| Pin | Before (#217) | After |
|---|---|---|
| 200-seed tuple/final (`engine.test.ts`, `cosmeticShots.test.ts` `pin`) | `32359e3717fd564731f85cbcc81eb8911f93280cc21c1eddc903a4eeb6b336df` | `8bd5c4273a106ad61fb0bf92373e10431ca78cc7f13bcf362dbd53e9a9840b81` |
| Full real payload/final (`cosmeticShots.test.ts` `full`) | `969d52256f8d9f8dfb3d4ec2e71e6b8ea654425f33e350095a9d434d5e3a2fe1` | `1cfad7d3427d2586a43d768014ec3de2329aeadd364710a3e122495c13afe964` |
| Every persisted step (`cosmeticShots.test.ts` `steps`) | `c0dceaf40a4b8ad414b96b90ef66b3e1a82b3ce324bd6db94822fe6c5dce30c1` | `0cf460db3b719c2be80d6178e9b9c837e659b0fc47143adeb52267f3aedd31ea` |
| 200-seed outcome summary (`commentary.test.ts`) | `0e9d017182972a3d21829ee2bee2406dc545385504547adb32fae91b9a602677` | `b6e1cb087bf209214928285e4ebfa135bc2a00a01725bce40a14d4f828a293f5` |

| Manual balanced seed (`tacticalBalance.test.ts`) | Before score / RNG / events | After score / RNG / events | After event SHA-256 |
|---|---|---|---|
| 11 | [4, 1] / 2329 / 425 | [2, 1] / 2262 / 400 | `c646ed45d35a15328aae43a4b7f3b1007150f8e64e851f307cda32b208adc68c` |
| 12 | [1, 0] / 2186 / 389 | [1, 0] / 2240 / 391 | `8a381dee5e969e9fc95f8e7bfe84fc3b5e7e6f23b7c50d4a9380e3215a749455` |
| 13 | [0, 3] / 2325 / 417 | [1, 2] / 2488 / 453 | `3254f936fda617155618c0bde31ac6e5af3125529f101aa15940777a386167b0` |

Other test changes:
- `cosmeticShots.test.ts`, "spectacle stays moderate": these matches run at the legacy 8 s
  snapshot, and the title now says so. The 8 s mean is 2.00 (#217: 1.84); the bounds are
  unchanged. At the live 6 s pace the mean is about 1.6, and `COS.rate`'s comment now says
  so. The pinned-baseline and transport tests get the same 20 s timeout as the
  save/reload test. All three are heavy and can time out at 5 s under full-suite load.
- `scenes.test.ts`:
  - The contest test skips claims and clearances, which have their own scene. A
    last-ditch tackle is still checked as a contest.
  - The shootout-badge test needs a wide shootout miss. The stream shift moved the first
    one in this seed set to match 138, so that test adds matches 120–139. The shared
    120-match set is unchanged, which keeps the other tests inside their timeouts.
- `crossDelivery.test.ts`: the real-engine cross set keeps only crosses followed by
  their header. Crosses followed by a claim or clearance are covered in the new file.
- New `finalThirdStops.test.ts` checks:
  - the share of stops and every kind of stop;
  - the progression range, and that the turnover is met where the progression left it;
  - that markets suspend with the progression and reopen with the turnover, using
    `markets.fixtureState`, and that no suspension is left hanging in any match;
  - that the next touch starts from the turnover spot, with the defending side;
  - the claim, clear and tackle scenes, and cross delivery to the meeting point;
  - frame-by-frame live-view continuity, with the defending side carrying the ball at
    the end.

## Deployment

Deploy between rounds, as for #195 and #217. A live match reads `deepTurnoverRate` as it
plays. `goalRates` / `model_json` is unchanged. Old clients ignore `stop` and draw a stop
as an ordinary tackle or interception.
