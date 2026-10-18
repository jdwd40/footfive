# Aggressive intensity and Overclock rebalance (#157)

This is an intentional balance change: seeded outcomes change for any side that
plays Aggressive or arms Overclock. Balanced, Passive, stance and fitness
outcomes are unchanged. Repeating or resuming a match with the same
configuration still produces identical state and events.

## Change

| Coefficient | Before (#133/#134) | After (#157) |
| --- | ---: | ---: |
| Aggressive attack | 1.25 | **1.20** |
| Aggressive defence | 1.00 | **0.95** |
| Overclock bonus | 1.12 | **1.10** |
| Passive, Balanced, stance tempo, fitness, costs | — | unchanged |

Aggressive still adds pressure and still wears energy (×1.4) and condition (×1.35)
faster. It now also gives up a little defence, so it is a trade-off instead of a free
buff.

The Overclock step was conditional. The rule was to apply it only if, after the
Aggressive change, Aggressive + Overclock was still above 58% or the strongest stack
still won more than 9.5% of 4-round runs. Aggressive + Overclock came in at 57.7%, but
the strongest stack, Overclock + scoreline coaching, still won 10.1% of runs (its
Aggressive-free value). So the bonus went from 1.12 to 1.10.

## Method (measured 2026-10-18)

- `scripts/balance-157/mirror-sim.cjs`: an authored B-grade squad plays an identical
  copy of itself (both manual, Balanced unless stated). Seeds mg1..mg10000, so each
  row is 10,000 matches with a 95% interval of about ±1.0pt. "Advance" includes extra
  time and penalties; W/D/L and goals are at 90'. Overclock rows charge the five
  starters 8 energy before kick-off.
- "Lead/trail coach" means Defend while leading, Attack while trailing, otherwise
  Balanced, with at most 4 changes.
- `scripts/balance-157/run-sim.cjs`: a 4-round knockout run (R16 to final).
  Energy and condition carry over between rounds, with +5 energy between rounds. Command
  Charge starts at 5 and regains 1.6 per round, so Overclock is armed whenever
  2 charges are available. The opponent is AI-controlled and carries the fatigue
  of the side just beaten.
- Before = main 4a49b28 (same engine and balance files as 31c6ae1).
  After = this branch.

## Results: single tie, B-grade mirror (adv %, W/D/L at 90', goals for–against)

| Setup | Before | After |
| --- | --- | --- |
| Baseline (Balanced v Balanced) | 50.1 (34.6/30.2/35.2, 1.03–1.04) | 50.1 (34.6/30.2/35.2, 1.03–1.04) |
| All Aggressive | 54.7 (40.5/28.5/30.9, 1.22–1.03) | **52.0** (37.7/29.1/33.3, 1.18–1.09) |
| All Passive | 44.7 (29.5/30.5/40.0, 0.90–1.10) | 44.7 (unchanged) |
| Overclock | 56.2 (40.1/30.0/29.9, 1.13–0.94) | **54.8** (38.9/30.3/30.9, 1.11–0.96) |
| Aggressive + Overclock | 61.5 (46.5/27.7/25.8, 1.35–0.92) | **56.5** (41.8/28.4/29.7, 1.25–1.01) |
| Aggressive + Attack + Overclock | 62.0 (49.8/22.8/27.4, 1.86–1.29) | **57.1** (45.0/23.5/31.4, 1.72–1.38) |
| Aggressive + lead/trail coach | 58.5 (43.9/28.8/27.3, 1.23–1.02) | **55.1** (40.8/28.8/30.4, 1.18–1.10) |
| Aggressive + chase when behind 70'+ | 56.2 | **53.3** |
| Overclock + lead/trail coach | 59.5 | **57.8** |
| Passive + Defend + Overclock | 49.9 (31.2/36.7/32.1, 0.73–0.74) | 49.1 (30.4/36.8/32.9, 0.72–0.76) |
| Lead/trail coach (Balanced) | 53.8 | 53.8 (unchanged) |
| Attack / Defend stance all match | 49.1 / 50.0 | unchanged |
| vs AI opponent, all Aggressive | 53.0 | 50.5 |

Goals per 90' (Balanced v Balanced) stay at 2.08, the same as before. Stance
goal totals are unchanged: one-side Attack 2.83, one-side Defend 1.56.

## Results: 4-round run (title %, mean wins per run)

| Strategy | Before | After |
| --- | --- | --- |
| Balanced | 5.6% (0.90) | 5.6% (0.90) |
| Passive | 6.0% (0.81) | 6.0% (0.81) |
| Aggressive | 6.1% (0.97) | **5.0%** (0.89) |
| Overclock every round | 7.2% (1.03) | 6.8% (1.00) |
| Lead/trail coach | 7.3% (1.00) | 7.3% (1.00) |
| Aggressive + lead/trail coach | 8.5% (1.12) | 6.8% (1.00) |
| Aggressive + Overclock | 9.3% (1.18) | 7.1% (1.02) |
| Aggressive + Attack + Overclock | 9.7% (1.19) | 6.7% (1.01) |
| Aggressive + Overclock + lead/trail coach | 11.3% (1.29) | **8.6%** (1.12) |
| Overclock + lead/trail coach | 10.1% (1.18) | **9.2%** (1.13) |
| Passive + Defend + Overclock | 6.7% (0.93) | 6.2% (0.90) |

Aggressive alone now trades a slightly lower title chance for more wins than
Passive and more condition wear (about 27 points per run more than Balanced). It is
no longer a free upgrade. The strongest stacks are about 8.6–9.2%, against 5.6% for
Balanced. Active management still pays, but no single combination stands out.

Intermediate step, Aggressive change only (Overclock still 1.12): Aggressive 52.0,
Aggressive + Overclock 57.7, Aggressive + Attack + Overclock 58.1. Run titles:
Aggressive + Overclock + coach 9.3%, Overclock + coach 10.1%.

## Overclock still pays

The #134 calibration (`scripts/overclock-calibrate.mjs --seeds 2000 --seed-start
20000`) on this branch gives +4.35pt [3.3, 5.4] for the full-fitness peer. That is
inside #134's +3 to +8 target, with a positive interval. Other profiles range from
+3.0 to +5.3pt, all with positive intervals. Overclock is still worth its two
charges.

## Live rollout

No schema or state migration is needed. A match in progress uses the new
coefficients for its remaining minutes after the normal hook reload. Its published
history is not rewritten. Stored kick-off `model_json` and existing prices keep their
original snapshots.
