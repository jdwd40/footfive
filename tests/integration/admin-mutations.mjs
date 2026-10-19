/**
 * Issue #29 admin guards and pagination.
 * Disposable PocketBase on loopback, ADMIN_MUTATIONS_PB_PORT (default 8306).
 * Stops only the process it spawned.
 * Hooks: ADMIN_MUTATIONS_HOOKS, or the worktree pocketbase/pb_hooks.
 * Migrations always come from the worktree pocketbase/pb_migrations.
 * Nonzero exit when any case fails. Evidence JSON is written either way.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.ADMIN_MUTATIONS_PB_PORT || 8306);
const HOOKS_SRC = process.env.ADMIN_MUTATIONS_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const MIGRATIONS = path.join(ROOT, "pocketbase/pb_migrations");
const PB_BIN = path.join(ROOT, "pocketbase/pocketbase");
const PHASE = process.env.ADMIN_MUTATIONS_HOOKS ? "baseline" : "current";
const EVIDENCE = `/tmp/ff29-admin-mutations-${PHASE}.json`;
const NOT_FOUND = "The requested resource wasn't found";
const HISTORY = "User has audit or coaching history; disable the account instead";

const ISOLATION_HOOK = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
onRecordDelete(function (e) {
  if (e.record.collection().name === "users" && e.record.get("email") === "late-delete@t.local") {
    throw new BadRequestError("injected delete failure");
  }
  e.next();
}, "users");
routerAdd("GET", "/api/admin-mutations/cron-jobs", function (e) {
  return e.json(200, $app.cron().jobs().map(function (j) { return j.id(); }));
});
`;

const cases = [];
let child = null;
let dataDir = "";
let stderr = "";

function expectCase(name, cond, detail = "") {
  cases.push({ name, ok: !!cond, detail: cond ? "" : String(detail).slice(0, 500) });
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond ? "" : " " + String(detail).slice(0, 280)));
}

function msg(data) {
  return String((data && data.message) || "").replace(/\.+$/, "");
}

function says(data, text) {
  const got = msg(data);
  return got === text || got.endsWith(": " + text);
}

function req(urlPath, { method = "GET", token, body } = {}) {
  const url = new URL(`http://127.0.0.1:${PORT}${urlPath}`);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      url,
      {
        method,
        agent: false,
        headers: {
          ...(token ? { Authorization: token } : {}),
          ...(payload
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
          });
        });
      },
    );
    r.setTimeout(60000, () => r.destroy(new Error("timeout " + method + " " + urlPath)));
    r.on("error", reject);
    if (payload) r.write(payload);
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

function userCount() {
  return withDb((db) => db.prepare("select count(*) c from users").get().c);
}

function userByEmail(email) {
  return withDb((db) =>
    db.prepare(
      "select id, email, role, credits, disabled, display_name from users where lower(email)=lower(?)",
    ).get(email),
  );
}

function userById(id) {
  return withDb((db) =>
    db.prepare("select id, email, role, credits, disabled from users where id=?").get(id),
  );
}

function teamById(id) {
  return withDb((db) =>
    db.prepare(
      "select id, ifnull(manager,'') manager, ifnull(manager_mode,'') mode from proball_teams where id=?",
    ).get(id),
  );
}

function freeTeamIds() {
  return withDb((db) =>
    db.prepare(
      "select id from proball_teams where manager is null or manager='' order by id",
    ).all(),
  ).map((row) => row.id);
}

function latestAudit(action, targetId) {
  const row = withDb((db) =>
    db.prepare(
      "select meta from admin_audit_logs where action=? and target_id=? order by created desc limit 1",
    ).get(action, targetId),
  );
  if (!row) return null;
  if (typeof row.meta === "object" && row.meta) return row.meta;
  try {
    return JSON.parse(row.meta);
  } catch {
    return { raw: row.meta };
  }
}

function overviewTruth() {
  return withDb((db) => {
    const users = db.prepare("select count(*) c from users").get().c;
    const teams = db.prepare("select count(*) c from proball_teams").get().c;
    const available = db.prepare(
      "select count(*) c from proball_teams where manager is null or manager=''",
    ).get().c;
    const managed = teams - available;
    return { users, teams, available, managed, spectators: Math.max(0, users - managed) };
  });
}

function orderedUserIds() {
  return withDb((db) =>
    db.prepare("select id from users order by created desc, id asc").all().map((row) => row.id),
  );
}

function probePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port: Number(PORT), host: "127.0.0.1", exclusive: true }, () => probe.close(resolve));
  });
}

async function start(hooksDir) {
  stderr = "";
  child = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      `--dir=${dataDir}`,
      `--hooksDir=${hooksDir}`,
      `--migrationsDir=${MIGRATIONS}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", (buf) => {
    stderr += buf.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("PB exited early (" + child.exitCode + ") " + stderr.slice(-500));
    try {
      const health = await req("/api/health");
      if (health.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("PB readiness timeout " + stderr.slice(-500));
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
  if (!res.ok) throw new Error("signup " + email + " " + res.status + " " + msg(res.data));
  return userByEmail(email);
}

async function login(email, password = "testpass99") {
  const res = await req("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password },
  });
  if (!res.ok) throw new Error("login " + email + " " + res.status + " " + msg(res.data));
  return { token: res.data.token, id: res.data.record.id, email };
}

function promote(email) {
  withDb((db) => db.prepare("update users set role='admin' where lower(email)=lower(?)").run(email));
}

async function createUser(token, body) {
  return req("/api/footfive/admin/users", { method: "POST", token, body });
}

function listed(data) {
  if (data && Array.isArray(data.users)) return data.users;
  if (Array.isArray(data)) return data;
  return [];
}

function usersQuery(params) {
  return "/api/footfive/admin/users?" + new URLSearchParams(params).toString();
}

async function run() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid ADMIN_MUTATIONS_PB_PORT");
  const work = mkdtempSync(path.join(tmpdir(), "ff29-admin-mutations-"));
  dataDir = path.join(work, "pb_data");
  const hooksDir = path.join(work, "hooks");
  mkdirSync(dataDir, { recursive: true });
  const evidence = {
    phase: PHASE,
    port: Number(PORT),
    hooks: HOOKS_SRC,
    migrations: MIGRATIONS,
    work,
    started: new Date().toISOString(),
    cases,
  };
  try {
    await probePort();
    cpSync(HOOKS_SRC, hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, "zz_admin_mutations_isolation.pb.js"), ISOLATION_HOOK);
    await start(hooksDir);

    const cron = await req("/api/admin-mutations/cron-jobs");
    const jobs = Array.isArray(cron.data) ? cron.data : [];
    expectCase(
      "control: scheduler keeps the system job and drops app crons",
      cron.ok && jobs.includes("__pbDBOptimize__") && jobs.every((id) => !String(id).startsWith("footfive_")),
      JSON.stringify({ status: cron.status, jobs }),
    );

    // Bootstrap precedes migrations; explicitly create the disposable world.
    const health = await req("/api/footfive/health");
    if (!health.ok) throw new Error("world setup: " + health.status + " " + msg(health.data));

    const stamp = Date.now();
    const adminEmail = `aa29_${stamp}@t.local`;
    const plainEmail = `plain29_${stamp}@t.local`;
    await signup(adminEmail, "adminpass99");
    promote(adminEmail);
    const admin = await login(adminEmail, "adminpass99");
    const plain = await login((await signup(plainEmail)).email);

    const denied = await req("/api/footfive/admin/overview", { token: plain.token });
    expectCase(
      "control: non-admin is denied overview",
      denied.status === 403 && says(denied.data, "Admin only"),
      denied.status + " " + msg(denied.data),
    );

    const validEmail = `valid29_${stamp}@t.local`;
    const valid = await createUser(admin.token, {
      email: validEmail,
      password: "testpass99",
      display_name: "Valid Person",
      reason: "create",
    });
    const validKeys = valid.data && typeof valid.data === "object" ? Object.keys(valid.data).sort() : [];
    expectCase(
      "control: valid create returns id and email only",
      valid.ok && validKeys.length === 2 && valid.data.email === validEmail && !("password" in valid.data),
      valid.status + " " + JSON.stringify(valid.data).slice(0, 200),
    );

    const omittedEmail = `omitted29_${stamp}@t.local`;
    const omitted = await createUser(admin.token, { email: omittedEmail, password: "testpass99", reason: "defaults" });
    const omittedRow = userByEmail(omittedEmail);
    expectCase(
      "control: omitted credits, role, and display name use defaults",
      omitted.ok &&
        omittedRow &&
        Number(omittedRow.credits) === 1000 &&
        omittedRow.role === "user" &&
        omittedRow.display_name === "omitted29_" + stamp,
      JSON.stringify(omittedRow),
    );

    const zeroEmail = `zero29_${stamp}@t.local`;
    const zero = await createUser(admin.token, {
      email: zeroEmail,
      password: "testpass99",
      credits: 0,
      display_name: "Zero",
    });
    const zeroRow = userByEmail(zeroEmail);
    expectCase(
      "control: explicit zero credits stay zero",
      zero.ok && zeroRow && Number(zeroRow.credits) === 0,
      JSON.stringify({ status: zero.status, message: msg(zero.data), row: zeroRow }),
    );

    const blankEmail = `blank-name@t.local`;
    const blank = await createUser(admin.token, {
      email: blankEmail,
      password: "testpass99",
      display_name: "",
    });
    const blankRow = userByEmail(blankEmail);
    expectCase(
      "control: blank display_name uses the local part",
      blank.ok && blankRow && blankRow.display_name === "blank-name",
      JSON.stringify({ status: blank.status, message: msg(blank.data), row: blankRow }),
    );

    const roleNullEmail = `rolenull29_${stamp}@t.local`;
    const roleOmitEmail = `roleomit29_${stamp}@t.local`;
    const roleNull = await createUser(admin.token, {
      email: roleNullEmail,
      password: "testpass99",
      role: null,
      display_name: "Role Null",
    });
    const roleOmit = await createUser(admin.token, {
      email: roleOmitEmail,
      password: "testpass99",
      display_name: "Role Omit",
    });
    expectCase(
      "control: null and omitted role become user",
      roleNull.ok &&
        roleOmit.ok &&
        userByEmail(roleNullEmail)?.role === "user" &&
        userByEmail(roleOmitEmail)?.role === "user",
      JSON.stringify({ null: msg(roleNull.data), omit: msg(roleOmit.data) }),
    );

    const badEmails = [`not-an-email-${stamp}`, `a@b`, `a b@${stamp}.com`];
    const emailResults = [];
    let emailsOk = true;
    for (const email of badEmails) {
      const before = userCount();
      const res = await createUser(admin.token, { email, password: "testpass99", display_name: "Bad" });
      const after = userCount();
      const pass = res.status === 400 && says(res.data, "Valid email required") && after === before;
      emailsOk = emailsOk && pass;
      emailResults.push({ email, status: res.status, message: msg(res.data), before, after });
    }
    expectCase("new: malformed emails reject and write no user", emailsOk, JSON.stringify(emailResults));

    const shortEmail = `short29_${stamp}@t.local`;
    const beforeShort = userCount();
    const short = await createUser(admin.token, {
      email: shortEmail,
      password: "seven77",
      display_name: "Short",
    });
    expectCase(
      "new: seven-character password rejects and writes no user",
      short.status === 400 && says(short.data, "Password must be at least 8 characters") && userCount() === beforeShort,
      short.status + " " + msg(short.data) + " count " + beforeShort + "->" + userCount(),
    );

    const ownerEmail = `owner29_${stamp}@t.local`;
    const beforeOwner = userCount();
    const owner = await createUser(admin.token, {
      email: ownerEmail,
      password: "testpass99",
      role: "owner",
      display_name: "Owner",
    });
    expectCase(
      "new: role owner rejects and writes no user",
      owner.status === 400 && says(owner.data, "Role must be user or admin") && userCount() === beforeOwner,
      owner.status + " " + msg(owner.data),
    );

    const longEmail = `longname29_${stamp}@t.local`;
    const beforeLong = userCount();
    const longName = await createUser(admin.token, {
      email: longEmail,
      password: "testpass99",
      display_name: "n".repeat(41),
    });
    expectCase(
      "new: 41-character display name rejects and writes no user",
      longName.status === 400 &&
        says(longName.data, "Display name must be 1 to 40 characters") &&
        userCount() === beforeLong,
      longName.status + " " + msg(longName.data),
    );

    const creditCases = [
      ["null", null],
      ["string", "10"],
      ["negative", -1],
      ["fraction", 1.5],
    ];
    const creditResults = [];
    let creditsOk = true;
    for (const [label, credits] of creditCases) {
      const email = `cred${label}29_${stamp}@t.local`;
      const before = userCount();
      const res = await createUser(admin.token, { email, password: "testpass99", credits, display_name: "Cred" });
      const after = userCount();
      const pass = res.status === 400 && says(res.data, "Credits must be a whole number of 0 or more") && after === before;
      creditsOk = creditsOk && pass;
      creditResults.push({ label, status: res.status, message: msg(res.data), before, after });
    }
    expectCase("new: null, string, negative, and fractional credits reject", creditsOk, JSON.stringify(creditResults));

    const dupA = `Ada${stamp}@t.local`;
    const dupB = `ada${stamp}@t.local`;
    const firstDup = await createUser(admin.token, { email: dupA, password: "testpass99", display_name: "Ada" });
    const beforeDup = userCount();
    const secondDup = await createUser(admin.token, { email: dupB, password: "testpass99", display_name: "ada" });
    const dupRows = withDb((db) =>
      db.prepare("select count(*) c from users where lower(email)=lower(?)").get(dupB).c,
    );
    expectCase(
      "control: case-variant addresses follow PocketBase email matching",
      firstDup.ok && secondDup.ok && dupRows === 2 && userCount() === beforeDup + 1,
      JSON.stringify({ first: firstDup.status, second: secondDup.status, message: msg(secondDup.data), dupRows }),
    );

    const beforeExactDup = userCount();
    const exactDup = await createUser(admin.token, { email: dupA, password: "testpass99", display_name: "Ada again" });
    expectCase(
      "new: exact duplicate rejects with a stable message and no write",
      exactDup.status === 400 && says(exactDup.data, "Email already in use") && userCount() === beforeExactDup,
      JSON.stringify({ status: exactDup.status, message: msg(exactDup.data), before: beforeExactDup, after: userCount() }),
    );

    const badPage = await req(usersQuery({ q: "", page: "0", perPage: "200" }), { token: admin.token });
    const badSize = await req(usersQuery({ q: "", page: "1", perPage: "201" }), { token: admin.token });
    const badQ = await req(usersQuery({ q: "q".repeat(255), page: "1", perPage: "200" }), { token: admin.token });
    expectCase(
      "new: page, page size, and overlong search reject",
      badPage.status === 400 &&
        says(badPage.data, "Page must be a whole number from 1") &&
        badSize.status === 400 &&
        says(badSize.data, "Page size must be a whole number from 1 to 200") &&
        badQ.status === 400 &&
        says(badQ.data, "Search query is too long"),
      JSON.stringify({ page: msg(badPage.data), size: msg(badSize.data), q: msg(badQ.data), statuses: [badPage.status, badSize.status, badQ.status] }),
    );

    const litEmail = `lit-filter@t.local`;
    const decoyEmail = `decoy-filter@t.local`;
    const literal = 'lit%_q"\\z';
    const decoyName = 'litXXq"\\z';
    const lit = await createUser(admin.token, { email: litEmail, password: "testpass99", display_name: literal });
    const decoy = await createUser(admin.token, { email: decoyEmail, password: "testpass99", display_name: decoyName });
    const found = await req(usersQuery({ q: literal, page: "1", perPage: "200" }), { token: admin.token });
    const foundEmails = listed(found.data).map((row) => row.email);
    expectCase(
      "control: literal special-character search hits one user and not the decoy",
      lit.ok && decoy.ok && found.ok && foundEmails.includes(litEmail) && !foundEmails.includes(decoyEmail),
      JSON.stringify({ lit: lit.status, decoy: decoy.status, found: found.status, emails: foundEmails }),
    );

    const percent = await req(usersQuery({ q: "%", page: "1", perPage: "200" }), { token: admin.token });
    const percentEmails = listed(percent.data).map((row) => row.email);
    expectCase(
      "new: percent query total is not every user",
      percent.ok &&
        typeof percent.data.totalItems === "number" &&
        percent.data.totalItems >= 1 &&
        percent.data.totalItems !== userCount() &&
        percentEmails.includes(litEmail) &&
        !percentEmails.includes(decoyEmail),
      JSON.stringify({ status: percent.status, totalItems: percent.data.totalItems, users: userCount(), message: msg(percent.data) }),
    );

    const underscore = await req(usersQuery({ q: "_", page: "1", perPage: "200" }), { token: admin.token });
    const underscoreEmails = listed(underscore.data).map((row) => row.email);
    expectCase(
      "new: underscore query stays literal",
      underscore.ok &&
        typeof underscore.data.totalItems === "number" &&
        underscore.data.totalItems < userCount() &&
        underscoreEmails.includes(litEmail) &&
        !underscoreEmails.includes(decoyEmail),
      JSON.stringify({ totalItems: underscore.data.totalItems, users: userCount(), emails: underscoreEmails }),
    );

    const quote = await req(usersQuery({ q: '"', page: "1", perPage: "200" }), { token: admin.token });
    const slash = await req(usersQuery({ q: "\\", page: "1", perPage: "200" }), { token: admin.token });
    const quoteEmails = listed(quote.data).map((row) => row.email).sort();
    const slashEmails = listed(slash.data).map((row) => row.email).sort();
    const both = [decoyEmail, litEmail].sort();
    expectCase(
      "new: quote and backslash queries match only the two literal names",
      quote.ok &&
        slash.ok &&
        quote.data.totalItems === 2 &&
        slash.data.totalItems === 2 &&
        JSON.stringify(quoteEmails) === JSON.stringify(both) &&
        JSON.stringify(slashEmails) === JSON.stringify(both),
      JSON.stringify({ quote: quote.data.totalItems, slash: slash.data.totalItems, quoteEmails, slashEmails }),
    );

    const world = await req("/api/footfive/world", { token: plain.token });
    if (!world.ok) throw new Error("world " + world.status + " " + msg(world.data));
    const free = freeTeamIds();
    if (free.length < 8) throw new Error("need 8 free teams, got " + free.length);

    const unknownDisable = await req("/api/footfive/admin/users/zzzunknownuser1/disable", {
      method: "POST",
      token: admin.token,
      body: { reason: "missing" },
    });
    expectCase(
      "control: unknown disable id is 404 not-found",
      unknownDisable.status === 404 && says(unknownDisable.data, NOT_FOUND),
      unknownDisable.status + " " + msg(unknownDisable.data),
    );
    const unknownDelete = await req("/api/footfive/admin/users/zzzunknownuser1", {
      method: "DELETE",
      token: admin.token,
      body: { reason: "missing" },
    });
    expectCase(
      "control: unknown delete id keeps status 400",
      unknownDelete.status === 400,
      unknownDelete.status + " " + msg(unknownDelete.data),
    );

    const stale = await login((await signup(`stale29_${stamp}@t.local`, "adminpass99")).email, "adminpass99");
    promote(stale.email);
    const staleAdmin = await login(stale.email, "adminpass99");
    withDb((db) => db.prepare("update users set disabled=1 where id=?").run(staleAdmin.id));
    const staleTarget = await signup(`staletarget29_${stamp}@t.local`);
    const staleDisable = await req(`/api/footfive/admin/users/${staleTarget.id}/disable`, {
      method: "POST",
      token: staleAdmin.token,
      body: { reason: "stale" },
    });
    expectCase(
      "control: stale disabled actor cannot disable",
      staleDisable.status === 403 && says(staleDisable.data, "Account disabled") && userById(staleTarget.id).disabled === 0,
      staleDisable.status + " " + msg(staleDisable.data),
    );
    const staleDeleteTarget = await signup(`staledel29_${stamp}@t.local`);
    const staleDelete = await req(`/api/footfive/admin/users/${staleDeleteTarget.id}`, {
      method: "DELETE",
      token: staleAdmin.token,
      body: { reason: "stale" },
    });
    expectCase(
      "control: disabled actor delete is denied by the account guard and keeps the target",
      staleDelete.status === 403 && says(staleDelete.data, "Account disabled") && !!userById(staleDeleteTarget.id),
      staleDelete.status + " " + msg(staleDelete.data),
    );

    const selfOff = await login((await signup(`selfoff29_${stamp}@t.local`, "adminpass99")).email, "adminpass99");
    promote(selfOff.email);
    const selfDisable = await login(selfOff.email, "adminpass99");
    const selfDisableRes = await req(`/api/footfive/admin/users/${selfDisable.id}/disable`, {
      method: "POST",
      token: selfDisable.token,
      body: { reason: "self" },
    });
    expectCase(
      "new: self-disable rejects and leaves the admin enabled",
      selfDisableRes.status === 400 &&
        says(selfDisableRes.data, "You cannot disable your own account") &&
        userById(selfDisable.id).disabled === 0,
      selfDisableRes.status + " " + msg(selfDisableRes.data) + " disabled=" + userById(selfDisable.id)?.disabled,
    );

    const selfDelSignup = await login((await signup(`selfdel29_${stamp}@t.local`, "adminpass99")).email, "adminpass99");
    promote(selfDelSignup.email);
    const selfDelete = await login(selfDelSignup.email, "adminpass99");
    const selfDeleteRes = await req(`/api/footfive/admin/users/${selfDelete.id}`, {
      method: "DELETE",
      token: selfDelete.token,
      body: { reason: "self" },
    });
    expectCase(
      "new: self-delete rejects and leaves the admin",
      selfDeleteRes.status === 400 &&
        says(selfDeleteRes.data, "You cannot delete your own account") &&
        !!userById(selfDelete.id),
      selfDeleteRes.status + " " + msg(selfDeleteRes.data),
    );

    async function extraAdmin(label) {
      const email = `${label}29_${stamp}@t.local`;
      await signup(email, "adminpass99");
      promote(email);
      return login(email, "adminpass99");
    }
    const pairA = await extraAdmin("paira");
    const pairB = await extraAdmin("pairb");
    const [pairResA, pairResB] = await Promise.all([
      req(`/api/footfive/admin/users/${pairB.id}/disable`, { method: "POST", token: pairA.token, body: { reason: "pair" } }),
      req(`/api/footfive/admin/users/${pairA.id}/disable`, { method: "POST", token: pairB.token, body: { reason: "pair" } }),
    ]);
    const pairLeft = withDb((db) =>
      db.prepare("select count(*) c from users where id in (?, ?) and role='admin' and disabled=0").get(pairA.id, pairB.id).c,
    );
    expectCase(
      "new: concurrent mutual disable leaves one of the pair enabled",
      pairLeft >= 1,
      JSON.stringify({ left: pairLeft, a: pairResA.status, b: pairResB.status, ma: msg(pairResA.data), mb: msg(pairResB.data) }),
    );

    const auditor = await extraAdmin("audit");
    const audited = await createUser(auditor.token, {
      email: `audited29_${stamp}@t.local`,
      password: "testpass99",
      display_name: "Audited",
      reason: "audit-ref",
    });
    const auditDelete = await req(`/api/footfive/admin/users/${auditor.id}`, {
      method: "DELETE",
      token: admin.token,
      body: { reason: "history" },
    });
    expectCase(
      "new: audit history blocks delete with the friendly message",
      audited.ok && auditDelete.status === 400 && says(auditDelete.data, HISTORY) && !!userById(auditor.id),
      auditDelete.status + " " + msg(auditDelete.data),
    );

    const coach = await signup(`coach29_${stamp}@t.local`);
    const fixture = withDb((db) => db.prepare("select id from shared_fixtures limit 1").get());
    if (!fixture) throw new Error("world created no fixture");
    withDb((db) => {
      const cols = db.prepare("pragma table_info(coaching_commands)").all().map((row) => row.name);
      const values = {
        id: "coachcmd0000001",
        fixture: fixture.id,
        team: free[0],
        user: coach.id,
        stance: "balanced",
        created: "2026-10-19 00:00:00.000Z",
        effective_from_minute: 0,
        segment_index: 0,
      };
      const present = cols.filter((name) => Object.prototype.hasOwnProperty.call(values, name));
      db.prepare(
        `insert into coaching_commands (${present.map((name) => `"${name}"`).join(",")}) values (${present.map(() => "?").join(",")})`,
      ).run(...present.map((name) => values[name]));
    });
    const coachDelete = await req(`/api/footfive/admin/users/${coach.id}`, {
      method: "DELETE",
      token: admin.token,
      body: { reason: "history" },
    });
    expectCase(
      "new: coaching history blocks delete with the friendly message",
      coachDelete.status === 400 && says(coachDelete.data, HISTORY) && !!userById(coach.id),
      coachDelete.status + " " + msg(coachDelete.data),
    );

    const modeUser = await signup(`mode29_${stamp}@t.local`);
    const takenUser = await signup(`taken29_${stamp}@t.local`);
    const releaseUser = await signup(`release29_${stamp}@t.local`);
    const missingUser = await signup(`missing29_${stamp}@t.local`);
    const disabledUser = await signup(`disabled29_${stamp}@t.local`);
    withDb((db) => db.prepare("update users set disabled=1 where id=?").run(disabledUser.id));
    const late = await signup("late-delete@t.local");
    const teams = freeTeamIds();
    const modeTeam = teams[0];
    const alreadyTeam = teams[1];
    const releaseTeam = teams[2];
    const missingTeam = teams[3];
    const unknownTeam = teams[4];
    const disabledTeam = teams[5];
    const lateTeam = teams[6];
    const claimTeam = teams[7];

    const modeAssign = await req(`/api/footfive/admin/teams/${modeTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: modeUser.id, reason: "mode" },
    });
    const modeRow = teamById(modeTeam);
    expectCase(
      "new: first assignment sets manual mode",
      modeAssign.ok && modeRow.manager === modeUser.id && modeRow.mode === "manual",
      JSON.stringify({ status: modeAssign.status, message: msg(modeAssign.data), row: modeRow }),
    );
    withDb((db) => db.prepare("update proball_teams set manager_mode='ai' where id=?").run(modeTeam));
    const modeAgain = await req(`/api/footfive/admin/teams/${modeTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: modeUser.id, reason: "mode-again" },
    });
    const modeKept = teamById(modeTeam);
    expectCase(
      "control: same-user reassign keeps ai mode",
      modeAgain.ok && modeKept.manager === modeUser.id && modeKept.mode === "ai",
      JSON.stringify({ status: modeAgain.status, message: msg(modeAgain.data), row: modeKept }),
    );

    const taken = await req(`/api/footfive/admin/teams/${modeTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: takenUser.id, reason: "taken" },
    });
    expectCase(
      "control: taken team rejects",
      taken.status === 400 && says(taken.data, "Team already has a manager — release first") && teamById(modeTeam).manager === modeUser.id,
      taken.status + " " + msg(taken.data),
    );
    const already = await req(`/api/footfive/admin/teams/${alreadyTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: modeUser.id, reason: "already" },
    });
    expectCase(
      "control: user who already manages a team rejects",
      already.status === 400 && says(already.data, "User already manages a team") && teamById(alreadyTeam).manager === "",
      already.status + " " + msg(already.data),
    );

    const releaseAssign = await req(`/api/footfive/admin/teams/${releaseTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: releaseUser.id, reason: "assign" },
    });
    const released = await req(`/api/footfive/admin/teams/${releaseTeam}/release`, {
      method: "POST",
      token: admin.token,
      body: { reason: "release" },
    });
    const releaseMeta = latestAudit("team_release", releaseTeam);
    expectCase(
      "control: explicit release clears the manager and writes team_release",
      releaseAssign.ok &&
        released.ok &&
        teamById(releaseTeam).manager === "" &&
        releaseMeta &&
        releaseMeta.after &&
        releaseMeta.after.manager === null,
      JSON.stringify({ assign: releaseAssign.status, release: released.status, meta: releaseMeta, manager: teamById(releaseTeam).manager }),
    );

    const missingAssign = await req(`/api/footfive/admin/teams/${missingTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: missingUser.id, reason: "hold" },
    });
    const missingEmpty = await req(`/api/footfive/admin/teams/${missingTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: {},
    });
    const missingBlank = await req(`/api/footfive/admin/teams/${missingTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: "" },
    });
    expectCase(
      "new: missing and empty assign userId does not release the team",
      missingAssign.ok &&
        missingEmpty.status === 400 &&
        says(missingEmpty.data, "User ID required") &&
        missingBlank.status === 400 &&
        says(missingBlank.data, "User ID required") &&
        teamById(missingTeam).manager === missingUser.id,
      JSON.stringify({
        assign: missingAssign.status,
        empty: missingEmpty.status + " " + msg(missingEmpty.data),
        blank: missingBlank.status + " " + msg(missingBlank.data),
        manager: teamById(missingTeam).manager,
      }),
    );

    const unknownAssign = await req(`/api/footfive/admin/teams/${unknownTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: "zzzunknownuser1" },
    });
    expectCase(
      "new: unknown assign target rejects and leaves the manager empty",
      unknownAssign.status === 400 && says(unknownAssign.data, "User not found") && teamById(unknownTeam).manager === "",
      unknownAssign.status + " " + msg(unknownAssign.data) + " manager=" + teamById(unknownTeam).manager,
    );
    const disabledAssign = await req(`/api/footfive/admin/teams/${disabledTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: disabledUser.id },
    });
    expectCase(
      "new: disabled assign target rejects",
      disabledAssign.status === 400 &&
        says(disabledAssign.data, "Cannot assign a disabled user") &&
        teamById(disabledTeam).manager === "",
      disabledAssign.status + " " + msg(disabledAssign.data) + " manager=" + teamById(disabledTeam).manager,
    );

    const lateAssign = await req(`/api/footfive/admin/teams/${lateTeam}/assign`, {
      method: "POST",
      token: admin.token,
      body: { userId: late.id, reason: "late" },
    });
    const lateDelete = await req(`/api/footfive/admin/users/${late.id}`, {
      method: "DELETE",
      token: admin.token,
      body: { reason: "late" },
    });
    expectCase(
      "new: late delete failure keeps the user and the team manager",
      lateAssign.ok &&
        lateDelete.status === 400 &&
        says(lateDelete.data, "Could not delete user") &&
        !!userById(late.id) &&
        teamById(lateTeam).manager === late.id,
      JSON.stringify({
        assign: lateAssign.status,
        del: lateDelete.status,
        message: msg(lateDelete.data),
        user: !!userById(late.id),
        manager: teamById(lateTeam)?.manager,
      }),
    );

    const claim = await req(`/api/footfive/teams/${claimTeam}/claim`, { method: "POST", token: plain.token });
    const claimMeta = latestAudit("team_claim", claimTeam);
    expectCase(
      "new: claim audit records before, after, reason, and success",
      claim.ok &&
        claimMeta &&
        claimMeta.before &&
        claimMeta.before.manager === null &&
        claimMeta.after &&
        claimMeta.after.manager === plain.id &&
        claimMeta.reason === "claim" &&
        claimMeta.success === true,
      JSON.stringify({ status: claim.status, message: msg(claim.data), meta: claimMeta }),
    );

    await stop();
    const template = userByEmail(adminEmail);
    withDb((db) => {
      const cols = db.prepare("pragma table_info(users)").all().map((row) => row.name);
      const source = db.prepare("select * from users where id=?").get(template.id);
      const insert = db.prepare(
        `insert into users (${cols.map((name) => `"${name}"`).join(",")}) values (${cols.map(() => "?").join(",")})`,
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < 501; i++) {
          const row = {};
          for (const name of cols) row[name] = source[name];
          row.id = "b" + String(i).padStart(14, "0");
          row.email = `bulk${i}@t.local`;
          row.username = "";
          row.tokenKey = randomBytes(25).toString("hex");
          row.display_name = `Bulk ${i}`;
          row.role = "user";
          row.disabled = 0;
          row.created = "2099-01-01 00:00:00.000Z";
          if (Object.prototype.hasOwnProperty.call(row, "updated")) row.updated = row.created;
          insert.run(...cols.map((name) => row[name]));
        }
        const teamCols = db.prepare("pragma table_info(proball_teams)").all().map((row) => row.name);
        const teamSource = db.prepare("select * from proball_teams limit 1").get();
        const teamRow = {};
        for (const name of teamCols) teamRow[name] = teamSource[name];
        teamRow.id = "extrateam000001";
        teamRow.slug = "extra-unmanaged-29";
        teamRow.name = "Extra Unmanaged";
        teamRow.abbreviation = "X29";
        teamRow.manager = "";
        if (Object.prototype.hasOwnProperty.call(teamRow, "manager_mode")) teamRow.manager_mode = "";
        db.prepare(
          `insert into proball_teams (${teamCols.map((name) => `"${name}"`).join(",")}) values (${teamCols.map(() => "?").join(",")})`,
        ).run(...teamCols.map((name) => teamRow[name]));
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already closed by the original error */
        }
        throw err;
      }
    });
    await start(hooksDir);

    const truth = overviewTruth();
    const overview = await req("/api/footfive/admin/overview", { token: admin.token });
    expectCase(
      "new: overview counts match the database past the old caps",
      overview.ok &&
        truth.users > 500 &&
        truth.teams >= 17 &&
        overview.data.users === truth.users &&
        overview.data.availableTeams === truth.available &&
        overview.data.managedTeams === truth.managed &&
        overview.data.spectators === truth.spectators,
      JSON.stringify({
        status: overview.status,
        got: overview.data && {
          users: overview.data.users,
          availableTeams: overview.data.availableTeams,
          managedTeams: overview.data.managedTeams,
          spectators: overview.data.spectators,
        },
        truth,
      }),
    );

    const collected = [];
    const seen = new Set();
    let duplicate = "";
    let page = 1;
    let last = null;
    let stuck = false;
    for (; page <= 6; page++) {
      last = await req(usersQuery({ q: "", page: String(page), perPage: "200" }), { token: admin.token });
      const ids = listed(last.data).map((row) => row.id);
      for (const id of ids) {
        if (seen.has(id)) duplicate = id;
        seen.add(id);
        collected.push(id);
      }
      if (last.data.hasMore !== true) break;
      if (page === 6) stuck = true;
    }
    const expectedIds = orderedUserIds();
    const page1 = await req(usersQuery({ q: "", page: "1", perPage: "200" }), { token: admin.token });
    expectCase(
      "new: tied-created pages are stable, bounded, and duplicate-free",
      !duplicate &&
        !stuck &&
        page1.data.hasMore === true &&
        listed(page1.data).length === 200 &&
        last &&
        last.data.hasMore === false &&
        JSON.stringify(collected) === JSON.stringify(expectedIds),
      JSON.stringify({
        duplicate,
        stuck,
        hasMore: page1.data.hasMore,
        len: listed(page1.data).length,
        collected: collected.length,
        expected: expectedIds.length,
        lastHasMore: last && last.data.hasMore,
      }),
    );
  } catch (err) {
    expectCase("suite: aborted", false, (err && err.stack) || String(err));
  } finally {
    await stop();
    evidence.finished = new Date().toISOString();
    evidence.passed = cases.filter((item) => item.ok).length;
    evidence.failed = cases.filter((item) => !item.ok).length;
    writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  }
  const passed = cases.filter((item) => item.ok).length;
  const failed = cases.length - passed;
  const controls = cases.filter((item) => item.name.startsWith("control:"));
  const newer = cases.filter((item) => item.name.startsWith("new:"));
  console.log(
    `admin-mutations ${PHASE}: ${passed} passed, ${failed} failed ` +
      `(controls ${controls.filter((item) => item.ok).length}/${controls.length}, ` +
      `new ${newer.filter((item) => item.ok).length}/${newer.length}) evidence ${EVIDENCE}`,
  );
  process.exit(failed ? 1 : 0);
}

run();
