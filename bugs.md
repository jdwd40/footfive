# Bugs

## Open

No blocker in the latest bounded pitch/ends QA; final review and human preview feel remain pending.

## Fixed — 2026-10-05 pitch/ends follow-up (independent QA PASS; not shipped)

- Actual ticker/shootout chrome clipped the pitch/commentary; completed winner/auto-return added a further clipping case — compacted that chrome without shrinking the enlarged pitch. Normal, setup and completed scenes pass at 320x568, 390x844, 768x1024, 1280x720 and 1440x900 for the tested actual-engine inputs, not every arbitrary text/browser combination.
- Teams kept canonical ends on screen — event-snapshot display projection now swaps halves and ET halves, with one coherent shootout end. Off-centre ET switches initially teleported the ball — presentation ball now eases to centre during the existing break walk-off before reflection; engine coordinates/events/RNG unchanged.
- Referee smaller than players, keeper/away strokes heavier — every actor now has base radius 1.45/stroke 0.3.
- Named event participants received rings without possession — only the semantic carrier at rendered grounded contact gets a ring; free-flight and uncollected receivers remain unmarked.

## Fixed — 2026-10-05 live polish

- Generic "NO GOAL" badge for blocks/misses — concrete WIDE / OVER / BLOCKED / SAVED! / WOODWORK badges from the engine outcome.
- Attacker drawn standing in the opponent keeper's hands after a failed attack — engine now tracks the ball holder; turnovers render as a keeper/defender clearance.
- Saving side's own next pass drawn with an outfielder standing on his keeper — launched by the keeper (scenes.ts; QA fix wave 1).
- Save/block/woodwork left the ball loose with nobody on it — keeper gathers, blocker collects the rebound.
- First move after half-time/extra-time ran via the old ball spot — period restarts reset the ball to the centre.
- Pitch overflowed the viewport on 1280x720 (only ~45% visible) — pitch box height-capped; score/clock HUD on the pitch.
- Referee darted across the centre line and moved with the ball during penalty kicks — slower trailing rule, fixed spot at the box corner for pens/shootouts.

## Fixed in Phase 12

- Admin screen never appeared after login — always redirected to dashboard with no Admin nav.
- Long team names broke tickers — canonical 3-letter abbreviations on compact views.

## Fixed in Phase 11

- Live commentary too fast — server turbo (~200ms/min) + short frontend holds.
- Admin login for `admin@admin.com` failed — account missing under that email; repaired.

## Design rules (not bugs)

- **Global management lock** while any fixture in the current shared round is live. Matches simultaneous kickoffs. Documented in `deploy/DEPLOY.md` and project plan.

## Non-blocking / future

- Optional Firefox E2E (`E2E_FIREFOX=1`) not in default CI.
- Pre-existing (2026-10-04 engine): displayed clock can rewind a few seconds after a bounce / save / block / card / goal because the result hold is not folded into the next event's `clk.s` (`matchEngine.js` `Ctx.prototype.s`). Parked, not touched by the live polish branch.
- Carrier/contact limitation: fast dribble or striker smoothing can leave the ball ahead of the actor and correctly suppress the ring; no continuous-highlight guarantee.
- Detailed shootout board and expanded ticker may require scrolling; compact critical HUD remains visible in the tested scenes. Laptop/desktop completed commentary has only ~6px spare margin; broader text/browser coverage is not certified.
- Human preview feel remains pending (including HUD footprint and existing period-banner edge clamping); automated/bounded pixel QA is not exhaustive feel approval.
- Production world may still use `pace=dev` from first install — operator can set `normal` via admin when desired (does not alter live scores).

## Fixed in Phase 10

- Matches stuck past 90' when `state_json` flags lost — phase recovery + safe JSON persist.
- Championship appeared not to start/progress — R16 recovered; QF auto-started on schedule.
- Intermittent false connection warnings — fail thresholds + ignore abort/hidden-tab.
- Missing between-round admin control — `between_round_minutes` default 3.

## Fixed in Phase 7–9

- Playwright libs, password-change UI, health surface, bootstrap race, smoke users, git baseline, backups.
