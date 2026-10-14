import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REVIEW_LABEL = "fable-review";
export const MARKER = "<!-- footfive-fable-review:v1 -->";
const DEFAULT_REPO = "jdwd40/footfive";
const SHA = /^[a-f0-9]{40}(?![\s\S])/i;

function validRepo(repo) {
  return typeof repo === "string" && repo === repo.trim() && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i.test(repo) && ![".", ".."].includes(repo.split("/")[1]);
}

function parseRecord(body) {
  const text = body.trimStart();
  if (!text.startsWith(MARKER)) throw new Error("Review marker must start the comment");
  const fence = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?:\r?\n|$)/.exec(text.slice(MARKER.length));
  if (!fence) throw new Error("Expected one fenced JSON record after the marker");
  const r = JSON.parse(fence[1]);
  if (!r || typeof r !== "object" || Array.isArray(r) ||
      ![1, 2].includes(r.round) || r.model !== "claude-fable-5-1" || typeof r.headSha !== "string" || !SHA.test(r.headSha) ||
      !["reserved", "complete"].includes(r.status) || !Array.isArray(r.findings) ||
      (r.status === "reserved" && Object.hasOwn(r, "verdict")) ||
      (r.status === "complete" && !["SHIP", "DO NOT SHIP"].includes(r.verdict)) ||
      r.findings.some((f) => !f || typeof f !== "object" || Array.isArray(f) || !["blocker", "major", "minor", "info"].includes(f.severity))) {
    throw new Error("Invalid review record schema");
  }
  return r;
}

/** Pure gate over GitHub PR/comment responses. One owner comment per round;
 * the writer edits its reservation to complete. Only the latest completed round
 * supplies the current verdict; all historical records must remain well formed. */
export function evaluateGate({ pr, comments, repo = DEFAULT_REPO } = {}) {
  const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
  if (!validRepo(repo) || !pr || typeof pr.head?.sha !== "string" || !SHA.test(pr.head.sha) ||
      !Array.isArray(pr.labels) || pr.labels.some((l) => typeof l?.name !== "string" || !l.name)) {
    return fail("invalid-state", "Missing or invalid repository, PR head or labels");
  }
  const headSha = pr.head.sha.toLowerCase();
  if (!pr.labels.some((l) => l.name.toLowerCase() === REVIEW_LABEL)) {
    return { ok: true, code: "not-required", reason: "PR is not labelled for Fable review", headSha };
  }
  if (!Array.isArray(comments)) return fail("invalid-state", "Review comments are unavailable", { headSha });
  const owner = repo.split("/")[0].toLowerCase();
  const records = [];
  for (const c of comments) {
    if (typeof c?.user?.login !== "string" || !c.user.login) return fail("invalid-state", "Comment author is unavailable");
    if (c.user.login.toLowerCase() !== owner) continue;
    if (typeof c.body !== "string") return fail("invalid-state", "Owner comment body is unavailable");
    if (!c.body.includes("<!-- footfive-fable-review:")) continue;
    try {
      if (!Number.isSafeInteger(c.id) || c.id <= 0) throw new Error("Invalid comment identity");
      records.push({ ...parseRecord(c.body), id: c.id }); // Metadata cannot replace the API comment identity.
    } catch {
      return fail("malformed-record", "A trusted review record is malformed", { headSha });
    }
  }
  records.sort((a, b) => a.id - b.id);
  const roundsUsed = records.length;
  const extra = { headSha, roundsUsed, action: roundsUsed === 0 ? "requestInitial" : roundsUsed === 1 ? "requestFollowup" : "none" };
  if (!roundsUsed) return fail("missing-review", "No trusted Fable review record", extra);
  if (roundsUsed > 2) return fail("round-limit", "More than two review rounds recorded; no third review", extra);
  if (records.some((r, i) => r.round !== i + 1 || (i && r.id === records[i - 1].id))) {
    return fail("round-order", "Review rounds must occur exactly once in order 1, 2", extra);
  }
  if (records.some((r) => r.status === "reserved")) return fail("pending-review", "A review reservation is unfinished", { ...extra, action: "none" });
  const latest = records.at(-1);
  const first = records[0];
  if (roundsUsed === 2 && latest.verdict === "SHIP" && first.headSha.toLowerCase() === latest.headSha.toLowerCase() &&
      (first.verdict === "DO NOT SHIP" || first.findings.some((f) => ["blocker", "major"].includes(f.severity)))) {
    return fail("unchanged-blocked-head", "A blocking first review requires a changed head before SHIP on round 2", extra);
  }
  if (latest.headSha.toLowerCase() !== headSha) return fail("stale-review", "Latest review is for a different PR head", extra);
  if (latest.verdict !== "SHIP") return fail("do-not-ship", "Latest review says DO NOT SHIP", extra);
  if (latest.findings.some((f) => ["blocker", "major"].includes(f.severity))) {
    return fail("blocking-findings", "Latest review has unresolved blocker or major findings", extra);
  }
  return { ok: true, code: "ship", reason: "Latest trusted Fable review approves this exact head", ...extra, action: "none" };
}

/** Dependency injection keeps CLI transport tests offline; the executable uses gh only. */
export function main(argv = process.argv.slice(2), { env = process.env, run = spawnSync, out = console.log } = {}) {
  const json = argv.includes("--json");
  let result;
  try {
    const args = argv.filter((a) => a !== "--json");
    if (args.length !== 2 || args[0] !== "check" || !/^[1-9]\d*$/.test(args[1]) || args[1] !== args[1].trim() || !Number.isSafeInteger(Number(args[1])) || argv.filter((a) => a === "--json").length > 1) {
      throw new Error("Usage: node scripts/fable-review.mjs check PR_NUMBER [--json]");
    }
    const repo = env.GH_REPO ?? env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
    if (!validRepo(repo)) throw new Error("Repository must be OWNER/REPO");
    const number = Number(args[1]);
    const api = (endpoint) => {
      const r = run("gh", ["api", "--method", "GET", endpoint], { encoding: "utf8", env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error(`GitHub API request failed: ${endpoint}`);
      try { return JSON.parse(r.stdout); } catch { throw new Error("GitHub API returned invalid JSON"); }
    };
    const readPr = () => {
      const pr = api(`repos/${repo}/pulls/${number}`);
      if (pr?.number !== number || pr?.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error("GitHub PR identity is missing or mismatched");
      return pr;
    };
    let pr = readPr();
    result = evaluateGate({ pr, comments: [], repo });
    if (result.code !== "not-required" && result.code !== "invalid-state") {
      const comments = [];
      let lastId = 0;
      for (let page = 1; ; page++) {
        const rows = api(`repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(rows) || rows.length > 100) throw new Error("GitHub API returned invalid comment pagination");
        for (const row of rows) {
          if (!Number.isSafeInteger(row?.id) || row.id <= lastId) throw new Error("GitHub comment pagination is missing identities or is unstable");
          lastId = row.id;
        }
        comments.push(...rows);
        if (rows.length < 100) break;
      }
      // Re-read after pagination: never approve using the head/label fetched before it.
      pr = readPr();
      result = evaluateGate({ pr, comments, repo });
    }
  } catch (error) {
    result = { ok: false, code: "api-or-input-error", reason: error.message };
  }
  out(json ? JSON.stringify(result) : `${result.ok ? "PASS" : "BLOCKED"}: ${result.reason}${result.action && result.action !== "none" ? ` (${result.action}; informational only)` : ""}`);
  return result.ok ? 0 : 1;
}

let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported without an executable path. */ }
if (isMain) process.exitCode = main();
