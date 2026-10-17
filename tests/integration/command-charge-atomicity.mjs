/**
 * Issue 18: actual authenticated actions against disposable PocketBase 0.28.4.
 * node tests/integration/command-charge-atomicity.mjs
 * COMMAND_CHARGE_PB_PORT=8299; COMMAND_CHARGE_HOOKS optionally selects baseline hooks.
 * Only temporary hooks/data are changed. External SQLite fixture writes happen
 * with our PB stopped. Faults/delays wrap persistence, never replace action logic.
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
const PORT = Number(process.env.COMMAND_CHARGE_PB_PORT || 8299);
assert(Number.isInteger(PORT) && PORT > 1024 && PORT <= 65535, "invalid disposable PB port");
const BASE = `http://127.0.0.1:${PORT}`;
const HOOKS_SOURCE = process.env.COMMAND_CHARGE_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ff-command-charge-"));
const DATA = path.join(TMP, "pb_data");
const HOOKS = path.join(TMP, "pb_hooks");
const FAULT = path.join(TMP, "fault.json");
const LOG = path.join(TMP, "pb.log");
const results = [];
let child;
let user;
let freshUser;
let team;
let ownFixture;
let foreignFixture;
let players;
let foreignPlayer;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const faultHooks = `
onRecordCreate(function(e) {
  var spec = null;
  try { spec = JSON.parse(toString($os.readFile($os.getenv("FF_CHARGE_FAULT")))); } catch (_) {}
  if (spec && spec.op === "create" && spec.collection === e.record.collection().name) {
    console.log("ff18-injected:" + spec.id);
    throw new Error("injected-command-charge:" + spec.id);
  }
  e.next();
});
onRecordUpdate(function(e) {
  var spec = null;
  try { spec = JSON.parse(toString($os.readFile($os.getenv("FF_CHARGE_FAULT")))); } catch (_) {}
  if (spec && spec.op === "update" && spec.collection === e.record.collection().name && (!spec.record || spec.record === e.record.id)) {
    if (spec.delayMs) {
      var until = Date.now() + spec.delayMs;
      while (Date.now() < until) {}
    } else {
      console.log("ff18-injected:" + spec.id);
      throw new Error("injected-command-charge:" + spec.id);
    }
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
const spend = (body, actor = user) => request("/api/footfive/command-charge/spend", actor.token, body);
const charge = (actor = user) => query("SELECT * FROM command_charge WHERE user = ?", actor.id);
const points = (actor = user) => charge(actor)[0]?.points;
function state() {
  return Object.fromEntries(["command_charge", "proball_players", "proball_teams", "tactical_scans"]
    .map((table) => [table, query(`SELECT * FROM ${table} ORDER BY id`)]));
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
    env: { ...process.env, FOOTFIVE_TIME_SCALE: "1", FF_CHARGE_FAULT: FAULT }, stdio: ["ignore", "pipe", "pipe"],
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
async function configure(extra = [], balance = 5, lastAt = new Date(Date.now() + 3600_000).toISOString()) {
  disarm();
  await stop();
  execute([
    ["UPDATE world SET progression_paused = 1, pace = 'normal' WHERE key = 'main'"],
    ["UPDATE command_charge SET points = ?, last_regen_at = ? WHERE user = ?", [balance, lastAt, user.id]],
    ["UPDATE proball_players SET condition = 40, energy = 40, energy_updated_at = ? WHERE team = ?", [new Date(Date.now() + 3600_000).toISOString(), team.id]],
    ["UPDATE proball_teams SET overclock_ready = 0, overclock_cost_pending = 0, overclock_fixture = '' WHERE id = ?", [team.id]],
    ["DELETE FROM tactical_scans"],
    ...extra,
  ]);
  await start();
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
  const created = await request("/api/collections/users/records", null, { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "Charge tester" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const login = await request("/api/collections/users/auth-with-password", null, { identity: email, password: "testpass99" });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { id: login.data.record.id, token: login.data.token };
}

async function main() {
  console.log(`Command Charge atomicity: ${HOOKS_SOURCE}, port ${PORT}, evidence ${TMP}`);
  fs.mkdirSync(DATA);
  fs.cpSync(HOOKS_SOURCE, HOOKS, { recursive: true });
  fs.writeFileSync(path.join(HOOKS, "zz_charge_faults.pb.js"), faultHooks);
  await start();
  user = await register("charge-main@test.local");
  freshUser = await register("charge-fresh@test.local");
  assert.equal((await request("/api/footfive/health")).status, 200);
  await stop();
  const teams = query("SELECT * FROM proball_teams ORDER BY sort_order");
  team = teams[0];
  execute([
    ["UPDATE world SET progression_paused = 1, pace = 'normal' WHERE key = 'main'"],
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [user.id, team.id]],
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [freshUser.id, teams[1].id]],
  ]);
  players = query("SELECT * FROM proball_players WHERE team = ? ORDER BY sort_order", team.id);
  foreignPlayer = query("SELECT * FROM proball_players WHERE team != ? LIMIT 1", team.id)[0];
  ownFixture = query("SELECT * FROM shared_fixtures WHERE home_team = ? OR away_team = ? LIMIT 1", team.id, team.id)[0];
  foreignFixture = query("SELECT * FROM shared_fixtures WHERE home_team != ? AND away_team != ? LIMIT 1", team.id, team.id)[0];
  assert(players.length >= 5 && ownFixture && foreignFixture, "complete real world fixture required");
  await start();
  assert.equal((await request("/api/footfive/command-charge", user.token)).status, 200);

  for (const [name, body] of [
    ["missing player parameter", { action: "rapid_charge" }],
    ["missing player record", { action: "rapid_charge", playerId: "missingplayer00" }],
    ["foreign player", { action: "field_repair", playerId: foreignPlayer.id }],
    ["missing scan fixture", { action: "tactical_scan", fixtureId: "missingfixture0" }],
    ["foreign scan fixture", { action: "tactical_scan", fixtureId: foreignFixture.id }],
    ["no upcoming scan fixture", { action: "tactical_scan" }],
  ]) await test(name + " spends nothing", async () => {
    const extra = name.startsWith("no upcoming") ? [["UPDATE shared_fixtures SET status = 'finished' WHERE home_team = ? OR away_team = ?", [team.id, team.id]]] : [];
    await configure(extra);
    const before = state();
    rejected(await spend(body));
    assert.deepEqual(state(), before);
    if (extra.length) await configure([["UPDATE shared_fixtures SET status = 'scheduled' WHERE id = ?", [ownFixture.id]]]);
  });

  for (const action of ["toString", "constructor", "__proto__"]) await test(`inherited action ${action} is cleanly rejected`, async () => {
    await configure();
    const before = state();
    const response = await spend({ action });
    rejected(response);
    assert.match(response.data.message, /unknown action/i);
    assert.deepEqual(state(), before);
  });

  for (const action of ["rapid_charge", "field_repair", "tactical_scan", "overclock"]) await test(`${action} retains its cost and effect`, async () => {
    await configure();
    const response = await spend({ action, playerId: players[0].id, fixtureId: ownFixture.id });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(points(), action === "overclock" ? 3 : 4);
    const player = query("SELECT * FROM proball_players WHERE id = ?", players[0].id)[0];
    if (action === "rapid_charge") assert.equal(player.energy, 58);
    if (action === "field_repair") assert.equal(player.condition, 55);
    if (action === "tactical_scan") {
      const scans = query("SELECT * FROM tactical_scans WHERE user = ?", user.id);
      assert.equal(scans.length, 1);
      assert.equal(scans[0].fixture_id, ownFixture.id);
      assert.deepEqual(JSON.parse(scans[0].report_json), response.data.report);
    }
    if (action === "overclock") {
      // Issue 121: arming owes the energy cost; the actual kick-off starters pay it.
      assert.deepEqual(query("SELECT overclock_ready, overclock_cost_pending FROM proball_teams WHERE id = ?", team.id)[0], { overclock_ready: 1, overclock_cost_pending: 1 });
      assert(query("SELECT energy FROM proball_players WHERE team = ?", team.id).every((row) => row.energy === 40));
    }
  });

  for (const [name, action, collection, op, record] of [
    ["player update", "rapid_charge", "proball_players", "update", players[0].id],
    ["scan insert", "tactical_scan", "tactical_scans", "create", null],
    ["late overclock team save", "overclock", "proball_teams", "update", team.id],
  ]) await test(`${name} fault rolls back charge and every effect`, async () => {
    await configure();
    const before = state();
    arm({ id: name, collection, op, record });
    const response = await spend({ action, playerId: players[0].id, fixtureId: ownFixture.id });
    rejected(response);
    // Goja/PB may wrap a persistence exception; use the real hook's unique log
    // marker to prove the requested late fault was reached, not its public text.
    const deadline = Date.now() + 1000;
    while (!fs.readFileSync(LOG, "utf8").includes("ff18-injected:" + name) && Date.now() < deadline) await sleep(10);
    assert(fs.readFileSync(LOG, "utf8").includes("ff18-injected:" + name), "requested fault did not run");
    assert.deepEqual(state(), before);
  });

  async function concurrentCase(balance, regen, firstUse) {
    const actor = firstUse ? freshUser : user;
    const actorTeam = firstUse ? query("SELECT id FROM proball_teams WHERE manager = ?", actor.id)[0].id : team.id;
    const targets = query("SELECT id FROM proball_players WHERE team = ? ORDER BY sort_order LIMIT 5", actorTeam);
    const count = firstUse ? 3 : 5;
    const expectedSuccess = firstUse ? 3 : balance + (regen ? 1 : 0);
    const lastAt = new Date(Date.now() - 900_000 - 10_000).toISOString();
    await configure([
      ["UPDATE proball_players SET condition = 0 WHERE team = ?", [actorTeam]],
      ...(firstUse ? [["DELETE FROM command_charge WHERE user = ?", [actor.id]]] : []),
    ], balance, regen ? lastAt : undefined);
    if (regen) {
      // Independently prove both public readers include the one earned point;
      // their response need not be materialised into the stored charge row.
      const direct = await request("/api/footfive/command-charge", actor.token);
      const world = await request("/api/footfive/world", actor.token);
      assert.equal(direct.status, 200);
      assert.equal(world.status, 200);
      assert.equal(direct.data.points, 2);
      assert.equal(world.data.commandCharge.points, 2);
    }
    arm({ collection: "command_charge", op: "update", delayMs: 120 });
    const actions = targets.slice(0, count).map((p) => spend({ action: "field_repair", playerId: p.id }, actor));
    const reads = (regen || firstUse) ? Array.from({ length: 4 }, (_, i) => request(i % 2 ? "/api/footfive/world" : "/api/footfive/command-charge", actor.token)) : [];
    const [responses, readResponses] = await Promise.all([Promise.all(actions), Promise.all(reads)]);
    assert.equal(responses.filter((r) => r.status === 200).length, expectedSuccess, JSON.stringify(responses));
    for (const response of responses.filter((r) => r.status !== 200)) {
      rejected(response);
      assert.match(response.data.message, /insufficient command charge/i);
    }
    for (const response of readResponses) {
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const value = response.data.commandCharge || response.data;
      assert(Number.isInteger(value.points) && value.points >= 0 && value.points <= (firstUse ? 5 : expectedSuccess));
    }
    assert.equal(charge(actor).length, 1);
    assert.equal(points(actor), (firstUse ? 5 : expectedSuccess) - expectedSuccess);
    targets.slice(0, count).forEach((p, i) => {
      assert.equal(query("SELECT condition FROM proball_players WHERE id = ?", p.id)[0].condition, responses[i].status === 200 ? 15 : 0);
    });
    const persisted = charge(actor)[0];
    const finalRead = await request("/api/footfive/command-charge", actor.token);
    assert.equal(finalRead.status, 200);
    assert.equal(finalRead.data.points, persisted.points, "reading must not restore spent credit");
    assert.equal(points(actor), persisted.points);
  }
  await test("parallel actions cannot overspend a two-point balance", () => concurrentCase(2, false, false));
  await test("regeneration GET/world reads racing spends cannot restore credit", () => concurrentCase(1, true, false));
  await test("first-use GET/world/spend race creates one row and reconciles effects", () => concurrentCase(5, false, true));

  await test("spending from regenerated full charge discards banked regen time", async () => {
    await configure([], 5, new Date(Date.now() - 3600_000).toISOString());
    const before = Date.now();
    const response = await spend({ action: "overclock" });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(points(), 3);
    const saved = charge()[0];
    const resetAt = Date.parse(saved.last_regen_at.replace(" ", "T"));
    await sleep(1000); // Exercise the specified subsequent read, well before a new point is due.
    const later = await request("/api/footfive/command-charge", user.token);
    assert.equal(later.status, 200);
    assert.equal(later.data.points, 3, `banked regen restored points; persisted clock ${saved.last_regen_at}`);
    assert.equal(points(), 3);
    assert(resetAt >= before - 10 && resetAt <= Date.now(), `regen clock not reset at spend: ${saved.last_regen_at}`);
  });

  // Issue 120: an armed overclock is a rejected request, never another purchase.
  const overclockSnapshot = () => JSON.stringify({ state: state(), fixtures: query("SELECT * FROM shared_fixtures ORDER BY id") });
  function alreadyArmed(response) {
    assert([400, 409].includes(response.status), JSON.stringify(response));
    assert.match(response.data.message, /overclock.*already armed/i);
  }
  function oneArmEffect() {
    assert.equal(points(), 3, "one arm costs exactly two points from five");
    const savedTeam = query("SELECT * FROM proball_teams WHERE id = ?", team.id)[0];
    assert.equal(savedTeam.overclock_ready, 1);
    assert.equal(savedTeam.overclock_cost_pending, 1);
    assert.equal(savedTeam.overclock_fixture, "");
    const squad = query("SELECT * FROM proball_players WHERE team = ?", team.id);
    assert.equal(squad.filter((p) => p.is_starter).length, 5);
    for (const player of squad) assert.equal(player.energy, 40,
      "arming owes the energy cost until kick-off (issue 121)");
  }

  await test("first overclock arm keeps its cost/effect; second arm changes no persisted state", async () => {
    await configure();
    const first = await spend({ action: "overclock" });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    oneArmEffect();
    const before = overclockSnapshot();
    const second = await spend({ action: "overclock" });
    assert.equal(overclockSnapshot(), before, "repeat arm changed charge clock, energy, flag or fixture state");
    alreadyArmed(second);
  });

  await test("concurrent first overclock arms buy exactly one effect despite balance sufficient for both", async () => {
    await configure([], 5);
    // Delay the real debit persistence inside the action, widening the overlap
    // without replacing its fresh reads, transaction or effect implementation.
    arm({ collection: "command_charge", op: "update", delayMs: 120 });
    const responses = await Promise.all([spend({ action: "overclock" }), spend({ action: "overclock" })]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1, JSON.stringify(responses));
    alreadyArmed(responses.find((r) => r.status !== 200));
    oneArmEffect();
  });

  for (const missingCharge of [false, true]) await test(`already-armed overclock rejects before ${missingCharge ? "creating absent" : "checking insufficient"} charge`, async () => {
    await configure([
      ["UPDATE proball_teams SET overclock_ready = 1, overclock_fixture = ? WHERE id = ?", [ownFixture.id, team.id]],
      ...(missingCharge ? [["DELETE FROM command_charge WHERE user = ?", [user.id]]] : []),
    ], 1);
    assert.equal(charge().length, missingCharge ? 0 : 1);
    const before = overclockSnapshot();
    const response = await spend({ action: "overclock" });
    assert.equal(overclockSnapshot(), before, "already-armed rejection must preserve every row, including absent charge");
    alreadyArmed(response);
  });

  // Issue 122: rejected full targets preserve raw application rows, including
  // unmaterialised energy and charge clocks. Never call a materialising GET here.
  function fullTargetState() {
    const tables = query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB '_*' AND name NOT GLOB 'sqlite_*' ORDER BY name");
    return JSON.stringify(tables.map(({ name }) => [name, query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY id`)]));
  }
  function alreadyFull(response, field) {
    rejected(response);
    assert.match(response.data.message, field === "energy" ? /energy already full/i : /condition already full/i);
  }
  // The preceding absent-charge overclock control intentionally leaves no row.
  // Create our own starting balance through the real API, not a hidden fixture dependency.
  assert.equal((await request("/api/footfive/command-charge", user.token)).status, 200);
  for (const [action, field] of [["rapid_charge", "energy"], ["field_repair", "condition"]]) {
    await test(`${action} rejects a stored full target without changing any application row`, async () => {
      await configure([[`UPDATE proball_players SET ${field} = 100 WHERE id = ?`, [players[0].id]]]);
      const before = fullTargetState();
      alreadyFull(await spend({ action, playerId: players[0].id }), field);
      assert.equal(fullTargetState(), before);
    });

    for (const absent of [false, true]) await test(`${action} full target rejects before ${absent ? "creating absent" : "checking empty"} charge`, async () => {
      // Restore the deleted fixture row even if baseline incorrectly creates one,
      // so all subsequent compatibility controls have the same initial state.
      const savedCharge = charge()[0];
      assert(savedCharge);
      try {
        await configure([
          [`UPDATE proball_players SET ${field} = 100 WHERE id = ?`, [players[0].id]],
          ...(absent ? [["DELETE FROM command_charge WHERE user = ?", [user.id]]] : []),
        ], 0);
        assert.equal(charge().length, absent ? 0 : 1);
        const before = fullTargetState();
        alreadyFull(await spend({ action, playerId: players[0].id }), field);
        assert.equal(fullTargetState(), before);
      } finally {
        if (absent) {
          await stop();
          const columns = Object.keys(savedCharge);
          execute([
            ["DELETE FROM command_charge WHERE user = ?", [user.id]],
            [`INSERT INTO command_charge (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, Object.values(savedCharge)],
          ]);
          await start();
        }
      }
    });

    await test(`${action} partial 99 target still costs one and clamps to 100`, async () => {
      await configure([[`UPDATE proball_players SET ${field} = 99 WHERE id = ?`, [players[0].id]]]);
      const otherPlayers = query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", players[0].id);
      const response = await spend({ action, playerId: players[0].id });
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.data[field], 100);
      assert.equal(query(`SELECT ${field} FROM proball_players WHERE id = ?`, players[0].id)[0][field], 100);
      assert.equal(points(), 4);
      assert.deepEqual(query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", players[0].id), otherPlayers);
    });

    await test(`${action} concurrent near-full requests buy one effect and reject the now-full target`, async () => {
      await configure([[`UPDATE proball_players SET ${field} = 99 WHERE id = ?`, [players[0].id]]], 5);
      const otherPlayers = query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", players[0].id);
      // Both requests can afford the effect; widen overlap at native debit save.
      arm({ collection: "command_charge", op: "update", delayMs: 120 });
      const responses = await Promise.all([spend({ action, playerId: players[0].id }), spend({ action, playerId: players[0].id })]);
      assert.equal(responses.filter((r) => r.status === 200).length, 1, JSON.stringify(responses));
      alreadyFull(responses.find((r) => r.status !== 200), field);
      assert.equal(points(), 4);
      assert.equal(query(`SELECT ${field} FROM proball_players WHERE id = ?`, players[0].id)[0][field], 100);
      assert.deepEqual(query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", players[0].id), otherPlayers);
    });
  }

  await test("regenerated full energy rejects and rolls back stored energy and its old stamp", async () => {
    // A full day comfortably earns the missing point at normal production pace.
    const oldStamp = new Date(Date.now() - 86400_000).toISOString();
    await configure([["UPDATE proball_players SET energy = 99, energy_updated_at = ? WHERE id = ?", [oldStamp, players[0].id]]]);
    const stored = query("SELECT * FROM proball_players WHERE id = ?", players[0].id)[0];
    assert.equal(stored.energy, 99);
    assert.equal(stored.energy_updated_at, oldStamp);
    const before = fullTargetState();
    alreadyFull(await spend({ action: "rapid_charge", playerId: players[0].id }), "energy");
    assert.equal(fullTargetState(), before);
  });

  // Issue 135: real partial battery (+40, cap 100). Not a full restore.
  const useBattery = (playerId, actor = user) => request(`/api/footfive/players/${playerId}/battery`, actor.token, {});
  function batterySurroundings(playerId) {
    return {
      treasury: query("SELECT treasury FROM proball_teams WHERE id = ?", team.id)[0].treasury,
      charge: query("SELECT * FROM command_charge ORDER BY id"),
      others: query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", playerId),
      matches: query("SELECT * FROM match_states ORDER BY id"),
    };
  }
  function assertOneBattery(playerId, before, remaining) {
    assert.equal(query("SELECT treasury FROM proball_teams WHERE id = ?", team.id)[0].treasury, before.treasury);
    assert.deepEqual(query("SELECT * FROM command_charge ORDER BY id"), before.charge);
    assert.deepEqual(query("SELECT * FROM proball_players WHERE id != ? ORDER BY id", playerId), before.others);
    assert.deepEqual(query("SELECT * FROM match_states ORDER BY id"), before.matches);
    assert.equal(query("SELECT battery_count FROM proball_teams WHERE id = ?", team.id)[0].battery_count, remaining);
  }

  await test("battery raises stored 20 energy to 60, consumes one, and refreshes only that stamp", async () => {
    await configure([
      ["UPDATE proball_players SET energy = 20 WHERE id = ?", [players[0].id]],
      ["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]],
    ]);
    const beforeStamp = query("SELECT energy_updated_at FROM proball_players WHERE id = ?", players[0].id)[0].energy_updated_at;
    const before = batterySurroundings(players[0].id);
    const started = Date.now();
    const response = await useBattery(players[0].id);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.ok, true);
    const player = query("SELECT energy, energy_updated_at FROM proball_players WHERE id = ?", players[0].id)[0];
    assert.equal(player.energy, 60);
    assertOneBattery(players[0].id, before, 1);
    const refreshed = Date.parse(String(player.energy_updated_at).replace(" ", "T"));
    assert.notEqual(player.energy_updated_at, beforeStamp);
    assert(refreshed >= started - 2000 && refreshed <= Date.now() + 2000, player.energy_updated_at);
  });

  await test("battery caps stored 90 energy at 100 and consumes one", async () => {
    await configure([
      ["UPDATE proball_players SET energy = 90 WHERE id = ?", [players[0].id]],
      ["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]],
    ]);
    const before = batterySurroundings(players[0].id);
    const response = await useBattery(players[0].id);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(query("SELECT energy FROM proball_players WHERE id = ?", players[0].id)[0].energy, 100);
    assertOneBattery(players[0].id, before, 1);
  });

  await test("battery rejects stored full energy with no writes", async () => {
    await configure([
      ["UPDATE proball_players SET energy = 100 WHERE id = ?", [players[0].id]],
      ["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]],
    ]);
    const before = fullTargetState();
    const response = await useBattery(players[0].id);
    alreadyFull(response, "energy");
    assert.equal(fullTargetState(), before);
  });

  await test("battery rejects energy regenerated to full and rolls back the old stamp", async () => {
    const oldStamp = new Date(Date.now() - 86400_000).toISOString();
    await configure([
      ["UPDATE proball_players SET energy = 99, energy_updated_at = ? WHERE id = ?", [oldStamp, players[0].id]],
      ["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]],
    ]);
    const stored = query("SELECT energy, energy_updated_at FROM proball_players WHERE id = ?", players[0].id)[0];
    assert.equal(stored.energy, 99);
    assert.equal(stored.energy_updated_at, oldStamp);
    const before = fullTargetState();
    alreadyFull(await useBattery(players[0].id), "energy");
    assert.equal(fullTargetState(), before);
  });

  await test("battery with no inventory rejects and leaves every application row unchanged", async () => {
    await configure([
      ["UPDATE proball_players SET energy = 20 WHERE id = ?", [players[0].id]],
      ["UPDATE proball_teams SET battery_count = 0 WHERE id = ?", [team.id]],
    ]);
    const before = fullTargetState();
    const response = await useBattery(players[0].id);
    rejected(response);
    assert.match(response.data.message, /no batteries/i);
    assert.equal(fullTargetState(), before);
  });

  await test("battery on a foreign player rejects and leaves every application row unchanged", async () => {
    await configure([["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]]]);
    const before = fullTargetState();
    const response = await useBattery(foreignPlayer.id);
    rejected(response);
    assert.match(response.data.message, /not your player/i);
    assert.equal(fullTargetState(), before);
  });

  await test("battery team-inventory save fault rolls back the written restore", async () => {
    await configure([
      ["UPDATE proball_players SET energy = 20 WHERE id = ?", [players[0].id]],
      ["UPDATE proball_teams SET battery_count = 2 WHERE id = ?", [team.id]],
    ]);
    const before = fullTargetState();
    arm({ id: "battery-team", collection: "proball_teams", op: "update", record: team.id });
    const response = await useBattery(players[0].id);
    rejected(response);
    const deadline = Date.now() + 1000;
    while (!fs.readFileSync(LOG, "utf8").includes("ff18-injected:battery-team") && Date.now() < deadline) await sleep(10);
    assert(fs.readFileSync(LOG, "utf8").includes("ff18-injected:battery-team"), "requested fault did not run");
    assert.equal(fullTargetState(), before);
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
