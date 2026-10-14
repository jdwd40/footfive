/**
 * FF-19: actual authenticated lineup requests, disposable PocketBase only.
 * node tests/integration/lineup-atomicity.mjs
 * LINEUP_PB_PORT defaults to 8300; LINEUP_HOOKS selects optional baseline hooks.
 * SQLite fixture writes require our process stopped; temp hooks only inject
 * persistence failures/delays. No production data, dependencies or live services.
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
const PORT = Number(process.env.LINEUP_PB_PORT || 8300);
assert(Number.isInteger(PORT) && PORT > 1024 && PORT <= 65535, "invalid disposable PB port");
const BASE = `http://127.0.0.1:${PORT}`;
const HOOKS_SOURCE = process.env.LINEUP_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ff-lineup-"));
const DATA = path.join(TMP, "pb_data");
const HOOKS = path.join(TMP, "pb_hooks");
const FAULT = path.join(TMP, "fault.json");
const LOG = path.join(TMP, "pb.log");
const results = [];
let child, user, otherUser, team, original, ids, foreignPlayer, frozenBefore;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const faultHooks = `
onRecordUpdate(function(e) {
  var spec = null;
  try { spec = JSON.parse(toString($os.readFile($os.getenv("FF_LINEUP_FAULT")))); } catch (_) {}
  if (spec && e.record.collection().name === "proball_players" && e.record.get("team") === spec.team) {
    if (spec.mode === "late-fault") {
      var key = "ff19_fault_" + spec.id;
      var count = ($app.store().get(key) || 0) + 1;
      $app.store().set(key, count);
      if (count > 2) {
        console.log("ff19-late-fault:" + spec.id);
        throw new Error("injected late lineup save");
      }
      e.next();
      console.log("ff19-earlier-save:" + spec.id + ":" + count);
      return;
    }
    if (spec.mode === "race") {
      for (var i = 0; i < spec.delays.length; i++) {
        var delay = spec.delays[i];
        if (e.record.id === delay.player && e.record.get("sort_order") === delay.order) {
          var until = Date.now() + delay.ms;
          while (Date.now() < until) {}
        }
      }
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
function disarm() { fs.rmSync(FAULT, { force: true }); }
function arm(spec) { fs.writeFileSync(FAULT, JSON.stringify(spec)); }
async function start() {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: PORT, host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
  child = spawn(path.join(ROOT, "pocketbase/pocketbase"), ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA}`, `--hooksDir=${HOOKS}`, `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`], {
    env: { ...process.env, FOOTFIVE_TIME_SCALE: "1", FF_LINEUP_FAULT: FAULT }, stdio: ["ignore", "pipe", "pipe"],
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
  const created = await request("/api/collections/users/records", null, { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "Lineup tester" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const login = await request("/api/collections/users/auth-with-password", null, { identity: email, password: "testpass99" });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { id: login.data.record.id, token: login.data.token };
}


const submit = (body, actor = user) => request("/api/footfive/my-team/lineup", actor.token, body);
const playerBytes = () => JSON.stringify(query("SELECT * FROM proball_players ORDER BY id"));
const ownRows = () => query("SELECT * FROM proball_players WHERE team = ? ORDER BY sort_order,id", team.id);
const lineup = () => ownRows().map((p) => [p.id, p.is_starter, p.sort_order]);
function frozen() {
  return query("SELECT id,home_lineup_json,away_lineup_json,lineups_frozen FROM shared_fixtures WHERE lineups_frozen = 1 ORDER BY id");
}
const reserveIds = (starters) => original.filter((p) => !starters.includes(p.id)).map((p) => p.id);
function expected(starters, subs) {
  const ordered = [...starters, ...subs];
  return ordered.map((id, index) => [id, index < 5 ? 1 : 0, index]);
}
async function configure(extra = []) {
  disarm();
  await stop();
  execute([
    ["UPDATE world SET progression_paused = 1 WHERE key = 'main'"],
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [user.id, team.id]],
    ...original.map((p) => ["UPDATE proball_players SET is_starter = ?, sort_order = ?, role = ? WHERE id = ?", [p.is_starter, p.sort_order, p.role, p.id]]),
    ...extra,
  ]);
  await start();
}
async function main() {
  console.log(`Lineup atomicity: ${HOOKS_SOURCE}, port ${PORT}, evidence ${TMP}`);
  fs.mkdirSync(DATA);
  fs.cpSync(HOOKS_SOURCE, HOOKS, { recursive: true });
  fs.writeFileSync(path.join(HOOKS, "zz_lineup_faults.pb.js"), faultHooks);
  await start();
  user = await register("lineup-main@test.local");
  otherUser = await register("lineup-other@test.local");
  assert.equal((await request("/api/footfive/health")).status, 200);
  await stop();
  team = query("SELECT * FROM proball_teams ORDER BY sort_order LIMIT 1")[0];
  const past = new Date(Date.now() - 1000).toISOString();
  execute([
    ["UPDATE proball_teams SET manager = ?, manager_mode = 'manual' WHERE id = ?", [user.id, team.id]],
    ["UPDATE shared_rounds SET scheduled_at = ? WHERE status = 'scheduled'", [past]],
    ["UPDATE shared_fixtures SET scheduled_at = ? WHERE status = 'scheduled'", [past]],
  ]);
  await start();
  assert.equal((await request("/api/footfive/health")).status, 200);
  assert(query("SELECT id FROM match_states").length > 0, "real kickoff must create match states");
  await stop();
  execute([["UPDATE world SET progression_paused = 1 WHERE key = 'main'"]]);
  await start();
  original = ownRows();
  assert.equal(original.length, 7, "authored squad fixture has five starters and two reserves");
  const gk = original.find((p) => p.role === "gk");
  const field = original.filter((p) => p.role !== "gk");
  assert(gk && field.length >= 5);
  ids = [gk.id, ...field.map((p) => p.id)];
  foreignPlayer = query("SELECT id FROM proball_players WHERE team != ? LIMIT 1", team.id)[0].id;
  frozenBefore = frozen();
  assert(frozenBefore.length > 0, "real frozen fixture lineups required");
  const starters = [ids[2], ids[0], ids[4], ids[5], ids[6]];
  const reserves = reserveIds(starters);

  const invalid = [
    ["missing starters", {}],
    ["four starters", { starters: starters.slice(0, 4) }],
    ["six starters", { starters: [...starters, reserves[0]] }],
    ["repeated goalkeeper", { starters: Array(5).fill(gk.id) }],
    ["duplicate field player", { starters: [gk.id, ids[1], ids[1], ids[2], ids[3]] }],
    ["string starters", { starters: "abcde" }],
    ["object starters", { starters: { 0: gk.id, length: 5 } }],
    ["false starters", { starters: false }],
    ["non-string starter", { starters: [gk.id, ids[1], ids[2], ids[3], {}] }],
    ["missing starter ID", { starters: [gk.id, ids[1], ids[2], ids[3], "missingplayer00"] }],
    ["foreign starter", { starters: [gk.id, ids[1], ids[2], ids[3], foreignPlayer] }],
    ["no goalkeeper", { starters: field.slice(0, 5).map((p) => p.id) }],
    ...[false, 0, "", "not-an-array", {}, [7]].map((subs) => [`malformed subs ${JSON.stringify(subs)}`, { starters, subs }]),
    ["duplicate subs", { starters, subs: [reserves[0], reserves[0]] }],
    ["foreign sub", { starters, subs: [foreignPlayer] }],
    ["missing sub ID", { starters, subs: ["missingplayer00"] }],
    ["starter/sub overlap", { starters, subs: [starters[0]] }],
  ];
  for (const [name, body] of invalid) await test(name + " rejects without any player write", async () => {
    await configure();
    const before = playerBytes();
    const response = await submit(body);
    rejected(response);
    assert.equal(playerBytes(), before);
  });

  for (const [name, supplied, bench] of [
    ["omitted subs", undefined, reserves],
    ["null subs", null, reserves],
    ["empty subs", [], reserves],
    ["partial subs", [reserves[1]], [reserves[1], reserves[0]]],
    ["full subs", [reserves[1], reserves[0]], [reserves[1], reserves[0]]],
  ]) await test(name + " preserves starter and fallback reserve order", async () => {
    await configure();
    const foreignBefore = query("SELECT * FROM proball_players WHERE team != ? ORDER BY id", team.id);
    const response = await submit({ starters, ...(supplied === undefined ? {} : { subs: supplied }) });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.ok, true);
    assert.deepEqual(lineup(), expected(starters, bench));
    assert.deepEqual(query("SELECT * FROM proball_players WHERE team != ? ORDER BY id", team.id), foreignBefore);
  });

  await test("at least one goalkeeper does not impose a new exactly-one restriction", async () => {
    await configure([["UPDATE proball_players SET role = 'gk' WHERE id = ?", [starters[0]]]]);
    const response = await submit({ starters, subs: reserves });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(lineup(), expected(starters, reserves));
  });

  await test("failure after earlier player saves rolls back every flag/order/row", async () => {
    await configure();
    const before = playerBytes();
    arm({ mode: "late-fault", team: team.id, id: "late-player" });
    const response = await submit({ starters, subs: [...reserves].reverse() });
    rejected(response);
    const markers = ["ff19-earlier-save:late-player:1", "ff19-earlier-save:late-player:2", "ff19-late-fault:late-player"];
    const deadline = Date.now() + 1000;
    while (!markers.every((marker) => fs.readFileSync(LOG, "utf8").includes(marker)) && Date.now() < deadline) await sleep(10);
    assert(markers.every((marker) => fs.readFileSync(LOG, "utf8").includes(marker)), "late fault must follow two completed player saves");
    assert.equal(playerBytes(), before);
  });

  for (const [name, manager] of [["released manager", ""], ["reassigned manager", otherUser.id]]) await test(name + " cannot modify old squad", async () => {
    await configure([["UPDATE proball_teams SET manager = ? WHERE id = ?", [manager, team.id]]]);
    const before = playerBytes();
    rejected(await submit({ starters, subs: reserves }));
    assert.equal(playerBytes(), before);
    if (manager) {
      const response = await submit({ starters, subs: reserves }, otherUser);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.deepEqual(lineup(), expected(starters, reserves));
    }
  });

  await test("concurrent valid saves leave one whole submitted lineup, never a mixture", async () => {
    await configure();
    const a = { starters, subs: [ids[3], ids[1]] };
    const b = { starters: [ids[6], ids[5], ids[0], ids[1], ids[3]], subs: [ids[4], ids[2]] };
    // Without a transaction: A saves early rows, B finishes during A's later
    // pause, then A finishes its tail. Inside a transaction these stay whole.
    arm({ mode: "race", team: team.id, delays: [
      { player: ids[3], order: 5, ms: 300 },
      { player: ids[0], order: 2, ms: 100 },
    ] });
    const responses = await Promise.all([submit(a), submit(b)]);
    for (const response of responses) assert.equal(response.status, 200, JSON.stringify(response.data));
    const actual = JSON.stringify(lineup());
    assert([a, b].some((body) => JSON.stringify(expected(body.starters, body.subs)) === actual), `mixed lineup: ${actual}`);
    assert.equal(ownRows().filter((p) => p.is_starter).length, 5);
  });

  await test("successful squad change leaves already-frozen real match lineups unchanged", async () => {
    await configure();
    assert.deepEqual(frozen(), frozenBefore);
    const statesBefore = query("SELECT id,state_json,seed FROM match_states ORDER BY id");
    const response = await submit({ starters, subs: [...reserves].reverse() });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.deepEqual(lineup(), expected(starters, [...reserves].reverse()));
    assert.deepEqual(frozen(), frozenBefore);
    assert.deepEqual(query("SELECT id,state_json,seed FROM match_states ORDER BY id"), statesBefore);
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
