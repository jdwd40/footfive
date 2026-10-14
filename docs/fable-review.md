# Fable review policy

Fable 5.1 is an additional reviewer for PRs with the `fable-review` label. It does
not replace the normal independent reviewer or CI. Unlabelled work receives no
Fable review. The lead verifies the actual model and preserves its selected
effort, session and pane; a tab name alone is not model evidence.

The user authorised this scope:

| Work | Label handling |
| --- | --- |
| Cosmetic shots #73 | One retrospective audit of merged PR #91 |
| World setup #16 | Existing PR #37 labelled; future PRs require Fable before merge |
| Command Charge #18, lineups #19, coaching order #20 | Label their PRs |
| E2E deploy gate #27, database backups #28 | Label their PRs |
| UI polish, playtest tweaks, match-viewing extras #79–#84 | Do not label |

The six queued issues carry the label as a reminder. The review workflow copies
the requirement to PRs with explicit closing references to those issues. For
`Refs`-only PRs, the lead adds it manually. Incidental mentions of an issue in a
test description or limitations section do not establish scope. Ask the user
before labelling uncertain work. Do not expand the retrospective audit list.

## Budget and evidence

1. Fetch the current PR head, labels and existing review records. Do not invoke
   Fable unless the PR is labelled. Check past reservations, including failed or
   interrupted attempts: removing/reapplying a label never resets the budget.
2. Before the initial invocation, create one owner-authored PR comment using the
   record format below with `round: 1` and `status: "reserved"`. Update that same
   comment after the result; do not create a second record for one invocation.
   Do not prompt a reviewer while an invocation is reserved or its outcome unknown.
3. Give Fable the exact commit, focused scope, relevant tests and normal review
   context. It must report concrete file/line evidence and end its entire review
   with exactly `SHIP` or `DO NOT SHIP`. It must not edit code or assign workers.
4. Publish the complete review in the same comment, mark the record `complete`,
   and copy its verdict and every unresolved finding without downgrading severity.
   A `SHIP` alongside any blocker/major still blocks merging. Keep resolved notes
   separately from the unresolved `findings` array.
5. Fix a blocker, obtain the normal reviewer’s required verification, and use the
   one remaining Fable invocation (`round: 2`) for the fix and directly affected
   behavior. This is a focused re-review, not a new broad audit. A stale approval
   after other fixes also needs the remaining re-review. If two invocations are
   exhausted or scope changes, stop and ask the user before any additional spend.

Place this marker and JSON at the start of the owner-authored comment; append the
actual review below it. The gate trusts the repository owner's authenticated
GitHub account as the lead's attestation, not arbitrary PR text or a model name
claimed by another commenter. It does not cryptographically attest model execution.

````markdown
<!-- footfive-fable-review:v1 -->
```json
{
  "round": 1,
  "model": "claude-fable-5-1",
  "headSha": "FULL_40_CHARACTER_COMMIT_SHA",
  "status": "reserved",
  "findings": []
}
```
````

A completed record also requires `"verdict": "SHIP"` or `"DO NOT SHIP"`.
Each finding has `severity` (`blocker`, `major`, `minor` or `info`) and should
include its location, failure and resolution condition. Include the observed
model/session, tested commit and actual checks in the accompanying report.

For the already-merged #91 audit, record the historical PR head and inspect the
deployed merge as well. A negative retrospective verdict cannot undo that merge:
record the findings, stop related shipping and arrange a reviewed remediation;
never claim it was a pre-merge review or silently roll production back.

## Checks and merge

`node scripts/fable-review.mjs check PR` reads live GitHub labels, the exact head
and all owner review records. It fails closed on missing, pending, stale,
malformed, blocking or over-budget evidence. It never invokes a model. Unlabelled
PRs pass without reading review records or spending Fable budget.

The GitHub workflow runs trusted default-branch code only, publishes a `Fable
review` check and responds to label/head/review-record changes. It never executes
PR code with write permissions and never calls a paid review service. The lead's
merge wrapper additionally requires the normal-review acknowledgement and successful
GitHub Actions results for all three existing FootFive CI jobs on the exact SHA:
unit/type/lint/build, PocketBase API E2E and Playwright Chromium. Missing, skipped,
pending or failed jobs block merging; other published checks must also pass.
A head change during workflow verification produces a failed check, never an
approval attributed to the earlier commit.

GitHub branch protection is unavailable on this private repository's current
plan (API returns HTTP 403). The check is visible but cannot be made a required
server-side merge rule here. The lead must use the wrapper and respect this
policy; direct GitHub merges by other actors remain technically possible.
