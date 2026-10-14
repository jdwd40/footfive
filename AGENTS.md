# Foot Five agent instructions

The lead is the sole orchestrator and integrator. Preserve existing changes and
agent models, effort settings, panes and sessions. Follow the current user scope.

## Required review before merge

Every PR needs the normal independent reviewer and green CI. A PR labelled
`fable-review` additionally needs Fable 5.1. Read [the review policy](docs/fable-review.md)
before requesting that review or merging a labelled PR.

- Never invoke Fable for an unlabelled PR, including UI polish, playtest tweaks and
  match-viewing extras #79–#84. Ask the user before adding the label outside the
  expressly authorised scope.
- Reserve and record each Fable invocation on its PR. One initial review and at
  most one focused review after fixes, across all revisions and label changes.
  Exhausted budget means stop and ask the user; never silently start a third run.
- Fable must end with `SHIP` or `DO NOT SHIP`. `DO NOT SHIP`, any blocker or any
  major issue is a hard stop until fixed and re-reviewed. The normal review limit
  never permits the lead to waive a Fable blocker.
- Freeze the reviewed head. A changed head invalidates approval. Keep both normal
  review evidence and the Fable record tied to the actual commit being merged.
- Use `bash scripts/merge-reviewed-pr.sh PR HEAD --normal-review-ship` after
  verifying the normal review. This checks the Fable requirement, all CI checks
  and the current head before merging. Do not bypass a failed review gate.

Approved issue scope for new PRs: #16, #18, #19, #20, #27 and #28. Carry the label
onto their PRs even when using `Refs` rather than `Closes`. The workflow can
automatically label explicit closing references; it never runs the model.
The one-off retrospective audit of #73 is PR #91 only. Labelling already-merged
PR #37 records the #16 requirement; it does not authorise another retrospective
Fable audit. No implementation of these queued issues is authorised by the
review-policy setup alone.
