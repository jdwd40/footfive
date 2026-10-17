# Fitness and investment balance (#135)

Fitness still affects performance, but it no longer overwhelms a player's base
attributes as strongly. The energy and condition multipliers now each use
`1 - 0.35 * (1 - value / 100)`. Full fitness is still 1; either axis alone has a
floor of 0.65. Energy 60 gives 0.86 instead of 0.74; condition 50 gives 0.825
instead of 0.65. The two factors still multiply. Existing input clamps, defaults,
role weights, intensity, grade contribution and sent-off behavior remain.

The effective-stats library and AI lineup selection use this same fitness
policy. The selection algorithm, role constraints, sort order and tie handling are
unchanged; a fatigued player's ranking can change because fitness weighs less.
The engine, squad/scouting estimates and new kickoff prices use the shared
library. Drain, persistent wear, natural regeneration, repair amounts, Command
Charge effects and Overclock's 1.12 bonus/eight-energy cost are unchanged.

## Upgrades and batteries

Upgrades still add **one** attribute point per purchase, with the same cap. The
base price remains 80, while price growth falls from 1.08 to 1.04. At attribute
70, one upgrade costs 259 instead of 805 credits. Ten points on each of three
70-rated players require 30 purchases: 9,330 instead of 34,974 credits (73% less).
This improves return per credit; it is not a claim that a stored point has been
multiplied or that a full campaign economy has been proved balanced. Prices
apply prospectively. Existing attributes, treasury balances and past purchases
are not rewritten or refunded.

The issue's full-battery claim was already out of date on the starting commit.
A battery already restores **up to 40 energy to one player**, capped at 100,
transactionally, consuming one inventory item. Its price remains 180. Battery
runtime behavior is preserved and tested against real PocketBase, including
full/regen-full rejection, ownership, inventory and rollback. The page now reads
the restore amount from API metadata, names the cap, and reports the reloaded
energy instead of calculating a promised gain in the browser. Older servers
without that metadata get generic partial-restoration copy. Empty inventory and
full-energy targets disable the button.

## Calibration

Reuse the real-engine controlled fixtures from #134: manual Balanced grade-B
subject 70/70 against peer 70/70, attack-heavy 90/70 and defence-heavy 70/90,
both orientations. This is not a replication of the issue author's management
simulation. The eight variants are full fitness, energy 60, condition 50,
+10 attack on starters 2/3/4, +10 defence on starters 0/1/2, energy 20, paid
Overclock at full fitness, and paid Overclock at energy 60. All other attributes
stay fixed. Opponents begin at full fitness. Overclock pays eight from the five
actual starters before `createMatch`, never from the reserves.

Energy/condition scenarios set all seven players' health. Reserves are inactive
and do not contribute to strength or the reported final starter fitness. The
energy-20 versus energy-60 comparison prices five batteries (900 credits) for
the five active players; it is a performance comparison, not a replay of seven
inventory operations. Actual single-player battery behavior is covered by the
PocketBase tests.

Each seed produces 48 outcomes. Differences pair treatment/control within an
orientation, average the two orientations within the seed, then calculate a
normal 95% interval across seed blocks. Advancement includes extra time and
penalties; regulation goals stop at minute 90. Shots/final fitness include extra
time. No multiple-comparison correction is claimed. Report all profiles and
comparisons, including uncertain or disappointing results.

The plan screened at most three 128-seed pilots (1000–1127), with fitness
impacts 0.45, 0.35 and 0.25. Choose the largest impact (least flattening) plausibly
reducing the fitness penalty substantially, with roughly 35% reduction as a
guideline and a clearly negative remaining penalty. Keep useful upgrade returns
and check paid Overclock. The selected 0.35 was frozen before the final sample:
0.45 was too weak; 0.35 was plausible analytically and in the peer/attack-heavy
pilots; the defence-heavy pilot remained inconclusive. Do not increase tuning
merely to force small-sample significance. The pilot does not prove every group
meets the guideline.

Final evidence is baseline versus selected, each run once over 2,000 different
seeds (30000–31999), 96,000 outcomes per report. No retuning or resampling against
this heldout sample. Numeric results, report hashes, deviations and uncertainty
are attached to the PR. The CLI stores raw outcomes and source hashes; keep
large JSON reports out of Git.

```sh
node scripts/fitness-calibrate.mjs --hooks /absolute/pb_hooks \
  --seeds 2000 --seed-start 30000 --output /tmp/fitness-report.json
```

The authored fresh-team AI calibration is a drift check, not a campaign test:
2,000 matches per source gave goals/90 2.10 to 2.10, extra-time share 0.264 to
0.269, shootouts 0.131 to 0.135, favourite wins 0.79 to 0.79, reds 0.17 to 0.17.
Live teams carry fatigue across rounds and can therefore change more. Lower
fitness penalties also reduce the value of repairs, batteries, Command Charge
fitness actions and conserving energy, and increase the net value of Overclock.
Those interactions are consequences of this proposal, not separate retunes.

## Determinism and rollout

No `rnd(st)` call site, RNG implementation or match-engine source changes are
needed. Old/new seeded outcomes deliberately differ. Keep fixed-input golden
coverage by documenting and repinning its exact manifests, preserving the same
200 inputs, projection and assertions. The event/final-state projection changed
from `eef854d6…` to `ea5b06fd…`, full payload/state from `e8da709c…` to
`318ca545…`, and stepwise state from `8014fab6…` to `617b66e6…`. Actual
draw counts can differ between old and new play; the RNG code is unchanged.
New-policy repeat and JSON-resume tests
must reproduce scores, stats, events, RNG and full state, with event/resource
invariants retained.

Stored energy, condition and attributes keep their values. An ongoing `v2` match
uses the new factors for future minutes; prior events and finished results are
unchanged. Existing frozen kickoff and tournament market prices are not repriced.
New kickoffs price the new factors. No schema migration or state-version change
is needed. This does not restore the reverted #133 tactics model.
