/**
 * World progression lock / read-only GETs regression (issue #17, review B3/B23/O12/D11).
 *
 * Real PocketBase (current hooks + migrations) on a scratch DB, accelerated time.
 * Proves:
 *   1. the world progresses with nobody watching, via cronAdd alone;
 *   2. GET /world, /live (scoreboard), /match/{id}, /markets, /markets/{id} and
 *      /bets/mine never write — a concurrent burst leaves the DB untouched;
 *   3. the world progression lease is single-flight: while another worker holds
 *      it, admin catch-up reports { locked: true } and advances nothing;
 *   4. an expired lease (crashed holder) is reclaimed safely by the next tick;
 *   5. 20 parallel admin catch-ups race for one due kick-off: exactly one wins,
 *      no duplicate tournaments/rounds/match_states;
 *   6. catch-up is admin-only: the old public route is gone, non-admins get 403;
 *   7. stale-lock detection keys off the lease expiry, not `updated`;
 *   8. static guard: liveView/matchView/worldSnapshot never call tick paths.
 *
 * Standalone:  node tests/integration/progression-lock.mjs
 * Env: PROGRESS_PB_PORT (default 8295). Own PB instance and scratch DB only.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = process.env.PROGRESS_PB_PORT || "8295";
const URL = `http://127.0.0.1:${PORT}`;
const SCALE = "160"; // 50 ms match minutes

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(p, method = "GET", token, body) {
  const res = await fetch(`${URL}${p}`, {
    method,
    headers: { ...(token ? { ["Authorization"]: token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
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

// ---- SQLite access (python3 stdlib), JSON in/out — same harness as settlement-recovery
let DB = "";
const PY = `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1], timeout=30, isolation_level=None)
c.row_factory = sqlite3.Row
out = []
stmts = json.loads(sys.stdin.read())
write = any(not s.lstrip().upper().startswith("SELECT") for s, _ in stmts)
if write: c.execute("BEGIN IMMEDIATE")
for stmt, params in stmts:
    cur = c.execute(stmt, params)
    out = [dict(r) for r in cur.fetchall()] if cur.description else out
if write: c.execute("COMMIT")
print(json.dumps(out))
`;
function sqlMany(stmts) {
  const r = spawnSync("python3", ["-c", PY, DB], { input: JSON.stringify(stmts), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status) throw new Error((r.error ? String(r.error) : r.stderr) + ": " + JSON.stringify(stmts).slice(0, 200));
  return JSON.parse(r.stdout);
}
const q = (s, p = []) => sqlMany([[s, p]]);
const one = (s, p = []) => q(s, p)[0] || null;
const num = (s, p = []) => Number(Object.values(one(s, p) || { n: 0 })[0] || 0);

// ---- PocketBase process. External SQL writes only happen with PB stopped
// (SQLite single-writer discipline; PB is the only writer in production).
let child = null;
let DATA_DIR = "";
async function start() {
  child = spawn(PB_BIN, ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA_DIR}`, `--hooksDir=${ROOT}/pocketbase/pb_hooks`, `--migrationsDir=${ROOT}/pocketbase/pb_migrations`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FOOTFIVE_TIME_SCALE: SCALE },
  });
  const sink = process.env.PROGRESS_PB_LOG ? (await import("node:fs")).createWriteStream(process.env.PROGRESS_PB_LOG, { flags: "a" }) : null;
  child.stdout.on("data", (d) => sink && sink.write(d));
  child.stderr.on("data", (d) => sink && sink.write(d));
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`PB exited early (${child.exitCode})`);
    try {
      if ((await fetch(`${URL}/api/health`)).ok) return;
    } catch {
      /* not ready */
    }
    await sleep(100);
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
async function write(stmts) {
  await stop();
  try {
    return sqlMany(stmts);
  } finally {
    await start();
  }
}
async function until(label, fn, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label);
}

async function mkuser(email, password = "testpass99") {
  await req("/api/collections/users/records", "POST", null, { email, password, passwordConfirm: password, display_name: email.split("@")[0] });
  const r = await req("/api/collections/users/auth-with-password", "POST", null, { identity: email, password });
  if (!r.ok) throw new Error("login failed " + email + " " + JSON.stringify(r.data));
  return { token: r.data.token, id: r.data.record.id, email };
}

const worldRow = () => one("SELECT * FROM world WHERE key = 'main'");

// Write-counters across every table a GET could plausibly touch.
function dbFingerprint() {
  const tables = ["world", "proball_teams", "proball_players", "shared_tournaments", "shared_rounds", "shared_fixtures", "match_states", "match_events", "shared_bets", "credit_ledger", "users"];
  const fp = {};
  for (const t of tables) fp[t] = num(`SELECT COUNT(*) n FROM ${t}`);
  fp.worldUpdated = worldRow().updated;
  fp.worldLock = worldRow().processing_status || "";
  return fp;
}

async function main() {
  DATA_DIR = mkdtempSync(path.join(tmpdir(), "ff-progress-"));
  DB = path.join(DATA_DIR, "data.db");
  console.log("progression-lock regression against", URL, "scale", SCALE);

  // (1) Progression without viewers: boot and make NO footfive requests at all;
  // the 1-minute cron must create the world and draw the first championship.
  await start();
  console.log("· waiting for cron-only progression (no requests fired)…");
  await until("cron-created championship", () => num("SELECT COUNT(*) n FROM shared_tournaments") > 0, 90000);
  ok("cron progresses the world with zero viewers", true);
  const wCron = worldRow();
  ok("cron tick released the lease", (wCron.processing_status || "idle") === "idle", wCron.processing_status);

  // Users; promote one to admin with PB stopped.
  const stamp = Date.now();
  const user = await mkuser(`pl_user_${stamp}@t.local`);
  const admin = await mkuser(`pl_admin_${stamp}@t.local`);
  await write([[`UPDATE users SET role = 'admin' WHERE email = ?`, [`pl_admin_${stamp}@t.local`]]]);

  // Drive the world to announced fixtures via the designed-tick endpoint.
  await until("fixtures announced", async () => {
    await req("/api/footfive/health");
    const l = await req("/api/footfive/live", "GET", user.token);
    return l.ok && (l.data.fixtures || []).length > 0;
  });
  const live1 = (await req("/api/footfive/live", "GET", user.token)).data;
  const fxId = live1.fixtures[0].id;

  // (6) catch-up is admin-only.
  const oldRoute = await req("/api/footfive/catch-up", "POST", user.token, {});
  ok("public /catch-up route is gone", oldRoute.status === 404, `status=${oldRoute.status}`);
  const userCu = await req("/api/footfive/admin/world/catch-up", "POST", user.token, {});
  ok("non-admin catch-up rejected", userCu.status === 403, `status=${userCu.status}`);
  const adminCu = await req("/api/footfive/admin/world/catch-up", "POST", admin.token, {});
  ok("admin catch-up allowed", adminCu.status === 200, `status=${adminCu.status} ${JSON.stringify(adminCu.data).slice(0, 120)}`);

  // (3) Held lease blocks progression: simulate a live holder.
  const holdUntil = Date.now() + 120000;
  await write([["UPDATE world SET processing_status = 'processing', processing_version = ? WHERE key = 'main'", [holdUntil]]]);
  const blocked = await req("/api/footfive/admin/world/catch-up", "POST", admin.token, {});
  ok("catch-up under held lease reports locked", blocked.ok && blocked.data.locked === true, JSON.stringify(blocked.data).slice(0, 120));

  // (2) GETs never save. The burst runs UNPAUSED with the lease held: a ticking
  // GET would advance the world and write (the cron can't interfere — it sees
  // the held lease and backs off), so any write is attributable to a GET.
  const before = dbFingerprint();
  const burst = [];
  for (let i = 0; i < 10; i++) {
    burst.push(req("/api/footfive/world", "GET", user.token));
    burst.push(req("/api/footfive/live", "GET", user.token));
    burst.push(req(`/api/footfive/match/${fxId}`, "GET", user.token));
    burst.push(req("/api/footfive/markets", "GET", user.token));
    burst.push(req(`/api/footfive/markets/${fxId}`, "GET", user.token));
    burst.push(req("/api/footfive/bets/mine", "GET", user.token));
  }
  const results = await Promise.all(burst);
  ok("GET burst all answered 200", results.every((r) => r.status === 200), results.filter((r) => r.status !== 200).map((r) => r.status).join(","));
  const after = dbFingerprint();
  ok("GET world/scoreboard/match/betting wrote nothing", JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }).slice(0, 400));

  const lockAfter = worldRow();
  ok("held lease untouched by the blocked tick", lockAfter.processing_status === "processing" && Number(lockAfter.processing_version) === holdUntil, JSON.stringify(lockAfter));
  const liveLocked = await req("/api/footfive/live", "GET", user.token);
  ok("GET /live still 200 while lease held (read-only)", liveLocked.status === 200, `status=${liveLocked.status}`);

  // (7) stale-lock detection keys off the lease expiry: held lock is NOT stale.
  const recStatus = await req("/api/footfive/admin/recovery/status", "GET", admin.token);
  const issues = (recStatus.data && (recStatus.data.worldIssues || (recStatus.data.report || {}).worldIssues)) || [];
  ok("active lease not flagged stale", !issues.some((i) => i.type === "stale_world_lock"), JSON.stringify(issues));

  // (4) Expired lease (crashed holder) is reclaimed safely and progression resumes.
  // If a scheduled round exists, make its kick-off due so the reclaim has visible
  // work; the mandatory property is that an expired lease never blocks the tick.
  const past = new Date(Date.now() - 5000).toISOString().replace("T", " ").replace("Z", "") + "Z";
  const t = one("SELECT * FROM shared_tournaments WHERE status = 'active'");
  const round = one("SELECT * FROM shared_rounds WHERE tournament = ? AND status = 'scheduled' ORDER BY created LIMIT 1", [t.id]);
  const stmts = [["UPDATE world SET processing_version = ? WHERE key = 'main'", [Date.now() - 1000]]]; // expire the lease
  if (round) {
    stmts.push(["UPDATE shared_rounds SET scheduled_at = ? WHERE id = ?", [past, round.id]]);
    stmts.push(["UPDATE shared_fixtures SET scheduled_at = ? WHERE round = ?", [past, round.id]]);
  }
  await write(stmts);
  const reclaim = await req("/api/footfive/admin/world/catch-up", "POST", admin.token, {});
  ok("expired lease reclaimed (tick runs, not locked)", reclaim.ok && reclaim.data.locked !== true, JSON.stringify(reclaim.data).slice(0, 160));
  if (round) {
    ok(
      "reclaim ran the due kick-off",
      (reclaim.data.actions || []).some((a) => String(a).startsWith("kickoff")),
      JSON.stringify(reclaim.data).slice(0, 160),
    );
  }
  ok("lease released to idle after reclaim", (worldRow().processing_status || "idle") === "idle", worldRow().processing_status);
  const staleIssues = ((await req("/api/footfive/admin/recovery/status", "GET", admin.token)).data.worldIssues) || [];
  ok("no stale lock reported after reclaim", !staleIssues.some((i) => i.type === "stale_world_lock"), JSON.stringify(staleIssues));

  // (5) Real concurrency: 20 parallel admin catch-ups race for the next due round.
  await until("next round scheduled", async () => {
    await req("/api/footfive/health");
    return !!one("SELECT * FROM shared_rounds WHERE status = 'scheduled' LIMIT 1");
  });
  const t2 = one("SELECT * FROM shared_tournaments WHERE status = 'active'");
  const round2 = one("SELECT * FROM shared_rounds WHERE tournament = ? AND status = 'scheduled' ORDER BY created LIMIT 1", [t2.id]);
  await write([
    ["UPDATE shared_rounds SET scheduled_at = ? WHERE id = ?", [past, round2.id]],
    ["UPDATE shared_fixtures SET scheduled_at = ? WHERE round = ?", [past, round2.id]],
  ]);
  // Fired right after restart, ahead of the next minute-boundary cron run.
  const races = await Promise.all(Array.from({ length: 20 }, () => req("/api/footfive/admin/world/catch-up", "POST", admin.token, {})));
  ok("all racing catch-ups answered 200", races.every((r) => r.status === 200), races.map((r) => r.status).join(","));
  const kickoffs = races.filter((r) => (r.data.actions || []).some((a) => String(a).startsWith("kickoff"))).length;
  ok("at most one racer kicked the round off", kickoffs <= 1, `kickoffs=${kickoffs}`);
  const round2After = one("SELECT status FROM shared_rounds WHERE id = ?", [round2.id]);
  ok("the due round did kick off exactly once", round2After && round2After.status !== "scheduled", JSON.stringify(round2After));
  ok("no duplicate tournaments", num("SELECT COUNT(*) n FROM shared_tournaments WHERE status = 'active'") === 1);
  const msCount = num("SELECT COUNT(*) n FROM match_states m JOIN shared_fixtures f ON f.id = m.fixture WHERE f.round = ?", [round2.id]);
  const fxCount = num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ?", [round2.id]);
  ok("one match_state per fixture (no double kick-off)", msCount === fxCount && fxCount > 0, `ms=${msCount} fx=${fxCount}`);
  ok("lease idle after the race", (worldRow().processing_status || "idle") === "idle");

  // (8) static guard: the three GET views must not call progression paths.
  const src = readFileSync(path.join(ROOT, "pocketbase", "pb_hooks", "lib", "worldService.js"), "utf8");
  for (const fn of ["liveView", "matchView", "worldSnapshot"]) {
    const startIdx = src.indexOf(`function ${fn}(`);
    const endIdx = src.indexOf("\nfunction ", startIdx + 1);
    const section = src.slice(startIdx, endIdx === -1 ? src.length : endIdx);
    ok(`${fn} never ticks`, !/tickIfDue\(|[^A-Za-z]tick\(|catchUpWorld\(/.test(section));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("FATAL", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stop();
    if (DATA_DIR && !process.env.KEEP_PROGRESS_DIR) rmSync(DATA_DIR, { recursive: true, force: true });
  });
