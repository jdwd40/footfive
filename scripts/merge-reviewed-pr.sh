#!/usr/bin/env bash
# Lead-only merge path. Normal review remains an independent human/agent step.
set -euo pipefail
if [[ $# != 3 || ! $1 =~ ^[1-9][0-9]*$ || ! $2 =~ ^[0-9a-f]{40}$ || $3 != --normal-review-ship ]]; then
  echo 'Usage: bash scripts/merge-reviewed-pr.sh PR HEAD --normal-review-ship' >&2
  exit 2
fi
pr=$1
head=$2
export GH_REPO="${GH_REPO:-${GITHUB_REPOSITORY:-jdwd40/footfive}}"
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node "$script_dir/fable-review.mjs" check "$pr"
gh pr checks "$pr" --repo "$GH_REPO"
current=$(gh pr view "$pr" --repo "$GH_REPO" --json headRefOid --jq .headRefOid)
[[ $current == "$head" ]] || { echo 'PR head changed; review and verify the new commit.' >&2; exit 1; }
# Refresh the label/evidence check after waiting for any CI/API operations.
node "$script_dir/fable-review.mjs" check "$pr"
gh pr merge "$pr" --repo "$GH_REPO" --merge --match-head-commit "$head"
