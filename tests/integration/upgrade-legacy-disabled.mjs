/**
 * Existing-data upgrade regression (issue #14 fix wave, review F3).
 *
 * Reproduces the real upgrade path WITHOUT a data reset:
 *   1. start PocketBase with the BASE (pre-fix) hooks/migrations on a fresh DB
 *   2. create users, log them in, disable them via the base admin route
 *   3. stop, then start the CURRENT hooks/migrations against the same DB
 *   4. the legacy disabled tokens must be dead everywhere — including /me and
 *      change-password — and re-enable must not resurrect them.
 *
 * Standalone:  node tests/integration/upgrade-legacy-disabled.mjs
 * Env: UPGRADE_PB_PORT (default 8293), UPGRADE_BASE (git ref, default origin/main).
 * Own PB instance, own scratch DB; no other service is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = process.env.UPGRADE_PB_PORT || "8293";
const URL = `http://127.0.0.1:${PORT}`;
const BASE = process.env.UPGRADE_BASE || "origin/main";

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
    { encoding: "utf8" },
  );
  if (r.status) throw new Error(r.stderr);
  return r.stdout.trim();
}

async function main() {
  const work = mkdtempSync(path.join(tmpdir(), "footfive-upgrade-"));
  const dataDir = path.join(work, "pb_data");
  const baseDir = path.join(work, "base");
  mkdirSync(dataDir, { recursive: true });
  try {
    // Extract the exact base hooks/migrations (no working-tree mutation).
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

    // --- Upgrade: current hooks/migrations, SAME database ---
    await start(path.join(ROOT, "pocketbase"), dataDir);
    const mig = sql(path.join(dataDir, "data.db"), "print(','.join(r[0] for r in c.execute('SELECT file FROM _migrations')))");
    ok("upgrade: account-security migration applied", mig.includes("1750000016_account_security_rules.js"), mig.slice(-120));

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
