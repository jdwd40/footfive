// Require the existing FootFive CI jobs, including their presence, on this SHA.
import { execFileSync } from "node:child_process";

const head = process.argv[2];
const repo = process.env.GH_REPO;
if (!/^[0-9a-f]{40}$/.test(head ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  throw new Error("Expected exact commit SHA and GH_REPO");
}
const pages = JSON.parse(execFileSync("gh", ["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`, "--paginate", "--slurp"], { encoding: "utf8" }));
if (!Array.isArray(pages) || !pages.length || pages.some((p) => !Array.isArray(p.check_runs))) throw new Error("Invalid CI response");
const runs = pages.flatMap((p) => p.check_runs);
for (const name of ["Unit / type / lint / build", "PocketBase API E2E", "Playwright Chromium"]) {
  const matching = runs.filter((r) => r.name === name && r.app?.slug === "github-actions");
  if (matching.some((r) => !Number.isSafeInteger(r.id))) throw new Error(`Invalid check identity: ${name}`);
  const latest = matching.sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.head_sha !== head || latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Error(`Required CI is missing or not successful for ${head}: ${name}`);
  }
}
console.log(`All three FootFive CI jobs succeeded for ${head}`);
