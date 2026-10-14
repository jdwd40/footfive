// Runs only trusted default-branch code. No model invocation or PR-code execution.
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APPROVED = new Set([16, 18, 19, 20, 27, 28]);
const EXCLUDED = new Set([79, 80, 81, 82, 83, 84]);
const repo = process.env.GITHUB_REPOSITORY;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository context");
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null);
if (!Number.isSafeInteger(number) || number < 1) throw new Error("Missing PR context");
const ghJson = (args, body) => JSON.parse(execFileSync("gh", args, {
  encoding: "utf8", input: body === undefined ? undefined : JSON.stringify(body),
}));
const pr = ghJson(["pr", "view", String(number), "--repo", repo, "--json", "state,headRefOid,labels,closingIssuesReferences"]);
if (pr.state !== "OPEN") {
  console.log("Closed PR: historical audits are recorded on their PR, not run automatically.");
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(pr.headRefOid)) throw new Error("Invalid PR head");
const linked = pr.closingIssuesReferences.filter((issue) => issue.url === `https://github.com/${repo}/issues/${issue.number}`);
const approved = linked.some((issue) => APPROVED.has(issue.number));
const mixed = approved && linked.some((issue) => EXCLUDED.has(issue.number));
const labelled = pr.labels.some((label) => label.name === "fable-review");
let result;
if (mixed && !labelled) {
  result = { status: 1, stdout: "Mixed approved/excluded scope: ask the user before adding fable-review.", stderr: "" };
} else {
  if (approved && !labelled) ghJson(["api", `repos/${repo}/issues/${number}/labels`, "--method", "POST", "--input", "-"], { labels: ["fable-review"] });
  result = spawnSync(process.execPath, [fileURLToPath(new URL("./fable-review.mjs", import.meta.url)), "check", String(number), "--json"], {
    encoding: "utf8", env: { ...process.env, GH_REPO: repo },
  });
}
const summary = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").slice(0, 60000);
let evaluated;
try { evaluated = JSON.parse(result.stdout); } catch { /* Mixed scope and transport errors fail closed. */ }
const passed = result.status === 0 && !result.error && evaluated?.ok === true && evaluated.headSha === pr.headRefOid;
const detail = evaluated?.headSha && evaluated.headSha !== pr.headRefOid
  ? "PR head changed during verification; retry against its current head.\n" + summary : summary;
ghJson(["api", `repos/${repo}/check-runs`, "--method", "POST", "--input", "-"], {
  name: "Fable review", head_sha: pr.headRefOid, status: "completed",
  conclusion: passed ? "success" : "failure",
  output: { title: passed ? "Fable policy satisfied" : "Fable review required or blocked", summary: detail || "Review gate failed without output." },
});
console.log(detail);
if (!passed) process.exitCode = 1;
