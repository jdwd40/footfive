# Bugs

## Open

None release-blocking.

## Production (P8)

- First install live; temporary `deploy_smoke_*` users may exist — disable via admin when ready.
- Workspace deployed without git tag (tree not a git repo at deploy time).

## Design rules (not bugs)

- **Global management lock** while any fixture in the current shared round is live. Matches simultaneous kickoffs. Documented in `deploy/DEPLOY.md` and project plan.

## Non-blocking / future

- Optional Firefox E2E (`E2E_FIREFOX=1`) not in default CI.
- Long multi-round browser tournament as a single test not required for RC (API + live UI flows cover critical paths).

## Fixed in Phase 7

- Playwright UI blocked on missing OS libs — vendored libs + CI Playwright container.
- `must_change_password` had no user-facing completion flow.
- No operational health surface for catch-up/stalls.
- Live match poll had no backoff / reconnect warning.
- Open P6 items on Playwright/CI/password/detail/backfill addressed in P6–P7.

## Fixed earlier

See Phase 5–6 sections in git history / prior `bugs.md` revisions.
