/**
 * Clean-database bootstrap test — empty pb_data_boot, no production.
 * Run: node tests/integration/bootstrap-clean.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PB = path.join(ROOT, "pocketbase", "pocketbase");
const DATA = path.join(ROOT, "pocketbase", "pb_data_boot");
const PORT = process.env.BOOT_PORT || "8094";
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error("health timeout");
}

function startPb() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(
    PB,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      `--dir=${DATA}`,
      `--hooksDir=${path.join(ROOT, "pocketbase/pb_hooks")}`,
      `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d) => process.stdout.write(`[pb] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[pb-err] ${d}`));
  return child;
}

async function counts() {
  // Use unauthenticated health + superuserless SQLite
  const DatabaseSync = (await import("node:sqlite")).DatabaseSync;
  // fallback python if no node:sqlite
  try {
    const db = new DatabaseSync(path.join(DATA, "data.db"));
    const world = db.prepare("select count(*) as c from world").get().c;
    const teams = db.prepare("select count(*) as c from proball_teams").get().c;
    const players = db.prepare("select count(*) as c from proball_players").get().c;
    const tours = db
      .prepare("select count(*) as c from shared_tournaments where status='active'")
      .get().c;
    db.close();
    return { world, teams, players, tours };
  } catch {
    const { spawnSync } = await import("node:child_process");
    const py = `
import sqlite3
c=sqlite3.connect(${JSON.stringify(path.join(DATA, "data.db"))})
print(c.execute("select count(*) from world").fetchone()[0])
print(c.execute("select count(*) from proball_teams").fetchone()[0])
print(c.execute("select count(*) from proball_players").fetchone()[0])
print(c.execute("select count(*) from shared_tournaments where status='active'").fetchone()[0])
`;
    const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || "sqlite fail");
    const [world, teams, players, tours] = r.stdout.trim().split("\n").map(Number);
    return { world, teams, players, tours };
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!fs.existsSync(PB)) throw new Error("missing pocketbase binary");
  let child = startPb();
  try {
    await waitHealth();
    // Wait for migrations + bootstrap loop (sync retries)
    await sleep(2500);
    // Trigger ensureWorld via catch-up path requires auth; use health + sqlite poll
    let h = await (await fetch(`${BASE}/api/footfive/health`)).json();
    for (let i = 0; i < 30 && !h.worldAvailable; i++) {
      await sleep(500);
      h = await (await fetch(`${BASE}/api/footfive/health`)).json();
    }
    // If still not ready, create a temp user and hit /world (ensures world)
    if (!h.worldAvailable) {
      const email = `boot_${Date.now()}@test.local`;
      await fetch(`${BASE}/api/collections/users/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: "testpass99",
          passwordConfirm: "testpass99",
          display_name: "boot",
        }),
      });
      const auth = await (
        await fetch(`${BASE}/api/collections/users/auth-with-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identity: email, password: "testpass99" }),
        })
      ).json();
      await fetch(`${BASE}/api/footfive/world`, {
        headers: { Authorization: auth.token },
      });
      h = await (await fetch(`${BASE}/api/footfive/health`)).json();
    }
    assert(h.worldAvailable, "worldAvailable after bootstrap");
    let c = await counts();
    console.log("first boot", c, h);
    assert(c.world === 1, `world count ${c.world}`);
    assert(c.teams === 16, `teams ${c.teams}`);
    assert(c.players >= 16 * 5, `players ${c.players}`);
    assert(c.tours === 1, `active tours ${c.tours}`);

    // restart without wiping data
    child.kill("SIGTERM");
    await sleep(1000);
    child = spawn(
      PB,
      [
        "serve",
        `--http=127.0.0.1:${PORT}`,
        `--dir=${DATA}`,
        `--hooksDir=${path.join(ROOT, "pocketbase/pb_hooks")}`,
        `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitHealth();
    await sleep(2000);
    h = await (await fetch(`${BASE}/api/footfive/health`)).json();
    c = await counts();
    console.log("second boot", c, h);
    assert(c.world === 1, "no duplicate world");
    assert(c.teams === 16, "no duplicate teams");
    assert(c.tours === 1, "no duplicate tournament");
    console.log("bootstrap-clean OK");
  } finally {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    // leave DATA for inspection unless CLEAN=1
    if (process.env.CLEAN === "1") fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
