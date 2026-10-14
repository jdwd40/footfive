// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";

const helper = fileURLToPath(new NodeURL("../../scripts/verify-deploy-ci.mjs", import.meta.url));
const repo = "jdwd40/footfive";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const required = ["Unit / type / lint / build", "PocketBase API E2E", "Playwright Chromium"];
const runsEndpoint = `repos/${repo}/actions/workflows/footfive-ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`;
const mainEndpoint = `repos/${repo}/git/ref/heads/main`;
const jobsEndpoint = (id: number) => `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`;
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 10, head_sha: sha, path: ".github/workflows/footfive-ci.yml", event: "push",
  head_branch: "main", repository: { full_name: repo }, head_repository: { full_name: repo },
  status: "completed", conclusion: "success", ...overrides,
});
const job = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: required.indexOf(name) + 100, name, run_id: 10, head_sha: sha,
  status: "completed", conclusion: "success", ...overrides,
});
const responses = (): Record<string, unknown> => ({
  [runsEndpoint]: [{ workflow_runs: [run()] }],
  [jobsEndpoint(10)]: [{ jobs: required.map((name) => job(name)) }],
  [mainEndpoint]: { object: { sha } },
});
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Every gh call is intercepted, including unexpected endpoints; no network fallback.
function check(data = responses(), flags: string[] = [], options: { sha?: string; repo?: string; apiFailure?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ff27-deploy-gate-"));
  scratch.push(dir);
  const fixture = join(dir, "responses.json");
  const trace = join(dir, "calls.jsonl");
  writeFileSync(fixture, JSON.stringify(data));
  writeFileSync(trace, "");
  writeFileSync(join(dir, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FF27_TRACE, JSON.stringify(args) + '\\n');
const data = JSON.parse(fs.readFileSync(process.env.FF27_FIXTURE, 'utf8'));
if (process.env.FF27_API_FAILURE === '1' || args[0] !== 'api' || !Object.hasOwn(data, args[1])) process.exit(42);
process.stdout.write(JSON.stringify(data[args[1]]));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [helper, options.sha ?? sha, ...flags], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: options.repo ?? repo,
      FF27_FIXTURE: fixture, FF27_TRACE: trace, FF27_API_FAILURE: options.apiFailure ? "1" : "0" },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { ...result, calls: readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}
function blocked(result: ReturnType<typeof check>, message: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout).not.toContain("passed FootFive CI");
}

describe("actual deployment CI gate (offline gh)", () => {
  it("accepts exact-SHA trusted main push with all three jobs and reads current main last", () => {
    const result = check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${sha} passed FootFive CI run 10`);
    expect(result.calls).toEqual([
      ["api", runsEndpoint, "--paginate", "--slurp"],
      ["api", jobsEndpoint(10), "--paginate", "--slurp"],
      ["api", mainEndpoint],
    ]);
  });

  it("finds the latest run and required jobs across multiple pages", () => {
    const data = responses();
    data[runsEndpoint] = [{ workflow_runs: [run({ id: 9, conclusion: "failure" })] }, { workflow_runs: [run()] }];
    data[jobsEndpoint(10)] = [
      { jobs: [job(required[0], { id: 90, conclusion: "failure" }), job(required[1])] },
      { jobs: [job(required[0]), job(required[2])] },
    ];
    expect(check(data).status).toBe(0);
  });

  it.each([
    ["missing", []],
    ["wrong SHA", [run({ head_sha: otherSha })]],
    ["wrong workflow", [run({ path: ".github/workflows/other.yml" })]],
    ["non-main", [run({ head_branch: "feature" })]],
    ["non-push", [run({ event: "pull_request" })]],
    ["foreign repository", [run({ repository: { full_name: "foreign/footfive" } })]],
    ["foreign head repository", [run({ head_repository: { full_name: "foreign/footfive" } })]],
  ])("rejects %s runs", (_label, runs) => {
    const data = responses();
    data[runsEndpoint] = [{ workflow_runs: runs }];
    const result = check(data);
    blocked(result, "no FootFive CI push run");
    expect(result.calls).toHaveLength(1);
  });

  it.each([
    ["completed", "failure"], ["in_progress", null], ["queued", null],
    ["completed", "skipped"], ["completed", "cancelled"],
  ])("rejects latest run %s/%s despite an older success", (status, conclusion) => {
    const data = responses();
    data[runsEndpoint] = [{ workflow_runs: [run({ id: 9 })] }, { workflow_runs: [run({ status, conclusion })] }];
    blocked(check(data), "latest FootFive CI run 10");
  });

  for (const name of required) {
    it.each([
      ["missing", null], ["failed", { conclusion: "failure" }],
      ["pending", { status: "in_progress", conclusion: null }],
      ["skipped", { conclusion: "skipped" }], ["cancelled", { conclusion: "cancelled" }],
      ["wrong SHA", { head_sha: otherSha }], ["wrong run", { run_id: 9 }],
    ])(`rejects ${name}: %s`, (_label, overrides) => {
      const data = responses();
      data[jobsEndpoint(10)] = [{ jobs: required.filter((n) => n !== name).map((n) => job(n))
        .concat(overrides === null ? [] : [job(name, overrides)]) }];
      blocked(check(data), `did not pass "${name}"`);
    });
  }

  it("does not let an older successful job mask a newer failed attempt on another page", () => {
    const data = responses();
    data[jobsEndpoint(10)] = [{ jobs: required.map((name) => job(name)) },
      { jobs: [job(required[2], { id: 200, conclusion: "failure" })] }];
    blocked(check(data), `did not pass "${required[2]}"`);
  });

  it.each([otherSha, undefined])("rejects different or missing current main (%s)", (main) => {
    const data = responses();
    data[mainEndpoint] = { object: { sha: main } };
    blocked(check(data), "not " + sha);
  });

  it("rollback skips only the current-main check", () => {
    const data = responses();
    delete data[mainEndpoint]; // Any attempt to read it fails in the offline gh.
    const result = check(data, ["--rollback"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("emergency rollback");
    expect(result.calls).toHaveLength(2);
  });

  it.each(["run", "job", "trust"])("rollback still rejects failing %s evidence", (failure) => {
    const data = responses();
    data[mainEndpoint] = { object: { sha: otherSha } };
    if (failure === "run") data[runsEndpoint] = [{ workflow_runs: [run({ conclusion: "failure" })] }];
    if (failure === "trust") data[runsEndpoint] = [{ workflow_runs: [run({ head_branch: "feature" })] }];
    if (failure === "job") data[jobsEndpoint(10)] = [{ jobs: required.slice(0, 2).map((name) => job(name)) }];
    expect(check(data, ["--rollback"]).status).toBe(1);
  });

  it.each([runsEndpoint, jobsEndpoint(10)])("fails closed on malformed pagination at %s", (endpoint) => {
    const data = responses();
    data[endpoint] = [{}, null];
    blocked(check(data), "invalid GitHub response");
  });

  it("fails closed on GitHub API failure", () => {
    expect(check(responses(), [], { apiFailure: true }).status).not.toBe(0);
  });

  it.each([
    { sha: "main" }, { sha: sha + ";echo unsafe" }, { repo: "" }, { repo: "owner/repo/extra" },
  ])("rejects invalid input before invoking gh: %j", (options) => {
    const result = check(responses(), [], options);
    blocked(result, "usage:");
    expect(result.calls).toEqual([]);
  });

  it("rejects unrecognized options before invoking gh", () => {
    const result = check(responses(), ["--force"]);
    blocked(result, "usage:");
    expect(result.calls).toEqual([]);
  });
});
