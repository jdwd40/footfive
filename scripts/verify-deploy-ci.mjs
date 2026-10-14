#!/usr/bin/env node
// Deployment gate shared by .github/workflows/deploy.yml and deploy/deploy.sh.
// A commit may deploy only when the latest FootFive CI run pushed to main in this
// repository for exactly that SHA passed all three required jobs. A new release
// must also still be the main head; --rollback allows an older tested main commit
// for an emergency rollback. Reads GitHub only; never deploys or writes.
import { execFileSync } from "node:child_process";

const WORKFLOW = ".github/workflows/footfive-ci.yml";
const REQUIRED = ["Unit / type / lint / build", "PocketBase API E2E", "Playwright Chromium"];

function fail(message) {
  console.error(`Deploy gate: ${message}`);
  process.exit(1);
}

const [sha, ...flags] = process.argv.slice(2);
const repo = process.env.GH_REPO;
const rollback = flags.length === 1 && flags[0] === "--rollback";
if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || (flags.length > 0 && !rollback)) {
  fail("usage: GH_REPO=owner/repo node scripts/verify-deploy-ci.mjs FULL_40_CHARACTER_SHA [--rollback]");
}

const gh = (args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
const list = (endpoint, key) => {
  const pages = gh([endpoint, "--paginate", "--slurp"]);
  if (!Array.isArray(pages) || !pages.length || pages.some((p) => !Array.isArray(p?.[key]))) {
    fail(`invalid GitHub response for ${endpoint}`);
  }
  return pages.flatMap((p) => p[key]);
};
const latest = (items) => items.filter((x) => Number.isSafeInteger(x.id)).sort((a, b) => b.id - a.id)[0];

const run = latest(list(`repos/${repo}/actions/workflows/footfive-ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`, "workflow_runs")
  .filter((r) => r.head_sha === sha && r.path === WORKFLOW && r.event === "push" && r.head_branch === "main"
    && r.repository?.full_name === repo && r.head_repository?.full_name === repo));
if (!run) fail(`no FootFive CI push run on main in ${repo} for ${sha}`);
if (run.status !== "completed" || run.conclusion !== "success") {
  fail(`latest FootFive CI run ${run.id} for ${sha} is ${run.status}/${run.conclusion}`);
}

const jobs = list(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, "jobs");
for (const name of REQUIRED) {
  const job = latest(jobs.filter((j) => j.name === name && j.run_id === run.id && j.head_sha === sha));
  if (!job || job.status !== "completed" || job.conclusion !== "success") {
    fail(`FootFive CI run ${run.id} did not pass "${name}" for ${sha} (${job ? `${job.status}/${job.conclusion}` : "missing"})`);
  }
}

if (!rollback) {
  const main = gh([`repos/${repo}/git/ref/heads/main`]).object?.sha;
  if (main !== sha) {
    fail(`main is at ${main ?? "an unknown commit"}, not ${sha}; a new release deploys the main head (use --rollback only for an emergency rollback)`);
  }
}
console.log(`Deploy gate: ${sha} passed FootFive CI run ${run.id} (${REQUIRED.join(", ")})${rollback ? "; emergency rollback to an older tested main commit" : "; it is the main head"}`);
