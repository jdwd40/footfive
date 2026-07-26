# Bugs

## Open

None release-blocking.

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
- Production world may still use `pace=dev` from first install — operator can set `normal` via admin when desired (does not alter live scores).

## Fixed in Phase 10

- Matches stuck past 90' when `state_json` flags lost — phase recovery + safe JSON persist.
- Championship appeared not to start/progress — R16 recovered; QF auto-started on schedule.
- Intermittent false connection warnings — fail thresholds + ignore abort/hidden-tab.
- Missing between-round admin control — `between_round_minutes` default 3.

## Fixed in Phase 7–9

- Playwright libs, password-change UI, health surface, bootstrap race, smoke users, git baseline, backups.
