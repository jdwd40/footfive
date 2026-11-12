# #217: more shots, same goals

This change intentionally changes outcomes, scorelines and odds. Three goal-model
constants in `pocketbase/pb_hooks/lib/balance.js` (`match`) change, exactly as
proposed in the issue:

| Constant | Before | After |
|---|---:|---:|
| `seqBase` (attack sequences per possession minute) | 0.28 | **0.36** |
| `onTargetBase` | 0.50 | **0.44** |
| `saveBase` | 0.48 | **0.54** |

Sides attack in more minutes and shoot more, and each shot converts less often, so
goals stay level. Engine code, RNG call sites, cosmetic generation, holds, timing,
stance and fitness policies, and settlement are unchanged. `goalRates` / `pairModel`
read the same constants, so the odds model follows without a code change. All
randomness still goes through `rnd(st)`, and the save/reload-every-step test passes,
so the engine stays deterministic and resumable.

## Calibration

Baseline: main 72e459c. Both sides measured on 2026-11-12.

### Harness (production pace, all 240 pairings, 4,800 matches)

`node harness/engine-stats.mjs --root <root> --matches 4800 --workers 3`. Matches
run at 6 s minutes. Match `i` is seeded `hashSeed("cal" + i)`, and the fixtures
walk all 240 ordered pairings equally (20 matches each). Use 4,800, not 1,000:
1,000 is not a multiple of 240, and on main that noise alone moves model-vs-sim from
+1.7% to +3.6%.

| Metric | Before | After | Criterion |
|---|---:|---:|---|
| Real shots / match (`stats.sh`) | 16.44 | **21.11** | 20–22 |
| Goals / match (incl. ET) | 3.36 | **3.37** | within ±0.1 of main |
| Goals / 90 | 3.11 | 3.13 | |
| Mean longest gap between real shots (min) | 17.86 | **14.76** | ≤ 15 |
| ...p90 / max | 26.1 / 74.9 | 21.0 / 45.1 | |
| ...counting kick-off and 90′ edges | 18.59 | 15.14 | |
| `pairModel` goals / 90 | 3.163 | **3.210** (+1.5% vs today) | within ±3% of today |
| Simulated normal-time goals / 90 | 3.110 | 3.132 | |
| Model vs simulation | +1.7% | **+2.5%** | within ±3% |
| Penalties / match | 0.25 | 0.33 | |
| Extra-time share | 20.8% | 19.6% | |
| Final-third entries / match | 15.16 | 19.45 | |
| Cosmetic long-range tries / match | 1.71 | 1.50 | |
| Trailing shots / possession minute, < 70′ → ≥ 70′ | 0.148 → 0.172 | 0.192 → 0.225 | |

Seed robustness (4,800 matches each, the same 240 pairings, other seed prefixes):

| Prefix | Goals/match before → after | Shots after | Gap after | Model vs sim after |
|---|---|---:|---:|---:|
| `cal` | 3.36 → 3.37 | 21.11 | 14.76 | +2.5% |
| `alt` | 3.35 → 3.42 | 21.10 | 14.79 | +1.7% |
| `zz` | 3.36 → 3.40 | 21.29 | 14.64 | +2.4% |

Every criterion holds on all three seed sets. Goals rise by 0.01–0.07, within ±0.1.
The rise comes mostly from penalties: they are awarded inside attack sequences, so
more sequences give more penalties (0.25 → 0.33 a match, about +0.06 goals). The
proposal is kept unchanged. A smaller `penBase` would hold penalties level, but no
criterion needs it.

`goalRates` needed no adjustment. It sits within ±3% of both the simulation and
today's value.

### `node scripts/engine-calibrate.mjs 3000`

The script's 16 pairings and explicit 15 s snapshot are unchanged. It now also
reports the mean and p90 longest gap between real shots, and the odds model
(`goalRates`, built the same way as `worldService.pairModel`) against simulated
goals/90. The "Before" column ran the updated script against main's engine and
balance.

| Metric | Before | After |
|---|---:|---:|
| Goals/90 | 2.95 | 3.03 |
| Extra time | 21.9% | 20.4% |
| Shootouts | 6.7% | 6.3% |
| Favourite wins | 82% | 83% |
| Penalties/match | 0.24 | 0.31 |
| Reds/match | 0.17 | 0.17 |
| Shots/match | 16.2 | 21.0 |
| On target/match | 6.7 | 7.7 |
| Longest shot gap, mean / p90 (min) | 18.06 / 26.1 | 14.80 / 21.1 |
| Model goals/90 | 3.113 | 3.157 |
| Model vs sim | +5.5% | +4.0% |

This script's 16 pairings are lower-scoring than the full set of 240, so its
model-vs-sim figure runs high on main as well. Use the 4,800-match harness figures
for the ±3% criterion.

## Deliberate assertion updates

Outcome pins are re-pinned because the tuning deliberately changes who attacks,
what the RNG draws, scorelines and winners. Seeds, timing, projections and strict
equality assertions are unchanged.

| Pin | Before | After |
|---|---|---|
| 200-seed tuple/final (`engine.test.ts`, `cosmeticShots.test.ts` `pin`) | `2d0870bfb62a6539a7119bc42088cddf863c1161e62a108fc2ba6c03e8f9da80` | `32359e3717fd564731f85cbcc81eb8911f93280cc21c1eddc903a4eeb6b336df` |
| Full real payload/final (`cosmeticShots.test.ts` `full`) | `b0c4a0049e34b0efed664c369944db95012815119a6c7c21dce74a126423398c` | `969d52256f8d9f8dfb3d4ec2e71e6b8ea654425f33e350095a9d434d5e3a2fe1` |
| Every persisted step (`cosmeticShots.test.ts` `steps`) | `ccee40cdb59cbcf17e9b775bb61f33fbb090841ac40a121c7ee5990e08c4ce9d` | `c0dceaf40a4b8ad414b96b90ef66b3e1a82b3ce324bd6db94822fe6c5dce30c1` |
| 200-seed outcome summary (`commentary.test.ts`) | `408d73e764db2a1c17f7ea39f06324b1b3209f850dc60baa749d04e2c03d96df` | `0e9d017182972a3d21829ee2bee2406dc545385504547adb32fae91b9a602677` |

| Manual balanced seed (`tacticalBalance.test.ts`) | Before score / RNG / events | After score / RNG / events | After event SHA-256 |
|---|---|---|---|
| 11 | [5, 2] / 2265 / 423 | [4, 1] / 2329 / 425 | `064ab9e2285786c8f510e2d8be17db5b9bede2329be4ed031e99b35bc6db5096` |
| 12 | [2, 0] / 2068 / 367 | [1, 0] / 2186 / 389 | `76103d181ecb3befd3332385535d503290bab9d81bb9c56513ec38c12e6c6923` |
| 13 | [2, 1] / 2668 / 475 | [0, 3] / 2325 / 417 | `7a99466d65abc486095f5cae367a8bc77f33b18310d29162eb013ca596ec4fb8` |

- `cosmeticShots.test.ts` "spectacle stays moderate": the mean number of cosmetic
  tries at 8 s over seeds 1000–1199 fell from 2.28 to 1.84. More minutes now carry
  a real attack, so fewer have spare time for a cosmetic try. The lower bound moves
  from > 2 to > 1.5. The upper bound (< 4), the per-match cap (≤ 15) and the 1 s
  "none" assertion are unchanged.
- The cosmetic-shot e2e spec (`e2e/gameplay-cosmetic-shots.spec.ts`) builds its runs
  from the engine at test time. Seeds 1000–1003 still give all four required runs
  (home/away × miss/block).
- No other fixtures encode main's outcome stream. The other e2e specs use authored
  events. `tests/integration/balance-replay.mjs` compares runs of the same
  configuration, not a pinned baseline.

## Deployment

Deploy between rounds, as for #195. A live match reads these constants as it plays,
and kickoff rebuilds `model_json`.
