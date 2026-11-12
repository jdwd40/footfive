# #228: price the current published manager stance

## Status and scope

The current-stance implementation and model-read performance fix are complete, but **the issue's universal ROI acceptance
criterion is not met**. An independently checked 19,200-match manager policy obeying the four-command cap and wall-clock
cooldown still yields significant positive bettor returns when future manager choices differ from holding the currently
published stance. The three broader calibration cohorts below use idealized direct-engine policies that bypass coaching
budget/cooldown guards; their numbers are retained as calibration evidence, not presented as API-legal strategy proof.
The two fixed-Attack cohorts also expose existing extreme-score numerical truncation above the calibration's reference
target. This remains draft work pending the policy decision, not a claim that every in-play market is calibrated.

No settlement, match outcome, RNG, command limit, polling or presentation rule changes.

## Published state and model

- Every event snapshot carries `cs: [homeStance, awayStance]`, captured when that event is emitted. A coaching row already
  publishes the same information. Thus the latest real published event supplies the latest applied stance at or before
  the quoted event, without scanning command history or reading the engine ahead of publication.
- `inPlayModel` keeps the kickoff `lh`/`la`, six score/urgency states, wear samples and AI policy from #219. Manager-run
  sides additionally get kickoff `cs`, the `ai` mask, and a table index `v` into deduplicated rate tables `vr`.
  There are three choices per manager, nine combinations for two managers. Exact duplicate tables share one JSON payload;
  two managers' nine combinations need five tables because the engine's goal rates depend on the sum of stance tempos.
- `odds.js` chooses the manager combination from the published `st.cs`. Missing/invalid snapshot values fall back to that
  side's kickoff stance. AI sides retain their existing future score/minute policy; their current published stance does
  not freeze their future AI choices. A manager's unknown future commands are not supplied to pricing.
- The chosen stance combination is explicitly included in the cache fingerprint, even when two combinations currently
  have equal rates. Selected wrappers and fingerprints are nonenumerable runtime memoization only; serialized models do
  not grow or change as quotes are read.
- `worldService.modelOf` caches at most 64 parsed models per goja VM by the **exact raw `model_json` string**, observing the
  current string on every read. Kickoff/repair on the same fixture cannot reuse an older source value, and fixture ids are
  not cache keys. All consumers read semantic fields; only odds' nonenumerable memoization changes. Unusual native-object,
  byte-array, missing and malformed field representations retain the existing `readJson` fallback. Cache eviction changes
  performance only, never prices or stored data.
- Both reference paths (`finalDist`, `_ref.dist`, `_ref.next`, `fixturePrices`, `exactPrice`) and polled paths
  (`marketProbs`, fixture cards, catalogues and bet quotes) receive the same selection. Fixture and betting services already
  pass the latest published snapshot, so no extra service/database reads are required.
- Pre-match and `round_first` kickoff rates retain their old meaning. Models without `v` retain their original prices,
  including old `{lh, la}` models and #219 staged models. **Drain live matches before deploying** if complete current-stance
  coverage is required: old in-flight models do not contain the counterfactual stance tables and cannot be repaired just
  from the last public row. Old snapshots are compatible through the kickoff fallback; `PubState.cs` is optional for them.

## Reproduce the manager calibration

```bash
node scripts/inplay-calibrate.mjs 4800 --prefix cal,alt,zz,qq --manager-policy ai-mirror --manager-side both --json > mirror.json
node scripts/inplay-calibrate.mjs 4800 --prefix cal,alt,zz,qq --manager-policy always-attack --manager-side both --json > attack.json
node scripts/inplay-calibrate.mjs 4800 --prefix cal,alt,zz,qq --manager-policy defend-then-attack --manager-side both --json > switch.json
```

These are **19,200 matches per policy**, all 240 ordered pairings equally weighted, 6 s minutes, fixed seeds. Both sides
are manager-run in the full runs. Each policy also has a final 240-match home-only and away-only smoke run. Default script
behavior remains the previous all-AI calibration; `--manager-side home|away|both` controls the managed sides.

These idealized policies use the engine's queued-command boundary directly. **They do not enforce the API's coaching
budget or cooldown**, so AI mirror in this full calibration is not an API-legal strategy simulation:

- AI mirror follows the existing 70′ chase, 78′ protect and 100′ level policy.
- Always Attack starts Balanced and commands Attack for minute 1, then holds it.
- Defend then Attack starts Defend and commands Attack for minute 1, then holds it.

The script never passes its future policy into the model. Snapshot times are 60′, 75′ and 85′, moved to the first open
published row when suspended, as before. It reports winner, next goal, all winning margins, and every offered exact score,
plus favourite/strength views. Every positive offered ROI cell is retained, including sparse cells. ROI standard errors
use whole-match clusters, accounting for repeated offers in a cell.

Independent review found that the original sampler could choose the first of several coaching rows with the same
publication timestamp. For example, at 85′ of `cal89`, row 447 still has the other side's old stance, whereas row 448 at the
same timestamp is the latest published state. `scripts/lib/published-snapshot.mjs` now canonicalizes to the highest sequence
at `at <= quoteTime` before checking danger, and again at every step past a suspension. Both the main samples and the
70–89′ strategy use it; an intermediate open row whose timestamp group ends closed cannot be priced. Four boundary tests
include that exact real match and synthetic closed-ending timestamp groups. **All three 19,200-match cohorts were rerun**
after this correction; the numbers below supersede the earlier invalid sampling results.

Per-selection prices must equal the real
`marketProbs` catalogue price exactly; ROI uses those actual offered odds, not a nearby reference price.

The validation changes from reference-price equality with a 1e-9 rounding-boundary allowance to exact catalogue/fast-price
identity plus a separate independent-reference check against a **declared 1e-7 absolute probability target**. Violations are reported
and make the process exit 1 **after the fixed cohort finishes**, preserving all ROI evidence. The script also reports
relative error (absolute delta / nonzero reference probability), with a separate maximum for offered selections. The full
corrected runs measured maximum offered relative error `1.407846e-7` (0.00001407846%) for AI mirror and `2.284115e-4`
(0.02284115%) for each fixed-Attack policy. Including tiny withdrawn tails, maximum relative error is 1 and 3 respectively;
859/1,592 comparisons have zero reference probability but positive fast-path mass, so their relative error is undefined.

## Fixed-cohort results

| Both sides managed | AI mirror | Always Attack | Defend then Attack |
| --- | ---: | ---: | ---: |
| Matches | 19,200 | 19,200 | 19,200 |
| Snapshots | 57,600 | 57,600 | 57,600 |
| Offered-price identity checks | 1,349,468 | 1,565,464 | 1,565,464 |
| Catalogue/fast price mismatches | 0 | 0 | 0 |
| Judged in-play probability cells (n ≥ 200) | 424 | 483 | 471 |
| In-play cells outside ±3 pp | **84** | 0 | 1 |
| Positive ROI cells, including pre-match and sparse cells | 175 | 82 | 89 |
| Positive ROI cells with ≥200 offers, including pre-match | 168 | 79 | 79 |
| Uncorrected normal 95% lower ROI bound >0, ≥200 offers | 53 | 2 | 5 |
| Maximum fast/reference absolute probability delta | 1.6088204e-8 | **3.0237401e-6** | **3.0237401e-6** |
| Reference checks above 1e-7 | 0 | **153** | **153** |
| Price-rounding differences from reference | 0 | 33 | 33 |
| Script exit | 0 | **1** | **1** |

Multiple-cell confidence intervals are not adjusted for multiple testing. The positive-cell counts include pre-match
future-switch exposure and noisy long-shot cells; they do not mean every positive point estimate establishes an exploitable
in-play edge. The AI-mirror failures below are large, well populated and cannot be dismissed as that noise.

| In-play bet (AI mirror, level at 85′) | Offers | Bettor ROI | Cluster SE |
| --- | ---: | ---: | ---: |
| Next goal: favourite | 4,568 | **+12.8%** | 1.628 pp |
| Winning margin: home by 1 | 4,568 | **+17.3%** | 2.963 pp |
| Exact additional goals: +2–1 | 4,568 | **+62.0%** | 14.128 pp |

In that state the model's no-further-goals probability is 32.1%, versus 18.6% observed (binomial SE 0.6 pp). Future manager
changes, especially both sides switching to Attack from 100′ when level, are not captured by holding the last published
stance. Feeding the simulator's known future policy into prices would conceal this limitation and is not implemented.
A policy/robust-pricing decision is required before claiming the universal ROI criterion; settlement is not a remedy.

For both fixed-Attack policies, next-goal-favourite ROI is −6.2% at 60′, −7.8% at 75′, −9.0% at 85′, and −8.3% pooled over
70–89′. They have the same played outcomes and in-play prices after minute 1; their kickoff prices differ. The one
Defend-then-Attack in-play cell outside ±3 pp has only 242 matches (75′, underdog 15–25%, underdog leads, next goal:
favourite; 4.1 pp discrepancy, ROI −12.9%). Positive pre-match future-switch returns are kept in the full reports but are
separate from the issue's in-play acceptance criterion.

### Guarded manager-policy exposure check

```bash
node scripts/manager-stance-exposure.mjs
# Defaults: --matches 19200 --prefix cal,alt,zz,qq; --root selects another checkout.
```

This separate check follows the AI stance policy only when a command is permitted by the four-command budget,
`BALANCE.liveCoachingCooldownMinutes × 6000 = 30000 ms` wall-clock cooldown and pending-command deduplication. It submits
commands at `nextAt - 1 ms` after already published play and asserts manual/live-phase eligibility. The issued timestamp
history is audited independently for cooldown violations. Pricing uses the shared latest-published/open-snapshot helper.
This is **guarded engine-only validation**, not HTTP/API integration: authentication, database transactions and catch-up
races are not exercised.

The durable script's 19,200 fixed-cohort results match the independent reviewer's check to `1e-12` in every reported mode
field. Both sides are manager-run, all 240 pairings equally weighted, with the same four fixed seed prefixes:

| Guarded policy, level score | Offered bets | Favourite next-goal ROI | SE |
| --- | ---: | ---: | ---: |
| 75′ | 4,835 | **+4.42689%** | 1.38009 pp |
| 85′ | 4,560 | **+12.8452%** | 1.62975 pp |

There are 44,469 issued and applied stance changes, at most four per team, **zero budget violations and zero cooldown
violations**; 4,599 desired targets are rejected by the budget and 5,098 by the cooldown. Each bucket places at most one
wager per match, so its payout sample standard error does not rely on treating repeated rows as independent. This
well-populated positive edge establishes that the future-policy limitation survives the live coaching constraints; it
is not inferred solely from the idealized three-policy calibration.

### Existing extreme-score approximation

The #219 fast path walks score differences only to ±8; the independent reference walks the larger score grid. Manager
Attack scenarios reach more extreme scorelines, exposing that existing tail approximation. At 60′ with score 0–6,
`cal111` has reference P(away by 3) `0.002346630936003404`, versus fast `0.002346619907569235`: only `1.10e-8` apart, but
prices round to 400.57 and 400.58 respectively. A regression test preserves this known boundary.

At more extreme scores the fixed-Attack runs exceed the **declared 1e-7 validation target**, up to `3.0237401e-6`; their
nonzero exits are intentional validation failures, not passing calibration. Every actual catalogue price still equals its
fast-path probability price exactly. This change does not expand the tail algorithm, raise the margin, withdraw extra
markets, or suppress the affected rows.

## Actual PocketBase/goja cost

```bash
POCKETBASE_BIN=/path/to/pocketbase node scripts/inplay-goja-bench.mjs /path/to/candidate both
POCKETBASE_BIN=/path/to/pocketbase node scripts/inplay-goja-bench.mjs /path/to/219 both
```

The harness uses a disposable database and copies the tested libraries. It creates a temporary superuser **before serve**,
which prevents PocketBase opening the fresh-install browser page; it opens no browser tab. It cleans up its own process
and directory. Timings use goja `Date.now` batches, not Node timings.

The first benchmark exposed a model-parsing regression: two-manager `JSON.parse` plus warm pricing rose from 0.080 ms on
#219 to 0.225 ms before the model-read cache. Core pricing was still about 6 ms cold and 0.011 ms warm, but that did not
account for real model reads. The cache fixes this separate measured regression without changing the model or prices.

The extended benchmark now constructs a **native PocketBase Record with a JSON field** and calls the real
`worldService.modelOf` plus `odds.marketProbs`. Cold read samples use a unique inert benchmark-version property and empty
odds caches; warm reads reuse the same raw model. No production cache-reset hook was added. It also replaces the model JSON
on the same native Record and verifies the replacement model's exact prices, guarding against stale-read optimization.
Database-query time is excluded; native JSON getters, parsing/memoization and odds work are included.

| Controlled both-manager cost, final cache source | #219 baseline | #228 with model-read cache |
| --- | ---: | ---: |
| Core cold market probabilities | 11.60 ms | 11.55 ms |
| Core warm market probabilities | 0.016 ms | 0.022 ms |
| Forced JSON parse + warm probabilities, bypassing model reader | 0.155 ms | 0.400 ms |
| **Native model read + cold probabilities** | **11.45 ms** | **11.40 ms** |
| **Native model read + warm probabilities** | **0.109 ms** | **0.0245 ms** |
| 120 pair qualifications | 697 ms | 705 ms |

These batches ran more slowly in absolute core timings than the earlier measurements; the controlled baseline and
candidate are reported together rather than attributing that change to this optimization. The production warm read path
is about **4.4 times faster** than #219 in this comparison. The all-AI read-plus-warm path similarly falls from 0.104 ms to
0.0205 ms. Cold core and full-read costs differ by one batch timer quantum (0.05 ms); warm core arithmetic alone is
0.006 ms higher while the complete warm model-read path is faster. The two-manager model remains 2,513 bytes versus 452 bytes in the benchmark's #219 baseline: forcing a fresh parse still
costs more, but ordinary unchanged model reads no longer do that work. Both baselines and candidates passed the native
same-fixture replacement check. The earlier absolute #219 review figures (7.0 ms cold, 0.2 ms warm, 541 ms per 120 pairs)
are historical measurements, not substituted for these controlled results.

## Regression and outcome evidence

`publishedStance.test.ts` covers publication boundaries, queued/hidden commands, both managers, mixed AI/manager behavior,
kickoff fallback, old models, alternating caches (including equal-rate stance combinations), JSON round trips, catalogue/
reference parity over all nine manager stance combinations, and the known high-score cent boundary.
`publishedSnapshot.test.ts` separately covers the four simultaneous-publication boundary regressions described above.
`modelReadCache.test.ts` checks fresh raw reads, exact-source keys across fixtures and encodings, same-fixture replacement,
bounded eviction, native/byte-array/malformed fallback, legacy models, and cached/fresh price parity for AI, either single
manager and both managers. Nonenumerable odds memoization leaves serialized model semantics unchanged.

A separate baseline comparison ran 2,880 matches: AI/home-only/away-only/both-manager configurations × three policies ×
240 ordered pairings. Complete final states and **all event payloads including cosmetics** are identical to #229 after
removing only the new `st.cs` field. No engine state shape or RNG call changes. The existing outcome tuple and persisted
step-state pins remain unchanged. Only full event hashes containing the new published field change:

| Pin | Before (#229) | After (#228) |
| --- | --- | --- |
| Cosmetic real payload | `9c4f9440b1bb27a474179a0a81f9ec1616f945238c72a77d1e130f2763872b72` | `5f7b253e8cd2e79abf40a57eb88ddfe803cf7fffee6243d048ab63accb726d7f` |
| Tactical seed 11 | `0512a474f1b3c8998d9db0067ec9ab65e31d4c4359b7521767e3d3414e17e80e` | `c719dd689ed8fa02268e5a8ff1b3dc6919249588b85c9f6426883a40916bf912` |
| Tactical seed 12 | `4aa4002ee26f0ca63bc02d132b784ae9e231bebb32178684e11a90c829141604` | `06ec479f956bae0ac8ee4daa03f626ccf52a8fa24aada670c7f3431bfc72def8` |
| Tactical seed 13 | `1495cad8a6fecf02c92729c899d85f507cf813aa3bb0780f2a066e71f220afce` | `aa780e3aff5070f381243a6bdb45f1490d9aadb7a5659a80b044a0ac747d0677` |

Local checks: the initial full suite passed 1,251 tests and failed six (four expected new-payload hashes, one new test's
wrong `fixturePrices` property, and an unrelated real-clock rate-limit assertion under load). The hashes/property were
fixed; the affected four files then passed 39/39, including the unchanged rate-limit test. The subsequently added rounding
regression passed with all five current-stance tests. Typecheck, lint (zero errors, six existing warnings), build and
balance replay (200 seeds, 400 configurations, 1,200 executions) passed. Final calibration metadata smoke and benchmark
script syntax checks passed. After the sampling review fix, all four boundary tests, lint for the three changed calibration
files, typecheck, and diff checks passed; all fixed cohorts were regenerated. No local browser E2E or deployment was run;
remote CI remains required.

After the model-read optimization, all 14 focused cache/stance/publication tests, typecheck, build and lint passed (zero
errors, six existing warnings). The actual PocketBase/goja benchmark passed native record replacement checks on both
baseline and candidate, and the guarded policy checker passed syntax/lint plus its full 19,200-match reproduction. The
57,600 idealized calibration matches were not rerun for this cache-only optimization: the model data and pricing functions
are unchanged, and cached/fresh parity is directly tested. The future-policy acceptance blocker remains unresolved.
