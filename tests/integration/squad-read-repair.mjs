/**
 * Issue #25 pure squad reads and truthful repair receipts.
 * Disposable loopback PocketBase. Stops only the process this file spawned.
 * Port: SQUAD_READS_PB_PORT, default 8309, integer 1..65535. Lead local sets 8322.
 * Hooks: SQUAD_READS_HOOKS, or the worktree pocketbase/pb_hooks.
 * Migrations always come from the worktree. Binary is pocketbase/pocketbase.
 * Same assertions for baseline and current. PHASE is only an evidence label.
 *
 * Repair is POST /api/footfive/players/{id}/repair (body.points, default 25).
 * Squad aliases are GET /api/footfive/my-team and GET /api/footfive/my-team/squad.
 * Announced match is GET /api/footfive/match/{id}.
 * Normal pace regenerates 12 energy per hour. A dev pace uses 120.
 * Repair price is 12 per applied point. http.fail publishes API messages as 400.
 * An internal ledger fault publishes "Could not repair player" and not the hook text.
 * Fixture SQL uses python3 sqlite and runs only while this PocketBase is stopped.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_SRC = process.env.SQUAD_READS_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const MIGRATIONS = path.join(ROOT, "pocketbase/pb_migrations");
const PB_BIN = path.join(ROOT, "pocketbase/pocketbase");
const PHASE = process.env.SQUAD_READS_HOOKS ? "baseline" : "current";
const APP_PASS = "testpass99";
const STAMP = Date.now();
const TABLES = new Set([
  "proball_players",
  "proball_teams",
  "world",
  "shared_rounds",
  "shared_fixtures",
  "match_states",
  "match_events",
  "team_finance_ledger",
]);
const HOOK = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
routerAdd("GET", "/api/squad-reads/cron-jobs", function (e) {
  var ids = [];
  var jobs = $app.cron().jobs();
  for (var i = 0; i < jobs.length; i++) ids.push(jobs[i].id());
  return e.json(200, ids);
});
routerAdd("POST", "/api/squad-reads/fail-next-ledger", function (e) {
  if (!e.auth || !e.auth.id) throw new UnauthorizedError("Authentication required");
  $app.store().set("ff25_fail_next_ledger", "1");
  return e.json(200, { armed: true });
}, $apis.requireAuth());
onRecordCreate(function (e) {
  var name = "";
  try { name = e.record.collection().name; } catch (err) { return e.next(); }
  if (name !== "team_finance_ledger") return e.next();
  var armed = false;
  try { armed = $app.store().get("ff25_fail_next_ledger") === "1"; } catch (err2) {}
  if (!armed) return e.next();
  try { $app.store().remove("ff25_fail_next_ledger"); } catch (err3) {}
  throw new Error("ff25-ledger-fault");
});
`;
const PY = `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1], timeout=30, isolation_level=None)
c.row_factory = sqlite3.Row
stmts = json.loads(sys.stdin.read())
def writing(sql):
    head = sql.lstrip().upper()
    return not (head.startswith("SELECT") or head.startswith("PRAGMA"))
if any(writing(s) for s, _ in stmts):
    c.execute("BEGIN IMMEDIATE")
    write = True
else:
    write = False
out = []
for stmt, params in stmts:
    cur = c.execute(stmt, params)
    out = [dict(r) for r in cur.fetchall()] if cur.description else []
if write:
    c.execute("COMMIT")
print(json.dumps(out))
`;

const cases = [];
let child = null;
let runWork = "";
let dataDir = "";
let hooksDir = "";
let port = 0;
let token = "";
let regen = 12;

function parsePort(value) {
  if (!/^[0-9]+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function safe(detail) {
  return String(detail).split(APP_PASS).join("[secret]").replace(/eyJ[A-Za-z0-9._-]{12,}/g, "[token]").slice(0, 500);
}

function expectCase(name, kind, ok, detail = "") {
  cases.push({ name, kind, ok: !!ok, detail: ok ? "" : safe(detail) });
  console.log((ok ? "  ok " : "  FAIL ") + kind + " " + name + (ok ? "" : " " + safe(detail).slice(0, 240)));
}

async function check(name, kind, fn) {
  try {
    const detail = await fn();
    expectCase(name, kind, detail == null || detail === true, detail === true || detail == null ? "" : detail);
  } catch (err) {
    expectCase(name, kind, false, err.message || String(err));
  }
}

function says(data, text) {
  const got = String((data && data.message) || "").replace(/\.+$/, "");
  return got === text || got.endsWith(": " + text);
}

function pbDate(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function parsePb(value) {
  if (value == null || value === "") return NaN;
  let text = String(value).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) text += "Z";
  return new Date(text).getTime();
}

function materialised(stored, lastMs, nowMs, perHour) {
  let energy = Math.max(0, Math.min(100, stored == null || stored === "" ? 100 : Number(stored)));
  if (!lastMs || Number.isNaN(lastMs) || !perHour) return Math.round(energy);
  const hours = Math.max(0, (nowMs - lastMs) / 3600000);
  return Math.round(Math.max(0, Math.min(100, energy + hours * perHour)));
}

function isWrite(stmt) {
  return !/^\s*(select|pragma)\b/i.test(stmt);
}

function sql(stmt, params = []) {
  if (isWrite(stmt) && child) throw new Error("fixture SQL requires owned PB stopped");
  const result = spawnSync("python3", ["-c", PY, path.join(dataDir, "data.db")], {
    input: JSON.stringify([[stmt, params]]),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status) throw new Error(safe((result.stderr || result.error || "sql").toString()).slice(0, 400));
  return JSON.parse(result.stdout || "[]");
}

function writeAll(stmts) {
  if (child) throw new Error("fixture SQL requires owned PB stopped");
  for (const [stmt, params] of stmts) sql(stmt, params || []);
}

function mustHave(table, names) {
  if (!TABLES.has(table)) throw new Error("unexpected table");
  const have = new Set(sql(`PRAGMA table_info(${table})`).map((row) => row.name));
  const missing = names.filter((name) => !have.has(name));
  if (missing.length) throw new Error(table + " missing " + missing.join(","));
}

function dump(table) {
  if (!TABLES.has(table)) throw new Error("unexpected table");
  return JSON.stringify(sql(`SELECT * FROM ${table} ORDER BY id`));
}

function req(urlPath, { method = "GET", token: auth, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const url = new URL(`http://127.0.0.1:${port}${urlPath}`);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        agent: false,
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(payload !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, data, text });
        });
      },
    );
    request.setTimeout(60000, () => request.destroy(new Error("timeout " + method + " " + urlPath)));
    request.on("error", reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

function pbEnv() {
  const env = { ...process.env };
  delete env.FOOTFIVE_PB_URL;
  delete env.FOOTFIVE_SUPERUSER_EMAIL;
  delete env.FOOTFIVE_SUPERUSER_PASSWORD;
  delete env.FOOTFIVE_ADMIN_EMAIL;
  delete env.FOOTFIVE_ADMIN_PASSWORD;
  env.FOOTFIVE_TIME_SCALE = "1";
  return env;
}

function probePort(n) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: n, host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
}

async function start() {
  child = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${port}`, `--dir=${dataDir}`, `--hooksDir=${hooksDir}`, `--migrationsDir=${MIGRATIONS}`],
    { env: pbEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const logFile = path.join(runWork, "pb.log");
  child.stdout.on("data", (chunk) => appendFileSync(logFile, chunk));
  child.stderr.on("data", (chunk) => appendFileSync(logFile, chunk));
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("owned PB exited before readiness");
    try {
      const health = await req("/api/health");
      if (health.status >= 200 && health.status < 300) return;
    } catch {
      /* wait for the owned process */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("owned PB readiness timeout");
}

async function stop() {
  const owned = child;
  child = null;
  if (!owned || owned.exitCode !== null) return;
  owned.kill("SIGTERM");
  await once(owned, "exit");
}

async function stopped(stmts) {
  await stop();
  writeAll(stmts);
  await start();
}

function num(stmt, params) {
  const row = sql(stmt, params)[0] || {};
  return Number(row.n != null ? row.n : Object.values(row)[0] || 0);
}

function playerOf(body, id) {
  const list = body && body.players;
  return Array.isArray(list) ? list.find((player) => player.id === id) || null : null;
}

function lineupOk(side) {
  return Array.isArray(side) && side.length > 0 && side.every((player) => player && player.name && player.role);
}

function account(teamId, playerId) {
  const player = sql(
    "SELECT energy, condition, ifnull(energy_updated_at,'') energy_updated_at FROM proball_players WHERE id=?",
    [playerId],
  )[0];
  return {
    player,
    treasury: num("SELECT treasury AS n FROM proball_teams WHERE id=?", [teamId]),
    ledgers: num("SELECT COUNT(*) AS n FROM team_finance_ledger WHERE team=? AND type='repair'", [teamId]),
  };
}

async function run() {
  port = parsePort(process.env.SQUAD_READS_PB_PORT || "8309");
  if (!port) throw new Error("SQUAD_READS_PB_PORT must be an integer from 1 to 65535");
  try {
    await probePort(port);
  } catch (err) {
    throw new Error("loopback port " + port + " is not free (" + (err.code || err.message) + "); not stopping it");
  }

  const work = mkdtempSync(path.join(tmpdir(), "ff25-squad-reads-"));
  runWork = work;
  dataDir = path.join(work, "pb_data");
  hooksDir = path.join(work, "hooks");
  mkdirSync(dataDir, { recursive: true });
  cpSync(HOOKS_SRC, hooksDir, { recursive: true });
  const hookFile = path.join(hooksDir, "zz_squad_reads.pb.js");
  writeFileSync(hookFile, HOOK);
  await start();

  await check("scheduler keeps the system job", "control", async () => {
    const cron = await req("/api/squad-reads/cron-jobs");
    const jobs = Array.isArray(cron.data) ? cron.data : [];
    if (cron.status !== 200 || !jobs.includes("__pbDBOptimize__") || jobs.some((id) => String(id).startsWith("footfive_"))) {
      return cron.status + " " + jobs.join(",");
    }
  });

  let health = await req("/api/footfive/health");
  let teamCount = num("SELECT COUNT(*) AS n FROM proball_teams");
  let round = sql("SELECT id FROM shared_rounds WHERE round_key='r16' ORDER BY rowid DESC LIMIT 1")[0];
  for (let i = 0; i < 4 && !(health.status === 200 && teamCount >= 16 && round); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    health = await req("/api/footfive/health");
    teamCount = num("SELECT COUNT(*) AS n FROM proball_teams");
    round = sql("SELECT id FROM shared_rounds WHERE round_key='r16' ORDER BY rowid DESC LIMIT 1")[0];
  }
  await check("production health bootstraps a world", "control", async () => {
    if (health.status !== 200 || teamCount < 16 || !round) return health.status + " teams " + teamCount + " r16 " + !!round;
  });
  if (!round) throw new Error("r16 round missing after health");

  const email = `cg25_${STAMP}@t.local`;
  const signup = await req("/api/collections/users/records", {
    method: "POST",
    body: { email, password: APP_PASS, passwordConfirm: APP_PASS, display_name: "cg25user" },
  });
  if (signup.status < 200 || signup.status >= 300) throw new Error("signup " + signup.status + " " + says(signup.data, "") );
  const login = await req("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password: APP_PASS },
  });
  if (!login.data.token) throw new Error("login " + login.status);
  token = login.data.token;
  const userId = login.data.record.id;

  await check("squad, match, and repair require auth", "control", async () => {
    const mine = await req("/api/footfive/my-team");
    const squad = await req("/api/footfive/my-team/squad");
    const match = await req("/api/footfive/match/zzzunknownfix01");
    const repair = await req("/api/footfive/players/zzzunknownply01/repair", { method: "POST", body: { points: 25 } });
    const arm = await req("/api/squad-reads/fail-next-ledger", { method: "POST", body: {} });
    const statuses = [mine.status, squad.status, match.status, repair.status, arm.status];
    if (statuses.some((status) => status !== 401)) return statuses.join("/");
  });

  const free = sql("SELECT id FROM proball_teams WHERE manager IS NULL OR manager='' ORDER BY id LIMIT 1")[0];
  if (!free) throw new Error("no free team");
  const teamId = free.id;
  const claim = await req(`/api/footfive/teams/${teamId}/claim`, { method: "POST", token, body: {} });
  await check("claim succeeds", "control", async () => {
    const manager = sql("SELECT ifnull(manager,'') AS manager FROM proball_teams WHERE id=?", [teamId])[0];
    if (claim.status !== 200 || !manager || manager.manager !== userId) return claim.status + " manager " + (manager && manager.manager);
  });

  const ids = sql("SELECT id FROM proball_players WHERE team=? ORDER BY sort_order, id", [teamId]).map((row) => row.id);
  if (!ids.length) throw new Error("claimed team has no players");
  const staleId = ids[0];
  const wideId = ids[1] || "";
  const plainId = ids[2] || "";
  const quietId = ids[3];
  if (!quietId) throw new Error("fixture needs four owned players");
  const foreign = sql("SELECT id FROM proball_players WHERE team!=? ORDER BY id LIMIT 1", [teamId])[0];
  if (!foreign) throw new Error("no foreign player");

  await stop();
  mustHave("world", ["id", "pace", "fixtures_window_minutes", "progression_paused"]);
  mustHave("shared_rounds", ["id", "round_key", "status", "scheduled_at"]);
  mustHave("shared_fixtures", ["id", "round", "home_team", "away_team", "status", "scheduled_at"]);
  mustHave("proball_players", ["id", "team", "energy", "energy_updated_at", "condition"]);
  mustHave("proball_teams", ["id", "manager", "treasury"]);
  mustHave("team_finance_ledger", ["team", "amount", "type", "player_id", "description"]);
  mustHave("match_states", ["id"]);
  mustHave("match_events", ["id"]);
  const world = sql("SELECT id, pace, fixtures_window_minutes FROM world WHERE key='main'")[0];
  if (!world || world.fixtures_window_minutes == null || world.fixtures_window_minutes === "") {
    throw new Error("fixtures_window_minutes missing");
  }
  regen = world.pace === "dev" ? 120 : 12;
  const windowMs = Number(world.fixtures_window_minutes) * 60000;
  const lead = Math.max(15000, Math.min(60000, windowMs - 5000));
  const kickoff = pbDate(Date.now() + lead);
  const stamp = pbDate(Date.now() - 3 * 3600000);
  writeAll([
    ["UPDATE world SET progression_paused=1 WHERE id=?", [world.id]],
    ["UPDATE shared_rounds SET scheduled_at=?, status='scheduled' WHERE id=?", [kickoff, round.id]],
    ["UPDATE shared_fixtures SET scheduled_at=?, status='scheduled' WHERE round=?", [kickoff, round.id]],
    ["UPDATE proball_teams SET treasury=2500 WHERE id=?", [teamId]],
    ["UPDATE proball_players SET energy=40, energy_updated_at=? WHERE id=?", [stamp, staleId]],
    ["UPDATE proball_players SET condition=90 WHERE id=?", [staleId]],
    ["UPDATE proball_players SET energy=63, energy_updated_at='' WHERE id=?", [quietId]],
    ...(wideId ? [["UPDATE proball_players SET condition=50 WHERE id=?", [wideId]]] : []),
    ...(plainId ? [["UPDATE proball_players SET condition=70 WHERE id=?", [plainId]]] : []),
  ]);
  const fixture = sql(
    "SELECT id FROM shared_fixtures WHERE round=? AND status='scheduled' AND (home_team=? OR away_team=?) LIMIT 1",
    [round.id, teamId, teamId],
  )[0];
  if (!fixture) throw new Error("claimed team has no scheduled r16 fixture");
  await start();

  const playersBefore = dump("proball_players");
  const staleRow = JSON.parse(playersBefore).find((row) => row.id === staleId);
  const quietRow = JSON.parse(playersBefore).find(
    (row) => row.team === teamId && row.id !== staleId && (row.energy_updated_at == null || row.energy_updated_at === ""),
  );

  async function readPair() {
    const clock = await req("/api/footfive/server-time", { token });
    const now = Number(clock.data && clock.data.serverTimeMs);
    const mine = await req("/api/footfive/my-team", { token });
    const squad = await req("/api/footfive/my-team/squad", { token });
    return { now, mine, squad, expected: materialised(staleRow.energy, parsePb(staleRow.energy_updated_at), now, regen) };
  }

  const first = await readPair();
  const second = await readPair();
  await check("squad reads return regenerated energy without storing it", "regression", async () => {
    const shown = [first.mine, first.squad].map((res) => playerOf(res.data, staleId));
    if (first.mine.status !== 200 || first.squad.status !== 200) return first.mine.status + "/" + first.squad.status;
    if (shown.some((player) => !player || player.energy !== first.expected)) {
      return "expected " + first.expected + " got " + shown.map((player) => player && player.energy).join("/");
    }
    if (dump("proball_players") !== playersBefore) return "player rows changed";
  });
  await check("repeat squad reads store nothing", "regression", async () => {
    const shown = [second.mine, second.squad].map((res) => playerOf(res.data, staleId));
    if (shown.some((player) => !player || player.energy !== second.expected)) return "repeat energy diverged from " + second.expected;
    if (dump("proball_players") !== playersBefore) return "repeat read stored a player row";
  });
  await check("aliases agree and modifiers match displayed energy", "control", async () => {
    const left = playerOf(first.mine.data, staleId);
    const right = playerOf(first.squad.data, staleId);
    if (!left || !right) return "player missing";
    const factor = 1 - 0.35 * (1 - left.energy / 100);
    const modifier = left.effective_modifiers && left.effective_modifiers.energy;
    const same =
      left.energy === right.energy &&
      left.effective_attack === right.effective_attack &&
      left.effective_defence === right.effective_defence &&
      JSON.stringify(left.effective_modifiers) === JSON.stringify(right.effective_modifiers) &&
      JSON.stringify(left.upgrade_cost) === JSON.stringify(right.upgrade_cost);
    const list = first.mine.data.players || [];
    const average = Math.round(list.reduce((sum, player) => sum + Number(player.energy), 0) / Math.max(list.length, 1));
    if (!same || Math.abs(Number(modifier) - factor) > 1e-6 || first.mine.data.averages.energy !== average) {
      return "modifier " + modifier + " factor " + factor + " average " + average;
    }
  });
  await check("null energy stamp displays the stored value", "control", async () => {
    if (!quietRow) return "no null-stamp teammate";
    const shown = playerOf(first.squad.data, quietRow.id);
    const stored = quietRow.energy == null || quietRow.energy === "" ? 100 : Number(quietRow.energy);
    if (!shown || shown.energy !== stored) return "displayed " + (shown && shown.energy) + " stored " + stored;
  });

  const beforeMatch = [dump("proball_players"), dump("shared_fixtures"), dump("shared_rounds"), dump("match_states"), dump("match_events")];
  const match = await req(`/api/footfive/match/${fixture.id}`, { token });
  const matchAgain = await req(`/api/footfive/match/${fixture.id}`, { token });
  const afterMatch = [dump("proball_players"), dump("shared_fixtures"), dump("shared_rounds"), dump("match_states"), dump("match_events")];
  await check("announced match preview leaves players, fixtures, state, and events unchanged", "regression", async () => {
    if (match.status !== 200 || matchAgain.status !== 200) return match.status + "/" + matchAgain.status;
    if (beforeMatch.join("\n") !== afterMatch.join("\n")) return "preview stored a row";
  });
  await check("announced match returns both display lineups", "control", async () => {
    const lineups = match.data && match.data.lineups;
    const key = match.data && match.data.round && match.data.round.key;
    if (!lineups || !lineupOk(lineups.home) || !lineupOk(lineups.away) || key !== "r16") {
      return match.status + " round " + key;
    }
  });

  async function postRepair(id, points) {
    return req(`/api/footfive/players/${id}/repair`, { method: "POST", token, body: { points } });
  }

  async function charged(id, points, applied, label) {
    const before = account(teamId, id);
    const res = await postRepair(id, points);
    const after = account(teamId, id);
    const latest = sql(
      "SELECT amount, type, player_id, description FROM team_finance_ledger WHERE team=? AND type='repair' ORDER BY rowid DESC LIMIT 1",
      [teamId],
    )[0];
    const cost = applied * 12;
    const receipt = res.status === 200 && res.data && res.data.ok === true && res.data.points === applied && res.data.cost === cost;
    const moved =
      Number(after.player.condition) === Number(before.player.condition) + applied &&
      after.treasury === before.treasury - cost &&
      after.ledgers === before.ledgers + 1 &&
      latest &&
      Number(latest.amount) === -cost &&
      String(latest.player_id) === id &&
      String(latest.description).includes("+" + applied);
    if (!receipt || !moved) {
      return (
        label +
        " status " +
        res.status +
        " points " +
        (res.data && res.data.points) +
        " cost " +
        (res.data && res.data.cost) +
        " treasury " +
        before.treasury +
        "->" +
        after.treasury
      );
    }
  }

  async function unchanged(id, run, message) {
    const before = account(teamId, id);
    const extra = id === foreign.id ? null : account(teamId, foreign.id);
    const res = await run();
    const after = account(teamId, id);
    const extraAfter = extra ? account(teamId, foreign.id) : null;
    if (res.status !== 400 || !says(res.data, message)) return res.status + " " + ((res.data && res.data.message) || "");
    if (JSON.stringify(before) !== JSON.stringify(after)) return "own account changed";
    if (extra && JSON.stringify(extra) !== JSON.stringify(extraAfter)) return "foreign account changed";
  }

  await check("repair 90 plus 25 reports the applied 10 and 120", "regression", async () => charged(staleId, 25, 10, "partial"));
  await check("full repair is rejected with no change", "control", async () =>
    unchanged(staleId, () => postRepair(staleId, 25), "Condition already full"),
  );
  await check("invalid repair is rejected with no change", "control", async () =>
    unchanged(staleId, () => postRepair(staleId, -3), "Invalid repair points"),
  );
  await check("foreign repair is rejected with no change", "control", async () =>
    unchanged(foreign.id, () => postRepair(foreign.id, 25), "Not your player"),
  );

  let wideTarget = wideId;
  if (!wideTarget) {
    await stopped([["UPDATE proball_players SET condition=50 WHERE id=?", [staleId]]]);
    wideTarget = staleId;
  }
  await check("repair 150 on condition 50 reports the remaining 50 and 600", "regression", async () =>
    charged(wideTarget, 150, 50, "capped"),
  );

  let plainTarget = plainId;
  if (!plainTarget) {
    plainTarget = staleId === wideTarget && ids.length > 1 ? ids.find((id) => id !== wideTarget) || staleId : staleId;
    await stopped([["UPDATE proball_players SET condition=70 WHERE id=?", [plainTarget]]]);
  }
  await check("ordinary noncapped repair receipt matches the charge", "control", async () => charged(plainTarget, 25, 25, "plain"));

  await stopped([
    ["UPDATE proball_teams SET treasury=30 WHERE id=?", [teamId]],
    ["UPDATE proball_players SET condition=80 WHERE id=?", [staleId]],
  ]);
  await check("insufficient treasury is rejected with no change", "control", async () =>
    unchanged(staleId, () => postRepair(staleId, 25), "Insufficient team treasury"),
  );

  await stopped([
    ["UPDATE proball_teams SET treasury=2500 WHERE id=?", [teamId]],
    ["UPDATE proball_players SET condition=90 WHERE id=?", [staleId]],
  ]);
  await check("ledger fault rolls back player, treasury, and ledger", "control", async () => {
    const before = account(teamId, staleId);
    const arm = await req("/api/squad-reads/fail-next-ledger", { method: "POST", token, body: {} });
    const res = await postRepair(staleId, 25);
    const after = account(teamId, staleId);
    if (arm.status !== 200) return "arm " + arm.status;
    if (res.status !== 400 || !says(res.data, "Could not repair player")) return res.status + " " + ((res.data && res.data.message) || "");
    if (String(res.text).includes("ff25-ledger-fault")) return "response contained the injected fault text";
    if (JSON.stringify(before) !== JSON.stringify(after)) return "fault committed a repair";
  });

  return { work, hookFile };
}

async function main() {
  let work = "";
  let hookFile = "";
  try {
    const out = await run();
    work = out.work;
    hookFile = out.hookFile;
  } catch (err) {
    expectCase("run", "control", false, err && err.message ? err.message : String(err));
  } finally {
    try {
      await stop();
    } catch (err) {
      console.log("stop " + safe(err.message || err));
    }
    work = work || runWork;
    const failed = cases.filter((item) => !item.ok);
    const evidence = {
      phase: PHASE,
      port,
      hooks: HOOKS_SRC,
      hookFile,
      workdir: work,
      passed: cases.length - failed.length,
      failed: failed.length,
      regressionsFailed: failed.filter((item) => item.kind === "regression").map((item) => item.name),
      controlsFailed: failed.filter((item) => item.kind === "control").map((item) => item.name),
      cases,
    };
    const body = JSON.stringify(evidence, null, 2);
    const stable = `/tmp/ff25-squad-reads-${PHASE}.json`;
    try {
      writeFileSync(stable, body);
      if (work) writeFileSync(path.join(work, "results.json"), body);
    } catch (err) {
      console.log("evidence " + safe(err.message || err));
    }
    console.log(
      `squad-reads ${PHASE}: ${evidence.passed} passed, ${failed.length} failed, port ${port}, ${work ? path.join(work, "results.json") : stable}`,
    );
    process.exit(failed.length ? 1 : 0);
  }
}

main();
