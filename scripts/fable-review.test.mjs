import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { URL as NodeURL } from "node:url";
import { MARKER, REVIEW_LABEL, evaluateGate, main } from "./fable-review.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const repo = "jdwd40/footfive";
const pr = (changes = {}) => ({ number: 91, base: { repo: { full_name: repo } }, head: { sha: HEAD }, labels: [{ name: REVIEW_LABEL }], ...changes });
const record = (round = 1, changes = {}) => {
  const r = { round, model: "claude-fable-5-1", headSha: HEAD, status: "complete", verdict: "SHIP", findings: [], ...changes };
  if (r.status === "reserved") delete r.verdict;
  return r;
};
const comment = (r = record(), id = 1, login = "jdwd40") => ({ id, user: { login }, body: `${MARKER}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`` });
const gate = (comments, changes = {}) => evaluateGate({ pr: pr(), comments, repo, ...changes });
const blocked = (result, code) => { assert.equal(result.ok, false); assert.equal(result.code, code); };

test("unlabelled PR passes without comment state", () => {
  assert.equal(evaluateGate({ pr: pr({ labels: [] }) }).code, "not-required");
});

test("labelled PR without a trusted record requests only informational initial review", () => {
  const result = gate([]);
  blocked(result, "missing-review");
  assert.equal(result.action, "requestInitial");
});

test("exact-head trusted SHIP permits minor/info findings and case-insensitive owner/SHA", () => {
  assert.equal(gate([comment(record(1, { headSha: HEAD.toUpperCase(), findings: [{ severity: "minor" }, { severity: "info" }] }), 5, "JDWD40")]).ok, true);
});

test("metadata, a complete trailing Markdown report, and CRLF fences are accepted", () => {
  const c = comment(record(1, { pane: "w7:pA", session: "existing", scope: [73], auditedCommit: OLD, extraMetadata: { note: "context" }, id: 999 }));
  c.body = c.body.replaceAll("\n", "\r\n") + "\r\n\r\n# Full review\r\nSHIP\r\n\r\n```js\r\nexample();\r\n```";
  assert.equal(gate([c, comment(record(2), 2)]).ok, true); // Metadata id cannot reorder records.
});

for (const severity of ["blocker", "major"]) {
  test(`${severity} finding blocks even when marked resolved or accompanied by SHIP`, () => {
    blocked(gate([comment(record(1, { findings: [{ severity, resolved: true }] }))]), "blocking-findings");
  });
}

test("latest DO NOT SHIP is a hard stop", () => {
  blocked(gate([comment(record(1, { verdict: "DO NOT SHIP" }))]), "do-not-ship");
});

test("stale first round requires followup; stale second round cannot request a third", () => {
  const first = comment(record(1, { headSha: OLD }));
  const one = gate([first]);
  blocked(one, "stale-review");
  assert.equal(one.action, "requestFollowup");
  const two = gate([first, comment(record(2, { headSha: OLD }), 2)]);
  blocked(two, "stale-review");
  assert.equal(two.action, "none");
});

test("a second complete round supersedes the first round's completed verdict/head/findings", () => {
  const old = comment(record(1, { verdict: "DO NOT SHIP", headSha: OLD, findings: [{ severity: "major" }] }));
  assert.equal(gate([comment(record(2), 20), old]).ok, true);
});

for (const changes of [{ verdict: "DO NOT SHIP" }, { findings: [{ severity: "blocker" }] }, { findings: [{ severity: "major" }] }]) {
  test(`blocking round 1 cannot become SHIP at unchanged head: ${JSON.stringify(changes)}`, () => {
    const first = comment(record(1, changes));
    blocked(gate([first, comment(record(2, { headSha: HEAD.toUpperCase() }), 2)]), "unchanged-blocked-head");
    assert.equal(gate([first, comment(record(2, { headSha: OLD }), 2)], { pr: pr({ head: { sha: OLD } }) }).ok, true);
  });
}

test("unfinished reservations block both as latest and as earlier history", () => {
  const reserved = comment(record(1, { status: "reserved" }));
  blocked(gate([reserved]), "pending-review");
  blocked(gate([reserved, comment(record(2), 2)]), "pending-review");
  blocked(gate([comment(), comment(record(2, { status: "reserved" }), 2)]), "pending-review");
});

test("editing a single reservation to complete uses one round", () => {
  const c = comment(record(1, { status: "reserved" }), 6169202349);
  blocked(gate([c]), "pending-review");
  c.body = comment(record()).body;
  assert.equal(gate([c]).roundsUsed, 1);
  assert.equal(gate([c]).ok, true);
});

test("label cycling does not reset the two-round lifetime budget", () => {
  const history = [comment(), comment(record(2), 2), comment(record(2), 3)];
  assert.equal(gate(history, { pr: pr({ labels: [] }) }).ok, true);
  const result = gate(history);
  blocked(result, "round-limit");
  assert.equal(result.action, "none");
});

test("missing initial, duplicate rounds, and reverse chronological rounds fail", () => {
  for (const history of [[comment(record(2))], [comment(), comment(record(), 2)], [comment(record(2)), comment(record(), 2)]]) blocked(gate(history), "round-order");
});

test("forged third-party records never approve or exhaust rounds", () => {
  const forged = comment(record(), 10, "outsider");
  forged.author_association = "OWNER";
  blocked(gate([forged]), "missing-review");
  forged.body = `${MARKER}\nnot JSON`;
  assert.equal(gate([comment(), forged, comment(record(2), 11, "another-outsider")]).roundsUsed, 1);
  assert.equal(gate([comment(), forged]).ok, true);
});

const invalidRecords = [
  { round: 3 }, { round: "1" }, { model: "other-model" }, { headSha: "short" }, { headSha: HEAD + "\n" },
  { status: "pending" }, { verdict: "ship" }, { findings: null }, { findings: [{ severity: "critical" }] },
];
for (const changes of invalidRecords) {
  test(`malformed trusted critical fields block: ${JSON.stringify(changes)}`, () => {
    blocked(gate([comment(record(1, changes)), comment(record(2), 2)]), "malformed-record");
  });
}

test("malformed fences, intervening header, invalid JSON, misplaced marker and reserved verdict fail closed", () => {
  const bodies = [
    `${MARKER}\n# Header before JSON\n${comment().body.split(MARKER)[1]}`,
    `${MARKER}\n\`\`\`json\n{bad}\n\`\`\``, `${MARKER}\n{}`, `prefix\n${comment().body}`,
    `${MARKER}\n\`\`\`json\n${JSON.stringify({ ...record(1, { status: "reserved" }), verdict: "SHIP" })}\n\`\`\``,
    "<!-- footfive-fable-review:v2 -->\n{}",
  ];
  for (const body of bodies) blocked(gate([{ ...comment(), body }]), "malformed-record");
});

test("missing API state fails closed", () => {
  for (const changes of [{ pr: null }, { pr: pr({ head: null }) }, { pr: pr({ labels: null }) }, { comments: null }, { comments: [{ body: comment().body }] }]) blocked(gate([], changes), "invalid-state");
});

function cli(responses, { args = ["check", "91", "--json"], env = { GH_REPO: repo } } = {}) {
  const calls = [];
  const output = [];
  const code = main(args, { env, out: (s) => output.push(s), run: (command, argv, options) => {
    assert.equal(command, "gh");
    assert.deepEqual(argv.slice(0, 3), ["api", "--method", "GET"]);
    assert.equal(options.shell, undefined);
    calls.push(argv[3]);
    assert.ok(responses.length, "unexpected API call");
    const next = responses.shift();
    return next?.failure ? next.failure : { status: 0, stdout: JSON.stringify(next) };
  } });
  return { code, result: JSON.parse(output[0]), calls };
}

test("CLI unlabelled check fetches PR only, with default repository", () => {
  const result = cli([pr({ labels: [] })], { env: {} });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, ["repos/jdwd40/footfive/pulls/91"]);
});

test("CLI paginates to a second page and rechecks current PR state", () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: "outsider" }, body: "discussion" }));
  const result = cli([pr(), first, [comment(record(), 101)], pr()]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, ["repos/jdwd40/footfive/pulls/91", "repos/jdwd40/footfive/issues/91/comments?per_page=100&page=1", "repos/jdwd40/footfive/issues/91/comments?per_page=100&page=2", "repos/jdwd40/footfive/pulls/91"]);
});

test("CLI head movement during pagination fails approval for old head", () => {
  const result = cli([pr(), [comment()], pr({ head: { sha: OLD } })]);
  assert.equal(result.code, 1);
  blocked(result.result, "stale-review");
});

test("CLI cannot skip an earlier owner round on a full first page", () => {
  const first = [comment(record(1, { status: "reserved" }))];
  for (let id = 2; id <= 100; id++) first.push({ id, user: { login: "outsider" }, body: "discussion" });
  const result = cli([pr(), first, [comment(record(2), 101)], pr()]);
  blocked(result.result, "pending-review");
});

test("CLI API failures, missing identity, invalid JSON and repeated pages fail closed", () => {
  for (const responses of [
    [{ failure: { status: 1, stderr: "failure" } }], [pr({ number: 92 })], [pr({ base: null })],
    [{ failure: { status: 0, stdout: "not json" } }], [pr(), null], [pr(), [{ user: { login: "jdwd40" }, body: "missing id" }]],
    [pr(), Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), [{ id: 100 }]],
  ]) assert.equal(cli(responses).code, 1);
});

test("CLI rejects invalid PR/repository inputs before executing gh", () => {
  for (const value of ["0", "-1", "1; touch /tmp/no", "1.5", "91\n", "9007199254740992"]) assert.equal(cli([], { args: ["check", value, "--json"] }).code, 1);
  for (const value of ["owner/repo;touch", "owner/../repo", "owner/..", "https://github.com/owner/repo", "owner/repo\n", ""]) assert.equal(cli([], { env: { GH_REPO: value } }).code, 1);
});

test("CLI honours repository environment precedence", () => {
  const custom = "someone/project";
  const customPr = pr({ labels: [], base: { repo: { full_name: custom } } });
  assert.equal(cli([customPr], { env: { GITHUB_REPOSITORY: custom } }).calls[0], `repos/${custom}/pulls/91`);
  assert.equal(cli([pr({ labels: [] })], { env: { GH_REPO: repo, GITHUB_REPOSITORY: custom } }).code, 0);
});

test("importing the CLI does not execute gh or print output", () => {
  const script = new NodeURL("./fable-review.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `process.argv[1]='/missing/executable'; await import(${JSON.stringify(script)});`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
