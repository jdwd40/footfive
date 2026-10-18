# Tactical balance (#133)

This is an intentional balance change. Seeded outcomes can differ from the old
configuration; repeating or resuming a match with the same configuration must
still produce identical state and events.

## Mechanics

Stance now changes match tempo rather than multiplying individual attack and
defence. Both teams' tempo terms enter both attacking edges:

```
edge(side) = attack(side) - defence(opponent) + edgeOffset
             + tempo(home stance) + tempo(away stance)
```

Attack contributes +22, Balanced 0 and Defend -22. Attack creates more chances
at both ends; Defend reduces chances at both ends. Opposing stances cancel their
tempo contributions. The existing stance foul factors remain 1.15/1.0/0.9.
Stance no longer changes possession through a weighted player-strength bonus.
The engine and the kickoff odds model use the same `chanceModel`/`goalRates`
path. This is a risk/reward choice, not a promised win-probability bonus.

Intensity still changes individual performance and wear. Aggressive attack and
defence multipliers are 1.25/1.0, Passive 0.8/0.95, and Balanced remains 1/1.
Energy drain and condition wear are unchanged: Aggressive buys immediate
pressure with more wear; Passive saves fitness at an immediate performance cost.
Overclock, fitness curves, purchase costs and timing are unchanged by #133.

## Calibration status — 2026-10-18

The numerical results recorded below and in the original #133 / PR #144
experiments were measured before #134 (Overclock) and #135 (fitness and upgrade
prices). They describe that earlier configuration. The combined effect of
#133, #134 and #135 has not been re-checked with many-seed simulations; in
particular, the earlier intensity and coaching effect sizes are not validated
for the current combination. A fresh balance check on main is planned after
PR #150 merges.

## Calibration method

`scripts/balance-calibrate.mjs` uses explicit manual teams, both orientations
and paired seeds. Each team has grade B, seven players, five starters with roles
GK/DEF/MID/MID/ATT, and initial energy/condition 100. The subject has attack and
defence 70. Opponents are peer 70/70, strong attack 90/70, or strong defence
70/90. These controlled fixtures are independent of the historical
`/workspace/mgmt-sim` analysis, whose inputs were unavailable; the historical
percentages are not claimed as reproduced.

Kickoff variants change one dimension at a time. Coaching variants branch from
the exact same naturally reached Balanced minute-70 state, grouped by its real
leading/tied/trailing score. Changes use `queueStance` and must emit their one
manager event at minute 71. Balanced coaching is a no-op. Advancement includes
extra time and penalties; goals are regulation-only. Other metrics include extra
time. Paired 95% intervals use independent seed blocks, with orientations
averaged inside each block; pooled Wilson intervals are descriptive only.

The initial sample used 128 seeds (1000–1127), 6,144 completed outcomes per
configuration. Two candidates were screened: tempo 22 and 30, both with the
selected intensity values. Tempo 22 was selected before the held-out run. It
gave a smaller change to AI scoring and shootouts than tempo 30. Analytical
goal-rate calculations informed screening but are not simulated win rates.

The fixed held-out evaluation uses 2,000 fresh seeds (10000–11999), 96,000
completed outcomes per configuration, with an immutable baseline and selected
candidate run once each. The PR records the resulting paired estimates,
uncertainty, score-stratum sample sizes and artifact identifiers. Those seeds
are not used to select or tune the candidate.

## Additional checks and limits

In the pilot, all 1,536 Balanced manual control rows matched the baseline's
event hash, final-state hash and RNG draw count. Equal manual teams under a
static stance have a 50/50 mirrored advancement split by symmetry; this alone
does not measure situational coaching value.

An additional 2,000-match authored-team AI calibration gave:

| Metric | Baseline | Selected tempo 22 | Screened tempo 30 |
| --- | ---: | ---: | ---: |
| Goals per 90 | 2.10 | 2.17 | 2.21 |
| Extra-time share | 0.264 | 0.266 | 0.265 |
| Shootout share | 0.131 | 0.101 | 0.088 |
| Favourite wins | 0.79 | 0.79 | 0.79 |

AI teams already attack when tied in extra time, so the stronger tempo effect
settles more of those matches before penalties. These AI fixtures are an
additional distribution check, not a substitute for the manual experiments.
These are historical measurements from before #134 and #135, as noted above.
Current combined fitness, intensity and Overclock effects still need the
post-merge balance check.

For repeatability/resume checks, run:

```sh
npm run test:balance-replay
node scripts/balance-calibrate.mjs --seeds 2000 --seed-start 10000 --output /tmp/balance-heldout.json
# Compare immutable baseline/current hook copies with the same inputs:
node scripts/balance-calibrate.mjs --hooks /absolute/baseline/pb_hooks --seeds 2000 --seed-start 10000 --output /tmp/balance-baseline.json
```

The replay suite runs 200 seeds across 400 configurations and 1,200 executions:
fresh runs, exact repeats and JSON-persisted incremental resumes. It compares
scores, statistics, RNG, state and the complete event stream, and checks event
ordering, future coaching, resource bounds and match completion. No RNG call
sites were added or removed for this change.

## Live rollout

No schema or state-version migration is needed. An ongoing v2 match uses the
new coefficients for future minutes after the normal deployment reload; its
published history and finished results are not rewritten. Stored kickoff
`model_json` and existing tournament qualification prices remain their original
snapshots. They are not retroactively repriced by this change. New kickoff
models use the new chance model. There is no claim that old frozen prices
reflect the new coefficients or later tactical changes.
