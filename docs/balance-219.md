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
  has no `resultHoldMs`; the second shot's own result holds as usual.
- **Minute-overrun guard** (`playMinute`).
  - What it does: when a minute's last row lands within 0.1 of a minute of the minute's end, or past it, the next minute
    waits until 0.1 of a minute after that row.
  - Why: before, a minute that overran published the next minute's first rows on top of its last scene. With rebounds that
    gave a 50-unit ball jump in the live view.
  - Scope (#219 review F4): the guard is not specific to rebounds. Any minute whose result hold or bounce ends near the
    minute's end triggers it. The reviewer measured this with every #219 feature switched off: the guard fires in about 98%
    of matches and moves the final whistle by 1.2 s on average (max 4.3 s).
  - Effect: timing only; outcomes are unchanged.
- **Markets.** A loose save or block keeps `d: 1`, so markets stay suspended from the first shot, through the parry and the
  second shot, until its result reopens them (or a goal holds them through the restart, as any goal does).
- **Determinism and resumability.** All new randomness goes through `rnd(st)`. No persisted field is added, so the state shape
  is unchanged (`tacticalBalance.test.ts` checks it). The save/reload-every-step test reproduces every stream. A state saved
  mid-match by the #218 engine resumes on this one. Its `st.counter` means the same thing, and from then on the match plays by
  the new rules.

### `goalRates` / the odds model

`goalRates(st, sit)` now models the whole minute loop, not a single attack:
- **The counter chain.** The counter flag a minute starts with (none / mine / theirs) is a 3-state Markov chain. Its
  stationary mix is solved in closed form (`sideRate`, the Markov chain tree theorem). This prices possession swings,
  counter-attacks and their `counterRisk`.
- **Each attack's goal chance** (`attackFlat`) includes:
  - the rebound off a parried save or a loose block;
  - the long-shot save bonus;
  - penalties;
  - counters.
- **Save chance** (review F1). It is the mean of the keeper's save chance against each opposing shooter, weighted as
  `attacker()` picks them (`saveMix` / `meanSave`).
  - Before: one save chance at a fixed attack of 72 (#218), then at the mean shooter.
  - Why that was wrong: `saveChance` clamps at 0.3 and 0.8. Against a weak side's weak shooters, a strong keeper's chance
    is cut at 0.8, so the mean shooter overstated the saves the underdog faces.
  - Why the mean is exact: an attack's chances are linear in the save chance over the whole clamped range, so the mean
    save chance prices the shooter mix exactly.
- **Fatigue** (review F1). `sit.minute` plays the state after that many more minutes of wear (`wornStrengths`, as
  `wear()` drains energy and condition). Tired players narrow the gap between strong and weak sides late in a match. The
  kickoff-only model priced every minute at full fitness.
- **Game state.** `sit` = `{ stance: { home, away }, urg: { home, away }, minute }` plays a game state. Without `sit`,
  the result is as before: the current stances, no urgency and no further wear.
- **Speed.** Strengths are computed once per wear level, and the arithmetic is flat (no per-attack objects), because
  PocketBase's JS VM is slow on calls and allocations.

`matchEngine.inPlayModel(st)` builds the kickoff `model_json` that `worldService.pairModel` now stores:
`{ lh, la, at: { chase: 70, protect: 78, settle: 100 }, k: [0, 60, 120], r: { n, hT, hT1, aT, aT1, L } }`.
- `lh`/`la` are the kickoff rates, as before. The `round_first` market still reads only these.
- `r` holds per-minute `[home, away]` rates for each game state, sampled after 0, 60 and 120 minutes of wear (flattened
  `[h0, a0, h60, a60, h120, a120]`). odds.js interpolates linearly between them; that is within 0.2% of the exact
  per-minute rates. The game states are the ones the AI stance policy and urgency produce:
  - `n`: no urgency, kickoff stances;
  - `hT`: home is trailing late;
  - `hT1`: home is trailing by one from 78′, and away sits deep (Defend);
  - `aT`, `aT1`: the same for away;
  - `L`: level from 100′, when both attack.

A side its manager runs keeps its kickoff stance in every state (the manager's later choices are not known); urgency still
applies to it. See Limitations.

**`odds.js` reference (the definition).** With a staged model (`r`, `k`, `at`), `finalDist` and `nextGoal` price the
remaining match as follows:
- **Before the chase (70′):** every score has the same rates, so each side's goals up to the chase are Poisson with the
  summed per-minute rates (`span`). That is how the pre-#219 model treated the whole match.
- **From the chase on:** each minute is walked, with its rates taken from the score at its start and the minute
  (`stageRates`). The engine plays at most one attack a minute, so a minute has at most one goal: home with probability
  `rate.h`, away with `rate.a`.
- **The end:** level after 90′ continues into extra time; level after 120′ is a coin flip, as before.
- **Red cards** are applied as before.
- **Legacy models:** a `{ lh, la }` model, which a match in flight at the deploy still has, is priced exactly as before.
- **Unchanged:** market rules, settlement, margin and withdrawal (`MIN_OFFER`).

**Fast paths** (review F2: the polled endpoints run in PocketBase's goja VM). They compute the reference's numbers with
less work:
- `markets.fixtureMarkets` gets every probability from one `odds.marketProbs` call.
- Per model and red-card state, a context is built once and cached in the module:
  - the span's per-minute rates as prefix sums;
  - a five-class rate table for the walked minutes (behind by 2+, by 1, level, ahead by 1, by 2+);
  - backward value tables `V[k][d]` (P(home qualifies) from minute k at difference d).
- **Qualify** (fixture cards, `finalDist(..., noDist)`, `pairQualify`) is then a table lookup, or before the chase the
  span's Poisson difference distribution against `V` at the chase.
- **Margins** walk the score difference alone. **Exact scores** walk only the 6 × 6 cells the market shows: goals never go
  down, so those cells receive mass only from inside the grid.
- Differences beyond ±8 count as decided.
- **Results cache:** per model, state and minute, bounded to 200 entries. All of these are pure functions of their inputs.
- **Equality:** `reboundsCounters.test.ts` asserts that every market probability equals the reference within 1e-9, cached
  or not, red cards included: 5 pairings × 13 states. The largest difference seen is 5.5e-11.

## Calibration

Measured on 2026-11-12, with these baselines:
- **#218 head fb8fec3**, on which this branch is stacked. Its 4,800-match engine figures are identical to 098c5a4, because
  fb8fec3 moved positions only.
- **Main b4b7467**, for context.

All engine figures are at production pace (6 s minutes), over all 240 pairings, 4,800 matches. The #219 review fixes
(model and odds code only) leave the simulated matches unchanged: the outcome pins are as before. Only the model figures
moved.

```bash
node scripts/engine-calibrate.mjs 4800 --pairs all [--prefix alt|zz]      # engine figures below (incl. counters, rebounds, trailing rate)
node harness/engine-stats.mjs --root <root> --matches 4800 --workers 3     # external harness: same fixtures, same numbers
node scripts/inplay-calibrate.mjs 4800 --prefix cal,alt,zz,qq              # in-play odds calibration (about 3 min per 4,800)
node scripts/inplay-calibrate.mjs 4800 --root <#218 tree>                  # the same against the #218 engine and odds
node scripts/inplay-calibrate.mjs 4800 --legacy                            # this engine priced with the old constant-rate model
node harness/view-stats.mjs --root <root> --matches 200                    # live view
```

How the engine metrics are counted:
- **Counters and rebounds** are marked explicitly in `engine-calibrate.mjs`: `counterAttacks` counts build-ups with `ctr`,
  and `reboundShots` counts shots with `reb`. The harness counts the same chains: `ctr` is its explicit counter flag, and a
  rebound is a chain's second shot.
- **Trailing shot rate** (`trailingShotsPerPossessionMin`) uses the harness's definition: the side behind at the start of a
  minute, its real shots per minute in which it had the ball (the side of the minute's first build-up or pass), in normal
  time. "Incl. cosmetic" adds its cosmetic long-range tries; that definition reproduces the issue's 0.17 → 0.20.

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
| Kickoff `lh + la` × 90 vs simulated goals/90 | +1.7% | +1.8% | −4.9% | see below |
| In-play model's expected goals/90 from kick-off vs simulated | | | **+1.8%** | within ±3% |

The kickoff `lh + la` rates are now the level, no-urgency, full-fitness state. The match scores more than that late on,
when someone is chasing, so "kickoff rates vs simulation" is no longer the right check. The right one is the model's own
expectation, walked through the game states from kick-off (`stagedGoals90` in engine-calibrate): +1.8% (`cal`), −0.7%
(`alt`), +1.2% (`zz`), +0.2% (the 3,000-match default run).

Seed robustness (4,800 matches each, the same 240 pairings):

| Prefix | Goals #218 → #219 | Trailing from 70′, real (incl. cosmetic) #218 → #219 | Counters | Rebounds | Staged model vs sim |
|---|---|---|---:|---:|---:|
| `cal` | 3.41 → 3.40 | 0.221 (0.237) → 0.306 (0.319) | 1.88 | 1.47 | +1.8% |
| `alt` | 3.40 → 3.51 | 0.223 (0.239) → 0.306 (0.318) | 1.87 | 1.51 | −0.7% |
| `zz` | 3.37 → 3.42 | 0.221 (0.237) → 0.308 (0.321) | 1.93 | 1.49 | +1.2% |
| pooled (14,400) | 3.39 → 3.44 (+0.05) | | | | |

Every criterion holds on all three seed sets. On `alt`, goals rise by 0.11, still inside ±0.15. Without the `saveBase`
change, goals would rise by about 0.55 a match: urgency adds late goals at both ends, and so do counters and rebounds.
Raising `saveBase` keeps the totals level. Shots rise to about 24 a match, because rebounds and the extra late attacks are
real shots.

### `node scripts/engine-calibrate.mjs 3000` (16 pairings, 15 s snapshot)

| Metric | #218 | #219 |
|---|---:|---:|
| Goals/90 | 3.08 | 3.11 |
| Extra time | 21.7% | 24.1% |
| Shootouts | 7.5% | 8.5% |
| Favourite wins | 83% | 83% |
| Shots | 21.2 | 24.2 |
| Counters | | 1.93 |
| Rebounds | | 1.47 |
| Trailing from 70′ (incl. cosmetic) | | 0.311 (0.328) |
| Staged model vs sim | | +0.2% |

### In-play odds calibration

`scripts/inplay-calibrate.mjs` plays each match, then snapshots the price the app would show when the public clock reaches
60′, 75′ and 85′:
- the published state is the last event at that moment, at the minute `odds.clockMinute` gives;
- if markets are suspended then, it takes the first later event that reopens them (66 of 14,400 snapshots on `cal`).

It prices that state with `markets.fixtureMarkets` (the fast paths) and the `model_json` that `pairModel` builds. Every
offered price is checked against the reference probability (`okP`): 1,395,612 checks over 19,200 matches. Exactly one
price, on `qq`, sat on a 2-decimal rounding boundary (435.37 / 435.38); the script accepts a price that `p ± 1e-9`
reproduces. Then, per cell, it compares the mean model probability of each selection with how often it won.

Cell groups:
- **core** (189 cells): minute × score state from the leader's side. Markets: to qualify, next goal, winning margin
  (exactly 1/2/3), and exact score grouped by goals still to come. The "fav view" splits the same markets by whether the
  pre-match favourite leads, is level or trails.
- **strength** (#219 review F1, 81 cells): minute × the pre-match underdog's chance to qualify (< 15%, 15–25%, 25–50%) ×
  the underdog's score state. Markets: to qualify and next goal.
- **pre-match** (10 cells): the winner price before kick-off, by the underdog's chance (< 15% … 45–50%), offered prices
  checked too.

Cells with fewer than 200 snapshots are not judged.

| Run (4,800 matches each unless pooled) | Core cells outside ±3 pp (of 189) | Strength (of judged) | Pre-match (of 10) | Worst core cell |
|---|---:|---:|---:|---|
| main b4b7467 (engine + odds), `cal` | 42 | 19 / 57 | 0 | 85′ level, next goal none: +12.5 pp |
| #218 fb8fec3 (engine + odds), `cal` | 41 | 21 / 57 | 2 | 85′ level, exact +0-0: +13.2 pp |
| #218, pooled `cal,alt,zz,qq` (19,200) | 39 | 22 / 81 | 0 | 85′ level, exact +0-0: +12.6 pp |
| #219 engine, old constant-rate model (`--legacy`), `cal` | 69 | 26 / 60 | 0 | 85′ level, next goal none: +14.9 pp |
| **#219, `cal`** | **0** | 5 / 63 | 0 | 75′ favourite trails, next goal underdog −2.8 pp (SE 1.3) |
| **#219, `alt`** | **3** | 11 / 63 | 0 | 60′ favourite level, winner favourite +3.1 pp (SE 1.3, n 1,290) |
| **#219, `zz`** | **0** | 4 / 63 | 0 | 75′ favourite trails, winner favourite +2.4 pp (SE 1.2) |
| **#219, `qq`** | **0** | 4 / 63 | 2 | 60′ favourite level, next goal favourite +2.9 pp (SE 1.4) |
| **#219, pooled `cal,alt,zz,qq` (19,200)** | **0** | **2 / 81** | **0** | 60′ favourite level, winner favourite +1.5 pp (SE 0.7) |

**Core.**
- The 4,800-match runs give 0–3 cells just outside ±3 pp. On `alt` there are 3 (the review reproduced 4 before these
  fixes): 60′ favourite level, winner +3.1; 60′ two up, exact +0-0 +3.0; 60′ two up, next goal none +3.0. Each is within
  2.4 standard errors, and none repeats on the other seed sets.
- Pooled over 19,200 matches, no core cell is beyond ±1.5 pp.
- The old model's errors were systematic and repeated on every seed set: "no further goal" was overpriced by 5–13 pp,
  level or two goals ahead, from 60′ on.

**Pre-match, by strength** (review F1). Pooled over 19,200 matches (`cal,alt,zz,qq`), the pre-match underdog to qualify:

| Underdog's chance | n | #218 model / observed | #218 bettor ROI | #219 model / observed | #219 bettor ROI |
|---|---:|---|---:|---|---:|
| < 15% | 5,760 | 9.0 / 8.0% | −21.0% | 8.5 / 9.1% | **−1.2%** |
| 15–25% | 4,000 | 19.8 / 16.9% | −20.0% | 19.7 / 20.5% | −2.7% |
| 25–35% | 4,000 | 29.6 / 28.4% | −9.9% | 29.9 / 29.9% | −5.9% |
| 35–45% | 4,320 | 40.0 / 40.5% | −4.7% | 39.7 / 39.9% | −5.6% |
| 45–50% | 1,120 | 47.9 / 46.3% | −9.2% | 46.9 / 48.5% | −2.6% |

Before the fixes, the review measured the < 15% underdog at 8.10% against 9.49% observed, a +10.0% ROI. Two model
changes close the gap:
- **Fatigue.** Rates are sampled at 0, 60 and 120 minutes of wear: 8.10 → 8.32%.
- **Shooter mix.** The keeper's save chance is averaged over the opposing shooters, so `saveChance`'s clamps count:
  → 8.45%.

Every underdog ROI is now ≤ 0 at the 6% margin, and every pre-match cell is within ±1.7 pp.

**In play, by strength.** Pooled, 2 of 81 strength cells are just outside ±3 pp:
- 60′, underdog < 15% leading, winner: −3.1 pp (SE 2.4, n 412);
- 75′, underdog < 15% leading, next goal underdog: −3.9 pp (SE 1.7, n 359).

The rest are within ±2.6 pp. A small residual remains, though. When a big underdog (< 15%) is level or ahead, most of its
cells sit 1–3 pp low, and those bets return more than the margin at the offered prices: level at 60′ +7.6%, at 75′
+3.6%; ahead at 75′, next goal +40.6% (n 359). Two diagnostics:
- **Component check.** In the state where a big favourite is chasing a big underdog late on, the model overstates the
  favourite's goal rate by ~5% and understates the underdog's by ~15% (6,844 minutes over 19,200 matches; each about
  1 SE).
- **Ruled out:** fatigue, the save-chance clamps and red cards (worth about 0.1 pp). The rest of the cause is not
  identified.

This is a known residual of the review's F1 for in-play big-underdog prices; see Limitations.

**"Next goal: the favourite" after 70′** (Fable on #217). The bettor's mean return per unit staked at the offered price,
taken at every minute from 70′ to 89′ (about 96,000 bets per 4,800 matches):

| | main | #218 | #219 engine, old model | **#219** |
|---|---:|---:|---:|---:|
| ROI, `cal` | +6.7% | +6.9% | +10.4% | **−7.3%** |
| ROI, pooled `cal,alt,zz,qq` | | +8.9% | | **−7.5%** |
| ...at 60′ / 75′ / 85′ (pooled) | | +1.4 / +7.0 / +11.5% | | −6.9 / −7.2 / −7.3% |

With a 6% margin, a calibrated price returns about −6%. The bettor's edge is gone.

<details>
<summary>Core table: pooled 19,200 matches (`cal,alt,zz,qq`), #218 versus #219</summary>

The #218 columns use #218's engine and odds on the same fixtures. Their n is close but not equal, so n is #219's. "**"
marks a cell beyond ±3 pp with n ≥ 200. "Bettor ROI" is the return at #219's offered prices; it is empty for the exact-score
groups, which are not single selections.

| Minute, state | Market | Selection | n | #218: model / observed % | diff pp | #219: model / observed % | diff pp | SE pp | #219 bettor ROI |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 60' lead1 | winner | leader | 7615 | 86.2 / 85.5 | +0.7 | 83.7 / 83.9 | -0.2 | 0.4 | -5.5% |
| 60' lead1 | winner | trailer | 7615 | 13.8 / 14.5 | -0.7 | 16.3 / 16.1 | +0.2 | 0.4 | -7.0% |
| 60' lead2+ | winner | leader | 6371 | 98.7 / 98.6 | +0.1 | 97.9 / 98.2 | -0.2 | 0.2 | -5.9% |
| 60' lead2+ | winner | trailer | 6371 | 1.3 / 1.4 | -0.1 | 2.1 / 1.8 | +0.2 | 0.2 | -26.5% |
| 60' level | winner | away | 5214 | 49.7 / 50.8 | -1.1 | 50.7 / 51.6 | -0.9 | 0.7 | -2.4% |
| 60' level | winner | home | 5214 | 50.3 / 49.2 | +1.1 | 49.3 / 48.4 | +0.9 | 0.7 | -6.7% |
| 75' lead1 | winner | leader | 6653 | 91.5 / 91.2 | +0.2 | 89.3 / 89.4 | -0.1 | 0.4 | -4.4% |
| 75' lead1 | winner | trailer | 6653 | 8.5 / 8.8 | -0.2 | 10.7 / 10.6 | +0.1 | 0.4 | -4.4% |
| 75' lead2+ | winner | leader | 7705 | 99.6 / 99.5 | +0.1 | 99.3 / 99.5 | -0.2 | 0.1 | -2.7% |
| 75' lead2+ | winner | trailer | 7705 | 0.4 / 0.5 | -0.1 | 0.7 / 0.5 | +0.2 | 0.1 | -44.9% |
| 75' level | winner | away | 4842 | 49.7 / 50.3 | -0.6 | 50.2 / 50.9 | -0.7 | 0.7 | -3.6% |
| 75' level | winner | home | 4842 | 50.3 / 49.7 | +0.6 | 49.8 / 49.1 | +0.7 | 0.7 | -7.2% |
| 85' lead1 | winner | leader | 6406 | 96.7 / 96.8 | -0.1 | 95.9 / 95.8 | +0.1 | 0.3 | -4.6% |
| 85' lead1 | winner | trailer | 6406 | 3.3 / 3.2 | +0.1 | 4.1 / 4.2 | -0.1 | 0.3 | 0.7% |
| 85' lead2+ | winner | leader | 8226 | 100.0 / 99.9 | +0.1 | 99.9 / 100.0 | -0.1 | 0.0 |  |
| 85' lead2+ | winner | trailer | 8226 | 0.0 / 0.1 | -0.1 | 0.1 / 0.0 | +0.1 | 0.0 | -100.0% |
| 85' level | winner | away | 4568 | 49.8 / 50.0 | -0.2 | 49.9 / 50.0 | -0.1 | 0.7 | -5.2% |
| 85' level | winner | home | 4568 | 50.2 / 50.0 | +0.2 | 50.1 / 50.0 | +0.1 | 0.7 | -6.8% |
| 60' lead1 | next_goal | leader | 7615 | 37.4 / 39.0 | -1.6 | 37.2 / 37.2 | +0.0 | 0.6 | -5.7% |
| 60' lead1 | next_goal | none | 7615 | 35.5 / 33.4 | +2.1 | 31.1 / 30.7 | +0.5 | 0.5 | -7.5% |
| 60' lead1 | next_goal | trailer | 7615 | 27.2 / 27.7 | -0.5 | 31.6 / 32.2 | -0.6 | 0.5 | -3.9% |
| 60' lead2+ | next_goal | leader | 6371 | 45.5 / 51.5 | -6.0 ** | 48.1 / 48.2 | -0.2 | 0.6 | -5.2% |
| 60' lead2+ | next_goal | none | 6371 | 33.3 / 26.4 | +6.9 ** | 25.4 / 25.6 | -0.2 | 0.5 | -5.3% |
| 60' lead2+ | next_goal | trailer | 6371 | 21.2 / 22.1 | -0.9 | 26.5 / 26.1 | +0.4 | 0.6 | -7.2% |
| 60' level | next_goal | away | 5214 | 43.2 / 46.7 | -3.5 ** | 46.6 / 46.5 | +0.1 | 0.7 | -5.3% |
| 60' level | next_goal | home | 5214 | 43.7 / 45.1 | -1.4 | 45.3 / 45.1 | +0.2 | 0.7 | -5.8% |
| 60' level | next_goal | none | 5214 | 13.1 / 8.2 | +4.9 ** | 8.1 / 8.5 | -0.3 | 0.4 | -2.4% |
| 75' lead1 | next_goal | leader | 6653 | 23.4 / 23.7 | -0.4 | 22.4 / 22.7 | -0.3 | 0.5 | -3.3% |
| 75' lead1 | next_goal | none | 6653 | 59.6 / 59.1 | +0.5 | 56.2 / 55.6 | +0.6 | 0.6 | -7.1% |
| 75' lead1 | next_goal | trailer | 6653 | 17.1 / 17.2 | -0.1 | 21.4 / 21.8 | -0.4 | 0.5 | -3.5% |
| 75' lead2+ | next_goal | leader | 7705 | 28.9 / 35.8 | -6.8 ** | 33.3 / 33.3 | -0.1 | 0.5 | -5.5% |
| 75' lead2+ | next_goal | none | 7705 | 57.7 / 48.2 | +9.5 ** | 46.9 / 47.0 | -0.1 | 0.6 | -5.7% |
| 75' lead2+ | next_goal | trailer | 7705 | 13.4 / 16.0 | -2.6 | 19.9 / 19.7 | +0.2 | 0.5 | -5.8% |
| 75' level | next_goal | away | 4842 | 38.8 / 44.0 | -5.2 ** | 43.6 / 43.7 | -0.1 | 0.7 | -4.3% |
| 75' level | next_goal | home | 4842 | 39.3 / 42.7 | -3.4 ** | 43.2 / 42.7 | +0.5 | 0.7 | -6.7% |
| 75' level | next_goal | none | 4842 | 21.9 / 13.3 | +8.7 ** | 13.3 / 13.6 | -0.3 | 0.5 | -3.4% |
| 85' lead1 | next_goal | leader | 6406 | 9.2 / 9.4 | -0.2 | 8.5 / 8.2 | +0.3 | 0.3 | -8.5% |
| 85' lead1 | next_goal | none | 6406 | 84.1 / 84.5 | -0.4 | 83.3 / 83.5 | -0.2 | 0.5 | -5.8% |
| 85' lead1 | next_goal | trailer | 6406 | 6.6 / 6.1 | +0.5 | 8.3 / 8.4 | -0.1 | 0.3 | -5.8% |
| 85' lead2+ | next_goal | leader | 8226 | 11.5 / 15.1 | -3.5 ** | 14.1 / 14.5 | -0.3 | 0.4 | -1.7% |
| 85' lead2+ | next_goal | none | 8226 | 83.2 / 78.1 | +5.1 ** | 77.6 / 77.5 | +0.1 | 0.5 | -6.1% |
| 85' lead2+ | next_goal | trailer | 8226 | 5.3 / 6.8 | -1.6 | 8.3 / 8.1 | +0.2 | 0.3 | -7.1% |
| 85' level | next_goal | away | 4568 | 34.5 / 40.7 | -6.2 ** | 40.7 / 40.5 | +0.2 | 0.7 | -5.6% |
| 85' level | next_goal | home | 4568 | 34.9 / 41.2 | -6.4 ** | 40.9 / 41.0 | -0.1 | 0.7 | -6.3% |
| 85' level | next_goal | none | 4568 | 30.7 / 18.1 | +12.6 ** | 18.3 / 18.6 | -0.3 | 0.6 | -5.0% |
| 60' lead1 | margin | leader by 1 | 7615 | 47.6 / 48.0 | -0.4 | 47.7 / 47.8 | -0.2 | 0.6 | -5.7% |
| 60' lead1 | margin | leader by 2 | 7615 | 24.4 / 22.8 | +1.6 | 21.4 / 21.2 | +0.2 | 0.5 | -6.5% |
| 60' lead1 | margin | leader by 3 | 7615 | 7.9 / 8.7 | -0.8 | 8.2 / 8.5 | -0.3 | 0.3 | -2.8% |
| 60' lead1 | margin | trailer by 1 | 7615 | 7.8 / 9.1 | -1.4 | 10.3 / 9.9 | +0.4 | 0.3 | -7.3% |
| 60' lead1 | margin | trailer by 2 | 7615 | 1.8 / 2.1 | -0.3 | 1.9 / 1.9 | +0.0 | 0.2 | -12.0% |
| 60' lead1 | margin | trailer by 3 | 7615 | 0.3 / 0.6 | -0.3 | 0.4 / 0.5 | -0.1 | 0.1 | 5.6% |
| 60' lead2+ | margin | leader by 1 | 6371 | 9.8 / 11.1 | -1.3 | 13.5 / 13.4 | +0.0 | 0.4 | -10.4% |
| 60' lead2+ | margin | leader by 2 | 6371 | 29.3 / 26.1 | +3.2 ** | 26.2 / 26.7 | -0.5 | 0.6 | 0.4% |
| 60' lead2+ | margin | leader by 3 | 6371 | 27.6 / 26.4 | +1.3 | 25.6 / 25.4 | +0.2 | 0.5 | -9.1% |
| 60' lead2+ | margin | trailer by 1 | 6371 | 0.7 / 0.8 | -0.1 | 1.3 / 1.2 | +0.0 | 0.1 | -23.0% |
| 60' lead2+ | margin | trailer by 2 | 6371 | 0.2 / 0.1 | +0.0 | 0.2 / 0.3 | -0.1 | 0.1 | -6.2% |
| 60' lead2+ | margin | trailer by 3 | 6371 | 0.0 / 0.1 | -0.1 | 0.1 / 0.1 | +0.0 | 0.0 | -66.9% |
| 60' level | margin | away by 1 | 5214 | 29.3 / 32.5 | -3.3 ** | 32.7 / 33.2 | -0.5 | 0.7 | -3.1% |
| 60' level | margin | away by 2 | 5214 | 8.3 / 8.5 | -0.2 | 7.8 / 7.6 | +0.2 | 0.4 | -2.4% |
| 60' level | margin | away by 3 | 5214 | 1.8 / 2.1 | -0.3 | 2.0 / 2.0 | +0.0 | 0.2 | -3.4% |
| 60' level | margin | home by 1 | 5214 | 29.6 / 31.4 | -1.8 | 31.8 / 31.4 | +0.4 | 0.6 | -5.7% |
| 60' level | margin | home by 2 | 5214 | 8.4 / 8.0 | +0.4 | 7.4 / 7.9 | -0.5 | 0.4 | 2.4% |
| 60' level | margin | home by 3 | 5214 | 1.9 / 2.4 | -0.6 | 1.9 / 1.5 | +0.4 | 0.2 | -11.8% |
| 75' lead1 | margin | leader by 1 | 6653 | 65.8 / 66.7 | -0.9 | 65.4 / 65.3 | +0.1 | 0.6 | -6.2% |
| 75' lead1 | margin | leader by 2 | 6653 | 19.0 / 18.1 | +0.9 | 17.0 / 16.9 | +0.1 | 0.5 | -6.0% |
| 75' lead1 | margin | leader by 3 | 6653 | 3.3 / 4.0 | -0.8 | 3.5 / 3.8 | -0.3 | 0.2 | -0.8% |
| 75' lead1 | margin | trailer by 1 | 6653 | 4.4 / 5.4 | -1.0 | 6.5 / 6.4 | +0.1 | 0.3 | -4.7% |
| 75' lead1 | margin | trailer by 2 | 6653 | 0.9 / 1.1 | -0.1 | 1.1 / 1.1 | +0.1 | 0.1 | -19.8% |
| 75' lead1 | margin | trailer by 3 | 6653 | 0.2 / 0.3 | -0.1 | 0.2 / 0.3 | -0.1 | 0.1 | 2.1% |
| 75' lead2+ | margin | leader by 1 | 7705 | 6.5 / 8.2 | -1.6 | 10.2 / 9.9 | +0.3 | 0.3 | -4.3% |
| 75' lead2+ | margin | leader by 2 | 7705 | 36.0 / 32.1 | +3.9 ** | 32.3 / 33.0 | -0.8 | 0.5 | 0.3% |
| 75' lead2+ | margin | leader by 3 | 7705 | 28.8 / 28.0 | +0.7 | 27.4 / 27.4 | +0.0 | 0.5 | -4.9% |
| 75' lead2+ | margin | trailer by 1 | 7705 | 0.2 / 0.3 | -0.1 | 0.4 / 0.3 | +0.1 | 0.1 | -56.1% |
| 75' lead2+ | margin | trailer by 2 | 7705 | 0.0 / 0.0 | -0.0 | 0.1 / 0.1 | -0.0 | 0.0 | -2.6% |
| 75' lead2+ | margin | trailer by 3 | 7705 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | -0.0 | 0.0 | -100.0% |
| 75' level | margin | away by 1 | 4842 | 28.4 / 32.7 | -4.3 ** | 32.6 / 32.8 | -0.1 | 0.7 | -4.4% |
| 75' level | margin | away by 2 | 4842 | 5.8 / 6.2 | -0.4 | 5.7 / 5.5 | +0.1 | 0.3 | 7.0% |
| 75' level | margin | away by 3 | 4842 | 1.0 / 1.0 | -0.0 | 1.1 / 1.0 | +0.1 | 0.1 | -31.3% |
| 75' level | margin | home by 1 | 4842 | 28.8 / 32.3 | -3.5 ** | 32.4 / 32.2 | +0.1 | 0.7 | -6.0% |
| 75' level | margin | home by 2 | 4842 | 6.0 / 6.4 | -0.5 | 5.6 / 5.7 | -0.1 | 0.3 | -1.2% |
| 75' level | margin | home by 3 | 4842 | 1.1 / 1.2 | -0.1 | 1.1 / 1.0 | +0.0 | 0.1 | 14.6% |
| 85' lead1 | margin | leader by 1 | 6406 | 86.0 / 86.4 | -0.4 | 85.9 / 86.2 | -0.3 | 0.4 | -5.7% |
| 85' lead1 | margin | leader by 2 | 6406 | 8.8 / 8.7 | +0.0 | 8.1 / 7.6 | +0.6 | 0.3 | -11.5% |
| 85' lead1 | margin | leader by 3 | 6406 | 0.6 / 0.8 | -0.2 | 0.5 / 0.9 | -0.3 | 0.1 | 68.0% |
| 85' lead1 | margin | trailer by 1 | 6406 | 1.5 / 1.8 | -0.3 | 2.3 / 2.4 | -0.1 | 0.2 | 5.7% |
| 85' lead1 | margin | trailer by 2 | 6406 | 0.3 / 0.4 | -0.1 | 0.5 / 0.4 | +0.1 | 0.1 | -2.5% |
| 85' lead1 | margin | trailer by 3 | 6406 | 0.1 / 0.1 | +0.0 | 0.1 / 0.1 | -0.0 | 0.0 | -13.0% |
| 85' lead2+ | margin | leader by 1 | 8226 | 2.5 / 3.3 | -0.8 | 4.2 / 3.8 | +0.4 | 0.2 | 1.0% |
| 85' lead2+ | margin | leader by 2 | 8226 | 40.2 / 38.7 | +1.5 | 39.7 / 40.3 | -0.5 | 0.5 | -4.5% |
| 85' lead2+ | margin | leader by 3 | 8226 | 29.0 / 28.7 | +0.4 | 28.4 / 28.3 | +0.1 | 0.5 | -0.7% |
| 85' lead2+ | margin | trailer by 1 | 8226 | 0.0 / 0.0 | -0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' lead2+ | margin | trailer by 2 | 8226 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' lead2+ | margin | trailer by 3 | 8226 | 0.0 / 0.0 | +0.0 | 0.0 / 0.0 | +0.0 | 0.0 | -100.0% |
| 85' level | margin | away by 1 | 4568 | 24.4 / 30.4 | -6.0 ** | 29.5 / 29.2 | +0.3 | 0.7 | -5.8% |
| 85' level | margin | away by 2 | 4568 | 5.1 / 5.4 | -0.3 | 5.2 / 4.9 | +0.3 | 0.3 | -2.0% |
| 85' level | margin | away by 3 | 4568 | 1.0 / 1.1 | -0.0 | 1.1 / 0.9 | +0.2 | 0.1 | -35.8% |
| 85' level | margin | home by 1 | 4568 | 24.6 / 29.7 | -5.1 ** | 29.7 / 30.1 | -0.4 | 0.7 | -5.2% |
| 85' level | margin | home by 2 | 4568 | 5.2 / 6.3 | -1.1 | 5.2 / 5.3 | -0.1 | 0.3 | -8.6% |
| 85' level | margin | home by 3 | 4568 | 1.1 / 1.2 | -0.1 | 1.1 / 1.2 | -0.0 | 0.2 | 20.6% |
| 60' lead1 | exact | +0-0 | 7615 | 35.5 / 33.4 | +2.1 | 31.1 / 30.7 | +0.5 | 0.5 |  |
| 60' lead1 | exact | +0-1 | 7615 | 5.6 / 3.3 | +2.3 | 4.1 / 4.4 | -0.3 | 0.2 |  |
| 60' lead1 | exact | +0-2 | 7615 | 6.7 / 7.8 | -1.1 | 8.5 / 8.2 | +0.3 | 0.3 |  |
| 60' lead1 | exact | +1-0 | 7615 | 20.9 / 18.8 | +2.2 | 17.1 / 17.3 | -0.2 | 0.4 |  |
| 60' lead1 | exact | +1-1 | 7615 | 10.9 / 13.0 | -2.0 | 14.3 / 15.0 | -0.7 | 0.4 |  |
| 60' lead1 | exact | +2-0 | 7615 | 7.1 / 7.7 | -0.7 | 7.1 / 7.3 | -0.2 | 0.3 |  |
| 60' lead1 | exact | other | 7615 | 13.4 / 16.1 | -2.8 | 17.7 / 17.0 | +0.7 | 0.4 |  |
| 60' lead2+ | exact | +0-0 | 6371 | 33.3 / 26.4 | +6.9 ** | 25.4 / 25.6 | -0.2 | 0.5 |  |
| 60' lead2+ | exact | +0-1 | 6371 | 11.8 / 12.0 | -0.2 | 14.2 / 14.4 | -0.2 | 0.4 |  |
| 60' lead2+ | exact | +0-2 | 6371 | 1.3 / 1.5 | -0.2 | 1.8 / 1.7 | +0.1 | 0.2 |  |
| 60' lead2+ | exact | +1-0 | 6371 | 24.3 / 24.5 | -0.2 | 22.1 / 21.6 | +0.5 | 0.5 |  |
| 60' lead2+ | exact | +1-1 | 6371 | 7.7 / 8.6 | -0.9 | 9.2 / 9.5 | -0.3 | 0.4 |  |
| 60' lead2+ | exact | +2-0 | 6371 | 10.0 / 11.7 | -1.7 | 10.5 / 10.1 | +0.3 | 0.4 |  |
| 60' lead2+ | exact | other | 6371 | 11.6 / 15.2 | -3.6 ** | 16.8 / 17.1 | -0.3 | 0.5 |  |
| 60' level | exact | +0-0 | 5214 | 13.1 / 8.2 | +4.9 ** | 8.1 / 8.5 | -0.3 | 0.4 |  |
| 60' level | exact | +0-1 | 5214 | 24.6 / 27.1 | -2.5 | 25.8 / 26.4 | -0.7 | 0.6 |  |
| 60' level | exact | +0-2 | 5214 | 7.2 / 7.4 | -0.3 | 6.5 / 6.2 | +0.3 | 0.3 |  |
| 60' level | exact | +1-0 | 5214 | 24.8 / 25.9 | -1.0 | 25.0 / 24.8 | +0.3 | 0.6 |  |
| 60' level | exact | +1-1 | 5214 | 5.8 / 4.9 | +0.9 | 5.8 / 5.8 | +0.0 | 0.3 |  |
| 60' level | exact | +2-0 | 5214 | 7.3 / 6.9 | +0.4 | 6.1 / 6.6 | -0.5 | 0.3 |  |
| 60' level | exact | other | 5214 | 17.2 / 19.7 | -2.4 | 22.7 / 21.7 | +0.9 | 0.6 |  |
| 75' lead1 | exact | +0-0 | 6653 | 59.6 / 59.1 | +0.5 | 56.2 / 55.6 | +0.6 | 0.6 |  |
| 75' lead1 | exact | +0-1 | 6653 | 4.7 / 2.7 | +1.9 | 3.6 / 3.6 | -0.0 | 0.2 |  |
| 75' lead1 | exact | +0-2 | 6653 | 4.0 / 4.9 | -0.9 | 5.7 / 5.4 | +0.3 | 0.3 |  |
| 75' lead1 | exact | +1-0 | 6653 | 17.7 / 16.6 | +1.1 | 15.4 / 15.3 | +0.1 | 0.4 |  |
| 75' lead1 | exact | +1-1 | 6653 | 5.8 / 7.0 | -1.2 | 8.3 / 8.8 | -0.5 | 0.3 |  |
| 75' lead1 | exact | +2-0 | 6653 | 3.0 / 3.8 | -0.8 | 3.2 / 3.5 | -0.3 | 0.2 |  |
| 75' lead1 | exact | other | 6653 | 5.3 / 6.0 | -0.7 | 7.7 / 7.8 | -0.1 | 0.3 |  |
| 75' lead2+ | exact | +0-0 | 7705 | 57.7 / 48.2 | +9.5 ** | 46.9 / 47.0 | -0.1 | 0.6 |  |
| 75' lead2+ | exact | +0-1 | 7705 | 10.2 / 12.1 | -2.0 | 14.5 / 14.7 | -0.2 | 0.4 |  |
| 75' lead2+ | exact | +0-2 | 7705 | 0.6 / 0.6 | -0.0 | 1.1 / 1.0 | +0.1 | 0.1 |  |
| 75' lead2+ | exact | +1-0 | 7705 | 21.4 / 24.6 | -3.2 ** | 22.6 / 22.6 | +0.0 | 0.5 |  |
| 75' lead2+ | exact | +1-1 | 7705 | 3.3 / 4.4 | -1.1 | 5.1 / 5.2 | -0.1 | 0.3 |  |
| 75' lead2+ | exact | +2-0 | 7705 | 4.4 / 6.3 | -1.9 | 5.7 / 5.5 | +0.2 | 0.3 |  |
| 75' lead2+ | exact | other | 7705 | 2.4 / 3.8 | -1.4 | 4.2 / 4.0 | +0.2 | 0.2 |  |
| 75' level | exact | +0-0 | 4842 | 21.9 / 13.3 | +8.7 ** | 13.3 / 13.6 | -0.3 | 0.5 |  |
| 75' level | exact | +0-1 | 4842 | 26.0 / 29.8 | -3.8 ** | 28.7 / 29.2 | -0.5 | 0.7 |  |
| 75' level | exact | +0-2 | 4842 | 5.3 / 5.7 | -0.4 | 5.1 / 5.1 | -0.0 | 0.3 |  |
| 75' level | exact | +1-0 | 4842 | 26.3 / 29.1 | -2.8 | 28.5 / 28.5 | -0.0 | 0.6 |  |
| 75' level | exact | +1-1 | 4842 | 6.1 / 5.6 | +0.4 | 6.8 / 6.6 | +0.2 | 0.4 |  |
| 75' level | exact | +2-0 | 4842 | 5.5 / 5.8 | -0.4 | 5.0 / 5.1 | -0.1 | 0.3 |  |
| 75' level | exact | other | 4842 | 8.9 / 10.6 | -1.7 | 12.7 / 11.8 | +0.9 | 0.5 |  |
| 85' lead1 | exact | +0-0 | 6406 | 84.1 / 84.5 | -0.4 | 83.3 / 83.5 | -0.2 | 0.5 |  |
| 85' lead1 | exact | +0-1 | 6406 | 2.2 / 1.2 | +1.0 | 1.6 / 1.7 | -0.1 | 0.2 |  |
| 85' lead1 | exact | +0-2 | 6406 | 1.3 / 1.6 | -0.3 | 2.0 / 2.0 | +0.0 | 0.2 |  |
| 85' lead1 | exact | +1-0 | 6406 | 8.4 / 8.4 | -0.0 | 7.6 / 7.1 | +0.6 | 0.3 |  |
| 85' lead1 | exact | +1-1 | 6406 | 1.7 / 1.7 | +0.0 | 2.4 / 2.4 | -0.1 | 0.2 |  |
| 85' lead1 | exact | +2-0 | 6406 | 0.5 / 0.7 | -0.2 | 0.4 / 0.7 | -0.3 | 0.1 |  |
| 85' lead1 | exact | other | 6406 | 1.8 / 1.9 | -0.1 | 2.7 / 2.7 | -0.0 | 0.2 |  |
| 85' lead2+ | exact | +0-0 | 8226 | 83.2 / 78.1 | +5.1 ** | 77.6 / 77.5 | +0.1 | 0.5 |  |
| 85' lead2+ | exact | +0-1 | 8226 | 4.8 / 6.3 | -1.5 | 7.6 / 7.6 | -0.0 | 0.3 |  |
| 85' lead2+ | exact | +0-2 | 8226 | 0.1 / 0.1 | +0.0 | 0.2 / 0.2 | +0.0 | 0.0 |  |
| 85' lead2+ | exact | +1-0 | 8226 | 10.5 / 13.5 | -3.0 | 12.7 / 13.0 | -0.3 | 0.4 |  |
| 85' lead2+ | exact | +1-1 | 8226 | 0.5 / 0.7 | -0.2 | 0.8 / 0.6 | +0.2 | 0.1 |  |
| 85' lead2+ | exact | +2-0 | 8226 | 0.7 / 1.1 | -0.4 | 0.9 / 1.0 | -0.1 | 0.1 |  |
| 85' lead2+ | exact | other | 8226 | 0.2 / 0.2 | -0.0 | 0.2 / 0.1 | +0.1 | 0.0 |  |
| 85' level | exact | +0-0 | 4568 | 30.7 / 18.1 | +12.6 ** | 18.3 / 18.6 | -0.3 | 0.6 |  |
| 85' level | exact | +0-1 | 4568 | 22.4 / 27.4 | -4.9 ** | 26.0 / 26.2 | -0.2 | 0.7 |  |
| 85' level | exact | +0-2 | 4568 | 4.7 / 5.0 | -0.3 | 4.7 / 4.4 | +0.2 | 0.3 |  |
| 85' level | exact | +1-0 | 4568 | 22.7 / 26.8 | -4.1 ** | 26.1 / 26.4 | -0.3 | 0.7 |  |
| 85' level | exact | +1-1 | 4568 | 7.0 / 6.8 | +0.2 | 8.5 / 8.6 | -0.1 | 0.4 |  |
| 85' level | exact | +2-0 | 4568 | 4.8 / 5.8 | -1.0 | 4.7 / 4.8 | -0.1 | 0.3 |  |
| 85' level | exact | other | 4568 | 7.6 / 10.1 | -2.5 | 11.7 / 11.1 | +0.6 | 0.5 |  |
| 60' fav leads | winner (fav view) | favourite | 10607 | 95.8 / 96.0 | -0.1 | 95.3 / 95.3 | +0.0 | 0.2 | -6.3% |
| 60' fav level | winner (fav view) | favourite | 5214 | 65.3 / 65.6 | -0.3 | 67.2 / 65.7 | +1.4 | 0.7 | -8.1% |
| 60' fav trails | winner (fav view) | favourite | 3379 | 20.4 / 22.5 | -2.1 | 25.8 / 25.2 | +0.6 | 0.7 | -10.0% |
| 75' fav leads | winner (fav view) | favourite | 11148 | 97.9 / 98.0 | -0.1 | 97.4 / 97.3 | +0.1 | 0.2 | -4.1% |
| 75' fav level | winner (fav view) | favourite | 4842 | 62.6 / 63.3 | -0.6 | 64.8 / 64.2 | +0.5 | 0.7 | -6.8% |
| 75' fav trails | winner (fav view) | favourite | 3210 | 10.8 / 11.7 | -0.9 | 14.8 / 13.6 | +1.1 | 0.6 | -24.7% |
| 85' fav leads | winner (fav view) | favourite | 11469 | 99.2 / 99.4 | -0.2 | 99.1 / 99.0 | +0.1 | 0.1 |  |
| 85' fav level | winner (fav view) | favourite | 4568 | 60.8 / 61.0 | -0.2 | 63.4 / 63.1 | +0.3 | 0.7 | -6.4% |
| 85' fav trails | winner (fav view) | favourite | 3163 | 3.8 / 4.1 | -0.3 | 5.3 / 4.9 | +0.4 | 0.4 | -32.2% |
| 60' fav leads | next_goal (fav view) | favourite | 10607 | 46.7 / 50.9 | -4.2 ** | 48.4 / 48.2 | +0.2 | 0.5 | -6.4% |
| 60' fav leads | next_goal (fav view) | underdog | 10607 | 19.6 / 19.7 | -0.2 | 23.3 / 23.6 | -0.3 | 0.4 | -4.9% |
| 60' fav level | next_goal (fav view) | favourite | 5214 | 57.0 / 60.5 | -3.5 ** | 60.9 / 59.8 | +1.0 | 0.7 | -7.8% |
| 60' fav level | next_goal (fav view) | underdog | 5214 | 29.8 / 31.3 | -1.5 | 31.0 / 31.7 | -0.7 | 0.6 | -3.4% |
| 60' fav trails | next_goal (fav view) | favourite | 3379 | 39.7 / 42.0 | -2.3 | 48.1 / 47.6 | +0.4 | 0.9 | -6.9% |
| 60' fav trails | next_goal (fav view) | underdog | 3379 | 23.7 / 25.4 | -1.7 | 22.7 / 23.5 | -0.8 | 0.7 | -2.4% |
| 75' fav leads | next_goal (fav view) | favourite | 11148 | 29.8 / 34.6 | -4.8 ** | 32.2 / 32.1 | +0.1 | 0.4 | -6.5% |
| 75' fav leads | next_goal (fav view) | underdog | 11148 | 12.3 / 13.4 | -1.1 | 17.0 / 17.3 | -0.4 | 0.4 | -3.5% |
| 75' fav level | next_goal (fav view) | favourite | 4842 | 50.9 / 55.9 | -5.0 ** | 57.0 / 56.1 | +0.9 | 0.7 | -7.5% |
| 75' fav level | next_goal (fav view) | underdog | 4842 | 27.2 / 30.8 | -3.6 ** | 29.7 / 30.2 | -0.5 | 0.7 | -3.5% |
| 75' fav trails | next_goal (fav view) | favourite | 3210 | 24.6 / 27.4 | -2.9 | 33.3 / 32.4 | +0.9 | 0.8 | -9.0% |
| 75' fav trails | next_goal (fav view) | underdog | 3210 | 14.9 / 15.8 | -0.9 | 14.4 / 15.4 | -1.0 | 0.6 | 2.6% |
| 85' fav leads | next_goal (fav view) | favourite | 11469 | 11.9 / 14.5 | -2.6 | 13.3 / 13.2 | +0.1 | 0.3 | -6.5% |
| 85' fav leads | next_goal (fav view) | underdog | 11469 | 4.8 / 5.4 | -0.6 | 6.9 / 7.0 | -0.1 | 0.2 | -5.1% |
| 85' fav level | next_goal (fav view) | favourite | 4568 | 45.0 / 51.8 | -6.8 ** | 53.3 / 53.2 | +0.2 | 0.7 | -6.3% |
| 85' fav level | next_goal (fav view) | underdog | 4568 | 24.3 / 30.1 | -5.8 ** | 28.3 / 28.2 | +0.1 | 0.7 | -5.6% |
| 85' fav trails | next_goal (fav view) | favourite | 3163 | 9.5 / 10.6 | -1.1 | 13.2 / 12.6 | +0.6 | 0.6 | -11.6% |
| 85' fav trails | next_goal (fav view) | underdog | 3163 | 5.8 / 6.1 | -0.2 | 5.8 / 6.4 | -0.6 | 0.4 | 1.9% |

</details>

<details>
<summary>Strength table (review F1): pooled 19,200 matches, #218 versus #219</summary>

| Minute, state | Market | Selection | n | #218: model / observed % | diff pp | #219: model / observed % | diff pp | SE pp | #219 bettor ROI |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 60' dog 15-25%, dog leads | winner (strength) | underdog | 614 | 72.1 / 69.0 | +3.1 ** | 66.9 / 68.7 | -1.8 | 1.9 | -3.2% |
| 60' dog 15-25%, dog level | winner (strength) | underdog | 1077 | 28.7 / 25.6 | +3.1 ** | 27.8 / 28.9 | -1.1 | 1.4 | -2.8% |
| 60' dog 15-25%, dog trails | winner (strength) | underdog | 2309 | 3.1 / 2.8 | +0.3 | 3.9 / 3.9 | +0.0 | 0.4 | -24.7% |
| 60' dog 25-50%, dog leads | winner (strength) | underdog | 2353 | 83.5 / 81.6 | +1.9 | 79.6 / 79.5 | +0.1 | 0.8 | -6.6% |
| 60' dog 25-50%, dog level | winner (strength) | underdog | 2991 | 41.0 / 41.8 | -0.8 | 40.5 / 41.6 | -1.1 | 0.9 | -3.8% |
| 60' dog 25-50%, dog trails | winner (strength) | underdog | 4096 | 7.0 / 7.1 | -0.1 | 8.5 / 8.5 | -0.0 | 0.4 | -7.3% |
| 60' dog<15%, dog leads | winner (strength) | underdog | 412 | 60.1 / 57.8 | +2.3 | 54.0 / 57.0 | -3.1 ** | 2.4 | -0.4% |
| 60' dog<15%, dog level | winner (strength) | underdog | 1146 | 19.1 / 18.0 | +1.1 | 17.7 / 20.2 | -2.6 | 1.2 | 7.6% |
| 60' dog<15%, dog trails | winner (strength) | underdog | 4202 | 1.2 / 0.9 | +0.3 | 1.4 / 1.3 | +0.1 | 0.2 | -21.4% |
| 75' dog 15-25%, dog leads | winner (strength) | underdog | 534 | 84.7 / 82.7 | +2.0 | 80.7 / 83.1 | -2.4 | 1.6 | -3.2% |
| 75' dog 15-25%, dog level | winner (strength) | underdog | 1013 | 31.6 / 28.9 | +2.7 | 30.4 / 31.5 | -1.1 | 1.5 | -3.6% |
| 75' dog 15-25%, dog trails | winner (strength) | underdog | 2453 | 1.6 / 1.3 | +0.3 | 2.2 / 2.4 | -0.2 | 0.3 | -30.8% |
| 75' dog 25-50%, dog leads | winner (strength) | underdog | 2317 | 91.3 / 90.7 | +0.6 | 88.4 / 89.1 | -0.7 | 0.6 | -5.3% |
| 75' dog 25-50%, dog level | winner (strength) | underdog | 2866 | 42.4 / 42.6 | -0.2 | 41.7 / 41.5 | +0.2 | 0.9 | -6.7% |
| 75' dog 25-50%, dog trails | winner (strength) | underdog | 4257 | 3.5 / 3.5 | -0.0 | 4.7 / 5.0 | -0.2 | 0.3 | -3.6% |
| 75' dog<15%, dog leads | winner (strength) | underdog | 359 | 77.7 / 75.5 | +2.2 | 70.9 / 73.3 | -2.3 | 2.3 | -2.1% |
| 75' dog<15%, dog level | winner (strength) | underdog | 963 | 23.1 / 21.2 | +1.9 | 21.1 / 23.2 | -2.1 | 1.4 | 3.6% |
| 75' dog<15%, dog trails | winner (strength) | underdog | 4438 | 0.6 / 0.6 | +0.0 | 0.8 / 0.8 | +0.0 | 0.1 | -25.8% |
| 85' dog 15-25%, dog leads | winner (strength) | underdog | 519 | 94.7 / 94.1 | +0.5 | 93.0 / 95.0 | -2.0 | 1.0 | -1.1% |
| 85' dog 15-25%, dog level | winner (strength) | underdog | 954 | 34.0 / 32.0 | +1.9 | 32.0 / 32.4 | -0.4 | 1.5 | -5.9% |
| 85' dog 15-25%, dog trails | winner (strength) | underdog | 2527 | 0.6 / 0.3 | +0.3 | 0.8 / 0.8 | -0.0 | 0.2 | -7.3% |
| 85' dog 25-50%, dog leads | winner (strength) | underdog | 2307 | 96.9 / 96.7 | +0.2 | 95.9 / 95.9 | +0.1 | 0.4 | 5.8% |
| 85' dog 25-50%, dog level | winner (strength) | underdog | 2759 | 43.4 / 44.1 | -0.7 | 42.5 / 42.5 | -0.0 | 0.9 | -6.2% |
| 85' dog 25-50%, dog trails | winner (strength) | underdog | 4374 | 1.2 / 1.1 | +0.2 | 1.7 / 1.9 | -0.2 | 0.2 | 4.6% |
| 85' dog<15%, dog leads | winner (strength) | underdog | 337 | 91.7 / 90.8 | +0.9 | 89.3 / 89.9 | -0.6 | 1.6 | -5.9% |
| 85' dog<15%, dog level | winner (strength) | underdog | 855 | 26.1 / 24.3 | +1.8 | 23.1 / 24.0 | -0.9 | 1.5 | -2.8% |
| 85' dog<15%, dog trails | winner (strength) | underdog | 4568 | 0.2 / 0.2 | +0.0 | 0.3 / 0.3 | -0.0 | 0.1 | 4.7% |
| 60' dog 15-25%, dog leads | next_goal (strength) | favourite | 614 | 46.7 / 46.6 | +0.1 | 54.1 / 54.6 | -0.4 | 2.0 | -5.2% |
| 60' dog 15-25%, dog leads | next_goal (strength) | underdog | 614 | 19.1 / 21.3 | -2.2 | 18.5 / 18.7 | -0.2 | 1.6 | -4.5% |
| 60' dog 15-25%, dog level | next_goal (strength) | favourite | 1077 | 62.9 / 67.5 | -4.6 ** | 65.4 / 65.4 | +0.0 | 1.4 | -6.1% |
| 60' dog 15-25%, dog level | next_goal (strength) | underdog | 1077 | 25.1 / 24.5 | +0.5 | 27.1 / 26.4 | +0.7 | 1.3 | -8.8% |
| 60' dog 15-25%, dog trails | next_goal (strength) | favourite | 2309 | 47.5 / 51.3 | -3.8 ** | 47.3 / 46.8 | +0.5 | 1.0 | -7.1% |
| 60' dog 15-25%, dog trails | next_goal (strength) | underdog | 2309 | 18.5 / 18.6 | -0.1 | 23.4 / 22.4 | +1.0 | 0.9 | -10.2% |
| 60' dog 25-50%, dog leads | next_goal (strength) | favourite | 2353 | 36.2 / 39.2 | -3.0 | 43.6 / 43.0 | +0.7 | 1.0 | -7.5% |
| 60' dog 25-50%, dog leads | next_goal (strength) | underdog | 2353 | 25.8 / 27.8 | -2.0 | 25.5 / 26.3 | -0.8 | 0.9 | -3.6% |
| 60' dog 25-50%, dog level | next_goal (strength) | favourite | 2991 | 50.7 / 53.9 | -3.2 ** | 53.5 / 52.6 | +0.9 | 0.9 | -7.8% |
| 60' dog 25-50%, dog level | next_goal (strength) | underdog | 2991 | 34.7 / 37.2 | -2.5 | 37.1 / 37.6 | -0.5 | 0.9 | -5.2% |
| 60' dog 25-50%, dog trails | next_goal (strength) | favourite | 4096 | 37.5 / 41.1 | -3.6 ** | 37.4 / 36.9 | +0.5 | 0.8 | -7.1% |
| 60' dog 25-50%, dog trails | next_goal (strength) | underdog | 4096 | 25.0 / 25.3 | -0.3 | 31.0 / 32.1 | -1.1 | 0.7 | -2.3% |
| 60' dog<15%, dog leads | next_goal (strength) | favourite | 412 | 56.4 / 57.5 | -1.1 | 64.2 / 64.1 | +0.1 | 2.4 | -6.1% |
| 60' dog<15%, dog leads | next_goal (strength) | underdog | 412 | 13.9 / 13.0 | +1.0 | 13.0 / 14.5 | -1.5 | 1.7 | 7.7% |
| 60' dog<15%, dog level | next_goal (strength) | favourite | 1146 | 73.4 / 76.3 | -2.9 | 75.7 / 73.3 | +2.4 | 1.3 | -9.1% |
| 60' dog<15%, dog level | next_goal (strength) | underdog | 1146 | 17.9 / 17.9 | -0.0 | 18.7 / 21.3 | -2.6 | 1.2 | 6.1% |
| 60' dog<15%, dog trails | next_goal (strength) | favourite | 4202 | 58.3 / 63.8 | -5.5 ** | 59.6 / 60.0 | -0.4 | 0.8 | -5.4% |
| 60' dog<15%, dog trails | next_goal (strength) | underdog | 4202 | 13.1 / 13.2 | -0.0 | 15.8 / 16.0 | -0.1 | 0.6 | -4.6% |
| 75' dog 15-25%, dog leads | next_goal (strength) | favourite | 534 | 29.2 / 29.0 | +0.2 | 37.8 / 37.8 | -0.0 | 2.1 | -6.5% |
| 75' dog 15-25%, dog leads | next_goal (strength) | underdog | 534 | 12.0 / 14.1 | -2.1 | 11.6 / 12.2 | -0.5 | 1.4 | -1.2% |
| 75' dog 15-25%, dog level | next_goal (strength) | favourite | 1013 | 57.1 / 62.8 | -5.7 ** | 61.8 / 60.1 | +1.7 | 1.5 | -8.7% |
| 75' dog 15-25%, dog level | next_goal (strength) | underdog | 1013 | 22.6 / 24.6 | -1.9 | 25.8 / 27.4 | -1.6 | 1.4 | -1.0% |
| 75' dog 15-25%, dog trails | next_goal (strength) | favourite | 2453 | 30.1 / 34.8 | -4.7 ** | 31.0 / 30.4 | +0.6 | 0.9 | -8.1% |
| 75' dog 15-25%, dog trails | next_goal (strength) | underdog | 2453 | 11.7 / 13.2 | -1.6 | 17.1 / 16.9 | +0.2 | 0.8 | -6.6% |
| 75' dog 25-50%, dog leads | next_goal (strength) | favourite | 2317 | 22.4 / 25.7 | -3.3 ** | 30.4 / 29.3 | +1.1 | 0.9 | -9.7% |
| 75' dog 25-50%, dog leads | next_goal (strength) | underdog | 2317 | 16.0 / 17.0 | -1.0 | 16.0 / 16.7 | -0.7 | 0.8 | -2.5% |
| 75' dog 25-50%, dog level | next_goal (strength) | favourite | 2866 | 45.3 / 49.6 | -4.4 ** | 50.3 / 50.0 | +0.3 | 0.9 | -6.7% |
| 75' dog 25-50%, dog level | next_goal (strength) | underdog | 2866 | 31.1 / 36.0 | -4.9 ** | 35.0 / 34.4 | +0.6 | 0.9 | -7.7% |
| 75' dog 25-50%, dog trails | next_goal (strength) | favourite | 4257 | 23.4 / 26.0 | -2.6 | 23.8 / 23.4 | +0.5 | 0.6 | -7.5% |
| 75' dog 25-50%, dog trails | next_goal (strength) | underdog | 4257 | 15.5 / 16.9 | -1.5 | 21.9 / 22.6 | -0.7 | 0.6 | -2.5% |
| 75' dog<15%, dog leads | next_goal (strength) | favourite | 359 | 36.4 / 40.3 | -3.9 ** | 45.3 / 44.3 | +1.0 | 2.6 | -8.2% |
| 75' dog<15%, dog leads | next_goal (strength) | underdog | 359 | 9.1 / 7.7 | +1.4 | 8.3 / 12.3 | -3.9 ** | 1.7 | 40.6% |
| 75' dog<15%, dog level | next_goal (strength) | favourite | 963 | 67.3 / 74.3 | -7.0 ** | 71.9 / 70.2 | +1.7 | 1.5 | -8.3% |
| 75' dog<15%, dog level | next_goal (strength) | underdog | 963 | 16.6 / 16.2 | +0.4 | 18.2 / 20.6 | -2.3 | 1.3 | 6.2% |
| 75' dog<15%, dog trails | next_goal (strength) | favourite | 4438 | 38.2 / 45.7 | -7.5 ** | 40.9 / 41.4 | -0.5 | 0.7 | -4.7% |
| 75' dog<15%, dog trails | next_goal (strength) | underdog | 4438 | 8.5 / 8.7 | -0.2 | 12.1 / 12.4 | -0.3 | 0.5 | -2.8% |
| 85' dog 15-25%, dog leads | next_goal (strength) | favourite | 519 | 11.4 / 11.2 | +0.2 | 15.1 / 14.5 | +0.6 | 1.5 | -11.3% |
| 85' dog 15-25%, dog leads | next_goal (strength) | underdog | 519 | 4.7 / 5.2 | -0.5 | 4.7 / 5.2 | -0.5 | 1.0 | 2.5% |
| 85' dog 15-25%, dog level | next_goal (strength) | favourite | 954 | 50.9 / 58.1 | -7.2 ** | 58.2 / 57.2 | +1.0 | 1.6 | -7.7% |
| 85' dog 15-25%, dog level | next_goal (strength) | underdog | 954 | 20.3 / 24.9 | -4.6 ** | 24.4 / 25.4 | -1.0 | 1.4 | -3.2% |
| 85' dog 15-25%, dog trails | next_goal (strength) | favourite | 2527 | 11.9 / 14.5 | -2.7 | 12.6 / 13.1 | -0.5 | 0.7 | -2.6% |
| 85' dog 15-25%, dog trails | next_goal (strength) | underdog | 2527 | 4.6 / 5.6 | -1.0 | 7.0 / 6.3 | +0.6 | 0.5 | -14.0% |
| 85' dog 25-50%, dog leads | next_goal (strength) | favourite | 2307 | 8.7 / 9.7 | -1.0 | 12.0 / 11.2 | +0.8 | 0.7 | -12.7% |
| 85' dog 25-50%, dog leads | next_goal (strength) | underdog | 2307 | 6.2 / 6.5 | -0.3 | 6.4 / 6.8 | -0.5 | 0.5 | -2.4% |
| 85' dog 25-50%, dog level | next_goal (strength) | favourite | 2759 | 40.0 / 46.3 | -6.3 ** | 47.1 / 47.3 | -0.3 | 1.0 | -5.7% |
| 85' dog 25-50%, dog level | next_goal (strength) | underdog | 2759 | 27.5 / 34.5 | -7.0 ** | 33.0 / 32.1 | +0.9 | 0.9 | -8.8% |
| 85' dog 25-50%, dog trails | next_goal (strength) | favourite | 4374 | 9.1 / 10.3 | -1.2 | 9.5 / 9.5 | +0.0 | 0.4 | -6.4% |
| 85' dog 25-50%, dog trails | next_goal (strength) | underdog | 4374 | 6.0 / 6.6 | -0.6 | 8.7 / 9.2 | -0.5 | 0.4 | -0.7% |
| 85' dog<15%, dog leads | next_goal (strength) | favourite | 337 | 14.6 / 18.8 | -4.2 ** | 18.7 / 19.0 | -0.3 | 2.1 | -4.5% |
| 85' dog<15%, dog leads | next_goal (strength) | underdog | 337 | 3.7 / 2.8 | +0.9 | 3.5 / 5.4 | -1.9 | 1.2 | 30.5% |
| 85' dog<15%, dog level | next_goal (strength) | favourite | 855 | 60.6 / 69.5 | -8.9 ** | 68.1 / 67.6 | +0.5 | 1.6 | -6.8% |
| 85' dog<15%, dog level | next_goal (strength) | underdog | 855 | 15.0 / 16.0 | -1.0 | 17.4 / 18.8 | -1.4 | 1.3 | 1.9% |
| 85' dog<15%, dog trails | next_goal (strength) | favourite | 4568 | 15.5 / 20.1 | -4.6 ** | 17.3 / 16.7 | +0.6 | 0.6 | -8.6% |
| 85' dog<15%, dog trails | next_goal (strength) | underdog | 4568 | 3.4 / 3.7 | -0.3 | 5.1 / 5.3 | -0.2 | 0.3 | -4.4% |

</details>

<details>
<summary>Pre-match table: pooled 19,200 matches, #218 versus #219</summary>

| Minute, state | Market | Selection | n | #218: model / observed % | diff pp | #219: model / observed % | diff pp | SE pp | #219 bettor ROI |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0' pre-match, dog 15-25% | winner (pre-match) | favourite | 4000 | 80.2 / 83.0 | -2.8 | 80.3 / 79.5 | +0.8 | 0.6 | -7.1% |
| 0' pre-match, dog 15-25% | winner (pre-match) | underdog | 4000 | 19.8 / 16.9 | +2.9 | 19.7 / 20.5 | -0.9 | 0.6 | -2.7% |
| 0' pre-match, dog 25-35% | winner (pre-match) | favourite | 4000 | 70.4 / 71.6 | -1.2 | 70.1 / 70.0 | +0.0 | 0.7 | -6.1% |
| 0' pre-match, dog 25-35% | winner (pre-match) | underdog | 4000 | 29.6 / 28.4 | +1.2 | 29.9 / 29.9 | -0.1 | 0.7 | -5.9% |
| 0' pre-match, dog 35-45% | winner (pre-match) | favourite | 4320 | 60.0 / 59.5 | +0.5 | 60.3 / 60.2 | +0.1 | 0.7 | -6.3% |
| 0' pre-match, dog 35-45% | winner (pre-match) | underdog | 4320 | 40.0 / 40.5 | -0.5 | 39.7 / 39.9 | -0.2 | 0.7 | -5.6% |
| 0' pre-match, dog 45-50% | winner (pre-match) | favourite | 1120 | 52.1 / 53.8 | -1.6 | 53.1 / 51.4 | +1.7 | 1.5 | -9.1% |
| 0' pre-match, dog 45-50% | winner (pre-match) | underdog | 1120 | 47.9 / 46.3 | +1.6 | 46.9 / 48.5 | -1.7 | 1.5 | -2.6% |
| 0' pre-match, dog <15% | winner (pre-match) | favourite | 5760 | 91.0 / 92.0 | -1.0 | 91.5 / 90.9 | +0.6 | 0.4 | -5.8% |
| 0' pre-match, dog <15% | winner (pre-match) | underdog | 5760 | 9.0 / 8.0 | +1.0 | 8.5 / 9.1 | -0.6 | 0.4 | -1.2% |

</details>

### Odds cost in PocketBase's VM (#219 review F2)

These are timings in goja (PocketBase 0.28.4), from the review's hook: `onBootstrap` timing loops over the real hook
modules, run with `pocketbase migrate up` on a scratch data dir. "Cold" clears the odds cache before each call. "Warm"
repeats the call; what the polled endpoints see after their first request is warm.

| Call | #218 | #219 before the fixes | #219 now, warm | #219 now, cold |
|---|---:|---:|---:|---:|
| `fixtureMarkets` pre-match (MarketsPanel) | 3.1–3.2 ms | 37 ms | **0.2 ms** | 7.3 ms |
| `fixtureMarkets` in play, a new minute each call (context cached) | 2.7 ms | (`finalDist` at 60′ alone: 15.8 ms) | **4.1 ms** | 7.2 ms |
| fixture card qualify (`finalDist(..., noDist)`) | 0.16–0.19 ms | 6.4 ms | **0.02–0.18 ms** | 2.8–3.2 ms |
| `pairModel` (`inPlayModel`) | 0.32 ms | 14.7 ms | 1.7 ms | 1.7 ms |
| `championshipOdds`-style 120 pairings (`pairModel` + `pairQualify`) | 59 ms | 2,560 ms | — | **542–561 ms** |

`finalDist` with a full distribution, staged model, is the reference walk: 35 ms. Nothing on a polled path calls it any
more (`fixtureMarkets` uses `marketProbs`; `fixturePrices` and `exactPrice` are unused). Scripts and tests do.

- **Met:** the polled paths are within the targets once warm.
  - MarketsPanel pre-match: 0.2 ms (target ≤ ~6 ms).
  - Fixture cards: ≤ 0.2 ms (target ≤ ~0.5 ms).
- **Above #218:** an in-play `fixtureMarkets` for a new minute takes 4.1 ms, against #218's 2.7 ms.
- **Not met: the championship odds,** about 550 ms against the ≤ ~150 ms target (#218: 59 ms). They run once a tournament, when
  the R16 round is created, inside its transaction. The 120 pairings are all distinct, so nothing is cached. Each costs
  about 4.5 ms: `pairModel` 1.7, the context 0.8, the value tables 2.0. Options for the lead:
  - accept about 0.5 s once per tournament;
  - price the champion and semi-finalist markets from the kickoff rates only (the legacy constant-rate qualify, about
    60 ms), at the cost of those markets' late-game calibration;
  - compute them outside the R16 transaction.

### Live view: `harness/view-stats.mjs --matches 200`, 60 fps, 100 ms samples

Re-run after the review fixes; identical, since they change no engine output.

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

Screenshots were taken from the real MatchPage build, headless Chromium, at 1280×800 and 390×844. The mocked API serves
real engine events, published by time as the server does, and the real market catalogue (`markets.fixtureMarkets` with
the fixture's `inPlayModel`). The files are in `ff-wt/media/219/`:
- `after-counter-{desktop,mobile}-{1-break,2-pass,3-progression,4-shot}.png`: a counter-attack.
- `after-rebound-{desktop,mobile}-{1-parry,2-rebound-shot,3-result}.png`: a rebound.
  - `3-result` was retaken (review F5): it now shows the result, WIDE, 0.9 s into its scene.
- `after-rebound-{desktop,mobile}-0-markets-suspended.png`: the market panel is suspended while the parried save and the
  rebound are in progress (taken about 1.1 s before the rebound's result is published). The pitch is still drawing the
  move about 1.5 s behind, as the live view always is; the mobile shot is full-page, so the panel is visible.

There is no "before": main and #218 have neither counters nor rebounds.

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
  - the in-play model: its structure (states × sample minutes, fatigue narrowing the gap, rates equal to goalRates at
    each sample minute); that a managed side keeps its stance; coherent distributions from every phase; that the
    next-goal "none" equals the current exact score; that the market catalogue prices from it; that a legacy model is
    priced as before;
  - fast paths equal to the reference walk: every market probability (qualify, the exact-score cells, margins and next
    goal) within 1e-9, cold and cached, over 5 pairings × 13 states (pre-match, both halves, the chase, full time, extra
    time, red cards);
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

- **Manager-run sides** (review F3; this predates the branch, and is not fixed here).
  - How they are priced: a side its manager runs is priced at its kickoff stance in every game state, because the
    published state does not carry the current stance.
  - The exploit: a manager's stance change is published as a coaching row, so a bettor can react to it before the price
    does. In the review's simulation, the bettor waits for a managed side's switch to Attack when trailing, then backs
    "next goal: the opponent". That returns **+10.7%** with the old constant-rate model and **+18.5%** with this branch's
    model. The model now prices the AI policy's late states, which makes the gap to a manager's actual stance larger.
  - Calibration covers AI sides only, since all the simulated fixtures are AI-run.
  - A fix needs the current stance in the published state, or coaching rows fed into the price, which is a separate change.
- **In-play big underdogs** (review F1 residual). Pre-match prices are calibrated by strength, and every underdog ROI is ≤ 0.
  In play, a < 15% underdog that is level or ahead is still priced 1–3 pp low in most cells (2 of 81 strength cells are
  just outside ±3 pp), and those bets return more than the margin. See "In play, by strength" for the figures and the
  diagnostics; the remaining cause is not identified.
- **Approximations in the model.**
  - Each minute's rates are stationary-chain averages for that game state.
  - The counter-flag reset at half-time and the minute already in progress (priced as a whole minute) are not modelled.
  - Fatigue is interpolated between 0, 60 and 120 minutes of wear (within 0.2% of the exact per-minute rates).
  - Before the chase, goals are Poisson. The engine allows one goal a minute, so this slightly overstates the spread of
    early goals.
  - The calibration residuals above include all of these.
- **Championship odds** take about 0.5 s in PocketBase's VM, against a target of ~150 ms; see the odds-cost section.
- **Sample sizes.** The issue's 1,000-match criterion was run at 4,800 per seed set, and pooled over 19,200 for the odds.
