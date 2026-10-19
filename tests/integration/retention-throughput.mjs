/**
 * Issues #4 and #22. Disposable loopback PocketBase; stops only this process.
 * Port RETENTION_PB_PORT default 8311 (lead local 8322). Hooks RETENTION_HOOKS
 * or the worktree pocketbase/pb_hooks. Migrations and binary stay on the worktree.
 * Same assertions for baseline and current. PHASE is an evidence label.
 *
 * Extends the passing probe: 201 bulk eligible fixtures (plus positive controls), 220 older blocked
 * fixtures and 220 already-purged fillers so status counts pass 500, production
 * admin retention routes, and one records-detail read. Protections, the late
 * match_events delete fault, and the scan window are the probe's.
 */
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_SRC = process.env.RETENTION_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const MIGRATIONS = path.join(ROOT, "pocketbase/pb_migrations");
const PB = path.join(ROOT, "pocketbase/pocketbase");
const PHASE = process.env.RETENTION_HOOKS ? "baseline" : "current";
const APP_PASS = "testpass99";
const PORT = (() => {
  const raw = process.env.RETENTION_PB_PORT || "8311";
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
})();
const DAY = 86400000;
const FILLER = 220;
const pbDate = (ms) => new Date(ms).toISOString().replace("T", " ");
const checks = [];
const check = (name, kind, ok, detail = "") => {
  const text = ok ? "" : String(detail).split(APP_PASS).join("[secret]").slice(0, 400);
  checks.push({ name, kind, ok: !!ok, detail: text });
  console.log((ok ? "  ok   " : "  FAIL ") + kind + " " + name + (ok ? "" : " :: " + text.slice(0, 300)));
};

const ISOLATION = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
routerAdd("GET", "/api/retention-throughput/cron-jobs", function (e) {
  return e.json(200, $app.cron().jobs().map(function (j) { return j.id(); }));
});
`;

const work = mkdtempSync(path.join(tmpdir(), "ff422-retention-"));
const DATA = path.join(work, "pb_data");
const HOOKS = path.join(work, "hooks");
let child = null;
let stderr = "";

function portFree() {
  return new Promise((resolve) => {
    const server = createServer().once("error", () => resolve(false));
    server.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function req(method, urlPath, { token, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1", port: PORT, method, path: urlPath, agent: false,
        headers: {
          ...(token ? { Authorization: token } : {}),
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let data = raw;
          try { data = JSON.parse(raw); } catch { /* text */ }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    request.setTimeout(180000, () => request.destroy(new Error("timeout " + method + " " + urlPath)));
    request.on("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FOOTFIVE_")) delete env[key];
  env.FOOTFIVE_TIME_SCALE = "1";
  return env;
}

async function start() {
  stderr = "";
  child = spawn(PB, ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA}`, `--hooksDir=${HOOKS}`, `--migrationsDir=${MIGRATIONS}`], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const logFile = path.join(work, "pb.log");
  child.stdout.on("data", (buf) => appendFileSync(logFile, buf));
  child.stderr.on("data", (buf) => { stderr = (stderr + buf).slice(-4000); appendFileSync(logFile, buf); });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("PB exited " + stderr.slice(-400));
    try { if ((await req("GET", "/api/health")).status === 200) return; } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("PB not ready " + stderr.slice(-400));
}

async function stop() {
  const owned = child;
  child = null;
  if (!owned || owned.exitCode !== null) return;
  owned.kill("SIGTERM");
  await new Promise((resolve) => { owned.once("exit", resolve); setTimeout(resolve, 15000); });
  if (owned.exitCode === null) owned.kill("SIGKILL");
}

function snapshot() {
  const db = new DatabaseSync(path.join(DATA, "data.db"), { readOnly: true, timeout: 10000 });
  try {
    const out = {};
    for (const [table, order] of [["credit_ledger", "id"], ["global_team_records", "id"], ["global_player_records", "id"], ["tournament_summaries", "id"], ["match_summaries", "id"], ["match_states", "id"], ["match_events", "id"], ["shared_bets", "id"], ["coaching_commands", "id"], ["tactical_scans", "id"], ["shared_fixtures", "id"], ["shared_rounds", "id"], ["shared_tournaments", "id"]]) {
      out[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((row) => JSON.stringify(row));
    }
    return out;
  } finally { db.close(); }
}

const now = Date.now();
const OLD = pbDate(now - 60 * DAY);
const OLDER = pbDate(now - 90 * DAY);
const expectPurged = new Set();
const expectKept = new Set();
let seq = 0;
let betCount = 0;
let sampleFx = "";
const nid = (prefix) => prefix + String(++seq).padStart(15 - prefix.length, "0");

function seed(db, userId) {
  const ins = (table, row) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => row[key]));
  };
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userId);
  db.prepare("UPDATE world SET progression_paused = 1, retention_days = 30 WHERE key = 'main'").run();
  const created = pbDate(now - 100 * DAY);
  ins("credit_ledger", { id: nid("lg"), user: userId, type: "bet_stake", amount: -10, description: "Retention preservation fixture", created });
  const tour = (id, status, number) => ins("shared_tournaments", { id, number, status, current_round: status === "complete" ? "complete" : "r16", created, updated: created });
  const round = (id, tournament, status) => ins("shared_rounds", { id, tournament, round_key: "r16", label: "R16", scheduled_at: created, status, idempotency_key: id, created, updated: created });
  tour("tdone0000000001", "complete", 42201);
  tour("tdone0000000002", "complete", 42202);
  tour("tactive00000001", "active", 42203);
  round("rdone0000000001", "tdone0000000001", "completed");
  round("rrf000000000001", "tdone0000000001", "completed");
  round("rcomp0000000001", "tdone0000000001", "completing");
  round("ract00000000001", "tactive00000001", "completed");
  round("rother000000001", "tdone0000000002", "completed");

  function fixture(fx, options = {}) {
    const tournament = options.tournament ?? "tdone0000000001";
    const roundId = options.round ?? "rdone0000000001";
    if (!options.noFixture) ins("shared_fixtures", { id: fx, tournament, round: roundId, slot: fx, home_team: "hometeam0000001", away_team: "awayteam0000001", scheduled_at: created, status: options.status ?? "finished", created, updated: created });
    if (!options.noState) ins("match_states", { id: "ms" + fx.slice(2), fixture: fx, seed: 1, sim_version: 2, state_json: JSON.stringify({ keep: fx }), events_json: JSON.stringify([{ legacy: fx }]), finalised: options.finalised ?? 1, progression_settled: options.settled ?? 1, created, updated: created });
    for (let eventSeq = 1; eventSeq <= 3; eventSeq++) ins("match_events", { id: nid("ev"), fixture: fx, round: roundId, seq: eventSeq, at: eventSeq, type: "goal", major: 1, data: JSON.stringify({ seq: eventSeq, fx }) });
    ins("coaching_commands", { id: nid("cc"), fixture: fx, team: "hometeam0000001", user: "user00000000001", stance: "attack", created });
    ins("match_summaries", { id: "su" + fx.slice(2), fixture_id: fx, tournament_id: options.sumTournament ?? tournament, completed_at: options.completed ?? OLD, events_purged: options.purged ?? 0, goals_json: JSON.stringify([{ g: fx }]), stats_json: JSON.stringify({ s: fx }), created });
    (options.expect === "purge" ? expectPurged : expectKept).add(fx);
  }
  const bet = (row) => {
    betCount += 1;
    ins("shared_bets", { id: nid("bt"), user: "user00000000001", fixture: row.fixture ?? "", round: row.round ?? "", tournament: row.tournament ?? "tdone0000000001", stake: 10, odds: 2, status: row.status, market: row.market, selection: "home", idempotency_key: "", created, updated: created });
  };

  for (let i = 0; i < 110; i++) fixture(nid("fxhba"), { tournament: "tactive00000001", round: "ract00000000001", completed: OLDER, expect: "keep" });
  for (let i = 0; i < 110; i++) {
    const fx = nid("fxhbb");
    fixture(fx, { completed: OLDER, expect: "keep" });
    bet({ fixture: fx, round: "rdone0000000001", status: "open", market: "next_goal" });
  }
  for (let i = 0; i < 201; i++) {
    const fx = nid("fxel");
    fixture(fx, { completed: i < 16 ? OLD : pbDate(now - 60 * DAY + i * 1000), expect: "purge" });
    if (i === 200) sampleFx = fx;
  }
  fixture(nid("fxlive"), { status: "live", expect: "keep" });
  fixture(nid("fxsched"), { status: "scheduled", expect: "keep" });
  fixture(nid("fxrcomp"), { round: "rcomp0000000001", expect: "keep" });
  fixture(nid("fxmism"), { sumTournament: "tdone0000000002", expect: "keep" });
  fixture(nid("fxorph"), { noFixture: true, noState: true, expect: "keep" });
  fixture(nid("fxnoround"), { round: "missinground001", expect: "keep" });
  fixture(nid("fxnotour"), { tournament: "missingtour0001", expect: "keep" });
  fixture(nid("fxunfin"), { finalised: 0, expect: "keep" });
  fixture(nid("fxunset"), { settled: 0, expect: "keep" });
  const openGoal = nid("fxbetng");
  fixture(openGoal, { expect: "keep" });
  bet({ fixture: openGoal, round: "rdone0000000001", status: "open", market: "next_goal" });
  const locked = nid("fxbetwl");
  fixture(locked, { expect: "keep" });
  bet({ fixture: locked, round: "rdone0000000001", status: "locked", market: "winner" });
  fixture(nid("fxrfa"), { round: "rrf000000000001", expect: "keep" });
  fixture(nid("fxrfb"), { round: "rrf000000000001", expect: "keep" });
  bet({ round: "rrf000000000001", status: "open", market: "round_first" });
  fixture(nid("fxrecent"), { completed: pbDate(now - DAY), expect: "keep" });
  fixture(nid("fxempty"), { completed: "", expect: "keep" });
  fixture(nid("fxfeb30"), { completed: "2026-02-30 00:00:00.000Z", expect: "keep" });
  fixture(nid("fxisot"), { completed: new Date(now - 60 * DAY).toISOString(), expect: "keep" });
  fixture(nid("fxjunk"), { completed: "garbage", expect: "keep" });
  fixture(nid("fxpurged"), { purged: 1, expect: "keep" });
  const won = nid("fxwon");
  fixture(won, { expect: "purge" });
  bet({ fixture: won, round: "rdone0000000001", status: "won", market: "next_goal" });
  fixture(nid("fxtourbet"), { expect: "purge" });
  bet({ round: "rdone0000000001", status: "open", market: "champion" });
  bet({ status: "open", market: "semis" });
  bet({ round: "rother000000001", status: "open", market: "round_first", tournament: "tdone0000000002" });
  fixture(nid("fxnostate"), { noState: true, expect: "purge" });
  fixture(nid("fxemptyt"), { sumTournament: "", expect: "purge" });
  const fFail = nid("fxfail");
  fixture(fFail, { completed: pbDate(now - 60 * DAY + 5500), expect: "keep" });
  db.exec(`CREATE TRIGGER zz_probe_fail BEFORE DELETE ON match_events WHEN OLD.fixture = '${fFail}' BEGIN SELECT RAISE(ABORT, 'probe injected failure'); END;`);
  // Fresh rows precede expired ones in the old unordered scan window.
  for (let i = 0; i < 60; i++) ins("tactical_scans", { id: nid("scnew"), user: "user00000000001", team: "hometeam0000001", fixture_id: "x", report_json: "{}", consumed: 0, created: pbDate(now - 1000 * i) });
  for (let i = 0; i < 70; i++) ins("tactical_scans", { id: nid("sc"), user: "user00000000001", team: "hometeam0000001", fixture_id: "x", report_json: "{}", consumed: 0, created: pbDate(now - 40 * DAY + i) });
  for (let i = 0; i < FILLER; i++) {
    const id = nid("zz");
    ins("match_summaries", { id, fixture_id: id, tournament_id: "", completed_at: OLD, events_purged: 1, goals_json: "{}", stats_json: "{}", created });
  }
  return fFail;
}

async function main() {
  if (!PORT) throw new Error("RETENTION_PB_PORT must be an integer from 1 to 65535");
  if (!(await portFree())) throw new Error("loopback port " + PORT + " is not free; not stopping it");
  console.log("phase " + PHASE + " port " + PORT + " work " + work);
  mkdirSync(DATA, { recursive: true });
  cpSync(HOOKS_SRC, HOOKS, { recursive: true });
  writeFileSync(path.join(HOOKS, "zz_retention_422.pb.js"), ISOLATION);
  await start();
  const email = `rt22_${now}@t.local`;
  const signup = await req("POST", "/api/collections/users/records", { body: { email, password: APP_PASS, passwordConfirm: APP_PASS, display_name: "rt22admin" } });
  if (signup.status < 200 || signup.status >= 300 || !signup.data || !signup.data.id) throw new Error("signup " + signup.status);
  const userId = signup.data.id;
  await stop();
  const db = new DatabaseSync(path.join(DATA, "data.db"), { timeout: 30000 });
  const fFail = seed(db, userId);
  db.close();
  await start();
  let token = "";
  try {
    const login = await req("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: APP_PASS } });
    if (!login.data || !login.data.token) throw new Error("login " + login.status);
    token = login.data.token;
    const anon = await req("POST", "/api/footfive/admin/retention/run");
    check("retention run requires auth", "control", anon.status === 401 || anon.status === 403, String(anon.status));
    const cron = await req("GET", "/api/retention-throughput/cron-jobs");
    const jobs = Array.isArray(cron.data) ? cron.data : [];
    check("isolation keeps the system job and drops app jobs", "control", cron.status === 200 && jobs.includes("__pbDBOptimize__") && jobs.every((id) => !String(id).startsWith("footfive_")), JSON.stringify(jobs));
    const beforeDetail = await req("GET", "/api/footfive/records/matches/" + sampleFx, { token });
    const s0 = snapshot();
    const preview = await req("POST", "/api/footfive/admin/retention/preview", { token });
    const s1 = snapshot();
    const body = preview.data || {};
    check("preview 200 and error empty", "regression", preview.status === 200 && body.error === "", JSON.stringify(body).slice(0, 400));
    check("preview deleted, fixtures and scans are 0", "regression", body.deleted === 0 && body.fixtures_deleted === 0 && body.scans_deleted === 0 && body.failed === 0, JSON.stringify(body).slice(0, 300));
    check("preview eligible_total is exact", "regression", body.eligible_total === expectPurged.size + 1, body.eligible_total + " vs " + (expectPurged.size + 1));
    check("preview scans_eligible is 70", "regression", body.scans_eligible === 70, String(body.scans_eligible));
    check("preview eligible list is capped at 50", "regression", Array.isArray(body.eligible) && body.eligible.length === 50 && body.examined === 50, String(body.eligible && body.eligible.length));
    check("preview made no game writes", "control", JSON.stringify(s0) === JSON.stringify(s1));
    const off = await req("PATCH", "/api/footfive/admin/world/settings", { token, body: { retention_days: 0 } });
    const never = await req("POST", "/api/footfive/admin/retention/run", { token });
    const sNever = snapshot();
    check("Never deletes nothing", "control", off.status === 200 && never.status === 200 && never.data.deleted === 0 && !never.data.fixtures_deleted && !never.data.scans_deleted && Array.isArray(never.data.skipped) && never.data.skipped.includes("Retention set to Never") && JSON.stringify(s0) === JSON.stringify(sNever), JSON.stringify(never.data).slice(0, 240));
    const back = await req("PATCH", "/api/footfive/admin/world/settings", { token, body: { retention_days: 30 } });
    if (back.status !== 200) throw new Error("restore retention_days " + back.status);
    const run = await req("POST", "/api/footfive/admin/retention/run", { token });
    const runBody = run.data || {};
    check("run 200", "regression", run.status === 200, JSON.stringify(runBody).slice(0, 300));
    check("one run purges every eligible fixture except the fault (>200)", "regression", runBody.fixtures_deleted === expectPurged.size && expectPurged.size > 200, runBody.fixtures_deleted + " vs " + expectPurged.size);
    check("run failed 1 and names the injected fault", "regression", runBody.failed === 1 && String(runBody.error || "").includes(fFail) && /probe injected failure/.test(String(runBody.error || "")), runBody.failed + " " + runBody.error);
    check("run deletes all 70 expired scans", "regression", runBody.scans_deleted === 70 && runBody.scans_eligible === 70, String(runBody.scans_deleted));
    check("deleted equals fixtures_deleted plus scans_deleted", "regression", runBody.deleted === runBody.fixtures_deleted + runBody.scans_deleted, String(runBody.deleted));
    check("run examines the whole eligible snapshot", "regression", runBody.examined === expectPurged.size + 1 && runBody.eligible_total === expectPurged.size + 1 && Array.isArray(runBody.eligible) && runBody.eligible.length === 50, runBody.examined + "/" + runBody.eligible_total);
    const status = await req("GET", "/api/footfive/admin/retention", { token });
    const summaryCount = s0.match_summaries.length;
    check("status counts are exact and past 500", "regression", status.status === 200 && summaryCount > 500 && status.data.match_summaries === summaryCount && status.data.events_purged === expectPurged.size + 1 + FILLER, JSON.stringify(status.data));
    const detail = await req("GET", "/api/footfive/records/matches/" + sampleFx, { token });
    // Existing JSVM JSON fields can be byte arrays on the wire. Compare the actual
    // permanent record payload, without changing that unrelated parser contract.
    const permanentDetail = (data) => Object.fromEntries(Object.entries(data).filter(([key]) => !["events", "eventsPurged"].includes(key)));
    check("records detail preserves every permanent summary field", "regression", beforeDetail.status === 200 && detail.status === 200 && detail.data.eventsPurged === true && JSON.stringify(permanentDetail(detail.data)) === JSON.stringify(permanentDetail(beforeDetail.data)));
    const afterRun = snapshot();
    const permanentTables = ["credit_ledger", "global_team_records", "global_player_records", "tournament_summaries", "shared_bets", "coaching_commands", "shared_fixtures", "shared_rounds", "shared_tournaments"];
    check("financial, records, fixture and coaching rows are byte-identical", "regression", permanentTables.every((table) => JSON.stringify(s0[table]) === JSON.stringify(afterRun[table])));
    const without = (rows, key) => JSON.stringify(rows.map((raw) => { const row = JSON.parse(raw); delete row[key]; return row; }));
    check("all summary and state columns except the two allowed fields are byte-identical", "regression", without(s0.match_summaries, "events_purged") === without(afterRun.match_summaries, "events_purged") && without(s0.match_states, "events_json") === without(afterRun.match_states, "events_json"));
    const again = await req("POST", "/api/footfive/admin/retention/run", { token });
    const againBody = again.data || {};
    check("armed fault retries once and purges nothing else", "regression", again.status === 200 && againBody.fixtures_deleted === 0 && againBody.failed === 1 && againBody.scans_deleted === 0 && againBody.deleted === 0 && againBody.eligible_total === 1, JSON.stringify({ ...againBody, eligible: undefined, skipped: undefined }).slice(0, 300));
  } finally {
    await stop();
  }

  const db2 = new DatabaseSync(path.join(DATA, "data.db"), { readOnly: true, timeout: 10000 });
  const one = (sql, ...args) => db2.prepare(sql).get(...args);
  const bad = [];
  for (const fx of expectPurged) {
    const summary = one("SELECT events_purged p, goals_json g, stats_json st FROM match_summaries WHERE fixture_id = ?", fx);
    const events = one("SELECT count(*) n FROM match_events WHERE fixture = ?", fx).n;
    const state = one("SELECT events_json e, state_json s, finalised f, progression_settled ps FROM match_states WHERE fixture = ?", fx);
    const coaching = one("SELECT count(*) n FROM coaching_commands WHERE fixture = ?", fx).n;
    if (!summary || summary.p !== 1 || events !== 0 || coaching !== 1 || summary.g !== JSON.stringify([{ g: fx }]) || summary.st !== JSON.stringify({ s: fx })) bad.push(fx + " purge");
    if (state && (state.e !== "[]" || state.s !== JSON.stringify({ keep: fx }) || state.f !== 1 || state.ps !== 1)) bad.push(fx + " state");
  }
  check("every expected fixture is purged and summary, state_json and coaching stay", "regression", bad.length === 0, bad.slice(0, 3).join(" | "));
  const keptBad = [];
  for (const fx of expectKept) {
    const summary = one("SELECT events_purged p FROM match_summaries WHERE fixture_id = ?", fx);
    const events = one("SELECT count(*) n FROM match_events WHERE fixture = ?", fx).n;
    const state = one("SELECT events_json e FROM match_states WHERE fixture = ?", fx);
    const wantFlag = fx.startsWith("fxpurged") ? 1 : 0;
    if (!summary || summary.p !== wantFlag || events !== 3 || (state && state.e !== JSON.stringify([{ legacy: fx }]))) keptBad.push(fx);
  }
  check("every protected, invalid and fault fixture is untouched", "regression", keptBad.length === 0, keptBad.slice(0, 4).join(" | "));
  check("fresh scans stay and expired scans are gone", "regression", one("SELECT count(*) n FROM tactical_scans WHERE id LIKE 'scnew%'").n === 60 && one("SELECT count(*) n FROM tactical_scans WHERE id LIKE 'sc0%'").n === 0);
  check("all coaching_commands stay", "regression", one("SELECT count(*) n FROM coaching_commands").n === expectPurged.size + expectKept.size);
  check("bets are unchanged", "control", one("SELECT count(*) n FROM shared_bets").n === betCount, String(betCount));
  db2.close();

  const writer = new DatabaseSync(path.join(DATA, "data.db"), { timeout: 30000 });
  writer.exec("DROP TRIGGER IF EXISTS zz_probe_fail");
  writer.close();
  await start();
  try {
    const login = await req("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: APP_PASS } });
    if (!login.data || !login.data.token) throw new Error("relogin " + login.status);
    const third = await req("POST", "/api/footfive/admin/retention/run", { token: login.data.token });
    const thirdBody = third.data || {};
    check("removing the fault lets that fixture purge", "regression", third.status === 200 && thirdBody.fixtures_deleted === 1 && thirdBody.failed === 0 && thirdBody.scans_deleted === 0 && thirdBody.deleted === 1 && thirdBody.eligible_total === 1, JSON.stringify(thirdBody).slice(0, 300));
  } finally {
    await stop();
  }
  const db3 = new DatabaseSync(path.join(DATA, "data.db"), { readOnly: true, timeout: 10000 });
  const fault = db3.prepare("SELECT events_purged p, goals_json g FROM match_summaries WHERE fixture_id = ?").get(fFail);
  const faultEvents = db3.prepare("SELECT count(*) n FROM match_events WHERE fixture = ?").get(fFail).n;
  const faultState = db3.prepare("SELECT events_json e, state_json s FROM match_states WHERE fixture = ?").get(fFail);
  const faultCoaching = db3.prepare("SELECT count(*) n FROM coaching_commands WHERE fixture = ?").get(fFail).n;
  db3.close();
  check("the retried fault keeps its summary, state_json and coaching", "regression", fault && fault.p === 1 && fault.g === JSON.stringify([{ g: fFail }]) && faultEvents === 0 && faultState && faultState.e === "[]" && faultState.s === JSON.stringify({ keep: fFail }) && faultCoaching === 1, JSON.stringify({ fault, faultEvents, faultState, faultCoaching }));

  const failed = checks.filter((item) => !item.ok);
  const evidence = {
    phase: PHASE, port: PORT, hooks: HOOKS_SRC, work,
    purged: expectPurged.size, kept: expectKept.size, filler: FILLER,
    passed: checks.length - failed.length, failed: failed.length,
    regressionsFailed: failed.filter((item) => item.kind === "regression").map((item) => item.name),
    controlsFailed: failed.filter((item) => item.kind === "control").map((item) => item.name),
    checks,
  };
  writeFileSync(path.join(work, "results.json"), JSON.stringify(evidence, null, 2));
  writeFileSync(`/tmp/ff422-retention-${PHASE}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ phase: PHASE, passed: evidence.passed, failed: evidence.failed, regressionsFailed: evidence.regressionsFailed, controlsFailed: evidence.controlsFailed, work }));
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(String(err && err.stack ? err.stack : err).split(APP_PASS).join("[secret]"));
  await stop();
  process.exit(2);
});
