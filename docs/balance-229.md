# #229: suspend markets from a published attack build-up

A real attack's first `build_up` row now carries `st.d = 1`, including a counter (`ctr: 1`). Its passes,
progression, shot and any loose rebound remain suspended. A shallow tackle/interception explicitly clears danger before
its public row, like a final-third stop already did. All other reopening rules stay the same: a shot result reopens
unless it is loose; goals and penalty results keep their existing hold until `restart`.

The catalogue and bet-placement code already reject a suspended fixture. No settlement, pricing, polling, rate-limit,
randomness, event-timing, score, statistic or presentation rule changes.

## Reproduce

From the candidate checkout, with the unchanged #219 head `38739a20d5e3dd9eae2a744b5397c27e63c56afb` in a separate checkout:

```bash
node scripts/attack-reveal-calibrate.mjs 9600 --baseline-root /path/to/219
npx vitest run --maxWorkers=4
npm run typecheck
npm run lint
npm run build
npm run test:balance-replay
```

The script uses all 240 ordered pairings equally, AI teams, 6 s production minutes and seeds `hashSeed("reveal" + i)`.
It compares **every noncosmetic event payload after removing only `st.d`**, and the complete final state, with the baseline.
All 9,600 matches passed both equality checks. The unchanged outcome tuple pin and step-state pin also continue to pass.

Suspended share is the duration carrying `d: 1` divided by duration in playable halves, including extra time and all goal/
penalty holds within those halves; pre-match, half-time/extra-time breaks and shootouts are excluded. Cosmetic rows do not
move the pricing state and are excluded. This definition is stated explicitly so the figures can be reproduced; the older
8.4% figure quoted by the issue was measured on #217, not this #219 baseline.

| 9,600 matches | #219 baseline | #229 |
| --- | ---: | ---: |
| Suspended share of playable live time | 10.6266% | 26.3405% |
| Open share | 89.3734% | 73.6595% |

The increase is **15.7139 percentage points**. Markets remain open for almost three quarters of playable live time. There
is no assertion that this availability tradeoff has been accepted through live playtesting.

## Published-row exposure

For each real published row with a named side, the script attempts one unit on “next goal: that side” at the real
`odds.nextGoal`/`markets.okP` price and the real `fixtureState` gate. For a turnover this means the side winning the ball.
Closed and withdrawn selections place no bet. Future goals exclude shootouts, as settlement does. A goal on the priced
row is already public and is excluded from the next-goal result. Results use whole-match clusters for standard errors,
because repeated rows in a match are correlated.

| Row/window | Rows | Offered bets | Bettor ROI | Cluster SE |
| --- | ---: | ---: | ---: | ---: |
| Build-up, all minutes | 376,902 | 0 | N/A | N/A |
| Counter build-up, all minutes (subset) | 18,471 | 0 | N/A | N/A |
| Build-up, 86–90′ | 21,584 | 0 | N/A | N/A |
| Counter build-up, 86–90′ (subset) | 1,112 | 0 | N/A | N/A |
| All named-side rows, all minutes | 4,301,680 | 2,218,318 | −9.84% | 0.50 pp |
| All named-side rows, 86–90′ | 231,836 | 111,704 | −35.08% | 1.73 pp |
| Open passes, all minutes | 2,480,283 | 1,376,005 | −10.13% | 0.49 pp |
| Open passes, 86–90′ | 129,083 | 66,071 | −36.38% | 2.03 pp |
| Coaching, all minutes | 22,631 | 22,631 | −4.53% | 1.48 pp |
| Coaching, 86–90′ | 1,753 | 1,753 | **+7.46%** | **11.42 pp** |

Every attacking progression (`cross`, `dribble`, `through_ball`), shot, penalty and loose result remains closed too.
Pass counts include ordinary open midfield passes; passes in real attack chains are all closed. Zero offered bets means
no actionable build-up exposure, **not a measured 0% ROI**.

### Acceptance limitation

The build-up leak is removed by rejecting every bet during the attack. The pooled open-row strategy loses overall and
at 86–90′. However, the literal criterion of a nonpositive point estimate for every published row type is **not fully
met**: the late coaching bucket is +7.46%, with 11.42 pp standard error (about −14.9% to +29.8% for a normal 95% interval).
This is not a statistically established edge, and the sample cannot prove a nonpositive true ROI in that bucket.
The script reports it without excluding it or rerunning seeds to obtain a negative number.

This run covers AI teams and bets on the row's named side at publication time. It does not establish every possible
selection/policy, every moment between rows, manager stance changes (#228), or a strategy backing the opponent after a
red card. Those limits must not be described as universal odds calibration.

## Regression coverage and golden changes

`attackSuspension.test.ts` checks 240 matches across all pairings: every real attack row through its public resolution is
closed, including counters, shallow/deep stops, long shots, and loose rebounds. It exercises selection rejection for every
incident type and checks reopening within one match minute. Goals and penalty results preserve their pre-existing restart
hold. It also checks complete event and state equality after JSON reloads between steps.

The older final-third test now measures the reopening bound in match minutes rather than eight rows, because suspending
from the build-up adds up to four passes before the previously suspended tail. Its progression/turnover checks remain.

Only full event hashes containing the danger flag change; score, RNG count, event count, timing, outcome tuples and
persisted step states keep their old assertions and pins:

| Pin | Before | After |
| --- | --- | --- |
| Cosmetic real payload | `9af045ea9b5dd535845a27f431cd5d80e3295c3a845db04d66c2aaa877198a01` | `9c4f9440b1bb27a474179a0a81f9ec1616f945238c72a77d1e130f2763872b72` |
| Tactical seed 11 | `5a14a147fbb3c9fea5d104672865bbb6ffcb49b181cbacb6aed36ddf545c67b3` | `0512a474f1b3c8998d9db0067ec9ab65e31d4c4359b7521767e3d3414e17e80e` |
| Tactical seed 12 | `512f1ca768d90da0af1f633c4cb876d0c0aef882a36b41ea7fdb50609d817a22` | `4aa4002ee26f0ca63bc02d132b784ae9e231bebb32178684e11a90c829141604` |
| Tactical seed 13 | `f3bb3f0cec2a8bb0c4bfb179ceba46725ed664c9955863fcbe02bce3a1a6a7f9` | `1495cad8a6fecf02c92729c899d85f507cf813aa3bb0780f2a066e71f220afce` |

## Validation on the candidate

- 9,600-match calibration and baseline parity: passed.
- Full Vitest with four workers: 1,252 tests passed, one new attack test timed out because it built the complete catalogue
  and asserted every selection for every row. That test was changed to check the gate for every row and exercise catalogue
  rejection once for each incident kind, preserving all 240 matches and outcome/penalty coverage. The final focused rerun
  passed both tests in 2.19 s (1.70 s in tests). Unchanged successful tests were not rerun again.
- Typecheck: passed. Lint: zero errors, six existing React refresh warnings. Production build: passed.
- Balance replay: passed, 200 seeds, 400 configurations, 1,200 executions including queued coaching and JSON reloads.
- No local browser E2E or live deployment was run for this engine-flag change; remote CI remains the delivery gate.
