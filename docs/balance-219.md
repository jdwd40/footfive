# #219: game-state urgency, real counter-attacks and rebounds

This change intentionally changes outcomes, scorelines and odds. Matches now react to the score late on, counters are real
breaks, saves and blocks can lead to a second shot, and the in-play odds follow all of it.

## Engine (`pocketbase/pb_hooks/lib/matchEngine.js`, `balance.js`)

| Constant (`BALANCE.match`) | Value | What it does |
|---|---:|---|
| `urgencyMinute` | 70 | From this minute (extra time included), a side that is behind at the start of a minute plays with urgency. It equals the AI chase minute, so a trailing AI side also switches to Attack, as before. |
| `urgencySeq` | 1.25 | × `pSeq` (attacks per possession minute) for that side, whatever its stance. |
| `urgencyPoss` | 0.04 | Extra possession share for that side. |
| `counterRate` | 0.07 | Chance that a side which won the ball last minute (`st.counter`) and keeps it breaks at once. |
| `counterRisk` | 1.6 | × `counterRate` when the side that lost the ball is trailing late (committed forward). |
| `counterShot` | 1.2 | × `pShot` on a counter-attack. |
| `reboundSave` / `reboundBlock` | 0.15 / 0.15 | Share of saves parried loose / blocks that drop to an attacker. |
| `reboundOn` | 0.85 | × `pOn` for the second shot. |
| `reboundSaveDrop` | 0.10 | The scrambling keeper's save chance is lower on the second shot by this much. |
| `saveBase` | 0.54 → **0.59** | Brings total goals back to the #218 level (see Calibration). |

- **Urgency.** `chanceModel(st, side, urg)` multiplies `pSeq` and `homePossession` adds `urgencyPoss` for the trailing side.
  The issue's prototype used ×1.35 on `pSeq` alone; ×1.25 plus a little possession gives the same late shot rate with fewer
  extra goals for the leader (whose counters are already priced by `counterRisk`).
- **Counter-attacks.** On main, `playMinute` cleared `st.counter` before `attack()` read it, so the "break quickly"
  build-up never happened; a counter only shifted possession. Now `playMinute` reads the flag first. When the side that won
  the ball keeps it, it breaks with probability `counterRate` (× `counterRisk`), in place of the usual `pSeq` draw:
  - the build-up starts where the ball was won, a touch on (a keeper throws it out to x 22–32), and carries `ctr: 1`;
  - one or two long forward passes (+12–19 along each, to x 70 at most), never a return pass;
  - then always a progression into the final third. There is no shot from range, and a failed counter dies there as a #218
    deep turnover does;
  - the shot chance is `pShot × counterShot`.
  `st.counter` is now also cleared at a period restart (kick-off of the second half or extra time): nobody breaks from a
  kick-off. Before, the flag carried across half-time into the next period's possession draw.
- **Rebounds.** In `shotResult()` (the old tail of `attack()`, unchanged for other results), a save draws `reboundSave` and
  a block `reboundBlock`. On a hit, the result row carries `loose: 1`, its `ball` is where the ball drops (a parry: x 87–91
  in front of goal; a block: just back from the shot), and `st.danger` stays set. `rebound()` then plays the second shot in
  the same chain: `reb: 1`, from that spot, by any attacker. Its outcome is drawn first: a block (`blockRate`), on target
  (`pOn × reboundOn`, then saved at `saveChance − reboundSaveDrop`) or scored, else wide or the woodwork. A rebound never
  produces a third shot. Both shots count in `stats.sh`, and the parry counts as a save.
- **Timing.** The gap between a loose save or block and the second shot is inserted into the minute (`ctx.pause`): 0.18 of a
  minute after a save and 0.13 after a block, which is at least the scene's length at 6 s and at 15 s minutes. A loose result
  has no `resultHoldMs`; the second shot's own result holds as usual. If a move still runs past the minute's end, the next
  minute waits until 0.1 of a minute after its last row. Before, a minute that overran published its next rows on top of
  the bounce. Minutes that end in time are unchanged.
- **Markets.** A loose save or block keeps `d: 1`, so markets stay suspended from the first shot, through the parry and the
  second shot, until its result reopens them (or a goal holds them through the restart, as any goal does).
- **Determinism and resumability.** All new randomness goes through `rnd(st)`. No persisted field is added, so the state shape
  is unchanged (`tacticalBalance.test.ts` checks it). The save/reload-every-step test reproduces every stream. A state saved
  mid-match by the #218 engine resumes on this one. Its `st.counter` means the same thing, and from then on the match plays by
  the new rules.

### `goalRates` / the odds model

`goalRates(st, sit)` now models the whole minute loop, not a single attack:
- the counter flag a minute starts with (none / mine / theirs) is a Markov chain. It is solved for its stationary mix
  (`sideRate`), so the possession swing, counter-attacks and their `counterRisk` are all priced;
- each attack's goal chance includes the rebound off a parried save or a loose block, the long-shot save bonus, penalties
  and counters (`attackModel`);
- the save chance uses the side's expected shooter (`shooterAttack`, weighted as `attacker()` picks him) instead of a fixed
  attack of 72. That fixed value made strong and weak sides look closer than they play: after it was fixed, model and
  simulation agree to within 1% in normal play;
- `sit` = `{ stance: { home, away }, urg: { home, away } }` plays a game state. Without `sit`, the result is as before: the
  current stances and no urgency.

`matchEngine.inPlayModel(st)` builds the kickoff `model_json` that `worldService.pairModel` now stores:
`{ lh, la, at: { chase: 70, protect: 78, settle: 100 }, s: { hT, hT1, aT, aT1, L } }`. Here `lh`/`la` are the kickoff
rates, as before, and the `round_first` market still reads only these. `s` holds the per-minute `[home, away]` rates in
each late game state the AI stance policy and urgency produce:
- `hT`: home is trailing late;
- `hT1`: home is trailing by one from 78′, and away sits deep (Defend);
- `aT`, `aT1`: the same for away;
- `L`: level from 100′, when both attack.

A side its manager runs keeps its kickoff stance in every state (the manager's later choices are not known). Urgency still
applies to it.

`odds.js`: with a staged model (`s` and `at` present), `finalDist` and `nextGoal` walk the remaining minutes. Each minute's
rates come from the score at its start and the minute (`stageRates`). Red cards are applied as before. The engine plays at
most one attack a minute, so a minute has at most one goal: home with probability `rate.h`, away with `rate.a`. Level
after 90′ continues into extra time; level after 120′ is a coin flip, as before. `finalDist(..., noDist)`, used by the
fixture cards and the bracket, walks the score difference only (about 1 ms per call in node). A legacy `{ lh, la }` model,
which a match in flight at the deploy still has, is priced exactly as before. Market rules, settlement, margin and
withdrawal (`MIN_OFFER`) are unchanged.

## Calibration

Measured on 2026-11-12. The baseline is the #218 head fb8fec3, on which this branch is stacked. The 4,800-match engine
figures are identical to 098c5a4; fb8fec3 moved positions only. Main is b4b7467, for context. All engine figures:
production pace (6 s minutes), all 240 pairings, 4,800 matches.

```bash
node scripts/engine-calibrate.mjs 4800 --pairs all [--prefix alt|zz]      # engine figures below (now incl. counters, rebounds, trailing rate)
node harness/engine-stats.mjs --root <root> --matches 4800 --workers 3     # external harness: same fixtures, same numbers
node scripts/inplay-calibrate.mjs 4800 --prefix cal,alt,zz                 # in-play odds calibration (about 2 min per 4,800)
node scripts/inplay-calibrate.mjs 4800 --root <#218 tree>                  # the same against the #218 engine and odds
node scripts/inplay-calibrate.mjs 4800 --legacy                            # this engine priced with the old constant-rate model
node harness/view-stats.mjs --root <root> --matches 200                    # live view
```

`engine-calibrate.mjs` marks counters and rebounds explicitly: `counterAttacks` counts build-ups with `ctr`, and
`reboundShots` counts shots with `reb`. The harness counts the same chains: `ctr` is its explicit counter flag, and a
rebound is a chain's second shot. Its `trailingShotsPerPossessionMin` uses the harness's definition: the side behind at the
start of a minute, its real shots per minute in which it had the ball (the side of the minute's first build-up or pass),
in normal time. "Incl. cosmetic" adds its cosmetic long-range tries. That is the definition that reproduces the issue's
0.17 → 0.20.

| Metric | main | #218 (before) | #219 (after) | Criterion |
|---|---:|---:|---:|---|
| Trailing side's shots / possession minute from 70′, incl. cosmetic | 0.189 | 0.237 | **0.319** | ≥ 0.26 |
| ...real shots only | 0.172 | 0.221 | **0.306** (+38%) | ≥ +30% on #218 (≥ 0.287) |
| ...before 70′ (real / incl. cosmetic) | 0.148 / 0.166 | 0.190 / 0.207 | 0.212 / 0.228 | |
| ...ratio from 70′ / before 70′ (real) | ×1.16 | ×1.16 | ×1.44 | |
| Counter-attacks / match | 0 | 0 | **1.88** | 1–3 |
| Rebound shots / match | 0 | 0 | **1.47** | 1–2 |
| Goals / match (incl. ET) | 3.36 | 3.41 | **3.40** (−0.01) | ±0.15 of #218 |
| Goals / 90 | 3.11 | 3.15 | 3.12 | |
| Real shots / match (`stats.sh`) | 16.44 | 21.12 | 24.12 | |
| Penalties / match | 0.25 | 0.33 | 0.35 | |
| Extra-time share | 20.8% | 20.0% | 22.5% | |
| Mean longest gap between real shots (min) | 17.86 | 14.84 | 14.16 | |
| Mean longest gap between chances (min) | 16.41 | 10.76 | 10.20 | |
| Final-third entries / match | 15.16 | 27.33 | 29.59 | |
| Kickoff `lh + la` × 90 vs simulated goals/90 | +1.7% | +1.8% | −5.0% | see below |
| In-play model's expected goals/90 from kick-off vs simulated | | | **+1.1%** | |

The kickoff `lh + la` rates are now the level, no-urgency state. The match scores more than that late on, when someone is
chasing. So "kickoff rates vs simulation" is no longer the right check. The model's own expectation, walked through the
game states from kick-off (`stagedGoals90` in engine-calibrate), is: +1.1% (`cal`), −1.5% (`alt`), +0.4% (`zz`).

Seed robustness (4,800 matches each, the same 240 pairings):

| Prefix | Goals #218 → #219 | Trailing from 70′, real (incl. cosmetic) #218 → #219 | Counters | Rebounds | Staged model vs sim |
|---|---|---|---:|---:|---:|
| `cal` | 3.41 → 3.40 | 0.221 (0.237) → 0.306 (0.319) | 1.88 | 1.47 | +1.1% |
| `alt` | 3.40 → 3.51 | 0.223 (0.239) → 0.306 (0.318) | 1.87 | 1.51 | −1.5% |
| `zz` | 3.37 → 3.42 | 0.221 (0.237) → 0.308 (0.321) | 1.93 | 1.49 | +0.4% |
| pooled (14,400) | 3.39 → 3.44 (+0.05) | | | | |

Every criterion holds on all three seed sets. On `alt`, goals rise by 0.11, still inside ±0.15. Without the `saveBase`
change, goals would rise by about 0.55 a match: urgency adds late goals at both ends, and so do counters and rebounds.
Raising `saveBase` keeps the totals level. Shots rise to about 24 a match, because rebounds and the extra late attacks are
real shots.

### `node scripts/engine-calibrate.mjs 3000` (16 pairings, 15 s snapshot)

Goals/90 3.11 (#218: 3.08), extra time 24.1% (21.7%), shootouts 8.5% (7.5%), favourite wins 83% (83%), shots 24.2 (21.2),
counters 1.93, rebounds 1.47, trailing from 70′ 0.311 (incl. cosmetic 0.328), staged model vs sim −0.6%.

### In-play odds calibration

`scripts/inplay-calibrate.mjs` plays each match, then snapshots the price the app would show when the public clock reaches
60′, 75′ and 85′:
- the published state is the last event at that moment, at the minute `odds.clockMinute` gives;
- if markets are suspended then, it takes the first later event that reopens them (66 of 14,400 snapshots on `cal`).

It prices that state with `markets.fixtureMarkets` and the `model_json` that `pairModel` builds, and checks every offered
price against the model probability (`okP`): 335,561 checks, none failed. It then compares, per bucket (minute × score state
seen from the leader's side), the mean model probability of each selection with how often it won. Markets: to qualify, next
goal, winning margin (exactly 1/2/3) and exact score, grouped by goals still to come. "Fav view" rows split the same
markets by whether the pre-match favourite leads, is level or trails. Cells with fewer than 200 snapshots are not judged.

| Run (4,800 matches each unless pooled) | Cells judged | Outside ±3 pp | Worst cell |
|---|---:|---:|---|
| main b4b7467 (engine + odds), `cal` | 189 | 42 | 85′ level, exact +0-0: +12.5 pp |
| #218 fb8fec3 (engine + odds), `cal` | 189 | 41 | 85′ level, exact +0-0: +13.2 pp |
| #218, pooled `cal,alt,zz` (14,400) | 189 | 37 | 85′ level, exact +0-0: +12.9 pp |
| #219 engine, old constant-rate model (`--legacy`), `cal` | 189 | 69 | 85′ level, exact +0-0: +15.0 pp |
| **#219, `cal`** | 189 | **1** | 75′ favourite trails, next goal: underdog −3.3 pp (SE 1.3, n 815) |
| **#219, `alt`** | 189 | **5** | 60′ favourite level, winner: favourite +3.8 pp (SE 1.3, n 1,290) |
| **#219, `zz`** | 189 | **0** | 75′ favourite trails, winner: favourite +2.6 pp (SE 1.2) |
| **#219, pooled `cal,alt,zz` (14,400)** | 189 | **0** | 60′ favourite level, winner: favourite +1.8 pp (SE 0.8); no cell beyond ±2 pp |

The 4,800-match runs give 0, 1 and 5 cells just outside ±3 pp, each within 2.8 standard errors. In a small cell (n about
800–1,300), a binomial standard error of 1.2–1.4 pp makes a 3 pp miss a 2–2.5 SE event, so a few such cells are expected
among 189 from sampling alone. They do not repeat across seed sets. Pooled over 14,400 matches, every cell is within 2 pp.
The old model's errors are systematic and repeat on every seed set: "no further goal" was overpriced by 5–13 pp, level or
two goals ahead, from 60′ on. The cause is the constant late rate, which ignored the chase, and the minute of extra time.

**"Next goal: the favourite" after 70′** (Fable on #217). The bettor's mean return per unit staked at the offered price,
taken at every minute from 70′ to 89′ (about 96,000 bets per 4,800 matches):

| | main | #218 | #219 engine, old model | **#219** |
|---|---:|---:|---:|---:|
| ROI, `cal` | +6.7% | +6.9% | +10.4% | **−7.6%** |
| ROI, pooled `cal,alt,zz` | | +8.8% | | **−6.9%** |
| ...at 60′ / 75′ / 85′ (pooled) | | +1.6 / +6.9 / +11.6% | | −6.9 / −6.8 / −6.4% |

With a 6% margin, a calibrated price returns about −6%. The bettor's edge is gone.

<details>
<summary>Full table: pooled 14,400 matches (`cal,alt,zz`), #218 versus #219</summary>

The #218 columns use #218's engine and odds on the same fixtures. Their n is close but not equal, so n is #219's. "**"
marks a cell beyond ±3 pp with n ≥ 200. "Bettor ROI" is the return at #219's offered prices; it is empty for the exact-score
groups, which are not single selections.

| Minute, score | Market | Selection | n | #218: model / observed % | diff pp | #219: model / observed % | diff pp | SE pp | #219 bettor ROI |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 60' lead1 | winner | leader | 5682 | 86.3 / 85.5 | +0.8 | 83.9 / 83.7 | +0.1 | 0.5 | -5.2% |
| 60' lead1 | winner | trailer | 5682 | 13.7 / 14.5 | -0.8 | 16.1 / 16.3 | -0.1 | 0.5 | 0.2% |
| 60' lead2+ | winner | leader | 4802 | 98.6 / 98.5 | +0.2 | 98.0 / 98.3 | -0.3 | 0.2 | -4.6% |
| 60' lead2+ | winner | trailer | 4802 | 1.4 / 1.5 | -0.2 | 2.0 / 1.7 | +0.3 | 0.2 | -35.9% |
| 60' level | winner | away | 3916 | 49.9 / 51.4 | -1.5 | 50.8 / 51.9 | -1.1 | 0.8 | -0.9% |
| 60' level | winner | home | 3916 | 50.1 / 48.6 | +1.5 | 49.2 / 48.1 | +1.1 | 0.8 | -5.8% |
| 75' lead1 | winner | leader | 5027 | 91.5 / 91.2 | +0.3 | 89.5 / 89.6 | -0.2 | 0.4 | -3.9% |
| 75' lead1 | winner | trailer | 5027 | 8.5 / 8.8 | -0.3 | 10.5 / 10.4 | +0.2 | 0.4 | -3.8% |
| 75' lead2+ | winner | leader | 5769 | 99.6 / 99.5 | +0.1 | 99.3 / 99.5 | -0.2 | 0.1 | -5.3% |
| 75' lead2+ | winner | trailer | 5769 | 0.4 / 0.5 | -0.1 | 0.7 / 0.5 | +0.2 | 0.1 | -42.0% |
| 75' level | winner | away | 3604 | 49.7 / 50.7 | -1.1 | 50.1 / 50.7 | -0.6 | 0.8 | -2.8% |
| 75' level | winner | home | 3604 | 50.3 / 49.3 | +1.1 | 49.9 / 49.3 | +0.6 | 0.8 | -6.1% |
| 85' lead1 | winner | leader | 4851 | 96.7 / 96.9 | -0.2 | 96.0 / 95.8 | +0.1 | 0.3 | -4.0% |
| 85' lead1 | winner | trailer | 4851 | 3.3 / 3.1 | +0.2 | 4.0 / 4.2 | -0.1 | 0.3 | -3.1% |
| 85' lead2+ | winner | leader | 6163 | 100.0 / 99.9 | +0.1 | 99.9 / 100.0 | -0.1 | 0.0 |  |
| 85' lead2+ | winner | trailer | 6163 | 0.0 / 0.1 | -0.1 | 0.1 / 0.0 | +0.1 | 0.0 | -100.0% |
| 85' level | winner | away | 3386 | 49.7 / 50.3 | -0.6 | 49.8 / 50.1 | -0.3 | 0.9 | -3.9% |
| 85' level | winner | home | 3386 | 50.3 / 49.7 | +0.6 | 50.2 / 49.9 | +0.3 | 0.9 | -6.3% |
| 60' lead1 | next_goal | leader | 5682 | 37.5 / 39.2 | -1.7 | 37.2 / 37.1 | +0.1 | 0.6 | -5.0% |
| 60' lead1 | next_goal | none | 5682 | 35.5 / 33.5 | +2.0 | 31.6 / 30.5 | +1.1 | 0.6 | -9.2% |
| 60' lead1 | next_goal | trailer | 5682 | 27.0 / 27.3 | -0.3 | 31.2 / 32.4 | -1.2 | 0.6 | 0.1% |
| 60' lead2+ | next_goal | leader | 4802 | 45.5 / 51.0 | -5.5 ** | 48.7 / 48.0 | +0.7 | 0.7 | -6.2% |
| 60' lead2+ | next_goal | none | 4802 | 33.3 / 26.2 | +7.1 ** | 25.7 / 25.7 | +0.0 | 0.6 | -5.8% |
| 60' lead2+ | next_goal | trailer | 4802 | 21.3 / 22.9 | -1.6 | 25.7 / 26.3 | -0.7 | 0.6 | -1.6% |
| 60' level | next_goal | away | 3916 | 43.4 / 47.4 | -4.0 ** | 46.4 / 46.8 | -0.4 | 0.8 | -3.5% |
| 60' level | next_goal | home | 3916 | 43.6 / 44.7 | -1.2 | 45.0 / 45.2 | -0.2 | 0.8 | -3.7% |
| 60' level | next_goal | none | 3916 | 13.1 / 7.9 | +5.2 ** | 8.5 / 8.0 | +0.5 | 0.4 | -11.4% |
| 75' lead1 | next_goal | leader | 5027 | 23.4 / 24.1 | -0.6 | 22.3 / 22.8 | -0.5 | 0.6 | -1.9% |
| 75' lead1 | next_goal | none | 5027 | 59.6 / 58.9 | +0.6 | 56.8 / 55.3 | +1.4 | 0.7 | -8.4% |
| 75' lead1 | next_goal | trailer | 5027 | 17.0 / 17.0 | -0.0 | 21.0 / 21.9 | -0.9 | 0.6 | 0.1% |
| 75' lead2+ | next_goal | leader | 5769 | 29.0 / 35.8 | -6.8 ** | 33.6 / 33.2 | +0.4 | 0.6 | -5.8% |
| 75' lead2+ | next_goal | none | 5769 | 57.7 / 48.4 | +9.3 ** | 47.3 / 47.1 | +0.2 | 0.7 | -6.2% |
| 75' lead2+ | next_goal | trailer | 5769 | 13.4 / 15.9 | -2.5 | 19.1 / 19.7 | -0.6 | 0.5 | -0.3% |
| 75' level | next_goal | away | 3604 | 38.7 / 44.9 | -6.2 ** | 43.2 / 43.7 | -0.5 | 0.8 | -2.3% |
| 75' level | next_goal | home | 3604 | 39.4 / 42.1 | -2.7 | 43.0 / 43.1 | -0.1 | 0.8 | -3.8% |
| 75' level | next_goal | none | 3604 | 21.9 / 13.0 | +8.9 ** | 13.9 / 13.2 | +0.7 | 0.6 | -9.1% |
| 85' lead1 | next_goal | leader | 4851 | 9.2 / 9.5 | -0.3 | 8.4 / 8.4 | -0.0 | 0.4 | -3.4% |
| 85' lead1 | next_goal | none | 4851 | 84.1 / 84.5 | -0.4 | 83.5 / 83.1 | +0.4 | 0.5 | -6.5% |
| 85' lead1 | next_goal | trailer | 4851 | 6.6 / 6.0 | +0.6 | 8.1 / 8.5 | -0.4 | 0.4 | -1.8% |
| 85' lead2+ | next_goal | leader | 6163 | 11.6 / 15.2 | -3.7 ** | 14.3 / 14.4 | -0.1 | 0.4 | -0.7% |
| 85' lead2+ | next_goal | none | 6163 | 83.2 / 78.0 | +5.2 ** | 77.8 / 77.3 | +0.5 | 0.5 | -6.7% |
| 85' lead2+ | next_goal | trailer | 6163 | 5.2 / 6.8 | -1.5 | 7.9 / 8.4 | -0.5 | 0.4 | 2.0% |
| 85' level | next_goal | away | 3386 | 34.4 / 41.3 | -6.9 ** | 40.2 / 40.7 | -0.5 | 0.8 | -2.5% |
| 85' level | next_goal | home | 3386 | 35.0 / 40.9 | -5.9 ** | 40.6 / 41.0 | -0.4 | 0.8 | -4.1% |
| 85' level | next_goal | none | 3386 | 30.7 / 17.8 | +12.9 ** | 19.1 / 18.3 | +0.8 | 0.7 | -9.5% |
| 60' lead1 | margin | leader by 1 | 5682 | 47.6 / 47.7 | -0.2 | 47.6 / 47.8 | -0.1 | 0.7 | -5.6% |
| 60' lead1 | margin | leader by 2 | 5682 | 24.5 / 23.1 | +1.4 | 21.4 / 21.4 | +0.0 | 0.5 | -5.9% |
| 60' lead1 | margin | leader by 3 | 5682 | 7.9 / 8.7 | -0.8 | 8.3 / 8.5 | -0.2 | 0.4 | -9.5% |
| 60' lead1 | margin | trailer by 1 | 5682 | 7.7 / 9.1 | -1.4 | 10.2 / 10.0 | +0.2 | 0.4 | 3.7% |
| 60' lead1 | margin | trailer by 2 | 5682 | 1.7 / 2.0 | -0.2 | 2.0 / 1.9 | +0.1 | 0.2 | -4.7% |
| 60' lead1 | margin | trailer by 3 | 5682 | 0.3 / 0.7 | -0.4 | 0.4 / 0.5 | -0.1 | 0.1 | 37.4% |
| 60' lead2+ | margin | leader by 1 | 4802 | 9.8 / 11.4 | -1.6 | 13.1 / 13.5 | -0.4 | 0.5 | -4.6% |
| 60' lead2+ | margin | leader by 2 | 4802 | 29.4 / 26.4 | +3.0 | 26.2 / 27.1 | -1.0 | 0.6 | 8.3% |
| 60' lead2+ | margin | leader by 3 | 4802 | 27.6 / 25.6 | +2.0 | 25.7 / 25.6 | +0.2 | 0.6 | -8.2% |
| 60' lead2+ | margin | trailer by 1 | 4802 | 0.7 / 0.8 | -0.1 | 1.2 / 1.1 | +0.2 | 0.1 | -43.2% |
| 60' lead2+ | margin | trailer by 2 | 4802 | 0.2 / 0.2 | -0.0 | 0.2 / 0.3 | -0.1 | 0.1 | 31.6% |
| 60' lead2+ | margin | trailer by 3 | 4802 | 0.0 / 0.1 | -0.1 | 0.1 / 0.1 | +0.0 | 0.0 | -57.3% |
| 60' level | margin | away by 1 | 3916 | 29.4 / 32.9 | -3.6 ** | 32.6 / 33.6 | -0.9 | 0.8 | -0.4% |
| 60' level | margin | away by 2 | 3916 | 8.3 / 8.6 | -0.3 | 7.8 / 7.5 | +0.4 | 0.4 | 0.8% |
| 60' level | margin | away by 3 | 3916 | 1.8 / 2.3 | -0.4 | 2.0 / 2.1 | -0.1 | 0.2 | 20.5% |
| 60' level | margin | home by 1 | 3916 | 29.5 / 31.0 | -1.5 | 31.6 / 31.3 | +0.4 | 0.7 | -4.6% |
| 60' level | margin | home by 2 | 3916 | 8.4 / 8.0 | +0.4 | 7.4 / 8.4 | -1.0 | 0.4 | 16.0% |
| 60' level | margin | home by 3 | 3916 | 1.9 / 2.3 | -0.4 | 1.9 / 1.3 | +0.6 | 0.2 | -15.2% |
| 75' lead1 | margin | leader by 1 | 5027 | 65.8 / 66.2 | -0.5 | 65.6 / 65.3 | +0.3 | 0.7 | -6.4% |
| 75' lead1 | margin | leader by 2 | 5027 | 19.1 / 18.3 | +0.8 | 17.0 / 17.0 | +0.0 | 0.5 | -4.5% |
| 75' lead1 | margin | leader by 3 | 5027 | 3.3 / 4.2 | -0.9 | 3.5 / 3.9 | -0.4 | 0.3 | 5.5% |
| 75' lead1 | margin | trailer by 1 | 5027 | 4.4 / 5.3 | -1.0 | 6.4 / 6.2 | +0.2 | 0.3 | -3.0% |
| 75' lead1 | margin | trailer by 2 | 5027 | 0.9 / 1.1 | -0.2 | 1.1 / 1.2 | -0.1 | 0.2 | 1.3% |
| 75' lead1 | margin | trailer by 3 | 5027 | 0.2 / 0.3 | -0.1 | 0.2 / 0.3 | -0.1 | 0.1 | 16.3% |
| 75' lead2+ | margin | leader by 1 | 5769 | 6.6 / 8.3 | -1.7 | 9.9 / 9.9 | -0.0 | 0.4 | 9.7% |
| 75' lead2+ | margin | leader by 2 | 5769 | 36.2 / 32.4 | +3.8 ** | 32.5 / 33.3 | -0.8 | 0.6 | 8.4% |
| 75' lead2+ | margin | leader by 3 | 5769 | 28.6 / 27.6 | +1.0 | 27.4 / 27.5 | -0.0 | 0.6 | -5.2% |
| 75' lead2+ | margin | trailer by 1 | 5769 | 0.2 / 0.3 | -0.1 | 0.4 / 0.3 | +0.1 | 0.1 | -51.0% |
| 75' lead2+ | margin | trailer by 2 | 5769 | 0.0 / 0.1 | -0.1 | 0.1 / 0.1 | -0.0 | 0.0 | -8.0% |
| 75' lead2+ | margin | trailer by 3 | 5769 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | -0.0 | 0.0 | -100.0% |
| 75' level | margin | away by 1 | 3604 | 28.4 / 33.1 | -4.7 ** | 32.4 / 32.6 | -0.2 | 0.8 | -2.7% |
| 75' level | margin | away by 2 | 3604 | 5.8 / 6.4 | -0.6 | 5.6 / 5.6 | +0.1 | 0.4 | 9.6% |
| 75' level | margin | away by 3 | 3604 | 1.0 / 1.0 | -0.0 | 1.1 / 1.1 | +0.0 | 0.2 | -23.0% |
| 75' level | margin | home by 1 | 3604 | 28.8 / 31.7 | -2.9 | 32.3 / 32.2 | +0.1 | 0.8 | -4.3% |
| 75' level | margin | home by 2 | 3604 | 6.0 / 6.5 | -0.6 | 5.6 / 6.2 | -0.6 | 0.4 | 14.4% |
| 75' level | margin | home by 3 | 3604 | 1.1 / 1.2 | -0.1 | 1.1 / 1.1 | +0.0 | 0.2 | 18.4% |
| 85' lead1 | margin | leader by 1 | 4851 | 86.0 / 86.4 | -0.5 | 86.1 / 85.8 | +0.2 | 0.5 | -6.3% |
| 85' lead1 | margin | leader by 2 | 4851 | 8.8 / 8.9 | -0.1 | 8.1 / 7.8 | +0.3 | 0.4 | -6.0% |
| 85' lead1 | margin | leader by 3 | 4851 | 0.6 / 0.8 | -0.2 | 0.5 / 0.9 | -0.4 | 0.1 | 93.7% |
| 85' lead1 | margin | trailer by 1 | 4851 | 1.5 / 1.8 | -0.3 | 2.2 / 2.3 | -0.1 | 0.2 | -2.0% |
| 85' lead1 | margin | trailer by 2 | 4851 | 0.3 / 0.5 | -0.2 | 0.4 / 0.4 | +0.0 | 0.1 | 14.0% |
| 85' lead1 | margin | trailer by 3 | 4851 | 0.1 / 0.1 | +0.0 | 0.1 / 0.1 | -0.0 | 0.1 | 6.6% |
| 85' lead2+ | margin | leader by 1 | 6163 | 2.5 / 3.3 | -0.8 | 4.1 / 3.9 | +0.2 | 0.2 | -9.4% |
| 85' lead2+ | margin | leader by 2 | 6163 | 40.5 / 39.1 | +1.5 | 39.9 / 40.5 | -0.6 | 0.6 | 3.6% |
| 85' lead2+ | margin | leader by 3 | 6163 | 28.9 / 28.2 | +0.7 | 28.6 / 28.4 | +0.2 | 0.6 | -3.2% |
| 85' lead2+ | margin | trailer by 1 | 6163 | 0.0 / 0.0 | -0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' lead2+ | margin | trailer by 2 | 6163 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' lead2+ | margin | trailer by 3 | 6163 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' level | margin | away by 1 | 3386 | 24.3 / 30.4 | -6.1 ** | 29.3 / 29.3 | -0.0 | 0.8 | -2.2% |
| 85' level | margin | away by 2 | 3386 | 5.1 / 5.6 | -0.5 | 5.1 / 4.9 | +0.2 | 0.4 | 1.3% |
| 85' level | margin | away by 3 | 3386 | 1.0 / 1.2 | -0.1 | 1.1 / 1.0 | +0.1 | 0.2 | -25.3% |
| 85' level | margin | home by 1 | 3386 | 24.7 / 29.4 | -4.7 ** | 29.5 / 29.9 | -0.3 | 0.8 | -4.1% |
| 85' level | margin | home by 2 | 3386 | 5.2 / 6.4 | -1.2 | 5.2 / 5.8 | -0.5 | 0.4 | 6.4% |
| 85' level | margin | home by 3 | 3386 | 1.1 / 1.2 | -0.1 | 1.2 / 1.1 | +0.1 | 0.2 | 10.6% |
| 60' lead1 | exact | +0-0 | 5682 | 35.5 / 33.5 | +2.0 | 31.6 / 30.5 | +1.1 | 0.6 |  |
| 60' lead1 | exact | +0-1 | 5682 | 5.6 / 3.3 | +2.3 | 4.2 / 4.5 | -0.3 | 0.3 |  |
| 60' lead1 | exact | +0-2 | 5682 | 6.6 / 7.9 | -1.3 | 8.5 / 8.3 | +0.2 | 0.4 |  |
| 60' lead1 | exact | +1-0 | 5682 | 21.0 / 19.1 | +1.9 | 17.4 / 17.4 | -0.0 | 0.5 |  |
| 60' lead1 | exact | +1-1 | 5682 | 10.9 / 12.8 | -1.9 | 14.0 / 15.1 | -1.1 | 0.5 |  |
| 60' lead1 | exact | +2-0 | 5682 | 7.1 / 7.8 | -0.7 | 7.2 / 7.4 | -0.1 | 0.3 |  |
| 60' lead1 | exact | other | 5682 | 13.3 / 15.6 | -2.3 | 17.1 / 16.8 | +0.3 | 0.5 |  |
| 60' lead2+ | exact | +0-0 | 4802 | 33.3 / 26.2 | +7.1 ** | 25.7 / 25.7 | +0.0 | 0.6 |  |
| 60' lead2+ | exact | +0-1 | 4802 | 11.9 / 12.5 | -0.6 | 13.9 / 14.5 | -0.6 | 0.5 |  |
| 60' lead2+ | exact | +0-2 | 4802 | 1.3 / 1.7 | -0.4 | 1.7 / 1.7 | -0.1 | 0.2 |  |
| 60' lead2+ | exact | +1-0 | 4802 | 24.3 / 24.5 | -0.2 | 22.6 / 21.5 | +1.0 | 0.6 |  |
| 60' lead2+ | exact | +1-1 | 4802 | 7.7 / 8.7 | -1.0 | 8.9 / 9.9 | -1.0 | 0.4 |  |
| 60' lead2+ | exact | +2-0 | 4802 | 10.0 / 11.5 | -1.5 | 10.8 / 10.1 | +0.7 | 0.4 |  |
| 60' lead2+ | exact | other | 4802 | 11.6 / 14.9 | -3.3 ** | 16.4 / 16.6 | -0.2 | 0.5 |  |
| 60' level | exact | +0-0 | 3916 | 13.1 / 7.9 | +5.2 ** | 8.5 / 8.0 | +0.5 | 0.4 |  |
| 60' level | exact | +0-1 | 3916 | 24.7 / 27.4 | -2.7 | 26.0 / 26.8 | -0.8 | 0.7 |  |
| 60' level | exact | +0-2 | 3916 | 7.2 / 7.5 | -0.3 | 6.5 / 6.1 | +0.5 | 0.4 |  |
| 60' level | exact | +1-0 | 3916 | 24.8 / 25.6 | -0.8 | 25.2 / 25.0 | +0.2 | 0.7 |  |
| 60' level | exact | +1-1 | 3916 | 5.8 / 5.1 | +0.7 | 5.7 / 5.7 | +0.0 | 0.4 |  |
| 60' level | exact | +2-0 | 3916 | 7.3 / 6.9 | +0.4 | 6.2 / 7.2 | -1.0 | 0.4 |  |
| 60' level | exact | other | 3916 | 17.2 / 19.7 | -2.5 | 21.9 / 21.2 | +0.6 | 0.7 |  |
| 75' lead1 | exact | +0-0 | 5027 | 59.6 / 58.9 | +0.6 | 56.8 / 55.3 | +1.4 | 0.7 |  |
| 75' lead1 | exact | +0-1 | 5027 | 4.7 / 2.8 | +1.9 | 3.6 / 3.6 | -0.0 | 0.3 |  |
| 75' lead1 | exact | +0-2 | 5027 | 4.0 / 4.8 | -0.9 | 5.6 / 5.2 | +0.4 | 0.3 |  |
| 75' lead1 | exact | +1-0 | 5027 | 17.8 / 16.7 | +1.1 | 15.4 / 15.4 | -0.0 | 0.5 |  |
| 75' lead1 | exact | +1-1 | 5027 | 5.8 / 6.8 | -1.0 | 8.0 / 9.3 | -1.3 | 0.4 |  |
| 75' lead1 | exact | +2-0 | 5027 | 3.0 / 3.9 | -0.9 | 3.2 / 3.6 | -0.4 | 0.3 |  |
| 75' lead1 | exact | other | 5027 | 5.2 / 6.1 | -0.9 | 7.4 / 7.5 | -0.1 | 0.4 |  |
| 75' lead2+ | exact | +0-0 | 5769 | 57.7 / 48.4 | +9.3 ** | 47.3 / 47.1 | +0.2 | 0.7 |  |
| 75' lead2+ | exact | +0-1 | 5769 | 10.1 / 12.1 | -2.0 | 14.0 / 14.7 | -0.7 | 0.5 |  |
| 75' lead2+ | exact | +0-2 | 5769 | 0.6 / 0.5 | +0.1 | 1.0 / 1.0 | +0.0 | 0.1 |  |
| 75' lead2+ | exact | +1-0 | 5769 | 21.4 / 24.9 | -3.5 ** | 22.9 / 22.4 | +0.5 | 0.5 |  |
| 75' lead2+ | exact | +1-1 | 5769 | 3.3 / 4.3 | -1.0 | 4.8 / 5.4 | -0.5 | 0.3 |  |
| 75' lead2+ | exact | +2-0 | 5769 | 4.5 / 6.2 | -1.7 | 5.9 / 5.5 | +0.4 | 0.3 |  |
| 75' lead2+ | exact | other | 5769 | 2.4 / 3.7 | -1.3 | 4.2 / 4.0 | +0.2 | 0.3 |  |
| 75' level | exact | +0-0 | 3604 | 21.9 / 13.0 | +8.9 ** | 13.9 / 13.2 | +0.7 | 0.6 |  |
| 75' level | exact | +0-1 | 3604 | 26.0 / 30.1 | -4.1 ** | 28.7 / 29.2 | -0.5 | 0.8 |  |
| 75' level | exact | +0-2 | 3604 | 5.3 / 5.9 | -0.6 | 5.0 / 5.1 | -0.0 | 0.4 |  |
| 75' level | exact | +1-0 | 3604 | 26.4 / 28.5 | -2.1 | 28.6 / 28.9 | -0.3 | 0.8 |  |
| 75' level | exact | +1-1 | 3604 | 6.1 / 6.0 | +0.1 | 6.7 / 6.7 | +0.0 | 0.4 |  |
| 75' level | exact | +2-0 | 3604 | 5.5 / 5.9 | -0.4 | 5.0 / 5.7 | -0.7 | 0.4 |  |
| 75' level | exact | other | 3604 | 8.9 / 10.7 | -1.7 | 12.1 / 11.2 | +0.9 | 0.5 |  |
| 85' lead1 | exact | +0-0 | 4851 | 84.1 / 84.5 | -0.4 | 83.5 / 83.1 | +0.4 | 0.5 |  |
| 85' lead1 | exact | +0-1 | 4851 | 2.2 / 1.2 | +1.0 | 1.7 / 1.8 | -0.1 | 0.2 |  |
| 85' lead1 | exact | +0-2 | 4851 | 1.3 / 1.6 | -0.3 | 2.0 / 1.9 | +0.1 | 0.2 |  |
| 85' lead1 | exact | +1-0 | 4851 | 8.4 / 8.5 | -0.1 | 7.6 / 7.3 | +0.3 | 0.4 |  |
| 85' lead1 | exact | +1-1 | 4851 | 1.7 / 1.8 | -0.1 | 2.3 / 2.5 | -0.2 | 0.2 |  |
| 85' lead1 | exact | +2-0 | 4851 | 0.5 / 0.7 | -0.2 | 0.4 / 0.8 | -0.4 | 0.1 |  |
| 85' lead1 | exact | other | 4851 | 1.8 / 1.7 | +0.1 | 2.5 / 2.7 | -0.2 | 0.2 |  |
| 85' lead2+ | exact | +0-0 | 6163 | 83.2 / 78.0 | +5.2 ** | 77.8 / 77.3 | +0.5 | 0.5 |  |
| 85' lead2+ | exact | +0-1 | 6163 | 4.8 / 6.2 | -1.4 | 7.2 / 7.8 | -0.6 | 0.3 |  |
| 85' lead2+ | exact | +0-2 | 6163 | 0.1 / 0.1 | -0.0 | 0.2 / 0.2 | +0.0 | 0.1 |  |
| 85' lead2+ | exact | +1-0 | 6163 | 10.5 / 13.7 | -3.2 ** | 12.8 / 12.9 | -0.0 | 0.4 |  |
| 85' lead2+ | exact | +1-1 | 6163 | 0.5 / 0.6 | -0.1 | 0.8 / 0.7 | +0.1 | 0.1 |  |
| 85' lead2+ | exact | +2-0 | 6163 | 0.7 / 1.1 | -0.4 | 1.0 / 1.0 | -0.0 | 0.1 |  |
| 85' lead2+ | exact | other | 6163 | 0.2 / 0.2 | -0.0 | 0.2 / 0.1 | +0.1 | 0.0 |  |
| 85' level | exact | +0-0 | 3386 | 30.7 / 17.8 | +12.9 ** | 19.1 / 18.3 | +0.8 | 0.7 |  |
| 85' level | exact | +0-1 | 3386 | 22.3 / 27.3 | -5.0 ** | 26.0 / 26.5 | -0.5 | 0.8 |  |
| 85' level | exact | +0-2 | 3386 | 4.7 / 5.2 | -0.5 | 4.6 / 4.4 | +0.3 | 0.4 |  |
| 85' level | exact | +1-0 | 3386 | 22.8 / 26.5 | -3.7 ** | 26.2 / 26.6 | -0.4 | 0.8 |  |
| 85' level | exact | +1-1 | 3386 | 7.0 / 7.1 | -0.1 | 8.2 / 8.6 | -0.4 | 0.5 |  |
| 85' level | exact | +2-0 | 3386 | 4.8 / 5.8 | -1.0 | 4.7 / 5.2 | -0.5 | 0.4 |  |
| 85' level | exact | other | 3386 | 7.7 / 10.4 | -2.7 | 11.1 / 10.4 | +0.8 | 0.5 |  |
| 60' fav leads | winner (fav view) | favourite | 7952 | 95.8 / 95.9 | -0.1 | 95.5 / 95.4 | +0.1 | 0.2 | -6.5% |
| 60' fav level | winner (fav view) | favourite | 3916 | 65.3 / 65.7 | -0.3 | 67.9 / 66.1 | +1.8 | 0.8 | -8.2% |
| 60' fav trails | winner (fav view) | favourite | 2532 | 20.2 / 22.5 | -2.3 | 26.0 / 25.3 | +0.7 | 0.9 | -7.9% |
| 75' fav leads | winner (fav view) | favourite | 8386 | 97.8 / 97.9 | -0.1 | 97.5 / 97.3 | +0.2 | 0.2 | -4.0% |
| 75' fav level | winner (fav view) | favourite | 3604 | 62.6 / 62.9 | -0.3 | 65.4 / 64.5 | +0.9 | 0.8 | -7.0% |
| 75' fav trails | winner (fav view) | favourite | 2410 | 10.8 / 11.7 | -0.9 | 15.1 / 13.6 | +1.5 | 0.7 | -24.9% |
| 85' fav leads | winner (fav view) | favourite | 8639 | 99.2 / 99.4 | -0.2 | 99.1 / 99.1 | +0.1 | 0.1 |  |
| 85' fav level | winner (fav view) | favourite | 3386 | 60.9 / 60.7 | +0.1 | 64.0 / 63.1 | +0.9 | 0.8 | -7.2% |
| 85' fav trails | winner (fav view) | favourite | 2375 | 3.8 / 4.0 | -0.2 | 5.4 / 5.1 | +0.3 | 0.5 | -29.6% |
| 60' fav leads | next_goal (fav view) | favourite | 7952 | 46.7 / 50.7 | -4.0 ** | 48.9 / 48.1 | +0.8 | 0.6 | -7.3% |
| 60' fav leads | next_goal (fav view) | underdog | 7952 | 19.5 / 19.9 | -0.3 | 22.5 / 23.7 | -1.2 | 0.5 | 0.7% |
| 60' fav level | next_goal (fav view) | favourite | 3916 | 57.0 / 61.0 | -4.0 ** | 61.4 / 60.5 | +0.9 | 0.8 | -7.3% |
| 60' fav level | next_goal (fav view) | underdog | 3916 | 29.8 / 31.1 | -1.3 | 30.1 / 31.5 | -1.5 | 0.7 | 0.0% |
| 60' fav trails | next_goal (fav view) | favourite | 2532 | 39.6 / 42.2 | -2.6 | 48.2 / 48.4 | -0.2 | 1.0 | -5.1% |
| 60' fav trails | next_goal (fav view) | underdog | 2532 | 23.7 / 25.4 | -1.6 | 22.2 / 23.3 | -1.2 | 0.8 | -0.3% |
| 75' fav leads | next_goal (fav view) | favourite | 8386 | 29.8 / 34.6 | -4.7 ** | 32.5 / 32.1 | +0.4 | 0.5 | -6.9% |
| 75' fav leads | next_goal (fav view) | underdog | 8386 | 12.2 / 13.2 | -1.0 | 16.2 / 17.2 | -1.0 | 0.4 | 1.7% |
| 75' fav level | next_goal (fav view) | favourite | 3604 | 50.9 / 55.9 | -5.0 ** | 57.3 / 56.5 | +0.8 | 0.8 | -7.0% |
| 75' fav level | next_goal (fav view) | underdog | 3604 | 27.2 / 31.1 | -3.9 ** | 28.8 / 30.2 | -1.4 | 0.8 | 0.8% |
| 75' fav trails | next_goal (fav view) | favourite | 2410 | 24.5 / 27.1 | -2.6 | 33.3 / 33.1 | +0.2 | 1.0 | -6.4% |
| 75' fav trails | next_goal (fav view) | underdog | 2410 | 14.9 / 16.1 | -1.3 | 13.9 / 15.2 | -1.3 | 0.7 | 6.0% |
| 85' fav leads | next_goal (fav view) | favourite | 8639 | 11.9 / 14.6 | -2.7 | 13.4 / 13.1 | +0.3 | 0.4 | -6.6% |
| 85' fav leads | next_goal (fav view) | underdog | 8639 | 4.8 / 5.3 | -0.5 | 6.5 / 7.1 | -0.5 | 0.3 | 2.1% |
| 85' fav level | next_goal (fav view) | favourite | 3386 | 45.0 / 51.9 | -6.8 ** | 53.6 / 53.3 | +0.3 | 0.9 | -6.0% |
| 85' fav level | next_goal (fav view) | underdog | 3386 | 24.3 / 30.3 | -6.0 ** | 27.3 / 28.3 | -1.0 | 0.8 | -0.6% |
| 85' fav trails | next_goal (fav view) | favourite | 2375 | 9.5 / 10.4 | -0.9 | 13.2 / 13.2 | -0.1 | 0.7 | -6.1% |
| 85' fav trails | next_goal (fav view) | underdog | 2375 | 5.8 / 6.1 | -0.3 | 5.5 / 6.9 | -1.4 | 0.5 | 15.4% |

</details>

### Live view: `harness/view-stats.mjs --matches 200`, 60 fps, 100 ms samples

| Metric | #218 (before) | #219 (after) |
|---|---:|---:|
| Transition jump, drawn, open → open: p50 / p99 / max | 0.33 / **5.80** / 14.86 | 0.34 / **5.97** / 13.69 |
| ...all transitions, p99 / max | 5.98 / 18.09 | 6.14 / 15.07 |
| ...backward component, p99 | 4.98 | 5.28 |
| Target discontinuity at the change tick, p99 | 6.45 | 6.66 |
| Bunching (≥ 6 players within 16 of the ball) | **9.5%** | **9.5%** |
| Forward / back / side / static / turnover | 45.2 / 10.9 / 17.8 / 15.8 / 10.4% | 45.6 / 10.6 / 17.8 / 15.6 / 10.4% |
| Ball in own half / final third | 73.1% / 5.0% | 72.6% / 5.4% |
| Live viewing seconds / match | 633 | 655 |

The p99 jump rises by 0.17 units per 100 ms. That is a change in mix, not a new teleport. Jumps above 5 units come mostly
from the existing build-up → first pass change, about 1,000 per 200 matches on both trees. There are about 14% more of them
because there are more attacks. Rebounds add 17 more (12 block → rebound shot, 5 save → rebound shot) out of about 290
rebounds, none above 15 units.

Before the minute-overrun guard, a first version had a 50-unit jump: a minute that overran published the next minute's
first row on top of a miss's bounce. That case is gone; the largest jump is now 15.1 (#218: 18.1), at a coaching event in
extra time.

Scenes (`src/domain/scenes.ts`):
- **Loose save:** the ball is parried to the engine's spot and the keeper stays down.
- **Loose block:** the ball comes back off the blocker to the spot, and the blocker does not win it.
- **The rebound's taker:** he arrives next to the ball. If the next published row is that rebound (look-ahead, as a cross
  reads its header), he is the shooter himself or a labelled team-mate following in; otherwise an unlabelled team-mate.
- **The rebound shot** starts where the loose ball stopped.
- **Counter-attack build-ups** play at the fast tempo.

No camera, banner, goal message, polling or rate-limit change. `reboundsCounters.test.ts` checks the frames through
shot → loose save or block → rebound shot (at most 4 units per 1/60 s tick).

Screenshots (real MatchPage build, mocked API fed real engine events, headless Chromium, 1280×800 and 390×844):
`ff-wt/media/219/after-counter-{desktop,mobile}-{1-break,2-pass,3-progression,4-shot}.png` and
`after-rebound-{desktop,mobile}-{1-parry,2-rebound-shot,3-result}.png`. There is no "before": main and #218 have neither
counters nor rebounds.

## Deliberate assertion updates

Outcome pins are re-pinned because the new draws and rules deliberately change the stream. Seeds, timing, projections and
the strict equality assertions are unchanged.

| Pin | Before (#218 fb8fec3) | After |
|---|---|---|
| 200-seed tuple/final (`engine.test.ts`, `cosmeticShots.test.ts` `pin`) | `8bd5c4273a106ad61fb0bf92373e10431ca78cc7f13bcf362dbd53e9a9840b81` | `daf66a03be69ba61ef446c362bb09a04681015b6681ccf064f401765de6fb9a8` |
| Full real payload/final (`cosmeticShots.test.ts` `full`) | `4143b324ba836466981ea53fc864594729bb070b14c041904bb6176c7a76f7d7` | `9af045ea9b5dd535845a27f431cd5d80e3295c3a845db04d66c2aaa877198a01` |
| Every persisted step (`cosmeticShots.test.ts` `steps`) | `b874c167e744da1de29debf440822a180a1d219507e90bf08f547e4433b2af22` | `ec15ee3cdb841300b010e19d4f0cab9f108107e3fa644f2ae5f560b36bd7845f` |
| 200-seed outcome summary (`commentary.test.ts`) | `b6e1cb087bf209214928285e4ebfa135bc2a00a01725bce40a14d4f828a293f5` | `1437a0386ef55a889c5db63d3a79ecb0fad9e813f2526cb8d51d3b7e0a143a29` |

| Manual balanced seed (`tacticalBalance.test.ts`) | Before score / RNG / events | After score / RNG / events | After event SHA-256 |
|---|---|---|---|
| 11 | [2, 1] / 2262 / 400 | [3, 2] / 2296 / 409 | `5a14a147fbb3c9fea5d104672865bbb6ffcb49b181cbacb6aed36ddf545c67b3` |
| 12 | [1, 0] / 2240 / 391 | [1, 0] / 2416 / 418 | `512f1ca768d90da0af1f633c4cb876d0c0aef882a36b41ea7fdb50609d817a22` |
| 13 | [1, 2] / 2488 / 453 | [1, 1] / 3173 / 564 | `f3bb3f0cec2a8bb0c4bfb179ceba46725ed664c9955863fcbe02bce3a1a6a7f9` |

Other test changes:
- `scenes.test.ts`: the result-hold test skips a loose save, which plays straight on into its rebound (its own test checks
  that gap against the scene's length). The "blocker or keeper ends with the ball" test skips loose results, whose ball goes
  to the rebound's taker.
- New `reboundsCounters.test.ts` (240 matches of the balance fixtures at 6 s) checks:
  - counters and rebounds a match;
  - a counter's shape: from where the ball was won, one or two long passes, a progression, no long shot, every kind of
    ending;
  - that counters convert more often than ordinary attacks;
  - the rebound chain: same chain, from the loose spot, never a third shot, both shots in the stats;
  - suspension through the rebound with `markets.fixtureState`;
  - the scene gap, and frame continuity with the taker on the ball;
  - the late trailing shot rate;
  - the in-play model: its structure; that a managed side keeps its stance; coherent distributions from every phase; that
    the cheap qualify walk equals the full walk; that the next-goal "none" equals the current exact score; that the market
    catalogue prices from it; that a legacy model is priced as before;
  - that a saved mid-match state resumes deterministically.
- `Pitch.ends.test.tsx` chooses a seeded match as a precondition: two manual Balanced sides that play extra time and a
  shootout with kicks from both, with the ball off-centre at every break. The stream shift moved seed 1031 off extra time,
  so it uses 1040, the next seed that meets those conditions. Teams, pace and assertions are unchanged.
- The existing odds, betting and settlement tests are unchanged and pass. Settlement code (`markets.settleFixtureBet`,
  `bettingService`) is untouched.

## Deployment

Deploy between rounds (`deploy/DEPLOY.md`). Fixtures scheduled before the deploy get the new `model_json` at kickoff. A
match in flight at the deploy resumes on the new engine, and its saved state is compatible. But its `model_json` is the
legacy `{ lh, la }`, which is priced with the old constant-rate model until the match ends: the `--legacy` row above shows
how miscalibrated that is. Old clients ignore `ctr`, `reb` and `loose`. They draw a loose save as an ordinary save and the
rebound as an ordinary shot, so the ball can jump from the keeper to the loose spot.

## Limitations

- A side run by its manager is priced at its kickoff stance in every game state, because the published state does not
  carry the current stance. Calibration covers AI sides only (all the simulated fixtures are AI).
- Each minute's model rates are stationary-chain averages for that game state. Fatigue drift, the counter flag after a
  half-time reset, and the minute already in progress (priced as a whole minute) are not modelled. The residuals above
  include them.
- The issue's 1,000-match criterion was run at 4,800 per seed set, and pooled over 14,400 for the odds.
