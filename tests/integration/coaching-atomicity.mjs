/**
 * FF-20 real PocketBase coaching/advancement atomicity. Disposable data/hooks only.
 * node tests/integration/coaching-atomicity.mjs
 * COACHING_PB_PORT=8304; COACHING_HOOKS optionally points to baseline hooks.
 * Fixed clock routes call real public service operations under real authentication.
 * Only the delayed-read case forwards real app/tx through a clock-crossing Proxy.
 * No engine/RNG implementation or fixture state is patched to calculate outcomes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { DatabaseSync } from "node:sqlite";


const ROOT = fileURLToPath(new NodeURL("../../", import.meta.url));
const PORT = Number(process.env.COACHING_PB_PORT || 8304);
assert(Number.isInteger(PORT) && PORT > 1024 && PORT <= 65535);
const BASE = `http://127.0.0.1:${PORT}`;
const HOOKS_SOURCE = process.env.COACHING_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ff-coaching-"));
const DATA = path.join(TMP, "pb_data"), HOOKS = path.join(TMP, "pb_hooks");
const FAULT = path.join(TMP, "fault.json"), LOG = path.join(TMP, "pb.log");
const FX = "ff20fixture0000", ROUND = "ff20round000000";
const results = [];
let child, user, otherUser, baseline, now, overdue;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtureHooks = `
routerAdd("POST", "/api/ff20/operation", function(e) {
  var body = e.requestInfo().body;
  var clock = body.now;
  var hit = false;
  var previous = Date.now;
  Date.now = function() { return clock; };
  try {
    var app = $app;
    if (body.crossRead) {
      app = new Proxy({}, { get: function(_target, key) {
        if (key !== "runInTransaction") return $app[key];
        return function(fn) { return $app.runInTransaction(function(tx) {
          return fn(new Proxy({}, { get: function(_t, k) {
            if (k !== "findRecordById") return tx[k];
            return function(col, id) {
              var row = tx.findRecordById(col, id);
              if (col === "shared_fixtures") {
                clock = body.now + body.crossRead;
                hit = true;
                console.log("ff20-clock-boundary");
              }
              return row;
            };
          } }));
        }); };
      } });
    }
    var svc = require(__hooks + "/lib/worldService.js");
    var result;
    if (body.op === "tick") result = svc.tick(app, clock);
    else if (body.op === "coach") result = svc.setCoaching(app, e.auth.id, body.fixture, body.stance);
    else if (body.op === "view") result = svc.matchView(app, body.fixture, 0, e.auth.id, body.through);
    else throw new Error("unknown test operation");
    return e.json(200, { result: result, clockHit: hit, clock: clock });
  } catch (err) {
    return e.json(400, { message: String(err.message || err), clockHit: hit, clock: clock });
  } finally { Date.now = previous; }
}, $apis.requireAuth());
onRecordCreate(function(e) {
  var s = null;
  try { s = JSON.parse(toString($os.readFile($os.getenv("FF_COACH_FAULT")))); } catch (_) {}
  if (s && e.record.get("fixture") === s.fixture) {
    if (e.record.collection().name === "match_events") {
      var key = "ff20-event-count-" + s.id;
      var n = ($app.store().get(key) || 0) + 1;
      $app.store().set(key, n);
      if (s.mode === "events" && (s.once ? n === 1 : n > (s.after || 0))) {
        console.log("ff20-fault:" + s.id + ":" + n);
        throw new Error("injected event save");
      }
      e.next();
      console.log("ff20-written:" + s.id);
      return;
    }
    if (s.mode === "command" && e.record.collection().name === "coaching_commands") {
      console.log("ff20-fault:" + s.id);
      throw new Error("injected command save");
    }
  }
  e.next();
});
onRecordUpdate(function(e) {
  var s = null;
  try { s = JSON.parse(toString($os.readFile($os.getenv("FF_COACH_FAULT")))); } catch (_) {}
  if (s && e.record.collection().name === "match_states" && e.record.get("fixture") === s.fixture) {
    if (s.mode === "state") {
      console.log("ff20-fault:" + s.id);
      throw new Error("injected state save");
    }
    e.next();
    if (s.mode === "command") console.log("ff20-written:" + s.id);
    return;
  }
  e.next();
});
`;
function query(sql, ...params) {
  const db = new DatabaseSync(path.join(DATA, "data.db"), { readOnly: true });
  try { return db.prepare(sql).all(...params).map((row) => ({ ...row })); }
  finally { db.close(); }
}
function execute(statements) {
  assert(!child, "fixture writes require stopped PocketBase");
  const db = new DatabaseSync(path.join(DATA, "data.db"));
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [sql, params = []] of statements) db.prepare(sql).run(...params);
    db.exec("COMMIT");
  } finally { db.close(); }
}
async function request(route, token, body) {
  const response = await fetch(BASE + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
function disarm() { fs.rmSync(FAULT, { force: true }); }
function arm(spec) { fs.writeFileSync(FAULT, JSON.stringify(spec)); }
async function start() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
  child = spawn(path.join(ROOT, "pocketbase/pocketbase"), ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA}`, `--hooksDir=${HOOKS}`, `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`], {
    env: { ...process.env, FOOTFIVE_TIME_SCALE: "1", FF_COACH_FAULT: FAULT }, stdio: ["ignore", "pipe", "pipe"],
  });
  let failure;
  child.on("error", (error) => { failure = error; });
  child.stdout.on("data", (data) => fs.appendFileSync(LOG, data));
  child.stderr.on("data", (data) => fs.appendFileSync(LOG, data));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    assert.equal(child.exitCode, null, "owned PB exited before readiness (port may be occupied)");
    try {
      const response = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        // Identify our temp directory through its real migrated DB, not a foreign service.
        if (fs.existsSync(path.join(DATA, "data.db"))) {
          query("SELECT id FROM world LIMIT 1"); // Schema ready; the designed health tick below ensures world data.
          return;
        }
      }
    } catch { /* Wait for this owned process's bootstrap. */ }
    await sleep(50);
  }
  throw new Error("owned PocketBase readiness timeout");
}
async function stop() {
  if (!child) return;
  const current = child;
  if (current.exitCode === null && current.signalCode === null) {
    const done = once(current, "close");
    current.kill("SIGTERM");
    const timer = setTimeout(() => current.kill("SIGKILL"), 3000);
    try { await done; } finally { clearTimeout(timer); }
  }
  child = undefined;
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, status: "FAIL", error: error.stack || String(error) });
    console.error("FAIL", name, error.message);
  } finally { disarm(); }
}
function rejected(response) {
  assert.equal(response.status, 400, JSON.stringify(response.data));
  assert.equal(typeof response.data.message, "string");
  assert(response.data.message.length > 0);
}
async function register(email) {
  const created = await request("/api/collections/users/records", null, { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "Coaching tester" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const login = await request("/api/collections/users/auth-with-password", null, { identity: email, password: "testpass99" });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { id: login.data.record.id, token: login.data.token };
}



const stateRow = () => query("SELECT * FROM match_states WHERE fixture = ?", FX)[0];
const state = () => JSON.parse(stateRow().state_json);
const events = () => query("SELECT * FROM match_events WHERE fixture = ? ORDER BY seq", FX);
const commands = () => query("SELECT * FROM coaching_commands WHERE fixture = ? ORDER BY id", FX);
const snapshot = () => JSON.stringify([stateRow(), events(), commands()]);
const operation = (op, clock, extra = {}, actor = user) => request("/api/ff20/operation", actor.token, { op, now: clock, fixture: FX, ...extra });
const coach = (clock, extra = {}) => operation("coach", clock, { stance: "attack", ...extra });
function restore(table, row) {
  const keys = Object.keys(row);
  return [`INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k])];
}
async function configure({ held = true, paused = false } = {}) {
  disarm();
  await stop();
  execute([
    ["DELETE FROM coaching_commands WHERE fixture = ?", [FX]],
    ["DELETE FROM match_events WHERE fixture = ?", [FX]],
    ["DELETE FROM match_states WHERE fixture = ?", [FX]],
    restore("match_states", baseline.ms),
    ...baseline.events.map((row) => restore("match_events", row)),
    ["UPDATE world SET progression_paused = ?, processing_status = ?, processing_version = ? WHERE key = 'main'", [paused ? 1 : 0, held ? "processing" : "idle", held ? Math.max(overdue + 3600_000, Date.now() + 3600_000) : 0]],
  ]);
  await start();
}
async function release() {
  await stop();
  execute([["UPDATE world SET progression_paused = 0, processing_status = 'idle', processing_version = 0 WHERE key = 'main'"]]);
  await start();
}
async function marker(text) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (fs.readFileSync(LOG, "utf8").includes(text)) return;
    await sleep(10);
  }
  assert.fail("missing actual fault/clock witness: " + text);
}
function reconciled() {
  const rows = events();
  const st = state();
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1));
  assert.equal(st.seq, rows.at(-1).seq);
  for (let i = 1; i < rows.length; i++) assert(rows[i].at >= rows[i - 1].at);
  for (const row of baseline.events) assert.deepEqual(rows.find((r) => r.id === row.id), row, "old event/goal changed or disappeared");
  const goals = rows.filter((r) => ["goal", "penalty_goal"].includes(r.type)).map((r) => JSON.parse(r.data));
  assert.deepEqual(st.score, ["home", "away"].map((side) => goals.filter((g) => g.side === side).length));
}
async function overdueCase(options, fault) {
  await configure(options);
  if (fault) arm({ fixture: FX, ...fault });
  const before = snapshot();
  const response = await coach(overdue);
  if (fault) await marker("ff20-fault:" + fault.id);
  if (response.status !== 200) {
    rejected(response);
    assert.match(response.data.message, /catching up/i);
    assert.equal(snapshot(), before);
    return;
  }
  // Complete the baseline reproduction before asserting: show the actual
  // manager event being applied to a minute that had elapsed at request time.
  const queued = state();
  disarm();
  await release();
  assert.equal((await operation("tick", overdue)).status, 200);
  const applied = events().map((r) => JSON.parse(r.data)).filter((e) => e.t === "coaching" && e.by === "manager");
  assert(applied.length > 0, "accepted stance must eventually be applied");
  assert(applied.every((e) => e.at > overdue), `retroactive manager event: at=${applied.map((e) => e.at)} request=${overdue}`);
  assert(queued.nextAt > overdue, "success must catch up before queueing");
  reconciled();
}
async function main() {
  console.log(`Coaching atomicity: ${HOOKS_SOURCE}, port ${PORT}, evidence ${TMP}`);
  fs.mkdirSync(DATA);
  fs.cpSync(HOOKS_SOURCE, HOOKS, { recursive: true });
  fs.writeFileSync(path.join(HOOKS, "zz_coaching_fixture.pb.js"), fixtureHooks);
  await start();
  user = await register("coaching-home@test.local");
  otherUser = await register("coaching-away@test.local");
  assert.equal((await request("/api/footfive/health")).status, 200);
  await stop();
  const teams = query("SELECT * FROM proball_teams ORDER BY sort_order");
  const round = query("SELECT * FROM shared_rounds WHERE round_key = 'r16' LIMIT 1")[0];
  const fixtures = query("SELECT * FROM shared_fixtures WHERE round = ? ORDER BY bracket_index", round.id);
  const firstClock = Date.now();
  execute([
    ["UPDATE shared_fixtures SET round = ? WHERE round = ?", [ROUND, round.id]],
    ["UPDATE shared_rounds SET id = ?, scheduled_at = ? WHERE id = ?", [ROUND, new Date(firstClock - 100).toISOString(), round.id]],
    ["UPDATE shared_fixtures SET id = ? WHERE id = ?", [FX, fixtures[0].id]],
    ...fixtures.map((f, i) => ["UPDATE shared_fixtures SET home_team = ?, away_team = ?, scheduled_at = ? WHERE id = ?", [teams[i * 2].id, teams[i * 2 + 1].id, new Date(firstClock - 100).toISOString(), i === 0 ? FX : f.id]]),
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [user.id, teams[0].id]],
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [otherUser.id, teams[1].id]],
    ["UPDATE world SET progression_paused = 0, processing_status = 'idle', processing_version = 0 WHERE key = 'main'"],
  ]);
  await start();
  assert.equal((await operation("tick", firstClock)).status, 200);
  await test("real production coaching POST is authenticated and pending-only", async () => {
    const st = state(), beforeEvents = events();
    assert(st.nextAt > Date.now(), "kickoff hold must still be future for real-clock control");
    const response = await request(`/api/footfive/matches/${FX}/coaching`, user.token, { stance: "attack" });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.used, 1);
    assert.equal(response.data.fromMinute, st.minute + 1);
    assert.equal(state().pending.home, "attack");
    assert.equal(state().rc, st.rc);
    assert.equal(state().seq, st.seq);
    assert.deepEqual(events(), beforeEvents);
  });
  await stop();
  const anchor = Date.now() + 86400_000;
  execute([
    ["DELETE FROM coaching_commands"], ["DELETE FROM match_events"], ["DELETE FROM match_states"],
    ["UPDATE shared_rounds SET status = 'scheduled', started_at = '', scheduled_at = ? WHERE id = ?", [new Date(anchor).toISOString(), ROUND]],
    ["UPDATE shared_fixtures SET status = 'scheduled', lineups_frozen = 0, scheduled_at = ? WHERE round = ?", [new Date(anchor).toISOString(), ROUND]],
    ["UPDATE world SET processing_status = 'processing', processing_version = ? WHERE key = 'main'", [anchor - 1]],
  ]);
  await start();
  assert.equal((await operation("tick", anchor + 150_000)).status, 200);
  baseline = { ms: stateRow(), events: events() };
  assert.equal(state().seed, 4143474510, "fixed fixture/round IDs pin the ordinary kickoff seed");
  assert(baseline.events.some((e) => ["goal", "penalty_goal"].includes(e.type)), "fixture must contain an actual old goal");
  now = state().nextAt - 1;
  overdue = state().nextAt + 3 * state().timing.minuteMs;

  await test("foreign manager and unauthenticated production requests do not mutate match", async () => {
    await configure();
    const before = snapshot();
    const foreign = fixtures[1].id;
    rejected(await request(`/api/footfive/matches/${foreign}/coaching`, user.token, { stance: "attack" }));
    assert.equal((await request(`/api/footfive/matches/${FX}/coaching`, null, { stance: "attack" })).status, 401);
    assert.equal(snapshot(), before);
  });
  await test("overdue state under held lease never accepts a retroactive command", () => overdueCase({ held: true }));
  await test("overdue state while paused never accepts a retroactive command", () => overdueCase({ paused: true }));
  await test("persistent preliminary advance fault cannot admit elapsed coaching", () => overdueCase({ held: false }, { mode: "events", id: "persistent", after: 0 }));
  await test("transient preliminary advance fault catches up before accepted retry", async () => {
    await configure({ held: false });
    arm({ fixture: FX, mode: "events", id: "transient", once: true });
    const response = await coach(overdue);
    await marker("ff20-fault:transient:1");
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert(state().nextAt > overdue);
    assert.equal(response.data.result.fromMinute, state().minute + 1);
    assert.equal(state().pending.home, "attack");
    reconciled();
  });
  await test("clock crossing during fresh fixture read rejects unchanged instead of using pre-tx time", async () => {
    await configure();
    const before = snapshot();
    const response = await coach(now, { crossRead: 2 });
    assert.equal(response.data.clockHit, true, "real fresh fixture read must cross nextAt: " + JSON.stringify(response.data));
    await marker("ff20-clock-boundary");
    rejected(response);
    assert.match(response.data.message, /catching up/i);
    assert.equal(snapshot(), before);
  });
  for (const mode of ["events", "state"]) await test(`late ${mode} save fault rolls back state AND events, retry preserves seq`, async () => {
    await configure({ held: false });
    const before = snapshot();
    arm({ fixture: FX, mode, id: "late-" + mode, after: 1 });
    await operation("tick", overdue);
    await marker("ff20-fault:late-" + mode);
    await marker("ff20-written:late-" + mode);
    assert.equal(snapshot(), before);
    disarm();
    await release();
    assert.equal((await operation("tick", overdue)).status, 200);
    assert(state().seq > JSON.parse(baseline.ms.state_json).seq);
    reconciled();
  });
  await test("command insert fault rolls back already-saved pending stance and usage", async () => {
    await configure();
    const before = snapshot();
    arm({ fixture: FX, mode: "command", id: "command" });
    rejected(await coach(now));
    await marker("ff20-written:command");
    await marker("ff20-fault:command");
    assert.equal(snapshot(), before);
  });
  await test("public event and score remain hidden until the event's reveal time", async () => {
    await configure();
    const goal = baseline.events.find((e) => ["goal", "penalty_goal"].includes(e.type));
    for (const cutoff of [goal.at - 1, goal.at]) {
      const response = await operation("view", cutoff, { through: cutoff });
      assert.equal(response.status, 200);
      const view = response.data.result;
      assert(view.events.every((e) => e.at <= cutoff));
      assert.equal(view.events.some((e) => e.seq === goal.seq), cutoff === goal.at);
      const publishedGoals = baseline.events.filter((e) => e.at <= cutoff && ["goal", "penalty_goal"].includes(e.type)).map((e) => JSON.parse(e.data));
      assert.deepEqual(view.fixture.st.sc, ["home", "away"].map((side) => publishedGoals.filter((e) => e.side === side).length));
    }
  });
  await test("authorized coaching racing advance preserves old goals, accepted command and contiguous seq", async () => {
    await configure({ held: false });
    const [coached, advanced] = await Promise.all([coach(now), operation("tick", overdue)]);
    assert.equal(advanced.status, 200);
    if (coached.status !== 200) {
      rejected(coached);
      assert.match(coached.data.message, /catching up/i);
      await release();
      const again = await coach(overdue);
      assert.equal(again.status, 200, JSON.stringify(again.data));
    }
    assert.equal(commands().length, 1);
    const commandAt = state().coach.home.last;
    await release();
    assert.equal((await operation("tick", state().nextAt)).status, 200);
    const managerEvents = events().map((e) => JSON.parse(e.data)).filter((e) => e.t === "coaching" && e.by === "manager" && e.side === "home");
    assert.equal(managerEvents.length, 1);
    assert(managerEvents[0].at > commandAt);
    reconciled();
  });
  await test("simultaneous same-side commands accept once and enforce cooldown without lost usage", async () => {
    await configure();
    const responses = await Promise.all([coach(now), coach(now, { stance: "defend" })]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1, JSON.stringify(responses));
    const denied = responses.find((r) => r.status !== 200);
    rejected(denied);
    assert.match(denied.data.message, /recharging/i);
    assert.equal(commands().length, 1);
    assert.equal(state().coach.home.n, 1);
    const winner = responses.find((r) => r.status === 200).data.result;
    assert.equal(state().pending.home, winner.stance);
    reconciled();
  });
  await test("real accepted commands reach existing usage limit and reject a fifth unchanged", async () => {
    await configure();
    let clock = now;
    for (let i = 0; i < 4; i++) {
      if (i) {
        clock += 5 * state().timing.minuteMs + 1;
        await release();
        assert.equal((await operation("tick", clock)).status, 200);
      }
      const response = await coach(clock, { stance: i % 2 ? "defend" : "attack" });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.equal(response.data.result.used, i + 1);
    }
    const before = snapshot();
    const denied = await coach(clock, { stance: "balanced" });
    rejected(denied);
    assert.match(denied.data.message, /no coaching commands left/i);
    assert.equal(snapshot(), before);
    assert.equal(commands().length, 4);
    reconciled();
  });
}
try { await main(); }
catch (error) { results.push({ name: "suite setup", status: "FAIL", error: error.stack || String(error) }); console.error(error); }
finally {
  disarm();
  await stop();
  fs.writeFileSync(path.join(TMP, "results.json"), JSON.stringify({ hooks: HOOKS_SOURCE, results }, null, 2));
}
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(`${results.length - failed}/${results.length} cases passed; evidence ${TMP}; owned PB stopped`);
process.exitCode = failed ? 1 : 0;
