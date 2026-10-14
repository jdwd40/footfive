import { afterEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const repo = "jdwd40/footfive";
const head = "a".repeat(40);
const issue = (number, repository = repo) => ({ number, url: `https://github.com/${repository}/issues/${number}` });

// Exercise the actual workflow entry point and gate, with every gh operation
// confined to a disposable fake executable. No network, model or repository write.
function workflow({ linked = [], labelled = false, state = "OPEN", event = { pull_request: { number: 101 } }, record, movedHead } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "footfive-fable-policy-"));
  dirs.push(dir);
  const stateFile = path.join(dir, "state.json");
  const eventFile = path.join(dir, "event.json");
  writeFileSync(stateFile, JSON.stringify({ linked, labelled, state, record, movedHead, calls: [] }));
  writeFileSync(eventFile, JSON.stringify(event));
  writeFileSync(path.join(dir, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.FABLE_TEST_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
let body;
if (args.includes('--input')) body = JSON.parse(fs.readFileSync(0, 'utf8'));
st.calls.push({args, body});
const endpoint = args.find(x => x.startsWith('repos/')) || '';
let result;
if (args[0] === 'pr') result = {state: st.state, headRefOid: '${head}', labels: st.labelled ? [{name:'fable-review'}] : [], closingIssuesReferences:st.linked};
else if (endpoint.endsWith('/labels')) { st.labelled = true; result = []; }
else if (endpoint.endsWith('/pulls/101')) result = {number:101, base:{repo:{full_name:'${repo}'}}, head:{sha:st.movedHead || '${head}'}, labels:st.labelled ? [{name:'fable-review'}] : []};
else if (endpoint.includes('/comments?')) result = st.record ? [{id:1,user:{login:'jdwd40'},body:'<!-- footfive-fable-review:v1 -->\\n'+String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify(st.record)+'\\n'+String.fromCharCode(96).repeat(3)+'\\n\\nSHIP'}] : [];
else if (endpoint.endsWith('/check-runs')) result = {};
else { process.stderr.write('unexpected gh operation'); process.exit(2); }
fs.writeFileSync(file, JSON.stringify(st));
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(new NodeURL("./fable-check-workflow.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: repo, GITHUB_EVENT_PATH: eventFile, FABLE_TEST_STATE: stateFile },
  });
  return { result, ...JSON.parse(readFileSync(stateFile, "utf8")) };
}

test("unrelated and viewing-extras PRs pass without label writes or review-record reads", () => {
  for (const linked of [[], [issue(79)], [issue(73)], [issue(16, "someone/else")]]) {
    const r = workflow({ linked });
    expect(r.result.status, r.result.stderr).toBe(0);
    expect(r.labelled).toBe(false);
    expect(r.calls.some((c) => c.args.some((s) => /comments\?|\/labels$/.test(s)))).toBe(false);
    expect(r.calls.find((c) => c.body?.name === "Fable review").body.conclusion).toBe("success");
  }
});

test("each authorised closing issue inherits the label and blocks until reviewed", () => {
  for (const n of [16, 18, 19, 20, 27, 28]) {
    const r = workflow({ linked: [issue(n)] });
    expect(r.result.status).toBe(1);
    expect(r.calls.find((c) => c.body?.labels).body.labels).toEqual(["fable-review"]);
    expect(r.calls.find((c) => c.body?.name === "Fable review").body.conclusion).toBe("failure");
  }
});

test("mixed authorised and excluded scope requires a decision without adding a label", () => {
  const r = workflow({ linked: [issue(16), issue(81)] });
  expect(r.result.status).toBe(1);
  expect(r.labelled).toBe(false);
  expect(r.calls.some((c) => c.body?.labels)).toBe(false);
  expect(r.result.stdout).toContain("ask the user");
});

test("a labelled exact-head SHIP passes, but DO NOT SHIP or a major finding blocks", () => {
  const record = { round: 1, model: "claude-fable-5-1", headSha: head, status: "complete", verdict: "SHIP", findings: [] };
  for (const [patch, expected] of [[{}, 0], [{ verdict: "DO NOT SHIP" }, 1], [{ findings: [{ severity: "major" }] }, 1]]) {
    const r = workflow({ labelled: true, record: { ...record, ...patch } });
    expect(r.result.status, r.result.stderr).toBe(expected);
    expect(r.calls.find((c) => c.body?.name === "Fable review").body.head_sha).toBe(head);
  }
});

test("closed historical PRs do not trigger new labels or review checks", () => {
  const r = workflow({ state: "MERGED", linked: [issue(16)], labelled: true, event: { issue: { number: 101, pull_request: {} } } });
  expect(r.result.status).toBe(0);
  expect(r.calls).toHaveLength(1);
});


test("a moving PR head cannot approve the earlier commit", () => {
  const movedHead = "b".repeat(40);
  const record = { round: 1, model: "claude-fable-5-1", headSha: movedHead, status: "complete", verdict: "SHIP", findings: [] };
  const r = workflow({ labelled: true, movedHead, record });
  expect(r.result.status).toBe(1);
  const check = r.calls.find((c) => c.body?.name === "Fable review").body;
  expect(check.head_sha).toBe(head);
  expect(check.conclusion).toBe("failure");
  expect(check.output.summary).toContain("head changed");
});
