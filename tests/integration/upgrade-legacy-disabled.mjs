/**
 * Existing-data upgrade regression (issue #14 fix wave, review F3).
 *
 * Reproduces the real upgrade path WITHOUT a data reset:
 *   1. start PocketBase with the BASE (pre-fix) hooks/migrations on a fresh DB
 *   2. create users, log them in, disable them via the base admin route
 *   3. stop, then start the CURRENT hooks/migrations against the same DB
 *   4. the legacy disabled tokens must be dead everywhere — including /me and
 *      change-password — and re-enable must not resurrect them.
 *   5. F6: the same upgrade with 501 legacy-disabled records must rotate ALL
 *      of them (no 500-row truncation) and preserve all other data.
 *
 * Standalone:  node tests/integration/upgrade-legacy-disabled.mjs
 * Env: UPGRADE_PB_PORT (default 8293), UPGRADE_BASE (git ref, default
 *      DEFAULT_BASE below).
 * Own PB instance, own scratch DB; no other service is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = process.env.UPGRADE_PB_PORT || "8293";
const URL = `http://127.0.0.1:${PORT}`;
// Pinned legacy base: the last main commit WITHOUT the account-security
// changes (original PR base). origin/main is unusable as a default: it gains
// the fix once merged, and CI's shallow checkout has no local origin/main.
const DEFAULT_BASE = "b3e6bffdc594fb7ea15d44e474c740dc67dfdd44";
const BASE = process.env.UPGRADE_BASE || DEFAULT_BASE;

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗", name, detail);
  }
}

async function req(p, method = "GET", token, body) {
  const res = await fetch(`${URL}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, ok: res.ok, data };
}
const login = (email, password = "testpass99") =>
  req("/api/collections/users/auth-with-password", "POST", null, { identity: email, password });
const create = (email) =>
  req("/api/collections/users/records", "POST", null, {
    email,
    password: "testpass99",
    passwordConfirm: "testpass99",
  });

let child = null;
async function start(baseDir, dataDir) {
  child = spawn(PB_BIN, [
    "serve",
    `--http=127.0.0.1:${PORT}`,
    `--dir=${dataDir}`,
    `--hooksDir=${baseDir}/pb_hooks`,
    `--migrationsDir=${baseDir}/pb_migrations`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`PB exited early (${child.exitCode})`);
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("PB readiness timeout");
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = null;
}
function sql(db, query) {
  const r = spawnSync(
    "python3",
    ["-c", `import sqlite3; c=sqlite3.connect(${JSON.stringify(db)}); ${query}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status) throw new Error(r.stderr);
  return r.stdout.trim();
}

// Full-table preservation snapshot/compare (excludes sqlite_% ANALYZE stats
// and PB system tables; users compared without tokenKey/updated — those two
// are the intentional upgrade changes). Every original column, value and row is
// compared by column name; the only column a later migration may add is listed
// in ADDED with the value every pre-existing row must read.
const PRESERV_PY = `
import sqlite3, json, sys
db, mode, snap = sys.argv[1], sys.argv[2], sys.argv[3]
c = sqlite3.connect(db)
ADDED = {'proball_teams': {'overclock_cost_pending': 0}}  # 1750000019: existing rows default false
tables = [x[0] for x in c.execute("select name from sqlite_master where type='table' and name not like '\\\\_%' escape '\\\\' and name not like 'sqlite_%' and name != 'users'")]
def cols(t):
    return [x[1] for x in c.execute('pragma table_info("' + t + '")')]
def dump(t, names):
    return sorted((list(r) for r in c.execute('select ' + ','.join('"'+n+'"' for n in names) + ' from "' + t + '"').fetchall()), key=repr)
ucols = [x[1] for x in c.execute('pragma table_info(users)') if x[1] not in ('tokenKey', 'updated')]
users = sorted((list(r) for r in c.execute('select ' + ','.join('"'+n+'"' for n in ucols) + ' from users').fetchall()), key=repr)
if mode == 'snapshot':
    json.dump({'tables': {t: {'columns': cols(t), 'rows': dump(t, cols(t))} for t in tables}, 'users': users}, open(snap, 'w'))
    print('SNAPSHOT_OK tables=' + str(len(tables)))
else:
    base = json.load(open(snap))
    changed, column_changes, bad_added = [], [], []
    for t, b in base['tables'].items():
        now = cols(t)
        missing = [n for n in b['columns'] if n not in now]
        added = [n for n in now if n not in b['columns']]
        if missing or sorted(added) != sorted(ADDED.get(t, {})):
            column_changes.append({'table': t, 'missing': missing, 'added': added})
        if missing or b['rows'] != dump(t, b['columns']):
            changed.append(t)
        for n, v in ADDED.get(t, {}).items():
            if n in added and any(r[0] != v for r in c.execute('select "' + n + '" from "' + t + '"')):
                bad_added.append(t + '.' + n)
    print(json.dumps({'changed_tables': changed, 'column_changes': column_changes, 'bad_added_values': bad_added, 'users_changed': base['users'] != users, 'quick_check': c.execute('pragma quick_check').fetchone()[0]}))
`;

// Disposable copies only: unschedule this app's background jobs (the minute catch-up
// writes world bookkeeping even while paused) and expose the live scheduler's job ids.
// Hook files load in no fixed order, so the removal runs once every file has loaded.
const ISOLATION_HOOK = `
onBootstrap(function (e) {
  e.next();
  e.app.cron().remove("footfive_catchup");
  e.app.cron().remove("footfive_retention_daily");
});
routerAdd("GET", "/api/upgrade-test/cron-jobs", function (e) {
  return e.json(200, $app.cron().jobs().map(function (j) { return j.id(); }));
});
`;

// 499 offline fixtures copied from a valid base-created record (unique
// IDs/emails/tokenKeys), initially enabled; the suite disables them before
// the upgrade so they stand in for persisted base-era disabled rows.
const BULK_INSERT_PY = (templateId) => `
import secrets
names=[r[1] for r in c.execute('pragma table_info(users)')]
t=dict(zip(names,c.execute('select * from users where id=?',('${templateId}',)).fetchone()))
for i in range(499):
 row=dict(t);row['id']='bulk'+str(i).zfill(11);row['email']='bulk%d@t.local'%i;row['username']='';row['tokenKey']=secrets.token_hex(25);row['disabled']=0
 c.execute('insert into users ('+','.join('"'+n+'"' for n in names)+') values ('+','.join('?' for _ in names)+')',[row[n] for n in names])
c.commit()
print('BULK_OK')
`;

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "footfive-upgrade-"));
  const dataDir = path.join(work, "pb_data");
  const baseDir = path.join(work, "base");
  const currentDir = path.join(work, "current");
  mkdirSync(dataDir, { recursive: true });
  try {
    // Extract the exact base hooks/migrations (no working-tree mutation).
    // Shallow CI checkouts (actions/checkout fetch-depth 1) do not contain the
    // pinned base commit; fetch it by SHA on demand (GitHub serves reachable
    // commits by SHA).
    const resolves = () =>
      spawnSync("git", ["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`], { cwd: ROOT }).status === 0;
    if (!resolves()) {
      const fetch = spawnSync("git", ["fetch", "--depth", "1", "origin", BASE], { cwd: ROOT, encoding: "utf8" });
      if (fetch.status !== 0 || !resolves()) {
        throw new Error(`cannot resolve upgrade base ${BASE}: ${(fetch.stderr || "").trim()}`);
      }
    }
    const files = spawnSync(
      "git",
      ["ls-tree", "-r", "--name-only", BASE, "pocketbase/pb_hooks", "pocketbase/pb_migrations"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (files.status) throw new Error(`git ls-tree failed: ${files.stderr}`);
    const relFiles = files.stdout.trim().split("\n").filter(Boolean);
    if (!relFiles.length) throw new Error(`git ls-tree returned no files for base ${BASE}`);
    for (const f of relFiles) {
      const dest = path.join(baseDir, path.relative("pocketbase", f));
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, spawnSync("git", ["show", `${BASE}:${f}`], { cwd: ROOT }).stdout);
    }
    for (const sub of ["pb_hooks", "pb_migrations"]) cpSync(path.join(ROOT, "pocketbase", sub), path.join(currentDir, sub), { recursive: true });
    for (const dir of [baseDir, currentDir]) writeFileSync(path.join(dir, "pb_hooks", "zz_upgrade_test_isolation.pb.js"), ISOLATION_HOOK);

    console.log(`Upgrade regression: base=${BASE} -> working tree, db=${dataDir}`);
    const stamp = Date.now();
    const adminEmail = `up_admin_${stamp}@t.local`;
    const legacy1 = `up_legacy1_${stamp}@t.local`;
    const legacy2 = `up_legacy2_${stamp}@t.local`;

    // --- Base implementation era ---
    await start(baseDir, dataDir);
    await create(adminEmail);
    sql(path.join(dataDir, "data.db"), `c.execute("UPDATE users SET role='admin' WHERE email='${adminEmail}'"); c.commit()`);
    const admin0 = await login(adminEmail);
    ok("base: admin login", admin0.ok, `status=${admin0.status}`);
    await create(legacy1);
    const l1 = await login(legacy1);
    ok("base: legacy1 login", l1.ok, `status=${l1.status}`);
    const dis1 = await req(`/api/footfive/admin/users/${l1.data.record.id}/disable`, "POST", admin0.data.token, { reason: "upgrade regression" });
    ok("base: legacy1 disabled", dis1.ok, `status=${dis1.status}`);
    await create(legacy2);
    const l2 = await login(legacy2);
    const dis2 = await req(`/api/footfive/admin/users/${l2.data.record.id}/disable`, "POST", admin0.data.token, { reason: "upgrade resurrection" });
    ok("base: legacy2 disabled", dis2.ok, `status=${dis2.status}`);
    const tok1 = l1.data.token;
    const tok2 = l2.data.token;
    const id1 = l1.data.record.id;
    await stop();

    // --- F6 staging: 501 legacy-disabled records (no 500-row page) ---
    const DB = path.join(dataDir, "data.db");
    sql(DB, BULK_INSERT_PY(id1));
    await start(baseDir, dataDir);
    const lB = await login("bulk498@t.local");
    ok("base: 501st fixture base login", lB.ok, `status=${lB.status}`);
    const tokB = lB.data.token;
    const idB = lB.data.record.id;
    const worldB = await req("/api/footfive/world", "GET", tokB);
    ok("base: 501st base token valid pre-upgrade (control)", worldB.ok, `status=${worldB.status}`);
    const disB = await req(`/api/footfive/admin/users/${idB}/disable`, "POST", admin0.data.token, { reason: "upgrade 501st legacy" });
    ok("base: 501st disabled via base admin route", disB.ok, `status=${disB.status}`);
    await stop();
    // The remaining bulk fixtures stand in for persisted base-era disabled rows.
    sql(DB, `c.execute("update users set disabled=1 where email like 'bulk%@t.local'"); c.commit()`);
    // Pause this disposable world before the baseline: an unpaused tick (request-driven
    // or the minute cron) claims the world lease and rewrites world.processing_version,
    // so the full comparison below would depend on timing. Every column stays compared.
    const paused = sql(DB, `cur = c.execute("update world set progression_paused = 1 where key = 'main'"); c.commit(); print(cur.rowcount)`);
    ok("base: disposable world paused before the preservation baseline", paused === "1", `rows=${paused}`);
    const beforeKeys = JSON.parse(
      sql(DB, `import json; print(json.dumps(dict(c.execute("select id, tokenKey from users where disabled=1").fetchall())))`),
    );
    ok("base: 501 legacy-disabled records staged", Object.keys(beforeKeys).length === 501, `count=${Object.keys(beforeKeys).length}`);
    const preservPy = path.join(work, "preserv.py");
    const snapFile = path.join(work, "preservation-baseline.json");
    writeFileSync(preservPy, PRESERV_PY);
    const snapRun = spawnSync("python3", [preservPy, DB, "snapshot", snapFile], { encoding: "utf8" });
    if (snapRun.status) throw new Error(`preservation snapshot failed: ${snapRun.stderr}`);

    // --- Upgrade: current hooks/migrations, SAME database ---
    await start(currentDir, dataDir);
    const jobs = await req("/api/upgrade-test/cron-jobs");
    ok(
      "upgrade: app background jobs unscheduled, PocketBase system jobs kept",
      jobs.ok && jobs.data.includes("__pbDBOptimize__") && !jobs.data.some((id) => id.startsWith("footfive_")),
      JSON.stringify(jobs.data),
    );
    const mig = sql(DB, "print(','.join(r[0] for r in c.execute('SELECT file FROM _migrations')))");
    ok("upgrade: account-security migration applied", mig.includes("1750000016_account_security_rules.js"), mig.slice(-120));

    // F6: EVERY legacy disabled tokenKey must be rotated — a truncated page
    // leaves escaped tokens that re-enable would resurrect.
    const afterKeys = JSON.parse(
      sql(DB, `import json; print(json.dumps(dict(c.execute("select id, tokenKey from users where disabled=1").fetchall())))`),
    );
    const unrotated = Object.keys(beforeKeys).filter((id) => afterKeys[id] === beforeKeys[id]);
    ok(
      "upgrade: ALL 501 legacy disabled tokenKeys rotated (F6)",
      Object.keys(afterKeys).length === 501 && unrotated.length === 0,
      `before=${Object.keys(beforeKeys).length} after=${Object.keys(afterKeys).length} unrotated=${unrotated.length}${unrotated.length ? " ids=" + unrotated.slice(0, 3).join(",") : ""}`,
    );
    // The 501st record's REAL base-issued token must be dead everywhere.
    for (const [p, m, b] of [
      [`/api/collections/users/records/${idB}`, "GET", undefined],
      ["/api/footfive/me", "GET", undefined],
      ["/api/footfive/account/change-password", "POST", { currentPassword: "testpass99", newPassword: "otherpass99" }],
      ["/api/collections/users/auth-refresh", "POST", undefined],
      ["/api/footfive/world", "GET", undefined],
    ]) {
      const r = await req(p, m, tokB, b);
      ok(`upgrade: 501st base token rejected on ${p} (F6)`, [400, 401, 403, 404].includes(r.status), `status=${r.status}`);
    }
    const listB = await req("/api/collections/users/records?perPage=5", "GET", tokB);
    ok("upgrade: 501st base token sees no native users rows (F6)", listB.status >= 400 || (listB.data.items || []).length === 0, `status=${listB.status}`);

    // Full-table preservation across the real upgrade (ANALYZE sqlite_stat*
    // excluded; users compared without the intentionally changed columns). A designed
    // tick runs first, so an unpaused world fails here every time, not only when a
    // scheduled tick happens to land in this window.
    const designedTick = await req("/api/footfive/health");
    ok("upgrade: designed tick ran before the preservation check", designedTick.ok, `status=${designedTick.status}`);
    const preservRun = spawnSync("python3", [preservPy, DB, "check", snapFile], { encoding: "utf8" });
    if (preservRun.status) throw new Error(`preservation check failed: ${preservRun.stderr}`);
    const preservRes = JSON.parse(preservRun.stdout.trim());
    ok("upgrade: business tables preserved (F6)", preservRes.changed_tables.length === 0, JSON.stringify(preservRes.changed_tables));
    ok(
      "upgrade: only proball_teams.overclock_cost_pending added, false on every existing team (F6)",
      preservRes.column_changes.length === 0 && preservRes.bad_added_values.length === 0,
      JSON.stringify({ columns: preservRes.column_changes, values: preservRes.bad_added_values }),
    );
    ok("upgrade: users preserved except tokenKey/updated (F6)", !preservRes.users_changed);
    ok("upgrade: sqlite quick_check ok (F6)", preservRes.quick_check === "ok", preservRes.quick_check);

    const selfGet = await req(`/api/collections/users/records/${id1}`, "GET", tok1);
    ok("upgrade: legacy token rejected on native self GET", [401, 403, 404].includes(selfGet.status), `status=${selfGet.status}`);
    const me = await req("/api/footfive/me", "GET", tok1);
    ok("upgrade: legacy token rejected on /me", [401, 403].includes(me.status), `status=${me.status}`);
    const cp = await req("/api/footfive/account/change-password", "POST", tok1, {
      currentPassword: "testpass99",
      newPassword: "legacynew99",
    });
    ok("upgrade: legacy token rejected on change-password", [401, 403].includes(cp.status), `status=${cp.status}`);
    const world = await req("/api/footfive/world", "GET", tok1);
    ok("upgrade: legacy token rejected on /world", [401, 403].includes(world.status), `status=${world.status}`);
    const teams = await req("/api/collections/proball_teams/records?perPage=5", "GET", tok1);
    const leak = teams.ok && Array.isArray(teams.data.items) && teams.data.items.length > 0;
    ok("upgrade: legacy token sees no native teams data", !leak, `status=${teams.status}`);
    const fresh = await login(legacy1);
    ok("upgrade: disabled fresh login rejected", !fresh.ok, `status=${fresh.status}`);

    // Business data preserved: same IDs, same rows, world intact.
    const row = sql(path.join(dataDir, "data.db"), `print(c.execute("SELECT id, disabled FROM users WHERE email='${legacy1}'").fetchone())`);
    ok("upgrade: legacy record preserved (id + disabled flag)", row.includes(id1) && row.includes("1"), row);
    const health = await req("/api/footfive/health");
    ok("upgrade: world healthy after migration", health.ok, `status=${health.status}`);

    // No resurrection on re-enable, even for legacy-disabled records (repeat
    // disable is a no-op transition and must not be required for revocation).
    const admin = await login(adminEmail);
    ok("upgrade: admin still works", admin.ok, `status=${admin.status}`);
    const at = admin.data.token;
    const redis = await req(`/api/footfive/admin/users/${l2.data.record.id}/disable`, "POST", at, { reason: "retry disable" });
    ok("upgrade: repeat disable no-op OK", redis.ok, `status=${redis.status}`);
    const enable = await req(`/api/footfive/admin/users/${l2.data.record.id}/enable`, "POST", at, { reason: "resurrection check" });
    ok("upgrade: enable OK", enable.ok, `status=${enable.status}`);
    const resurrect = await req("/api/footfive/world", "GET", tok2);
    ok("upgrade: pre-disable token NOT resurrected after enable", [401, 403].includes(resurrect.status), `status=${resurrect.status}`);
    const reEnabled = await login(legacy2);
    ok("upgrade: re-enabled user can log in fresh", reEnabled.ok, `status=${reEnabled.status}`);

    // F6: the 501st legacy record must not be revivable either — repeat
    // disable is a no-op transition and must not repair a skipped rotation.
    const redisB = await req(`/api/footfive/admin/users/${idB}/disable`, "POST", at, { reason: "retry disable 501st" });
    ok("upgrade: 501st repeat disable no-op OK (F6)", redisB.ok, `status=${redisB.status}`);
    const enableB = await req(`/api/footfive/admin/users/${idB}/enable`, "POST", at, { reason: "501st resurrection check" });
    ok("upgrade: 501st enable OK (F6)", enableB.ok, `status=${enableB.status}`);
    const resurrectB = await req("/api/footfive/world", "GET", tokB);
    ok("upgrade: 501st base token NOT resurrected after enable (F6)", resurrectB.status === 401, `status=${resurrectB.status}`);

    // --- F7: native users session discovery requires disabled=false ---
    // A disabled record whose token escaped revocation (field flipped offline,
    // no rotation — the exact F6 escape shape, defense-in-depth control) must
    // not keep native self-discovery; forced-password discovery must remain.
    const escEmail = `up_escape_${stamp}@t.local`;
    await create(escEmail);
    const esc = await login(escEmail);
    ok("F7: escape fixture login", esc.ok, `status=${esc.status}`);
    const tokE = esc.data.token;
    const idE = esc.data.record.id;
    sql(DB, `c.execute("update users set disabled=1 where id='${idE}'"); c.commit()`);
    const escGet = await req(`/api/collections/users/records/${idE}`, "GET", tokE);
    ok("F7: escaped disabled token rejected on native self GET", [401, 403, 404].includes(escGet.status), `status=${escGet.status}`);
    const escList = await req("/api/collections/users/records?perPage=5", "GET", tokE);
    ok("F7: escaped disabled token sees no native users rows", escList.status >= 400 || (escList.data.items || []).length === 0, `status=${escList.status}`);

    const fpEmail = `up_forced_${stamp}@t.local`;
    const fpCreate = await req("/api/footfive/admin/users", "POST", at, { email: fpEmail, password: "temppass99", display_name: "UpForced", reason: "F7 discovery control" });
    ok("F7: forced fixture created", fpCreate.ok, `status=${fpCreate.status}`);
    const fpReset = await req(`/api/footfive/admin/users/${fpCreate.data.id}/password`, "POST", at, { password: "temppass99", mustChange: true, reason: "F7 control" });
    ok("F7: forced reset applied", fpReset.ok, `status=${fpReset.status}`);
    const fpLogin = await login(fpEmail, "temppass99");
    ok("F7: forced login", fpLogin.ok, `status=${fpLogin.status}`);
    const fpGet = await req(`/api/collections/users/records/${fpLogin.data.record.id}`, "GET", fpLogin.data.token);
    ok("F7: forced-password native self GET still works (session discovery)", fpGet.ok, `status=${fpGet.status}`);
    const fpMe = await req("/api/footfive/me", "GET", fpLogin.data.token);
    ok("F7: forced /me session discovery still works", fpMe.ok && fpMe.data.must_change_password === true, `status=${fpMe.status}`);

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
