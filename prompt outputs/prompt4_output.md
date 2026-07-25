# Prompt 4 completion report — Flagship Live Match & Scoreboard

**Date:** 2026-07-25  
**PocketBase:** 0.28.4  
**Status:** Complete

---

## Summary

Polished the **shared live scoreboard** and **live match watch experience** without changing the server-authoritative incremental simulation model.

- Shared **round store** powers scoreboard, ticker, and match switcher (one poll source).
- **Event reveal queue** with dedupe, late-open catch-up, paced holds, and **Catch up to Live**.
- **Score from revealed events only** — prevents snapshot jump-ahead.
- Dedicated **penalty focus** and **shootout board** (markers, FT vs pens separation).
- Mobile-first hierarchy: score → phase → event → coaching → ticker → feed → stats.
- Match switcher strip + other-score ticker; reduced-motion + aria-live.
- Balance sample (80 knockout sims) measured ET/shootout rates.

## Live-view architecture

### Data contract (audit)

| Concern | Behaviour |
|---|---|
| Match snapshot | `GET /api/footfive/match/{id}?sinceSeq=` — due events, scores, phase, coaching, stats when finished |
| Scoreboard | `GET /api/footfive/scoreboard` — all fixtures in active shared round |
| Sequence | Stable `seq` on each event; client tracks `lastSeq` |
| Score | Server may return authoritative mid-match scores; **UI score uses revealed queue** |
| Catch-up | Route invokes shared `catchUpWorld`; client bulk-reveals old events, paces last few |
| Switching | Queue recreated per `fixtureId`; round store keeps all scores |
| Hidden future | Server only returns due events (`offsetMs` / segment cursor) |

### Client modules

- `src/domain/eventDisplay.ts` — importance, hold/delay, styles
- `src/domain/eventQueue.ts` — inbox → paced reveal
- `src/domain/scoreFromRevealed.ts` — normal vs shootout score rules
- `src/hooks/useLiveMatch.ts` — poll + queue + stale-request guard
- `src/hooks/useRoundStore.ts` — single scoreboard poll, pause when tab hidden

### Score rules (client)

1. Visible normal score updates only as scoring events (`goal`, `penalty_scored`) reveal.  
2. Shootout goals update shootout tally only (FT score unchanged).  
3. Penalty save/miss do not require score change.  
4. API snapshot must not advance UI score ahead of queue.  
5. `match_end` marks finished.

## Scoreboard changes

- Uses shared `useRoundStore` (no per-page duplicate polls).
- Compact cards: live chip, phase label, kickoff countdown, pens line, “Your match”, Watch CTA.
- Refresh + visibility return.

## Event presentation

- Major / medium / minor holds via `eventDisplay`.
- Late open: history dumped; last 3 events paced.
- Catch-up button flushes queue.
- Penalty focus panel + shootout board with kick markers.
- Coaching controls with pending state + aria-pressed.

## Penalty & shootout

- In-match: `PenaltyFocus` for award → walk-up → result.
- Shootout: dedicated board, FT note, sudden-death cue, markers (goal/miss/current).

## PocketBase

- No schema migration required for Prompt 4.
- No sim rewrite; continues incremental segments + existing routes.

## Assets

- Reused existing Imagine assets (`broadcast-frame`, `penalty-scene`, badges).
- No new remote URLs.

## Files created / changed

### Created
- `src/domain/eventDisplay.ts`, `eventQueue.ts`, `scoreFromRevealed.ts`
- `src/domain/eventQueue.test.ts`
- `src/hooks/useLiveMatch.ts`, `useRoundStore.ts`
- `src/components/live/MatchSwitcher.tsx`, `ShootoutBoard.tsx`, `PenaltyFocus.tsx`
- `scripts/shootout-sample.mjs`
- `prompt outputs/prompt4_output.md`

### Changed
- `LiveMatchPage.tsx`, `ScoreboardPage.tsx`, `FixtureCard.tsx`, `index.css`

## Tests & results

| Suite | Result |
|---|---|
| Unit (incl. queue + score) | **27 passed** |
| `tsc -b` | **pass** |
| `vite build` | **pass** |
| Shootout sample (80 matches) | ET **32.5%**, shootouts **18.8%**, SD among SO **20%**, avg goals **2.54**, upsets **21.3%** |

Shootouts remain a recognisable feature (~1 in 5 KO matches) without forced outcomes; no balance hack applied.

## Performance

- One scoreboard poll shared across consumers.
- Match poll pauses when document hidden; refreshes on visibility.
- Stale response IDs ignored.
- Event history capped (~80 queue / 30 displayed).
- Switcher/ticker use CSS overflow-x without page overflow.

## Development data

- None wiped; additive frontend only.

## Known limitations

- Shootout kick markers approximate taken kicks from scores (no per-kick taken count on API).
- No dedicated full-match “replay from kickoff” mode (by design: catch-up to live).
- Viewport matrix not automated in CI (manual widths documented).

## Unresolved bugs

- See `bugs.md` (global management window, Phase 1 table leftovers, shootout marker approximation).

## Documentation

- `project_plan.md` / `changelog` / `new_features` / `README` / `bugs` updated for live UX.

## Recommended Prompt 5

1. Records & history centre  
2. Admin credit/manager UI  
3. Retention job  
4. Optional per-kick shootout state on API for perfect markers  
5. Drop Phase 1 collections  
6. Playwright mobile viewport checks  

---

*End of Prompt 4 report.*
