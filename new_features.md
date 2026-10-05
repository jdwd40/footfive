# Features

## Implemented — 2026-10-05 pitch/ends follow-up (bounded independent QA PASS; not shipped)

- [x] Modestly larger responsive pitch except tiny views; compact actual ticker/scoreboard/completed chrome keeps critical HUD and commentary usable at the five tested viewports; detailed shootout board may scroll
- [x] Event-snapshot display-only half/ET end changes with centred break-ball continuity and one coherent shootout end; engine coordinates, events, outcomes and RNG unchanged
- [x] Equal actor base radius 1.45/stroke 0.3, including both keepers and referee
- [x] Carrier-only ring at actual smoothed rendered possession contact; free-flight unmarked, no participant-only rings; fast dribble/striker contact gaps may suppress the ring
- [ ] Human preview feel approval and final Grok4.6 Low code+docs review (automated/bounded pixel QA does not replace these)

## Completed — 2026-10-05 live polish

- [x] Concrete outcome badges (WIDE / OVER / BLOCKED / SAVED! / WOODWORK / PENALTY) tied to the engine result
- [x] On-pitch HUD: score, clock, shootout PENS and kicking team, visible with the pitch on desktop, laptop and mobile
- [x] Possession hand-offs rendered (keeper gathers, blocker collects, clearances after turnovers)
- [x] Live-watch QA harness (`scripts/live-watch.mjs`) for real fixtures and labelled offline-engine replays

## Completed — Prompt 7 (RC)

- [x] GitHub Actions CI (unit, API e2e, Playwright container)
- [x] Browser E2E green (Chromium mobile + desktop)
- [x] Vendored browser libs for local Linux without root
- [x] Temporary password → forced change flow
- [x] Public + admin health routes
- [x] Structured catch-up logs + admin health panel
- [x] Live reconnect backoff + connection warning
- [x] Route lazy-loading performance
- [x] Restart recovery smoke + rehearsal script

## Completed — Prompt 6

- Playwright scaffolding, API e2e, backfill, recovery, deploy pack

## Completed — Prompt 5–2

- Records, admin, retention, live UX, management economy, shared world

## Deferred (post-RC)

- Transfers, training, contracts, wages
- Manual substitutions, chat, native apps, real money
- External APM platforms
