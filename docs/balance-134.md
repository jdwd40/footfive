# Overclock balance (#134)

Overclock multiplies the player contribution to effective attack and defence by
1.12 instead of 1.06. Arming still costs two Command Charge. At kick-off the five
actual starters still pay eight energy each, once, inside the existing kick-off
transaction. The selection, pending-cost flag, legacy prepaid compatibility,
rollback behavior and single-use activation are unchanged.

The old bonus largely cancelled its own energy penalty. The change adjusts one
coefficient, rather than removing the price or changing who pays it. It is an
advantage, not a guaranteed result. A tired squad can get less value from it.

## Calibration and selection

Run the real engine with controlled grade-B manual Balanced squads. The subject
has 70 attack and defence; opponents are peer 70/70, attack-heavy 90/70, and
defence-heavy 70/90. Subject starting energy/condition are 100/100, 60/100 and
100/60. Opponents start at 100/100. Run both orientations with paired seeds.

The On input pays the configured eight energy from exactly the five starters
before `createMatch` and passes `oc: true`. Bench energy is unchanged. The engine
snapshot must contain the charged energy as `e0`. Off pays nothing. Fixture IDs
are identical across On/Off and source versions. These fixtures are not a
replication of the issue author's management simulation or a campaign economy.

The selection plan was fixed before running candidates: at most three 128-seed
pilots (1000–1127), then one heldout comparison of baseline and the selected
candidate, each with 2,000 different seeds (20000–21999). The full-fitness peer
target is +3 to +8 percentage points in advancement after paying energy, with a
positive paired 95% interval on the heldout run. Other health/profile results
must be reported even when inconclusive. Never tune against the heldout sample.

Pilots screened bonuses 1.12, 1.14 and 1.16. The full-fitness peer estimates were
+4.69, +4.69 and +5.47 points respectively. Select 1.12 as the smallest plausible
candidate. These small pilot estimates have wide intervals; final evidence and
its report hashes are attached to the PR.

Each seed produces 36 outcomes: three opponents, three health scenarios, both
orientations, and Off/On. Advancement includes extra time and penalties;
regulation goals stop at minute 90. Shots and final fitness include extra time.
For each comparison, average the two orientation differences within each seed,
then calculate a normal 95% interval across seed blocks. Orientations are not
independent samples. Intervals have no multiple-comparison correction.

```sh
node scripts/overclock-calibrate.mjs --hooks /absolute/pb_hooks \
  --seeds 2000 --seed-start 20000 --output /tmp/overclock-report.json
```

Reports include source hashes, inputs, raw outcomes, event/state hashes, RNG
counts and nine summary groups. Keep large raw reports out of Git. Compare every
Off row across versions for identical state, events, RNG and metrics. The
Overclock unit suite checks 200 seeded repeat/JSON-resume paths and event
invariants; existing real-PocketBase suites cover activation and actual payers.
No RNG call site or ordering changes are needed.

## Pricing and rollout

Kick-off odds already use the same charged players and Overclock coefficient as
the match engine. New kick-offs therefore price the new coefficient. Existing
published events, finished results, frozen kick-off prices and tournament futures
prices are not rewritten. An ongoing `v2` match with `oc: true` uses the new
coefficient for future minutes; its already-paid energy cost is unchanged. A
team armed before deployment pays the same cost at its next kick-off.

No schema migration or state-format change is required. Default AI teams never
arm Overclock, so their Overclock-off matches stay identical. Tactics and
intensity remain on the restored pre-#133 model: this PR does not restore the
reverted tactics proposal. The fitness proposal (#135) must recheck Overclock,
since a flatter energy penalty changes the effective price of eight energy.
