/**
 * Issue #21 collection guards.
 * Disposable PocketBase on loopback. Stops only the process this file spawned.
 * Port: COLLECTION_GUARDS_PB_PORT, default 8308, integer 1..65535. Lead local sets 8322.
 * Hooks: COLLECTION_GUARDS_HOOKS, or the worktree pocketbase/pb_hooks.
 * CLI: COLLECTION_GUARDS_CLI, or the worktree scripts/footfive-admin.mjs.
 * Migrations always come from the worktree pocketbase/pb_migrations.
 * Binary is the worktree pocketbase/pocketbase.
 * Same assertions for baseline and current. PHASE is only an evidence label.
 *
 * Written against the probed freeze:
 * main.pb.js 119b429d96a5e0bb1afcff73e0c5e3c0f2a4087d
 * scripts/footfive-admin.mjs 8a709dc6b14242dd6559795c596df66873c3bfb3
 *
 * Probed wire classes this file requires:
 * - ordinary and app-admin create/update/delete on the 23 base collections: 403
 *   "Only superusers can perform this action."
 * - users self-delete: 403 "Use protected FootFive routes." and the account stays
 * - delete of another user: 404 from the rule
 * - superuser create on the deny-13, and superuser player update: 403 hook message
 * - superuser team manager PATCH: 200, then the original manager is put back
 * - superuser users delete: 204
 * - profile PATCH 200, protected field 403, superuser users PATCH 200
 * - app_settings invalid create: 400, and the row count stays (guard passed, not saved)
 * - world PATCH runs only after production health has created a world row
 *
 * CLI cleanup-smoke --confirm, one candidate at a time:
 * plain user deleted; managed user released then deleted; open bet released then
 * disabled; claimer (audit history) released then disabled; coaching history
 * released then disabled; application admin skipped. Lookup failures are injected
 * with a copied hook and abort before release, disable, or delete.
 * Audit POSTs still warn "audit write skipped" because admin is required.
 * Collection matrix calls are paced at about 20/s. Limiters and poll config stay as they are.
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
const HOOKS_SRC = process.env.COLLECTION_GUARDS_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const CLI_SRC = process.env.COLLECTION_GUARDS_CLI || path.join(ROOT, "scripts/footfive-admin.mjs");
const MIGRATIONS = path.join(ROOT, "pocketbase/pb_migrations");
const PB_BIN = path.join(ROOT, "pocketbase/pocketbase");
const PHASE = process.env.COLLECTION_GUARDS_HOOKS || process.env.COLLECTION_GUARDS_CLI ? "baseline" : "current";
const EVIDENCE = `/tmp/ff21-collection-guards-${PHASE}.json`;
const APP_PASS = "testpass99";
const SU_PASS = "cg21SyntheticPass99";
const STAMP = Date.now();
const SU_EMAIL = `su21_${STAMP}@t.local`;
const RULE = "Only superusers can perform this action";
const HOOK = "Use protected FootFive routes";
const UNKNOWN = "zzzunknownrec01";
const CANDIDATE = /^(deploy_smoke_|p5a_|admin_p5_|e2e_|api_a_|api_b_|api_admin_|api_pw_|perf_|p6admin_|p7_)/i;
const OPEN_NOTE = "disabled: deploy smoke with open bets";
const HISTORY_NOTE = "disabled: deploy smoke with audit/coaching history";

const DENY_13 = [
  "proball_teams",
  "match_states",
  "shared_fixtures",
  "shared_bets",
  "global_team_records",
  "global_player_records",
  "match_summaries",
  "tournament_summaries",
  "credit_ledger",
  "team_finance_ledger",
  "proball_players",
  "shared_tournaments",
  "shared_rounds",
];
const DENY_UPDATE = DENY_13.filter((name) => name !== "proball_teams");
const SUPER_10 = [
  "admin_audit_logs",
  "app_settings",
  "backfill_runs",
  "coaching_commands",
  "command_charge",
  "match_events",
  "retention_runs",
  "reward_settlements",
  "tactical_scans",
  "world",
];
const BASE_23 = DENY_13.concat(SUPER_10);
const TABLES = new Set(BASE_23.concat("users"));

const ISOLATION_HOOK = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
routerAdd("GET", "/api/collection-guards/cron-jobs", function (e) {
  return e.json(200, $app.cron().jobs().map(function (j) { return j.id(); }));
});
`;

const cases = [];
let child = null;
let dataDir = "";
let port = 0;
let suToken = "";
let paceAt = 0;

function parsePort(value) {
  if (!/^[0-9]+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function safe(detail) {
  return String(detail)
    .split(APP_PASS)
    .join("[secret]")
    .split(SU_PASS)
    .join("[secret]")
    .replace(/eyJ[A-Za-z0-9._-]{12,}/g, "[token]")
    .slice(0, 500);
}

function expectCase(name, cond, detail = "") {
  cases.push({ name, ok: !!cond, detail: cond ? "" : safe(detail) });
  console.log((cond ? "  ok " : "  FAIL ") + name + (cond ? "" : " " + safe(detail).slice(0, 280)));
}

function msg(data) {
  const raw = data && (data.message || (data.data && data.data.message) || "");
  return String(raw).replace(/\.+$/, "");
}

function says(data, text) {
  const got = msg(data);
  return got === text || got.endsWith(": " + text);
}

function flagOn(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function pbNow() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ".000Z");
}

function nid(prefix) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = prefix;
  while (out.length < 15) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out.slice(0, 15);
}

function assertTable(table) {
  if (!TABLES.has(table)) throw new Error("unexpected table");
}

function req(urlPath, { method = "GET", token, body } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
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
          resolve({ status: res.statusCode, data });
        });
      },
    );
    r.setTimeout(60000, () => r.destroy(new Error("timeout " + method + " " + urlPath)));
    r.on("error", reject);
    if (payload !== null) r.write(payload);
    r.end();
  });
}

async function matrixReq(method, urlPath, token, body) {
  const wait = paceAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  paceAt = Date.now() + 50;
  return req(urlPath, { method, token, body });
}

function withDb(fn) {
  const db = new DatabaseSync(path.join(dataDir, "data.db"), { timeout: 10000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function checkpoint() {
  withDb((db) => {
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      /* the next read still observes a committed write on the shared file */
    }
  });
}

function countTable(table) {
  assertTable(table);
  return withDb((db) => db.prepare(`select count(*) c from ${table}`).get().c);
}

function firstId(table) {
  assertTable(table);
  return withDb((db) => {
    const row = db.prepare(`select id from ${table} limit 1`).get();
    return row ? row.id : "";
  });
}

function snapshot(table, id) {
  assertTable(table);
  if (!id) return "";
  return withDb((db) => {
    const row = db.prepare(`select * from ${table} where id=?`).get(id);
    return row ? JSON.stringify(row) : "";
  });
}

function insertRow(table, obj) {
  assertTable(table);
  withDb((db) => {
    db.exec("PRAGMA foreign_keys = ON");
    const cols = new Set(db.prepare(`pragma table_info(${table})`).all().map((column) => column.name));
    const fields = Object.keys(obj).filter((key) => cols.has(key) && obj[key] !== undefined);
    if (!fields.includes("id")) throw new Error(table + " id missing");
    db.prepare(`insert into ${table} (${fields.join(",")}) values (${fields.map(() => "?").join(",")})`).run(
      ...fields.map((key) => obj[key]),
    );
  });
  checkpoint();
}

function userByEmail(email) {
  return withDb((db) =>
    db.prepare("select id, email, ifnull(role,'') role from users where lower(email)=lower(?)").get(email),
  );
}

function userFields(id) {
  return withDb((db) =>
    db
      .prepare(
        "select id, email, ifnull(role,'') role, ifnull(disabled,0) disabled, ifnull(admin_note,'') admin_note, ifnull(display_name,'') display_name, ifnull(must_change_password,0) must_change, ifnull(credits,0) credits from users where id=?",
      )
      .get(id),
  );
}

function sameAccount(before, after) {
  return (
    !!after &&
    before.id === after.id &&
    before.email === after.email &&
    before.role === after.role &&
    String(before.disabled) === String(after.disabled) &&
    before.admin_note === after.admin_note
  );
}

function teamManager(teamId) {
  const row = withDb((db) =>
    db.prepare("select ifnull(manager,'') manager from proball_teams where id=?").get(teamId),
  );
  return row ? row.manager : null;
}

function ledgerCount(userId) {
  return withDb((db) => db.prepare("select count(*) c from credit_ledger where user=?").get(userId).c);
}

function probePort(n) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: n, host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
}

async function start(hooksDir) {
  child = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${port}`, `--dir=${dataDir}`, `--hooksDir=${hooksDir}`, `--migrationsDir=${MIGRATIONS}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (buf) => {
    void buf;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("owned PB exited before readiness");
    try {
      const health = await req("/api/health");
      if (health.status >= 200 && health.status < 300) return;
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

async function upsertSuperuser() {
  const up = spawn(PB_BIN, ["superuser", "upsert", SU_EMAIL, SU_PASS, `--dir=${dataDir}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  up.stdout.on("data", (buf) => {
    text += buf.toString();
  });
  up.stderr.on("data", (buf) => {
    text += buf.toString();
  });
  const [code] = await once(up, "exit");
  if (code !== 0) throw new Error("superuser upsert failed (" + code + ") " + safe(text).slice(0, 300));
}

async function signup(email, displayName) {
  const res = await req("/api/collections/users/records", {
    method: "POST",
    body: {
      email,
      password: APP_PASS,
      passwordConfirm: APP_PASS,
      display_name: (displayName || email.split("@")[0]).slice(0, 40),
    },
  });
  if (res.status < 200 || res.status >= 300) throw new Error("signup failed " + res.status + " " + msg(res.data));
  const row = userByEmail(email);
  if (!row) throw new Error("signup row missing");
  return row;
}

async function login(email) {
  const res = await req("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password: APP_PASS },
  });
  if (res.status < 200 || res.status >= 300 || !res.data.token) {
    throw new Error("login failed " + res.status + " " + msg(res.data));
  }
  return { token: res.data.token, id: res.data.record.id };
}

async function superLogin() {
  const res = await req("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: SU_EMAIL, password: SU_PASS },
  });
  if (res.status < 200 || res.status >= 300 || !res.data.token) {
    throw new Error("superuser auth failed " + res.status);
  }
  suToken = res.data.token;
}

function promote(email) {
  withDb((db) => db.prepare("update users set role='admin' where lower(email)=lower(?)").run(email));
  checkpoint();
}

function assignManager(userId) {
  const team = withDb((db) =>
    db.prepare("select id from proball_teams where ifnull(manager,'')='' order by id limit 1").get(),
  );
  if (!team) throw new Error("no free team");
  withDb((db) => db.prepare("update proball_teams set manager=? where id=?").run(userId, team.id));
  checkpoint();
  return team.id;
}

function isCandidate(row) {
  return CANDIDATE.test(row.email || "") || /smoke/i.test(row.display_name || "");
}

function park(keepId) {
  const parked = [];
  withDb((db) => {
    const rows = db.prepare("select id, email, ifnull(display_name,'') display_name from users").all();
    for (const row of rows) {
      if (row.id === keepId) continue;
      if (!isCandidate(row)) continue;
      parked.push(row);
      db.prepare("update users set email=?, display_name=? where id=?").run(`done21_${row.id}@t.local`, "done21", row.id);
    }
  });
  checkpoint();
  return parked;
}

function unpark(parked) {
  withDb((db) => {
    for (const row of parked) {
      db.prepare("update users set email=?, display_name=? where id=?").run(row.email, row.display_name || "done21", row.id);
    }
  });
  checkpoint();
}

async function listTotal(collection, filter) {
  const res = await req(
    `/api/collections/${collection}/records?perPage=1&filter=${encodeURIComponent(filter)}`,
    { token: suToken },
  );
  if (res.status < 200 || res.status >= 300 || typeof res.data.totalItems !== "number") {
    throw new Error(collection + " totalItems " + res.status);
  }
  return res.data.totalItems;
}

function cleanupCli() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    env.FOOTFIVE_PB_URL = `http://127.0.0.1:${port}`;
    env.FOOTFIVE_SUPERUSER_EMAIL = SU_EMAIL;
    env.FOOTFIVE_SUPERUSER_PASSWORD = SU_PASS;
    const proc = spawn(process.execPath, [CLI_SRC, "cleanup-smoke", "--confirm"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const take = (buf) => {
      out += buf.toString();
      if (out.length > 200000) out = out.slice(-200000);
    };
    proc.stdout.on("data", take);
    proc.stderr.on("data", take);
    proc.once("error", reject);
    proc.once("exit", (code) => resolve({ code, out: safe(out) }));
  });
}

async function isolate(label, fn) {
  try {
    await fn();
  } catch (err) {
    expectCase(label, false, err.message || String(err));
  }
}

function lookupHook() {
  // Activate one failure per CLI run through the shared app store, independent
  // of request-event query wrappers. Each native callback is self-contained.
  return ["proball_teams", "shared_bets", "admin_audit_logs", "coaching_commands"]
    .map((collection) => `
onRecordsListRequest(function (e) {
  if ($app.store().get("ff21_lookup_fault") === "${collection}") throw new BadRequestError("FF21 lookup failed");
  return e.next();
}, "${collection}");
`).join("\n") + `
routerAdd("POST", "/api/collection-guards/fault/{collection}", function (e) {
  var collection = e.request.pathValue("collection");
  if (["none", "proball_teams", "shared_bets", "admin_audit_logs", "coaching_commands"].indexOf(collection) < 0) throw new BadRequestError("Unknown fixture collection");
  $app.store().set("ff21_lookup_fault", collection);
  return e.json(200, { collection: collection });
});
`;
}

async function run() {
  port = parsePort(process.env.COLLECTION_GUARDS_PB_PORT || "8308");
  if (!port) throw new Error("COLLECTION_GUARDS_PB_PORT must be an integer from 1 to 65535");
  try {
    await probePort(port);
  } catch (err) {
    throw new Error("loopback port " + port + " is not free (" + (err.code || err.message) + "); not stopping it");
  }

  const work = mkdtempSync(path.join(tmpdir(), "ff21-collection-guards-"));
  dataDir = path.join(work, "pb_data");
  const hooksDir = path.join(work, "hooks");
  mkdirSync(dataDir, { recursive: true });
  cpSync(HOOKS_SRC, hooksDir, { recursive: true });
  writeFileSync(path.join(hooksDir, "zz_collection_guards_isolation.pb.js"), ISOLATION_HOOK);
  await upsertSuperuser();
  await start(hooksDir);

  const cron = await req("/api/collection-guards/cron-jobs");
  const jobs = Array.isArray(cron.data) ? cron.data : [];
  expectCase(
    "control: scheduler keeps the system job and drops app crons",
    cron.status === 200 && jobs.includes("__pbDBOptimize__") && jobs.every((id) => !String(id).startsWith("footfive_")),
    cron.status + " " + jobs.join(","),
  );

  let health = await req("/api/footfive/health");
  let teamTotal = countTable("proball_teams");
  for (let i = 0; i < 4 && !(health.status === 200 && teamTotal >= 16); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    health = await req("/api/footfive/health");
    teamTotal = countTable("proball_teams");
  }
  expectCase(
    "control: production health bootstraps a world",
    health.status === 200 && teamTotal >= 16,
    health.status + " teams " + teamTotal,
  );

  const adminEmail = `cg21a_${STAMP}@t.local`;
  const userEmail = `cg21u_${STAMP}@t.local`;
  const adminRow = await signup(adminEmail, `cg21a${STAMP}`.slice(0, 40));
  promote(adminEmail);
  const admin = await login(adminEmail);
  const userRow = await signup(userEmail, `cg21u${STAMP}`.slice(0, 40));
  const user = await login(userEmail);
  await superLogin();
  expectCase(
    "control: signup leaves an ordinary role",
    userFields(userRow.id).role === "user" && userFields(adminRow.id).role === "admin",
    "roles",
  );

  const blockedEmail = `cg21own_${STAMP}@t.local`;
  const blocked = await req("/api/collections/users/records", {
    method: "POST",
    body: {
      email: blockedEmail,
      password: APP_PASS,
      passwordConfirm: APP_PASS,
      display_name: "cg21own",
      credits: 5,
    },
  });
  expectCase(
    "control: signup rejects a protected field",
    blocked.status === 403 && says(blocked.data, "Field credits is server-owned") && !userByEmail(blockedEmail),
    blocked.status + " " + msg(blocked.data),
  );

  for (const name of BASE_23) {
    for (const who of [
      { label: "user", token: user.token },
      { label: "admin", token: admin.token },
    ]) {
      await isolate(`${who.label} ${name} create/update/delete denied`, async () => {
        const id = firstId(name) || UNKNOWN;
        const real = id !== UNKNOWN;
        const before = countTable(name);
        const snap = real ? snapshot(name, id) : "";
        const created = await matrixReq("POST", `/api/collections/${name}/records`, who.token, {});
        const afterCreate = countTable(name);
        const updated = await matrixReq("PATCH", `/api/collections/${name}/records/${id}`, who.token, {});
        const afterSnap = real ? snapshot(name, id) : "";
        const deleted = await matrixReq("DELETE", `/api/collections/${name}/records/${id}`, who.token);
        const after = countTable(name);
        expectCase(
          `${who.label} ${name} create/update/delete denied`,
          created.status === 403 &&
            says(created.data, RULE) &&
            updated.status === 403 &&
            says(updated.data, RULE) &&
            deleted.status === 403 &&
            says(deleted.data, RULE) &&
            afterCreate === before &&
            after === before &&
            (!real || afterSnap === snap),
          [created.status, msg(created.data), updated.status, msg(updated.data), deleted.status, msg(deleted.data)].join(
            " | ",
          ),
        );
      });
    }
  }

  for (const name of DENY_13) {
    await isolate(`superuser create ${name} denied`, async () => {
      const before = countTable(name);
      const res = await matrixReq("POST", `/api/collections/${name}/records`, suToken, {});
      expectCase(
        `superuser create ${name} denied`,
        res.status === 403 && says(res.data, HOOK) && countTable(name) === before,
        res.status + " " + msg(res.data),
      );
    });
  }

  for (const name of DENY_UPDATE) {
    await isolate(`superuser update ${name} denied`, async () => {
      const id = firstId(name);
      if (!id) {
        const before = countTable(name);
        const res = await matrixReq("PATCH", `/api/collections/${name}/records/${UNKNOWN}`, suToken, {});
        const denied = res.status === 403 ? says(res.data, HOOK) : res.status !== 200;
        expectCase(
          `superuser update ${name} empty denial`,
          denied && countTable(name) === before,
          "status " + res.status + " " + msg(res.data) + " (empty collection, not persistence)",
        );
        return;
      }
      const snap = snapshot(name, id);
      const res = await matrixReq("PATCH", `/api/collections/${name}/records/${id}`, suToken, {});
      expectCase(
        `superuser update ${name} denied`,
        res.status === 403 && says(res.data, HOOK) && snapshot(name, id) === snap,
        res.status + " " + msg(res.data) + (snapshot(name, id) === snap ? "" : " row changed"),
      );
    });
  }

  for (const name of SUPER_10) {
    await isolate(`superuser create ${name}`, async () => {
      const before = countTable(name);
      const res = await matrixReq("POST", `/api/collections/${name}/records`, suToken, {});
      if (name === "app_settings") {
        expectCase(
          "superuser app_settings invalid create is validation 400",
          res.status === 400 && countTable(name) === before,
          "guard passed, validation rejected; status " + res.status + " count " + before + "->" + countTable(name),
        );
        return;
      }
      if (res.status === 400) {
        expectCase(
          `superuser create ${name} guard passed validation rejected`,
          countTable(name) === before,
          "guard passed, validation rejected; status 400 count " + before + "->" + countTable(name),
        );
        return;
      }
      if (res.status === 200 && res.data && res.data.id) {
        const del = await matrixReq("DELETE", `/api/collections/${name}/records/${res.data.id}`, suToken);
        expectCase(
          `superuser create ${name} allowed then removed`,
          del.status === 204 && countTable(name) === before,
          "create " + res.status + " delete " + del.status,
        );
        return;
      }
      expectCase(`superuser create ${name} allowed`, false, "status " + res.status + " " + msg(res.data));
    });
  }

  for (const name of SUPER_10) {
    await isolate(`superuser update ${name}`, async () => {
      const id = firstId(name);
      if (!id) {
        expectCase(`superuser update ${name} has no seeded row`, true, "create probe left no row");
        return;
      }
      const res = await matrixReq("PATCH", `/api/collections/${name}/records/${id}`, suToken, {});
      const reached = (res.status === 200 || res.status === 400) && !!firstId(name);
      expectCase(
        `superuser update ${name} reaches the record`,
        reached,
        res.status + " " + msg(res.data),
      );
    });
  }

  const profile = await req(`/api/collections/users/records/${user.id}`, {
    method: "PATCH",
    token: user.token,
    body: { display_name: "Cg21 Profile" },
  });
  expectCase(
    "control: profile update sticks",
    profile.status === 200 && userFields(user.id).display_name === "Cg21 Profile",
    profile.status + " " + msg(profile.data),
  );
  const creditsBefore = userFields(user.id).credits;
  const protectedPatch = await req(`/api/collections/users/records/${user.id}`, {
    method: "PATCH",
    token: user.token,
    body: { credits: Number(creditsBefore) + 1 },
  });
  expectCase(
    "control: protected profile field rejected",
    protectedPatch.status === 403 &&
      says(protectedPatch.data, "Field credits is server-owned") &&
      userFields(user.id).credits === creditsBefore,
    protectedPatch.status + " " + msg(protectedPatch.data),
  );

  const roleUser = await signup(`cg21role_${STAMP}@t.local`, "cg21role");
  const roleUp = await req(`/api/collections/users/records/${roleUser.id}`, {
    method: "PATCH",
    token: suToken,
    body: { role: "admin" },
  });
  const roleBack = await req(`/api/collections/users/records/${roleUser.id}`, {
    method: "PATCH",
    token: suToken,
    body: { role: "user" },
  });
  expectCase(
    "control: superuser users role patch",
    roleUp.status === 200 && userFields(roleUser.id).role === "user" && roleBack.status === 200,
    roleUp.status + "/" + roleBack.status + " role " + (userFields(roleUser.id) || {}).role,
  );

  const me = await req("/api/footfive/me", { token: user.token });
  const overview = await req("/api/footfive/admin/overview", { token: user.token });
  const adminOverview = await req("/api/footfive/admin/overview", { token: admin.token });
  expectCase("control: ordinary /me", me.status === 200, String(me.status));
  expectCase(
    "control: ordinary admin overview rejected",
    overview.status === 403 && says(overview.data, "Admin only"),
    overview.status + " " + msg(overview.data),
  );
  expectCase("control: app admin overview", adminOverview.status === 200, String(adminOverview.status));

  const forced = await signup(`cg21force_${STAMP}@t.local`, "cg21force");
  const forcedAuth = await login(forced.email);
  withDb((db) => db.prepare("update users set must_change_password=1 where id=?").run(forced.id));
  checkpoint();
  const forcedMe = await req("/api/footfive/me", { token: forcedAuth.token });
  const forcedElsewhere = await req("/api/footfive/admin/overview", { token: forcedAuth.token });
  const forcedDelete = await req(`/api/collections/users/records/${forced.id}`, {
    method: "DELETE",
    token: forcedAuth.token,
  });
  expectCase(
    "control: forced password can read /me and is blocked elsewhere",
    forcedMe.status === 200 && forcedElsewhere.status === 403 && says(forcedElsewhere.data, "Password change required"),
    forcedMe.status + "/" + forcedElsewhere.status + " " + msg(forcedElsewhere.data),
  );
  expectCase(
    "control: forced password self-delete does not remove the user",
    forcedDelete.status !== 200 && forcedDelete.status !== 204 && !!userFields(forced.id),
    String(forcedDelete.status),
  );

  const disabled = await signup(`cg21dis_${STAMP}@t.local`, "cg21dis");
  const disabledAuth = await login(disabled.email);
  withDb((db) => db.prepare("update users set disabled=1 where id=?").run(disabled.id));
  checkpoint();
  const disabledMe = await req("/api/footfive/me", { token: disabledAuth.token });
  const disabledDelete = await req(`/api/collections/users/records/${disabled.id}`, {
    method: "DELETE",
    token: disabledAuth.token,
  });
  expectCase(
    "control: disabled account is rejected",
    disabledMe.status === 403 && says(disabledMe.data, "Account disabled"),
    disabledMe.status + " " + msg(disabledMe.data),
  );
  expectCase(
    "control: disabled self-delete does not remove the user",
    disabledDelete.status !== 200 && disabledDelete.status !== 204 && !!userFields(disabled.id),
    String(disabledDelete.status),
  );

  await isolate("self-delete leaves the account and ledger", async () => {
    const ordinary = await signup(`cg21self_${STAMP}@t.local`, "cg21self");
    const asAdmin = await signup(`cg21aself_${STAMP}@t.local`, "cg21aself");
    promote(asAdmin.email);
    const ordinaryAuth = await login(ordinary.email);
    const adminAuth = await login(asAdmin.email);
    const ordinaryLedger = nid("cg21led");
    const adminLedger = nid("cg21led");
    insertRow("credit_ledger", { id: ordinaryLedger, user: ordinary.id, type: "ff21", amount: 1, description: "ff21", created: pbNow() });
    insertRow("credit_ledger", { id: adminLedger, user: asAdmin.id, type: "ff21", amount: 1, description: "ff21", created: pbNow() });
    const beforeOrdinary = userFields(ordinary.id);
    const beforeAdmin = userFields(asAdmin.id);
    const delOrdinary = await req(`/api/collections/users/records/${ordinary.id}`, { method: "DELETE", token: ordinaryAuth.token });
    const delAdmin = await req(`/api/collections/users/records/${asAdmin.id}`, { method: "DELETE", token: adminAuth.token });
    expectCase(
      "ordinary self-delete rejected before cascade",
      delOrdinary.status === 403 &&
        says(delOrdinary.data, HOOK) &&
        sameAccount(beforeOrdinary, userFields(ordinary.id)) &&
        ledgerCount(ordinary.id) === 1,
      delOrdinary.status + " " + msg(delOrdinary.data),
    );
    expectCase(
      "app-admin self-delete rejected before cascade",
      delAdmin.status === 403 &&
        says(delAdmin.data, HOOK) &&
        sameAccount(beforeAdmin, userFields(asAdmin.id)) &&
        ledgerCount(asAdmin.id) === 1,
      delAdmin.status + " " + msg(delAdmin.data),
    );
  });

  await isolate("delete another user stays on the rule", async () => {
    const keep = await signup(`cg21keep_${STAMP}@t.local`, "cg21keep");
    const res = await req(`/api/collections/users/records/${keep.id}`, { method: "DELETE", token: user.token });
    expectCase("delete another user is a rule 404", res.status === 404 && !!userFields(keep.id), String(res.status));
  });

  await isolate("superuser delete of a disposable user", async () => {
    const victim = await signup(`cg21del_${STAMP}@t.local`, "cg21del");
    const ledgerId = nid("cg21led");
    insertRow("credit_ledger", { id: ledgerId, user: victim.id, type: "ff21", amount: 1, description: "ff21", created: pbNow() });
    const res = await req(`/api/collections/users/records/${victim.id}`, { method: "DELETE", token: suToken });
    expectCase(
      "superuser users delete removes the account and ledger",
      res.status === 204 && !userFields(victim.id) && ledgerCount(victim.id) === 0,
      String(res.status),
    );
  });

  await isolate("superuser world update", async () => {
    const world = withDb((db) => db.prepare("select id, round_interval_ms ms from world limit 1").get());
    expectCase("control: health created a world row", !!(world && world.id), world ? "present" : "missing");
    if (!world || !world.id) return;
    const next = world.ms === 60001 ? 60002 : 60001;
    const patched = await req(`/api/collections/world/records/${world.id}`, {
      method: "PATCH",
      token: suToken,
      body: { round_interval_ms: next },
    });
    const mid = withDb((db) => db.prepare("select round_interval_ms ms from world where id=?").get(world.id));
    const restored = await req(`/api/collections/world/records/${world.id}`, {
      method: "PATCH",
      token: suToken,
      body: { round_interval_ms: world.ms },
    });
    const end = withDb((db) => db.prepare("select round_interval_ms ms from world where id=?").get(world.id));
    const restoredValue = end && end.ms === world.ms;
    expectCase(
      "superuser world update sticks then restores",
      patched.status === 200 && mid && mid.ms === next && restored.status === 200 && restoredValue,
      [patched.status, mid && mid.ms, restored.status, end && end.ms].join("/"),
    );
  });

  await isolate("superuser team manager update", async () => {
    const team = withDb((db) =>
      db.prepare("select id, ifnull(manager,'') manager from proball_teams order by id limit 1").get(),
    );
    if (!team) throw new Error("no team");
    const patched = await req(`/api/collections/proball_teams/records/${team.id}`, {
      method: "PATCH",
      token: suToken,
      body: { manager: user.id },
    });
    const mid = teamManager(team.id);
    const restored = await req(`/api/collections/proball_teams/records/${team.id}`, {
      method: "PATCH",
      token: suToken,
      body: { manager: team.manager },
    });
    const end = teamManager(team.id);
    expectCase(
      "superuser team manager update sticks then restores",
      patched.status === 200 && mid === user.id && restored.status === 200 && end === team.manager,
      [patched.status, mid, restored.status, end].join("/"),
    );
  });

  const claimer = await signup(`e2e_claim_${STAMP}@t.local`, `e2eclaim${STAMP}`.slice(0, 40));
  const claimAuth = await login(claimer.email);
  const claimTeam = withDb((db) =>
    db.prepare("select id from proball_teams where ifnull(manager,'')='' order by id limit 1").get(),
  );
  if (!claimTeam) throw new Error("no free team to claim");
  const claim = await req(`/api/footfive/teams/${claimTeam.id}/claim`, { method: "POST", token: claimAuth.token });
  const claimManager = teamManager(claimTeam.id);
  const claimAudit = await listTotal("admin_audit_logs", `admin="${claimer.id}"`);
  expectCase(
    "control: protected claim writes the team",
    claim.status === 200 && claimManager === claimer.id && claimAudit > 0,
    claim.status + " manager " + claimManager + " audit " + claimAudit,
  );

  await isolate("cli plain smoke user deleted", async () => {
    const person = await signup(`e2e_plain_${STAMP}@t.local`, `e2eplain${STAMP}`.slice(0, 40));
    park(person.id);
    const result = await cleanupCli();
    expectCase(
      "cli plain smoke user deleted",
      result.code === 0 &&
        !userFields(person.id) &&
        result.out.includes("deleted " + person.email) &&
        result.out.includes("audit write skipped") &&
        result.out.includes("cleanup done"),
      "exit " + result.code + " " + result.out.slice(0, 240),
    );
  });

  await isolate("cli managed smoke user released then deleted", async () => {
    const person = await signup(`e2e_managed_${STAMP}@t.local`, `e2emanaged${STAMP}`.slice(0, 40));
    const teamId = assignManager(person.id);
    const teams = await listTotal("proball_teams", `manager="${person.id}"`);
    const bets = await listTotal("shared_bets", `user="${person.id}" && settled=false`);
    const audit = await listTotal("admin_audit_logs", `admin="${person.id}"`);
    const coaching = await listTotal("coaching_commands", `user="${person.id}"`);
    if (teams !== 1 || bets !== 0 || audit !== 0 || coaching !== 0) {
      throw new Error("managed preflight teams " + teams + " bets " + bets + " audit " + audit + " coaching " + coaching);
    }
    park(person.id);
    const result = await cleanupCli();
    expectCase(
      "cli managed smoke user released then deleted",
      result.code === 0 &&
        !userFields(person.id) &&
        teamManager(teamId) === "" &&
        result.out.includes("released team") &&
        result.out.includes("deleted " + person.email) &&
        result.out.includes("cleanup done"),
      "exit " + result.code + " manager " + teamManager(teamId) + " " + result.out.slice(0, 240),
    );
  });

  await isolate("cli open bet released then disabled", async () => {
    const fx = firstId("shared_fixtures");
    const selection = firstId("proball_teams");
    if (!fx || !selection) throw new Error("no shared fixture to seed an open bet");
    const person = await signup(`e2e_bets_${STAMP}@t.local`, `e2ebets${STAMP}`.slice(0, 40));
    const teamId = assignManager(person.id);
    insertRow("shared_bets", {
      id: nid("cg21bet"),
      user: person.id,
      fixture: fx,
      selection_team: selection,
      stake: 1,
      odds: 2,
      status: "open",
      settled: 0,
      created: pbNow(),
      updated: pbNow(),
    });
    const bets = await listTotal("shared_bets", `user="${person.id}" && settled=false`);
    const audit = await listTotal("admin_audit_logs", `admin="${person.id}"`);
    const coaching = await listTotal("coaching_commands", `user="${person.id}"`);
    if (bets < 1 || audit !== 0 || coaching !== 0) {
      throw new Error("open bet preflight bets " + bets + " audit " + audit + " coaching " + coaching);
    }
    park(person.id);
    const result = await cleanupCli();
    const after = userFields(person.id);
    expectCase(
      "cli open bet released then disabled",
      result.code === 0 &&
        !!after &&
        flagOn(after.disabled) &&
        after.admin_note === OPEN_NOTE &&
        teamManager(teamId) === "" &&
        result.out.includes("disable (open bets)") &&
        result.out.includes(person.email) &&
        result.out.includes("released team") &&
        !result.out.includes("deleted " + person.email),
      "exit " + result.code + " note " + (after && after.admin_note) + " " + result.out.slice(0, 240),
    );
  });

  await isolate("cli claimer history released then disabled", async () => {
    // Earlier independent CLI cases parked this pre-created claimant. Restore
    // its original candidate identity before checking its required audit history.
    withDb((db) => db.prepare("update users set email=? where id=?").run(claimer.email, claimer.id));
    const bets = await listTotal("shared_bets", `user="${claimer.id}" && settled=false`);
    const coaching = await listTotal("coaching_commands", `user="${claimer.id}"`);
    if (claimAudit < 1 || bets !== 0 || coaching !== 0 || claimManager !== claimer.id) {
      throw new Error("claimer preflight audit " + claimAudit + " bets " + bets + " coaching " + coaching);
    }
    park(claimer.id);
    const result = await cleanupCli();
    const after = userFields(claimer.id);
    expectCase(
      "cli claimer history released then disabled",
      result.code === 0 &&
        !!after &&
        flagOn(after.disabled) &&
        after.admin_note === HISTORY_NOTE &&
        teamManager(claimTeam.id) === "" &&
        result.out.includes("disable (audit/coaching history)") &&
        result.out.includes("released team") &&
        !result.out.includes("deleted " + claimer.email) &&
        result.out.includes("cleanup done"),
      "exit " + result.code + " note " + (after && after.admin_note) + " " + result.out.slice(0, 240),
    );
  });

  await isolate("cli coaching history released then disabled", async () => {
    const fx = firstId("shared_fixtures");
    if (!fx) throw new Error("no shared fixture to seed coaching history");
    const person = await signup(`e2e_coach_${STAMP}@t.local`, `e2ecoach${STAMP}`.slice(0, 40));
    const teamId = assignManager(person.id);
    insertRow("coaching_commands", {
      id: nid("cg21cmd"),
      fixture: fx,
      team: teamId,
      user: person.id,
      stance: "defend",
      created: pbNow(),
    });
    const coaching = await listTotal("coaching_commands", `user="${person.id}"`);
    const bets = await listTotal("shared_bets", `user="${person.id}" && settled=false`);
    if (coaching < 1 || bets !== 0) throw new Error("coaching preflight " + coaching + " bets " + bets);
    park(person.id);
    const result = await cleanupCli();
    const after = userFields(person.id);
    const commandLeft = withDb((db) =>
      db.prepare("select count(*) c from coaching_commands where user=?").get(person.id).c,
    );
    expectCase(
      "cli coaching history released then disabled",
      result.code === 0 &&
        !!after &&
        flagOn(after.disabled) &&
        after.admin_note === HISTORY_NOTE &&
        teamManager(teamId) === "" &&
        commandLeft === 1 &&
        result.out.includes("disable (audit/coaching history)") &&
        !result.out.includes("deleted " + person.email),
      "exit " + result.code + " note " + (after && after.admin_note) + " " + result.out.slice(0, 240),
    );
  });

  await isolate("cli application admin skipped", async () => {
    const person = await signup(`e2e_admin_${STAMP}@t.local`, `e2eadmin${STAMP}`.slice(0, 40));
    promote(person.email);
    const teamId = assignManager(person.id);
    const before = userFields(person.id);
    park(person.id);
    const result = await cleanupCli();
    const after = userFields(person.id);
    expectCase(
      "cli application admin skipped",
      result.code === 0 &&
        !!after &&
        after.role === "admin" &&
        String(after.disabled) === String(before.disabled) &&
        teamManager(teamId) === person.id &&
        result.out.includes("skipped admin " + person.email) &&
        !result.out.includes("released team") &&
        !result.out.includes("deleted " + person.email) &&
        result.out.includes("cleanup done"),
      "exit " + result.code + " " + result.out.slice(0, 240),
    );
  });

  const lookupTeams = await signup(`e2e_lookt_${STAMP}@t.local`, `e2elookt${STAMP}`.slice(0, 40));
  const lookupBets = await signup(`e2e_lookb_${STAMP}@t.local`, `e2elookb${STAMP}`.slice(0, 40));
  const lookupAudit = await signup(`e2e_looka_${STAMP}@t.local`, `e2elooka${STAMP}`.slice(0, 40));
  const lookupCoach = await signup(`e2e_lookc_${STAMP}@t.local`, `e2elookc${STAMP}`.slice(0, 40));
  const lookupTeamIds = {
    teams: assignManager(lookupTeams.id),
    audit: assignManager(lookupAudit.id),
    coaching: assignManager(lookupCoach.id),
  };
  await stop();
  writeFileSync(
    path.join(hooksDir, "zz_collection_guards_lookup_fault.pb.js"),
    lookupHook(),
  );
  await start(hooksDir);
  await superLogin();

  async function expectLookupAbort(label, person, teamId, collection) {
    const before = userFields(person.id);
    const managerBefore = teamId ? teamManager(teamId) : "";
    const parked = park(person.id);
    try {
      const armed = await req(`/api/collection-guards/fault/${collection}`, { method: "POST" });
      if (armed.status !== 200 || armed.data.collection !== collection) throw new Error("fixture fault activation failed");
      const result = await cleanupCli();
      const after = userFields(person.id);
      const managerAfter = teamId ? teamManager(teamId) : "";
      expectCase(
        label,
        result.code !== 0 &&
          sameAccount(before, after) &&
          !flagOn(after && after.disabled) &&
          managerAfter === managerBefore &&
          result.out.includes("FF21 lookup failed") &&
          !result.out.includes("released team") &&
          !result.out.includes("deleted " + person.email) &&
          !result.out.includes("disable ("),
        "exit " + result.code + " manager " + managerAfter + " " + result.out.slice(0, 240),
      );
    } finally {
      await req("/api/collection-guards/fault/none", { method: "POST" });
      unpark(parked);
    }
  }

  await isolate("cli teams lookup failure aborts before mutation", async () => {
    await expectLookupAbort("cli teams lookup failure aborts before mutation", lookupTeams, lookupTeamIds.teams, "proball_teams");
  });
  await isolate("cli open-bet lookup failure aborts before mutation", async () => {
    if (teamManager && (await listTotal("proball_teams", `manager="${lookupBets.id}"`)) !== 0) {
      throw new Error("open-bet lookup user should have no team");
    }
    await expectLookupAbort("cli open-bet lookup failure aborts before mutation", lookupBets, "", "shared_bets");
  });
  await isolate("cli audit lookup failure aborts before mutation", async () => {
    await expectLookupAbort("cli audit lookup failure aborts before mutation", lookupAudit, lookupTeamIds.audit, "admin_audit_logs");
  });
  await isolate("cli coaching lookup failure aborts before mutation", async () => {
    await expectLookupAbort("cli coaching lookup failure aborts before mutation", lookupCoach, lookupTeamIds.coaching, "coaching_commands");
  });
}

async function main() {
  try {
    await run();
  } catch (err) {
    expectCase("run", false, err && err.message ? err.message : String(err));
  } finally {
    try {
      await stop();
    } catch (err) {
      console.log("stop " + safe(err.message || err));
    }
    const failed = cases.filter((item) => !item.ok).length;
    try {
      writeFileSync(
        EVIDENCE,
        JSON.stringify(
          {
            phase: PHASE,
            port,
            hooks: HOOKS_SRC,
            cli: CLI_SRC,
            work: dataDir ? path.dirname(dataDir) : null,
            passed: cases.length - failed,
            failed,
            cases,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.log("evidence " + safe(err.message || err));
    }
    console.log(
      `collection-guards ${PHASE}: ${cases.length - failed} passed, ${failed} failed, port ${port}, ${EVIDENCE}`,
    );
    process.exit(failed ? 1 : 0);
  }
}

main();
