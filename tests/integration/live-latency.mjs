/**
 * Live event latency regression (live carrier dribbling back and forth with no passing).
 *
 * After #38 took progression off the GET routes, live matches only advanced on the
 * one-minute cron, so events reached /api/footfive/match/:id in ~60 s batches and the
 * pitch dwelt (and shuttled) between them. The cron now pumps the lease-guarded tick
 * ~1/s while a round is live. This test runs a real PocketBase at NORMAL pace
 * (FOOTFIVE_TIME_SCALE=1), lets the cron alone kick a round off — no /health, no admin
 * catch-up, no bets — then polls GET /match/:id about once a second for ~15 s and
 * asserts the newest published event is never more than LAG_LIMIT_MS behind server time.
 * Engine events come every ~1.6–3.3 s, so a perfectly published feed already shows up to
 * ~3.3 s of age between events; the limit adds the ~1 s pump interval. Unfixed, the age
 * climbs towards 60 s.
 *
 * Standalone:  node tests/integration/live-latency.mjs   (takes ~2 min: waits for a cron minute)
 * Env: LIVE_PB_PORT (default 8297), LIVE_LAG_LIMIT_MS (default 5000).
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = process.env.LIVE_PB_PORT || "8297";
const URL = `http://127.0.0.1:${PORT}`;
const LAG_LIMIT_MS = Number(process.env.LIVE_LAG_LIMIT_MS || 5000);
const POLL_SECONDS = 15;
const HARD_LIMIT_MS = 8000;

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

// SQLite via python3 stdlib (same harness as progression-lock / settlement-recovery).
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
  const r = spawnSync("python3", ["-c", PY, DB], { input: JSON.stringify(stmts), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status) throw new Error((r.error ? String(r.error) : r.stderr) + ": " + JSON.stringify(stmts).slice(0, 200));
  return JSON.parse(r.stdout);
}
const one = (s, p = []) => sqlMany([[s, p]])[0] || null;

let child = null;
let DATA_DIR = "";
async function start() {
  child = spawn(PB_BIN, ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA_DIR}`, `--hooksDir=${ROOT}/pocketbase/pb_hooks`, `--migrationsDir=${ROOT}/pocketbase/pb_migrations`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FOOTFIVE_TIME_SCALE: "1" },
  });
  const sink = process.env.LIVE_PB_LOG ? (await import("node:fs")).createWriteStream(process.env.LIVE_PB_LOG, { flags: "a" }) : null;
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
    const t = setTimeout(() => child && child.exitCode === null && child.kill("SIGKILL"), 10000);
    await once(child, "exit");
    clearTimeout(t);
  }
  child = null;
}
async function until(label, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error("timeout waiting for " + label);
}
const pbDate = (ms) => new Date(ms).toISOString().replace("T", " ");

async function main() {
  DATA_DIR = mkdtempSync(path.join(tmpdir(), "ff-live-"));
  DB = path.join(DATA_DIR, "data.db");
  console.log("live-latency regression against", URL, "normal pace, limit", LAG_LIMIT_MS, "ms");
  await start();

  // World + first championship (fixtures announced, kick-off minutes away).
  await until("first round scheduled", async () => {
    await req("/api/footfive/health");
    return !!one("SELECT id FROM shared_rounds WHERE status IN ('scheduled','management') LIMIT 1");
  }, 30000);
  const email = `live_${Date.now()}@t.local`;
  await req("/api/collections/users/records", "POST", null, { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "live" });
  const auth = await req("/api/collections/users/auth-with-password", "POST", null, { identity: email, password: "testpass99" });
  if (!auth.ok) throw new Error("login failed " + JSON.stringify(auth.data));
  const token = auth.data.token;

  // Bring the kick-off forward (setup only, PB stopped: single-writer discipline). From
  // here on nothing but the cron may advance the world: only GET /match is called.
  const round = one("SELECT id FROM shared_rounds WHERE status IN ('scheduled','management') ORDER BY created LIMIT 1");
  await stop();
  const kick = pbDate(Date.now() + 3000);
  sqlMany([
    ["UPDATE shared_rounds SET scheduled_at = ? WHERE id = ?", [kick, round.id]],
    ["UPDATE shared_fixtures SET scheduled_at = ? WHERE round = ?", [kick, round.id]],
  ]);
  await start();
  const fx = one("SELECT id FROM shared_fixtures WHERE round = ? ORDER BY bracket_index LIMIT 1", [round.id]);
  console.log("· waiting for the cron to kick the round off (no ticking requests)…");
  await until("round live via cron", () => one("SELECT status FROM shared_rounds WHERE id = ?", [round.id]).status === "live", 75000);
  // Let the match get going: kick-off scene plus a few events.
  await until("first events", async () => (await req(`/api/footfive/match/${fx.id}`, "GET", token)).data.events?.length >= 3, 20000);

  const lags = [];
  let polls = 0;
  let grew = 0;
  let lastCount = 0;
  for (let i = 0; i < POLL_SECONDS; i++) {
    const r = await req(`/api/footfive/match/${fx.id}`, "GET", token);
    if (r.status === 200) {
      polls++;
      const evs = r.data.events || [];
      const newest = evs.reduce((m, e) => Math.max(m, e.at || 0), 0);
      if (r.data.fixture?.st?.ph !== "finished" && newest) lags.push(r.data.serverTimeMs - newest);
      if (r.data.eventsPage?.nextSeq > lastCount) grew++;
      lastCount = r.data.eventsPage?.nextSeq ?? lastCount;
    }
    await sleep(1000);
  }
  const max = Math.max(...lags);
  console.log(`  lag per poll (ms): ${lags.join(", ")}`);
  ok(`${POLL_SECONDS} polls answered`, polls === POLL_SECONDS, `polls=${polls}`);
  const over = lags.filter((l) => l > LAG_LIMIT_MS).length;
  // Allow one poll inside a long natural gap (goal celebration, card) but never a stale feed: unfixed, the age climbs ~1 s per poll.
  ok(`newest event ≤ ${LAG_LIMIT_MS} ms behind server time (≤1 poll over, none over ${HARD_LIMIT_MS})`, lags.length >= POLL_SECONDS - 2 && over <= 1 && max <= HARD_LIMIT_MS, `max=${max} over=${over}`);
  ok("events arrive steadily, not in one batch", grew >= Math.floor(POLL_SECONDS / 3), `polls with new events=${grew}`);
  const w = one("SELECT processing_status FROM world WHERE key = 'main'");
  ok("no stuck lease", w.processing_status !== "error", JSON.stringify(w));

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
    if (DATA_DIR && !process.env.KEEP_LIVE_DIR) rmSync(DATA_DIR, { recursive: true, force: true });
  });
