import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const head = "a".repeat(40);
const names = ["Unit / type / lint / build", "PocketBase API E2E", "Playwright Chromium"];
const run = (name, id) => ({ name, id, app: { slug: "github-actions" }, head_sha: head, status: "completed", conclusion: "success" });

// Invoke the real shell merge path and both Node guards. Only gh is replaced;
// even the positive case records an offline fake merge without network access.
function merge(runs, { currentHead = head, checksFail = false, normal = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "footfive-merge-guard-"));
  dirs.push(dir);
  const stateFile = path.join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ runs, currentHead, checksFail, calls: [] }));
  writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.FABLE_TEST_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
st.calls.push(args);
fs.writeFileSync(file, JSON.stringify(st));
if (args.includes('merge')) process.exit(0);
if (args.includes('checks')) process.exit(st.checksFail ? 1 : 0);
if (args.includes('view')) { process.stdout.write(st.currentHead); process.exit(0); }
if (args.some(x => x.includes('/check-runs?'))) process.stdout.write(JSON.stringify([{check_runs:st.runs}]));
else if (args.includes('api')) process.stdout.write(JSON.stringify({number:101,base:{repo:{full_name:'jdwd40/footfive'}},head:{sha:st.currentHead},labels:[]}));
else process.exit(2);
`, { mode: 0o700 });
  const script = fileURLToPath(new NodeURL("./merge-reviewed-pr.sh", import.meta.url));
  const result = spawnSync("bash", [script, "101", head, ...(normal ? ["--normal-review-ship"] : [])], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GH_REPO: "jdwd40/footfive", FABLE_TEST_STATE: stateFile },
  });
  const calls = JSON.parse(readFileSync(stateFile, "utf8")).calls;
  return { result, merged: calls.some((c) => c.includes("merge")), calls };
}

test("successful Fable check alone cannot replace any required FootFive CI job", () => {
  for (const runs of [[run("Fable review", 4)], ...names.map((missing) => names.filter((n) => n !== missing).map(run))]) {
    const r = merge(runs);
    expect(r.result.status).not.toBe(0);
    expect(r.merged).toBe(false);
  }
});

test("required CI must succeed, on this head, from GitHub Actions", () => {
  for (const patch of [
    { status: "in_progress", conclusion: null }, { conclusion: "skipped" },
    { conclusion: "failure" }, { head_sha: "b".repeat(40) }, { app: { slug: "other-app" } },
  ]) {
    const runs = names.map(run);
    runs[0] = { ...runs[0], ...patch };
    const r = merge(runs);
    expect(r.result.status).not.toBe(0);
    expect(r.merged).toBe(false);
  }
});

test("latest rerun must succeed and other checks must also pass", () => {
  const runs = names.map(run);
  const pending = merge([...runs, { ...run(names[0], 99), status: "queued", conclusion: null }]);
  expect(pending.merged).toBe(false);
  expect(merge(runs, { checksFail: true }).merged).toBe(false);
});

test("normal review acknowledgement and matching current head are required", () => {
  expect(merge(names.map(run), { normal: false }).merged).toBe(false);
  expect(merge(names.map(run), { currentHead: "b".repeat(40) }).merged).toBe(false);
});

test("successful CI and normal review use a merge bound to the expected head", () => {
  const r = merge(names.map(run));
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.merged).toBe(true);
  expect(r.calls.find((c) => c.includes("merge"))).toContain(head);
  expect(r.calls.filter((c) => c.some((s) => s.endsWith("/pulls/101")))).toHaveLength(2);
});
