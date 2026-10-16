/**
 * FF-121: authenticated overclock purchase -> real kickoff -> actual five pay once.
 * node tests/integration/overclock-kickoff.mjs
 * OVERCLOCK_PB_PORT=8322; OVERCLOCK_HOOKS optionally selects baseline hooks.
 * Old-schema upgrade is self-contained: copy repository migrations except 0019,
 * create declarative legacy prepaid rows, then apply the actual new migration.
 * Only scratch data/hooks/migrations change; external SQL runs with owned PB stopped.
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
const PORT = Number(process.env.OVERCLOCK_PB_PORT || 8322);
assert(Number.isInteger(PORT) && PORT > 1024 && PORT <= 65535);
const BASE = `http://127.0.0.1:${PORT}`;
const HOOKS_SOURCE = process.env.OVERCLOCK_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const NEW_MIGRATION = "1750000019_overclock_pending_cost.js";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ff-overclock-kickoff-"));
const DATA = path.join(TMP, "pb_data"), HOOKS = path.join(TMP, "pb_hooks"), MIGRATIONS = path.join(TMP, "pb_migrations");
const FAULT = path.join(TMP, "fault.json"), LOG = path.join(TMP, "pb.log");
const results = [];
let child, user, team, fixture, round, original, fixtureRows, roundRows, clock, legacyPlayers, legacyTeam, oldMigrationRows;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fixtureHooks = `
routerAdd("POST", "/api/ff121/operation", function(e) {
  var body = e.requestInfo().body;
  var previous = Date.now;
  Date.now = function() { return body.now; };
  try {
    var w = require(__hooks + "/lib/worldService.js");
    var result;
    if (body.op === "tick") result = w.tick($app, body.now);
    else if (body.op === "preview") {
      var m = require(__hooks + "/lib/managementService.js");
      var own = m.loadTeamSnapshot($app, body.team);
      result = { own: own, view: w.matchView($app, body.fixture, 0, e.auth.id) };
    } else throw new Error("unknown fixture operation");
    return e.json(200, result);
  } catch (err) { return e.json(400, { message: String(err.message || err) }); }
  finally { Date.now = previous; }
}, $apis.requireAuth());
onRecordUpdate(function(e) {
  var s = null;
  try { s = JSON.parse(toString($os.readFile($os.getenv("FF_OVERCLOCK_FAULT")))); } catch (_) {}
  if (s && e.record.collection().name === "proball_players" && e.record.get("team") === s.team) {
    e.next();
    console.log("ff121-paid:" + s.id + ":" + e.record.id);
    return;
  }
  e.next();
});
onRecordCreate(function(e) {
  var s = null;
  try { s = JSON.parse(toString($os.readFile($os.getenv("FF_OVERCLOCK_FAULT")))); } catch (_) {}
  if (s && e.record.collection().name === "match_states" && e.record.get("fixture") === s.fixture) {
    console.log("ff121-late-fault:" + s.id);
    throw new Error("injected late kickoff state save");
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
  child = spawn(path.join(ROOT, "pocketbase/pocketbase"), ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA}`, `--hooksDir=${HOOKS}`, `--migrationsDir=${MIGRATIONS}`], {
    env: { ...process.env, FOOTFIVE_TIME_SCALE: "1", FF_OVERCLOCK_FAULT: FAULT }, stdio: ["ignore", "pipe", "pipe"],
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
  const created = await request("/api/collections/users/records", null, { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "Overclock tester" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const login = await request("/api/collections/users/auth-with-password", null, { identity: email, password: "testpass99" });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { id: login.data.record.id, token: login.data.token };
}



const ownPlayers = () => query("SELECT * FROM proball_players WHERE team = ? ORDER BY sort_order,id", team.id);
const ownTeam = () => query("SELECT * FROM proball_teams WHERE id = ?", team.id)[0];
const charge = () => query("SELECT * FROM command_charge WHERE user = ?", user.id)[0];
const purchase = () => request("/api/footfive/command-charge/spend", user.token, { action: "overclock" });
const operation = (op, now = clock) => request("/api/ff121/operation", user.token, { op, now, team: team.id, fixture: fixture.id });
function restore(table, row) {
  const keys = Object.keys(row);
  return [`INSERT INTO ${table} (${keys.map((k) => '"' + k + '"').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => row[k])];
}
function snapshot() {
  return JSON.stringify(Object.fromEntries(["proball_teams", "proball_players", "shared_fixtures", "shared_rounds", "match_states", "match_events", "command_charge", "team_finance_ledger"]
    .map((table) => [table, query(`SELECT * FROM ${table} ORDER BY id`)])));
}
async function configure({ ai = false, legacy = false } = {}) {
  disarm();
  await stop();
  execute([
    ["DELETE FROM match_events"], ["DELETE FROM match_states"],
    ["DELETE FROM shared_fixtures"], ["DELETE FROM shared_rounds"],
    ...roundRows.map((row) => restore("shared_rounds", row)),
    ...fixtureRows.map((row) => restore("shared_fixtures", row)),
    ["UPDATE world SET progression_paused = 1, processing_status = 'idle', processing_version = 0 WHERE key = 'main'"],
    ["UPDATE proball_teams SET treasury = 0, battery_count = 0"],
    ["UPDATE proball_teams SET manager_mode = ?, overclock_ready = ?, overclock_cost_pending = 0, overclock_fixture = '' WHERE id = ?", [ai ? "ai" : "manual", legacy ? 1 : 0, team.id]],
    ["UPDATE command_charge SET points = ?, last_regen_at = ? WHERE user = ?", [legacy ? 3 : 5, new Date(clock + 86400_000).toISOString(), user.id]],
    ["UPDATE proball_players SET energy_updated_at = ?, condition = 100", [new Date(clock + 86400_000).toISOString()]],
    ...original.map((p) => ["UPDATE proball_players SET energy = ?, is_starter = ?, sort_order = ?, attack = ?, defence = ? WHERE id = ?", [legacy ? (p.is_starter ? 72 : 80) : 80, p.is_starter, p.sort_order, p.attack, p.defence, p.id]]),
  ]);
  await start();
}
async function kick() {
  await stop();
  execute([["UPDATE world SET progression_paused = 0, processing_status = 'idle', processing_version = 0 WHERE key = 'main'"]]);
  await start();
  return operation("tick");
}
function frozenState() {
  const fx = query("SELECT * FROM shared_fixtures WHERE id = ?", fixture.id)[0];
  const ms = query("SELECT * FROM match_states WHERE fixture = ?", fixture.id)[0];
  assert(ms && fx.lineups_frozen, "real kickoff must create and freeze the fixture");
  const state = JSON.parse(ms.state_json);
  const side = fx.home_team === team.id ? "home" : "away";
  return { fx, ms, state, side, frozen: JSON.parse(fx[side + "_lineup_json"]) };
}
function checkPayment(before, chosen, { prepaid = false } = {}) {
  const saved = ownPlayers();
  const frozen = frozenState();
  assert.equal(chosen.length, 5);
  assert.deepEqual(frozen.frozen.filter((p) => p.is_starter).map((p) => p.id).sort(), [...chosen].sort());
  assert.deepEqual(frozen.state.teams[frozen.side].players.filter((p) => p.is_starter).map((p) => p.id).sort(), [...chosen].sort());
  assert.equal(frozen.state.teams[frozen.side].oc, true);
  for (const old of before) {
    const expected = old.energy - (!prepaid && chosen.includes(old.id) ? 8 : 0);
    const row = saved.find((p) => p.id === old.id);
    assert.equal(row.energy, expected, `persisted cost for ${old.name}`);
    const fp = frozen.frozen.find((p) => p.id === old.id);
    const ep = frozen.state.teams[frozen.side].players.find((p) => p.id === old.id);
    assert.equal(fp.energy, expected, `frozen energy for ${old.name}`);
    assert.equal(ep.energy, expected, `engine energy for ${old.name}`);
    assert.equal(ep.e0, expected, `engine initial energy for ${old.name}`);
  }
  assert.equal(ownTeam().overclock_ready, 0);
  assert.equal(ownTeam().overclock_cost_pending, 0);
  assert.equal(ownTeam().overclock_fixture, fixture.id);
}
async function witness(text) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (fs.readFileSync(LOG, "utf8").includes(text)) return;
    await sleep(10);
  }
  assert.fail("missing actual kickoff fault witness: " + text);
}
async function main() {
  console.log(`Overclock kickoff: ${HOOKS_SOURCE}, port ${PORT}, evidence ${TMP}`);
  fs.mkdirSync(DATA);
  fs.cpSync(HOOKS_SOURCE, HOOKS, { recursive: true });
  fs.writeFileSync(path.join(HOOKS, "zz_overclock_fixture.pb.js"), fixtureHooks);
  fs.mkdirSync(MIGRATIONS);
  const migrationSource = path.join(ROOT, "pocketbase/pb_migrations");
  for (const name of fs.readdirSync(migrationSource)) if (name !== NEW_MIGRATION) fs.copyFileSync(path.join(migrationSource, name), path.join(MIGRATIONS, name));
  assert(fs.existsSync(path.join(migrationSource, NEW_MIGRATION)), "new migration must be present before this suite runs");
  await start();
  user = await register("overclock-manager@test.local");
  assert.equal((await request("/api/footfive/health")).status, 200);
  await stop();
  team = query("SELECT * FROM proball_teams ORDER BY sort_order LIMIT 1")[0];
  fixture = query("SELECT * FROM shared_fixtures WHERE home_team = ? OR away_team = ? LIMIT 1", team.id, team.id)[0];
  round = query("SELECT * FROM shared_rounds WHERE id = ?", fixture.round)[0];
  clock = Date.now() + 3600_000;
  execute([
    ["UPDATE world SET progression_paused = 1 WHERE key = 'main'"],
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual', treasury = 0, battery_count = 0 WHERE id = ?", [user.id, team.id]],
    ["UPDATE shared_rounds SET scheduled_at = ? WHERE id = ?", [new Date(clock).toISOString(), round.id]],
    ["UPDATE shared_fixtures SET scheduled_at = ? WHERE round = ?", [new Date(clock).toISOString(), round.id]],
    ["UPDATE proball_players SET energy = 80, condition = 100, energy_updated_at = ? WHERE team = ?", [new Date(clock + 86400_000).toISOString(), team.id]],
  ]);
  await start();
  assert.equal((await request("/api/footfive/command-charge", user.token)).status, 200);
  original = ownPlayers();
  assert.equal(original.length, 7);
  assert.equal(query("PRAGMA table_info(proball_teams)").some((r) => r.name === "overclock_cost_pending"), false);
  await test("new hooks on old schema reject arming with no free flag, charge or energy mutation", async () => {
    const before = snapshot();
    const response = await purchase();
    assert([400, 503].includes(response.status), JSON.stringify(response));
    assert.match(response.data.message, /upgrade|unavailable|migration|updat/i);
    assert.equal(snapshot(), before);
  });
  await stop();
  // Declarative pre-deploy data shape: the old arm already spent two points and
  // eight energy on its saved starters. No replacement old arm implementation.
  execute([
    ["UPDATE proball_teams SET overclock_ready = 1, overclock_fixture = '' WHERE id = ?", [team.id]],
    ["UPDATE command_charge SET points = 3 WHERE user = ?", [user.id]],
    ...original.map((p) => ["UPDATE proball_players SET energy = ? WHERE id = ?", [p.is_starter ? 72 : 80, p.id]]),
  ]);
  legacyPlayers = ownPlayers();
  legacyTeam = ownTeam();
  oldMigrationRows = query("SELECT * FROM _migrations ORDER BY file");
  fs.copyFileSync(path.join(migrationSource, NEW_MIGRATION), path.join(MIGRATIONS, NEW_MIGRATION));
  await start();
  await test("forward migration defaults pending false and preserves prepaid rows and old migration history", async () => {
    assert.equal(ownTeam().overclock_cost_pending, 0);
    const { overclock_cost_pending, ...unchanged } = ownTeam();
    assert.equal(overclock_cost_pending, 0);
    assert.deepEqual(unchanged, legacyTeam);
    assert.deepEqual(ownPlayers(), legacyPlayers);
    assert.deepEqual(query("SELECT * FROM _migrations WHERE file != ? ORDER BY file", NEW_MIGRATION), oldMigrationRows);
    assert.equal(query("SELECT file FROM _migrations WHERE file = ?", NEW_MIGRATION).length, 1);
  });
  fixtureRows = query("SELECT * FROM shared_fixtures ORDER BY id");
  roundRows = query("SELECT * FROM shared_rounds ORDER BY id");
  const savedFive = original.filter((p) => p.is_starter).map((p) => p.id);
  const gk = original.find((p) => p.role === "gk");
  const field = original.filter((p) => p.role !== "gk");
  const changedFive = [gk.id, field[0].id, field[1].id, field[4].id, field[5].id];

  await test("legacy prepaid arm is consumed without another deduction; subsequent new arm defers cost", async () => {
    await configure({ legacy: true });
    const before = ownPlayers();
    assert.equal((await kick()).status, 200);
    checkPayment(before, savedFive, { prepaid: true });
    const afterKickoff = ownPlayers();
    const response = await purchase();
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(charge().points, 1);
    assert.equal(ownTeam().overclock_ready, 1);
    assert.equal(ownTeam().overclock_cost_pending, 1);
    assert.deepEqual(ownPlayers(), afterKickoff);
  });
  await test("new arm spends two charge and sets pending without touching any player energy row", async () => {
    await configure();
    const before = ownPlayers();
    const response = await purchase();
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(charge().points, 3);
    assert.equal(ownTeam().overclock_ready, 1);
    assert.equal(ownTeam().overclock_cost_pending, 1);
    assert.equal(ownTeam().overclock_fixture, "");
    assert.deepEqual(ownPlayers(), before);
  });
  await test("manual lineup changed after arming charges exactly the actual frozen five", async () => {
    await configure();
    const before = ownPlayers();
    assert.equal((await purchase()).status, 200);
    const response = await request("/api/footfive/my-team/lineup", user.token, { starters: changedFive, subs: field.slice(2, 4).map((p) => p.id) });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal((await kick()).status, 200);
    checkPayment(before, changedFive);
    assert.equal(charge().points, 3);
  });
  await test("Full AI pays its single pre-debit selection even when debit would change fitness ranking", async () => {
    await configure({ ai: true });
    await stop();
    execute([
      ["UPDATE proball_players SET attack = 50, defence = 50 WHERE team = ?", [team.id]],
      ...field.map((p, i) => ["UPDATE proball_players SET energy = ? WHERE id = ?", [[90, 89, 86, 85, 88, 87][i], p.id]]),
    ]);
    await start();
    const before = ownPlayers();
    assert.notDeepEqual([...savedFive].sort(), [...changedFive].sort(), "AI must differ from saved flags");
    assert.equal((await purchase()).status, 200);
    assert.equal((await kick()).status, 200);
    checkPayment(before, changedFive);
    // Excluded players are now fitter than some payers: reselecting after the
    // debit would visibly choose a different lineup, which is forbidden.
    const energies = new Map(ownPlayers().map((p) => [p.id, p.energy]));
    assert(energies.get(field[2].id) > energies.get(field[5].id));
    assert.deepEqual(ownPlayers().filter((p) => p.is_starter).map((p) => p.id).sort(), [...savedFive].sort());
  });
  await test("squad/world/live and snapshot/match previews never consume or charge an armed cost", async () => {
    await configure();
    assert.equal((await purchase()).status, 200);
    const before = JSON.stringify([ownPlayers(), ownTeam(), charge()]);
    for (const route of ["/api/footfive/my-team", "/api/footfive/world", "/api/footfive/live"]) assert.equal((await request(route, user.token)).status, 200, route);
    const preview = await operation("preview", clock - 1);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(JSON.stringify([ownPlayers(), ownTeam(), charge()]), before);
    assert.equal(query("SELECT id FROM match_states WHERE fixture = ?", fixture.id).length, 0);
  });
  await test("repeated kickoff and scheduled partial-round repair preserve already-paid fixture once", async () => {
    await configure();
    assert.equal((await purchase()).status, 200);
    assert.equal((await kick()).status, 200);
    const before = JSON.stringify([ownPlayers(), ownTeam(), frozenState()]);
    assert.equal((await operation("tick")).status, 200);
    assert.equal(JSON.stringify([ownPlayers(), ownTeam(), frozenState()]), before);
    await stop();
    const other = fixtureRows.find((f) => f.id !== fixture.id);
    execute([
      ["DELETE FROM match_events WHERE fixture = ?", [other.id]], ["DELETE FROM match_states WHERE fixture = ?", [other.id]],
      ["DELETE FROM shared_fixtures WHERE id = ?", [other.id]], ["UPDATE shared_rounds SET status = 'scheduled' WHERE id = ?", [round.id]],
    ]);
    await start();
    assert.equal((await operation("tick")).status, 200);
    assert.equal(query("SELECT id FROM shared_fixtures WHERE round = ?", round.id).length, 8);
    assert.equal(JSON.stringify([ownPlayers(), ownTeam(), frozenState()]), before);
  });
  await test("late kickoff save fault rolls back all five energy costs, flags and frozen state; retry charges once", async () => {
    await configure();
    assert.equal((await purchase()).status, 200);
    const beforePlayers = ownPlayers();
    arm({ id: "kickoff", team: team.id, fixture: fixture.id });
    const before = snapshot();
    const response = await kick();
    rejected(response);
    await witness("ff121-late-fault:kickoff");
    for (const id of savedFive) await witness("ff121-paid:kickoff:" + id);
    assert.equal(snapshot(), before);
    disarm();
    assert.equal((await kick()).status, 200);
    checkPayment(beforePlayers, savedFive);
    const once = JSON.stringify([ownPlayers(), ownTeam(), frozenState()]);
    assert.equal((await operation("tick")).status, 200);
    assert.equal(JSON.stringify([ownPlayers(), ownTeam(), frozenState()]), once);
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
