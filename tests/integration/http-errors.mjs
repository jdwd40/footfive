/**
 * Issue #30 safe HTTP errors.
 * Disposable PocketBase. Loopback only. Stops only the process this file spawned.
 * Port: HTTP_ERRORS_PB_PORT, default 8307, integer 1..65535. Lead's local run sets 8322.
 * Hooks: HTTP_ERRORS_HOOKS, or the worktree pocketbase/pb_hooks.
 * Migrations always come from the worktree pocketbase/pb_migrations.
 * Same assertions for baseline and current. Nonzero exit when any case fails.
 *
 * Inherited PocketBase limit: a body such as {"count":1} trailing is parsed as
 * the first JSON object. This file does not require that trailing garbage be
 * rejected. Login and the two native user hooks are outside this matrix.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_SRC = process.env.HTTP_ERRORS_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const MIGRATIONS = path.join(ROOT, "pocketbase/pb_migrations");
const PB_BIN = path.join(ROOT, "pocketbase/pocketbase");
const PHASE = process.env.HTTP_ERRORS_HOOKS ? "baseline" : "current";
const EVIDENCE = `/tmp/ff30-http-errors-${PHASE}.json`;
const MARKER = "ff30-secret-marker";
const SHAPES = [
  ["broken", "{"],
  ["array", "[]"],
  ["primitive", "1"],
  ["null", "null"],
];
const KINDS = ["go_no_rows", "go", "js", "other"];
const DIAGNOSTIC_KEYS = ["ts", "level", "event", "app", "route", "kind"];

const ISOLATION_HOOK = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
routerAdd("GET", "/api/http-errors/cron-jobs", function (e) {
  return e.json(200, $app.cron().jobs().map(function (j) { return j.id(); }));
});
`;

const cases = [];
let child = null;
let dataDir = "";
let stderr = "";
let port = 0;

function parsePort(value) {
  if (!/^[0-9]+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function safe(detail) {
  return String(detail).split(MARKER).join("[marker]").slice(0, 500);
}

function expectCase(name, cond, detail = "") {
  cases.push({ name, ok: !!cond, detail: cond ? "" : safe(detail) });
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : " " + safe(detail).slice(0, 280)));
}

function msg(data) {
  return String((data && data.message) || "").replace(/\.+$/, "");
}

function says(data, text) {
  const got = msg(data);
  return got === text || got.endsWith(": " + text);
}

function leaked(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes(MARKER) || text.includes("team_finance_ledger") || text.includes("/tmp/ff30");
}

function req(urlPath, { method = "GET", token, body, raw } = {}) {
  const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
  const url = new URL(`http://127.0.0.1:${port}${urlPath}`);
  return new Promise((resolve, reject) => {
    const r = http.request(
      url,
      {
        method,
        agent: false,
        headers: {
          ...(token ? { Authorization: token } : {}),
          ...(payload !== null
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            data,
            text,
          });
        });
      },
    );
    r.setTimeout(60000, () => r.destroy(new Error("timeout " + method + " " + urlPath)));
    r.on("error", reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

function withDb(fn) {
  const db = new DatabaseSync(path.join(dataDir, "data.db"), { timeout: 10000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function userByEmail(email) {
  return withDb((db) =>
    db.prepare("select id, email, role, credits, disabled from users where lower(email)=lower(?)").get(email),
  );
}

function userById(id) {
  return withDb((db) => db.prepare("select id, disabled, credits from users where id=?").get(id));
}

function teamById(id) {
  return withDb((db) =>
    db.prepare(
      "select id, ifnull(manager,'') manager, ifnull(treasury,0) treasury, ifnull(battery_count,0) batteries from proball_teams where id=?",
    ).get(id),
  );
}

function playerById(id) {
  return withDb((db) =>
    db.prepare("select id, ifnull(condition,100) condition, ifnull(energy,100) energy from proball_players where id=?").get(id),
  );
}

function userCount() {
  return withDb((db) => db.prepare("select count(*) c from users").get().c);
}

function auditCount(action) {
  return withDb((db) => db.prepare("select count(*) c from admin_audit_logs where action=?").get(action).c);
}

function ledgerCount(teamId) {
  return withDb((db) =>
    db.prepare("select count(*) c from team_finance_ledger where team=?").get(teamId).c,
  );
}

function roundStamp() {
  return withDb((db) => {
    const rounds = db.prepare(
      "select id || '=' || ifnull(scheduled_at,'') stamp from shared_rounds order by id",
    ).all();
    const fixtures = db.prepare(
      "select id || '=' || ifnull(scheduled_at,'') stamp from shared_fixtures order by id",
    ).all();
    return rounds.map((row) => row.stamp).join("|") + "#" + fixtures.map((row) => row.stamp).join("|");
  });
}

function probePort(n) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: n, host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
}

async function start(hooksDir) {
  stderr = "";
  child = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${port}`,
      `--dir=${dataDir}`,
      `--hooksDir=${hooksDir}`,
      `--migrationsDir=${MIGRATIONS}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (buf) => {
    stderr += buf.toString();
    if (stderr.length > 200000) stderr = stderr.slice(-200000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("owned PB exited before readiness");
    try {
      const health = await req("/api/health");
      if (health.ok) return;
    } catch {
      /* not ready */
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

async function signup(email, password = "testpass99") {
  const res = await req("/api/collections/users/records", {
    method: "POST",
    body: {
      email,
      password,
      passwordConfirm: password,
      display_name: email.split("@")[0].slice(0, 40),
    },
  });
  if (!res.ok) throw new Error("signup failed " + res.status + " " + msg(res.data));
  return userByEmail(email);
}

async function login(email, password = "testpass99") {
  const res = await req("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password },
  });
  if (!res.ok) throw new Error("login failed " + res.status + " " + msg(res.data));
  return { token: res.data.token, id: res.data.record.id };
}

function promote(email) {
  withDb((db) => db.prepare("update users set role='admin' where lower(email)=lower(?)").run(email));
}

async function run() {
  port = parsePort(process.env.HTTP_ERRORS_PB_PORT || "8307");
  const work = mkdtempSync(path.join(tmpdir(), "ff30-http-errors-"));
  dataDir = path.join(work, "pb_data");
  const hooksDir = path.join(work, "hooks");
  mkdirSync(dataDir, { recursive: true });
  const evidence = {
    phase: PHASE,
    port,
    hooks: HOOKS_SRC,
    migrations: MIGRATIONS,
    work,
    started: new Date().toISOString(),
    cases,
  };
  try {
    if (!port) throw new Error("HTTP_ERRORS_PB_PORT must be an integer from 1 to 65535");
    try {
      await probePort(port);
    } catch (err) {
      throw new Error("loopback port " + port + " is not free (" + (err.code || err.message) + "); not stopping it");
    }
    cpSync(HOOKS_SRC, hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, "zz_http_errors_isolation.pb.js"), ISOLATION_HOOK);
    await start(hooksDir);

    const cron = await req("/api/http-errors/cron-jobs");
    const jobs = Array.isArray(cron.data) ? cron.data : [];
    expectCase(
      "control: scheduler keeps the system job and drops app crons",
      cron.ok && jobs.includes("__pbDBOptimize__") && jobs.every((id) => !String(id).startsWith("footfive_")),
      cron.status + " " + jobs.join(","),
    );

    const stamp = Date.now();
    const adminEmail = `ha30_${stamp}@t.local`;
    const userEmail = `hu30_${stamp}@t.local`;
    await signup(adminEmail, "adminpass99");
    promote(adminEmail);
    const admin = await login(adminEmail, "adminpass99");
    const user = await login((await signup(userEmail)).email);
    const health = await req("/api/footfive/health");
    const teamTotal = withDb((db) => db.prepare("select count(*) c from proball_teams").get().c);
    expectCase(
      "control: production health bootstraps a world",
      health.ok && teamTotal >= 16,
      health.status + " teams " + teamTotal,
    );

    const free = withDb((db) =>
      db.prepare("select id from proball_teams where manager is null or manager='' order by id").all(),
    ).map((row) => row.id);
    if (free.length < 4) throw new Error("need 4 free teams");
    const claim = await req(`/api/footfive/teams/${free[0]}/claim`, { method: "POST", token: user.token });
    if (!claim.ok) throw new Error("claim failed " + claim.status + " " + msg(claim.data));
    const teamId = free[0];
    const player = withDb((db) =>
      db.prepare("select id from proball_players where team=? order by id limit 1").get(teamId),
    );
    if (!player) throw new Error("claimed team has no player");
    const playerId = player.id;
    withDb((db) => db.prepare("update proball_players set condition=40 where id=?").run(playerId));

    const disableUser = await signup(`hd30_${stamp}@t.local`);
    const deleteUser = await signup(`hx30_${stamp}@t.local`);
    const enableUser = await signup(`he30_${stamp}@t.local`);
    withDb((db) => db.prepare("update users set disabled=1 where id=?").run(enableUser.id));
    const releaseUser = await signup(`hr30_${stamp}@t.local`);
    const releaseTeam = free[2];
    const hold = await req(`/api/footfive/admin/teams/${releaseTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: releaseUser.id, reason: "hold" },
    });
    if (!hold.ok) throw new Error("assign hold failed " + hold.status + " " + msg(hold.data));

    const denied = await req("/api/footfive/admin/overview", { token: user.token });
    expectCase(
      "control: ordinary user is denied admin overview",
      denied.status === 403 && says(denied.data, "Admin only"),
      denied.status + " " + msg(denied.data),
    );
    const disabledWho = await login((await signup(`hz30_${stamp}@t.local`)).email);
    withDb((db) => db.prepare("update users set disabled=1 where id=?").run(disabledWho.id));
    const disabledMe = await req("/api/footfive/me", { token: disabledWho.token });
    expectCase(
      "control: disabled account is denied",
      disabledMe.status === 403 && says(disabledMe.data, "Account disabled"),
      disabledMe.status + " " + msg(disabledMe.data),
    );
    const forced = await login((await signup(`hf30_${stamp}@t.local`)).email);
    withDb((db) => db.prepare("update users set must_change_password=1 where id=?").run(forced.id));
    const forcedMe = await req("/api/footfive/me", { token: forced.token });
    const forcedMode = await req("/api/footfive/my-team/mode", {
      method: "POST",
      token: forced.token,
      body: { mode: "manual" },
    });
    expectCase(
      "control: forced password still sees /me and is denied elsewhere",
      forcedMe.ok && forcedMe.status !== 401 && forcedMode.status === 403 && says(forcedMode.data, "Password change required"),
      forcedMe.status + " / " + forcedMode.status + " " + msg(forcedMode.data),
    );

    const other = await login((await signup(`ho30_${stamp}@t.local`)).email);
    const otherClaim = await req(`/api/footfive/teams/${free[1]}/claim`, { method: "POST", token: other.token });
    if (!otherClaim.ok) throw new Error("second claim failed " + otherClaim.status + " " + msg(otherClaim.data));
    const foreign = withDb((db) =>
      db.prepare("select id from proball_players where team=? order by id limit 1").get(free[1]),
    );
    const notYours = await req(`/api/footfive/players/${foreign.id}/battery`, { method: "POST", token: user.token });
    expectCase(
      "control: another team's player keeps Not your player at 400",
      notYours.status === 400 && says(notYours.data, "Not your player") && !leaked(notYours.text),
      notYours.status + " " + msg(notYours.data),
    );

    const deleteFixture = withDb((db) => db.prepare("select * from users where id=?").get(deleteUser.id));
    const tokens = { user: user.token, admin: admin.token };
    const routes = [
      { name: "coaching", method: "POST", path: "/api/footfive/matches/zzzunknownuser1/coaching", who: "user" },
      { name: "bets", method: "POST", path: "/api/footfive/bets", who: "user" },
      { name: "mode", method: "POST", path: "/api/footfive/my-team/mode", who: "user" },
      { name: "stance", method: "POST", path: "/api/footfive/my-team/stance", who: "user" },
      { name: "lineup", method: "POST", path: "/api/footfive/my-team/lineup", who: "user" },
      { name: "intensity", method: "POST", path: "/api/footfive/my-team/intensity", who: "user" },
      { name: "upgrade", method: "POST", path: `/api/footfive/players/${playerId}/upgrade`, who: "user" },
      {
        name: "batteries/buy",
        method: "POST",
        path: "/api/footfive/team-shop/batteries/buy",
        who: "user",
        danger: true,
        snap: () => {
          const team = teamById(teamId);
          return team.treasury + ":" + team.batteries + ":" + ledgerCount(teamId);
        },
      },
      {
        name: "repair",
        method: "POST",
        path: `/api/footfive/players/${playerId}/repair`,
        who: "user",
        danger: true,
        snap: () => {
          const row = playerById(playerId);
          return row.condition + ":" + teamById(teamId).treasury;
        },
      },
      { name: "spend", method: "POST", path: "/api/footfive/command-charge/spend", who: "user" },
      {
        name: "admin create",
        method: "POST",
        path: "/api/footfive/admin/users",
        who: "admin",
        danger: true,
        snap: () => String(userCount()),
      },
      {
        name: "admin delete",
        method: "DELETE",
        path: `/api/footfive/admin/users/${deleteUser.id}`,
        who: "admin",
        danger: true,
        snap: () => (userById(deleteUser.id) ? "present" : "gone"),
      },
      { name: "admin credits", method: "POST", path: `/api/footfive/admin/users/${user.id}/credits`, who: "admin" },
      { name: "admin treasury", method: "POST", path: `/api/footfive/admin/teams/${teamId}/treasury`, who: "admin" },
      {
        name: "admin assign",
        method: "POST",
        path: `/api/footfive/admin/teams/${teamId}/assign`,
        who: "admin",
        danger: true,
        snap: () => teamById(teamId).manager,
      },
      {
        name: "admin reset",
        method: "POST",
        path: `/api/footfive/admin/teams/${teamId}/reset`,
        who: "admin",
        danger: true,
        snap: () => String(playerById(playerId).energy),
      },
      {
        name: "admin settings",
        method: "PATCH",
        path: "/api/footfive/admin/world/settings",
        who: "admin",
        danger: true,
        snap: () => String(auditCount("world_settings")),
      },
      {
        name: "admin apply",
        method: "POST",
        path: "/api/footfive/admin/world/apply-between-round",
        who: "admin",
        danger: true,
        snap: roundStamp,
      },
      { name: "admin password", method: "POST", path: `/api/footfive/admin/users/${user.id}/password`, who: "admin" },
      { name: "change-password", method: "POST", path: "/api/footfive/account/change-password", who: "user" },
      {
        name: "admin disable",
        method: "POST",
        path: `/api/footfive/admin/users/${disableUser.id}/disable`,
        who: "admin",
        danger: true,
        snap: () => String(userById(disableUser.id).disabled),
      },
      {
        name: "admin enable",
        method: "POST",
        path: `/api/footfive/admin/users/${enableUser.id}/enable`,
        who: "admin",
        danger: true,
        snap: () => String(userById(enableUser.id).disabled),
      },
      {
        name: "admin release",
        method: "POST",
        path: `/api/footfive/admin/teams/${releaseTeam}/release`,
        who: "admin",
        danger: true,
        snap: () => teamById(releaseTeam).manager,
      },
    ];
    let shapeCursor = 0;
    for (const route of routes) {
      if (route.name === "admin reset") {
        withDb((db) => db.prepare("update proball_players set energy=40 where id=?").run(playerId));
      }
      const shapes = route.danger ? SHAPES : [SHAPES[shapeCursor++ % SHAPES.length]];
      const notes = [];
      let ok = true;
      for (const [label, raw] of shapes) {
        const before = route.snap ? route.snap() : "";
        const res = await req(route.path, { method: route.method, token: tokens[route.who], raw });
        const after = route.snap ? route.snap() : "";
        const pass =
          res.status === 400 &&
          says(res.data, "Invalid request body") &&
          before === after &&
          !leaked(res.text);
        ok = ok && pass;
        if (!pass) notes.push(label + " " + res.status + " " + msg(res.data) + (before === after ? "" : " snapshot-changed"));
      }
      expectCase("malformed: " + route.name, ok, notes.join("; "));
    }

    // Malformed requests deliberately expose old default mutations on baseline.
    // Restore this isolated user before independent valid-delete compatibility.
    // The malformed cases already recorded every before/after difference above.
    withDb((db) => {
      const columns = Object.keys(deleteFixture);
      db.prepare(`INSERT OR IGNORE INTO users (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...columns.map((key) => deleteFixture[key]));
    });
    const createdBefore = userCount();
    const blankCreate = await req("/api/footfive/admin/users", { method: "POST", token: admin.token, body: {} });
    expectCase(
      "control: empty create object keeps Valid email required and writes nothing",
      blankCreate.status === 400 && says(blankCreate.data, "Valid email required") && userCount() === createdBefore,
      blankCreate.status + " " + msg(blankCreate.data),
    );
    const blankAssign = await req(`/api/footfive/admin/teams/${teamId}/assign`, {
      method: "POST",
      token: admin.token,
      body: {},
    });
    expectCase(
      "control: empty assign object keeps User ID required and the manager",
      blankAssign.status === 400 && says(blankAssign.data, "User ID required") && teamById(teamId).manager === user.id,
      blankAssign.status + " " + msg(blankAssign.data),
    );
    const creditsBefore = userById(user.id).credits;
    const blankCredits = await req(`/api/footfive/admin/users/${user.id}/credits`, {
      method: "POST",
      token: admin.token,
      body: {},
    });
    expectCase(
      "control: empty credits object keeps Invalid amount",
      blankCredits.status === 400 && says(blankCredits.data, "Invalid amount") && userById(user.id).credits === creditsBefore,
      blankCredits.status + " " + msg(blankCredits.data),
    );
    const blankPassword = await req("/api/footfive/account/change-password", {
      method: "POST",
      token: user.token,
      body: {},
    });
    const stillLogged = await req("/api/collections/users/auth-with-password", {
      method: "POST",
      body: { identity: userEmail, password: "testpass99" },
    });
    expectCase(
      "control: empty change-password object keeps the length rule and the password",
      blankPassword.status === 400 &&
        says(blankPassword.data, "New password must be at least 8 characters") &&
        stillLogged.ok,
      blankPassword.status + " " + msg(blankPassword.data),
    );

    const buyBefore = teamById(teamId);
    const buyLedger = ledgerCount(teamId);
    const bought = await req("/api/footfive/team-shop/batteries/buy", {
      method: "POST",
      token: user.token,
      body: {},
    });
    const buyAfter = teamById(teamId);
    expectCase(
      "valid: empty battery buy uses the one-battery default",
      bought.ok &&
        buyAfter.batteries === buyBefore.batteries + 1 &&
        buyAfter.treasury === buyBefore.treasury - 180 &&
        ledgerCount(teamId) === buyLedger + 1,
      bought.status + " " + msg(bought.data),
    );
    const trailBefore = teamById(teamId);
    const trailed = await req("/api/footfive/team-shop/batteries/buy", {
      method: "POST",
      token: user.token,
      raw: '{"count":1} trailing',
    });
    const trailAfter = teamById(teamId);
    expectCase(
      "control: trailing JSON garbage still acts as the first object",
      trailed.ok && trailAfter.batteries === trailBefore.batteries + 1 && trailAfter.treasury === trailBefore.treasury - 180,
      trailed.status + " " + msg(trailed.data),
    );

    // Same independent repair fixture for baseline and current after rejection checks.
    withDb((db) => db.prepare("update proball_players set condition=40 where id=?").run(playerId));
    const repairBefore = playerById(playerId);
    const repaired = await req(`/api/footfive/players/${playerId}/repair`, {
      method: "POST",
      token: user.token,
      body: { points: 25 },
    });
    const repairAfter = playerById(playerId);
    expectCase(
      "valid: repair points change condition",
      repaired.ok && repairAfter.condition === repairBefore.condition + 25,
      repaired.status + " " + msg(repaired.data) + " condition " + repairBefore.condition + "->" + repairAfter.condition,
    );

    const disabled = await req(`/api/footfive/admin/users/${disableUser.id}/disable`, {
      method: "POST",
      token: admin.token,
      body: {},
    });
    expectCase(
      "valid: empty disable body disables",
      disabled.ok && userById(disableUser.id).disabled === 1,
      disabled.status + " " + msg(disabled.data),
    );
    const enabled = await req(`/api/footfive/admin/users/${enableUser.id}/enable`, {
      method: "POST",
      token: admin.token,
    });
    expectCase(
      "valid: no-body enable enables",
      enabled.ok && userById(enableUser.id).disabled === 0,
      enabled.status + " " + msg(enabled.data),
    );
    const removed = await req(`/api/footfive/admin/users/${deleteUser.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    expectCase(
      "valid: no-body delete deletes a user with no history",
      removed.ok && !userById(deleteUser.id),
      removed.status + " " + msg(removed.data),
    );
    const released = await req(`/api/footfive/admin/teams/${releaseTeam}/release`, {
      method: "POST",
      token: admin.token,
    });
    expectCase(
      "valid: no-body release clears the manager",
      released.ok && teamById(releaseTeam).manager === "",
      released.status + " " + msg(released.data),
    );
    withDb((db) => db.prepare("update proball_players set energy=40 where id=?").run(playerId));
    const reset = await req(`/api/footfive/admin/teams/${teamId}/reset`, {
      method: "POST",
      token: admin.token,
      body: {},
    });
    expectCase(
      "valid: empty reset body restores energy",
      reset.ok && playerById(playerId).energy === 100,
      reset.status + " " + msg(reset.data) + " energy " + playerById(playerId).energy,
    );
    const settingsBefore = auditCount("world_settings");
    const settings = await req("/api/footfive/admin/world/settings", {
      method: "PATCH",
      token: admin.token,
      body: {},
    });
    expectCase(
      "valid: empty settings object is the supported no-op save",
      settings.ok && auditCount("world_settings") === settingsBefore + 1,
      settings.status + " " + msg(settings.data),
    );
    const applyBefore = roundStamp();
    const apply = await req("/api/footfive/admin/world/apply-between-round", {
      method: "POST",
      token: admin.token,
    });
    const applyOk =
      apply.ok ||
      (apply.status === 400 && says(apply.data, "No round is waiting to kick off") && roundStamp() === applyBefore);
    expectCase(
      "valid: no-body apply uses the service result",
      applyOk && !leaked(apply.text),
      apply.status + " " + msg(apply.data),
    );

    const unknownUser = "zzzunknownuser1";
    const unknownTeam = "zzzunknownteam1";
    const unknownDelete = await req(`/api/footfive/admin/users/${unknownUser}`, {
      method: "DELETE",
      token: admin.token,
      body: {},
    });
    const unknownCredits = await req(`/api/footfive/admin/users/${unknownUser}/credits`, {
      method: "POST",
      token: admin.token,
      body: { mode: "add", amount: 1, reason: "missing" },
    });
    const unknownTreasury = await req(`/api/footfive/admin/teams/${unknownTeam}/treasury`, {
      method: "POST",
      token: admin.token,
      body: { mode: "add", amount: 1, reason: "missing" },
    });
    const unknownAssign = await req(`/api/footfive/admin/teams/${unknownTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: user.id, reason: "missing" },
    });
    const unknownReset = await req(`/api/footfive/admin/teams/${unknownTeam}/reset`, {
      method: "POST",
      token: admin.token,
      body: { mode: "energy", reason: "missing" },
    });
    const unknownPassword = await req(`/api/footfive/admin/users/${unknownUser}/password`, {
      method: "POST",
      token: admin.token,
      body: { password: "pw-ff30-reset-99", reason: "missing" },
    });
    expectCase(
      "unknown: delete, credits, treasury, assign, reset, and password use their fallbacks",
      unknownDelete.status === 400 &&
        says(unknownDelete.data, "Could not delete user") &&
        unknownCredits.status === 400 &&
        says(unknownCredits.data, "Could not adjust credits") &&
        unknownTreasury.status === 400 &&
        says(unknownTreasury.data, "Could not adjust treasury") &&
        unknownAssign.status === 400 &&
        says(unknownAssign.data, "Could not assign team") &&
        unknownReset.status === 400 &&
        says(unknownReset.data, "Could not reset team") &&
        unknownPassword.status === 400 &&
        says(unknownPassword.data, "Could not reset password") &&
        ![unknownDelete, unknownCredits, unknownTreasury, unknownAssign, unknownReset, unknownPassword].some(
          (res) => leaked(res.text) || res.text.includes("no rows") || res.text.includes("pw-ff30-reset-99"),
        ),
      [unknownDelete, unknownCredits, unknownTreasury, unknownAssign, unknownReset, unknownPassword]
        .map((res) => res.status + " " + msg(res.data))
        .join("; "),
    );
    const unknownTeamDetail = await req(`/api/footfive/records/teams/${unknownTeam}`, { token: user.token });
    expectCase(
      "unknown: team detail maps a missing target to Team not found",
      unknownTeamDetail.status === 404 &&
        says(unknownTeamDetail.data, "Team not found") &&
        !unknownTeamDetail.text.includes("no rows") &&
        !leaked(unknownTeamDetail.text),
      unknownTeamDetail.status + " " + msg(unknownTeamDetail.data),
    );
    const unknownTourney = await req("/api/footfive/records/tournaments/zzzunknowntour1", { token: user.token });
    const tourneyOk =
      !unknownTourney.text.includes("no rows") &&
      !leaked(unknownTourney.text) &&
      (unknownTourney.status === 200 ||
        (unknownTourney.status === 404 && says(unknownTourney.data, "Tournament details unavailable")));
    expectCase(
      "unknown: tournament detail does not claim a target miss or leak internals",
      tourneyOk,
      unknownTourney.status + " " + msg(unknownTourney.data),
    );

    const faultBefore = teamById(teamId);
    const faultLedger = ledgerCount(teamId);
    const logAt = stderr.length;
    withDb((db) => {
      db.exec(`
        CREATE TRIGGER ff30_buy_fault
        BEFORE INSERT ON team_finance_ledger
        BEGIN
          SELECT RAISE(ABORT, '${MARKER} team_finance_ledger /tmp/ff30-not-a-path');
        END;
      `);
    });
    let fault;
    try {
      fault = await req("/api/footfive/team-shop/batteries/buy", {
        method: "POST",
        token: user.token,
        body: { count: 1 },
      });
    } finally {
      withDb((db) => db.exec("DROP TRIGGER IF EXISTS ff30_buy_fault"));
    }
    const faultAfter = teamById(teamId);
    const added = stderr.slice(logAt);
    const diagnostic = added
      .split("\n")
      .filter((line) => line.includes("[footfive-json]") && line.includes("route_error"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(line.indexOf("{")));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const diagnosticOk =
      diagnostic.length >= 1 &&
      diagnostic.every((entry) => {
        const keys = Object.keys(entry);
        return (
          entry.event === "route_error" &&
          entry.route === "POST /api/footfive/team-shop/batteries/buy" &&
          KINDS.includes(entry.kind) &&
          keys.every((key) => DIAGNOSTIC_KEYS.includes(key)) &&
          !JSON.stringify(entry).includes(MARKER) &&
          !JSON.stringify(entry).includes(userEmail) &&
          !JSON.stringify(entry).includes("team_finance_ledger") &&
          !JSON.stringify(entry).includes("/tmp/ff30")
        );
      });
    expectCase(
      "fault: late ledger failure rolls back, uses the battery fallback, and scrubbed diagnostics",
      fault.status === 400 &&
        fault.status !== 401 &&
        fault.status !== 403 &&
        says(fault.data, "Could not buy battery") &&
        !leaked(fault.text) &&
        !added.includes(MARKER) &&
        faultAfter.treasury === faultBefore.treasury &&
        faultAfter.batteries === faultBefore.batteries &&
        ledgerCount(teamId) === faultLedger &&
        diagnosticOk,
      fault.status + " " + msg(fault.data) + (diagnosticOk ? "" : " diagnostic-mismatch"),
    );
    const session = await req("/api/footfive/me", { token: user.token });
    expectCase(
      "fault: the same session /me stays 200",
      session.ok && session.status !== 401 && session.status !== 403 && session.data.id === user.id,
      session.status + " " + msg(session.data),
    );

    const missing = await login((await signup(`hm30_${stamp}@t.local`)).email);
    withDb((db) => db.prepare("delete from users where id=?").run(missing.id));
    const missingMe = await req("/api/footfive/me", { token: missing.token });
    expectCase(
      "control: a deleted account token still fails native authentication",
      missingMe.status === 401 &&
        !missingMe.text.includes("no rows") &&
        !leaked(missingMe.text),
      missingMe.status + " " + msg(missingMe.data),
    );
  } catch (err) {
    expectCase("suite: aborted", false, (err && err.message) || String(err));
  } finally {
    try {
      if (dataDir) withDb((db) => db.exec("DROP TRIGGER IF EXISTS ff30_buy_fault"));
    } catch {
      /* database may not exist yet */
    }
    await stop();
    evidence.finished = new Date().toISOString();
    evidence.passed = cases.filter((item) => item.ok).length;
    evidence.failed = cases.filter((item) => !item.ok).length;
    writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  }
  const passed = cases.filter((item) => item.ok).length;
  const failed = cases.length - passed;
  console.log(`http-errors ${PHASE}: ${passed} passed, ${failed} failed, port ${port}, evidence ${EVIDENCE}`);
  process.exit(failed ? 1 : 0);
}

run();
