/**
 * Public scoreboard endpoint — isolated integration test against a REAL
 * disposable PocketBase (never production data, never the default 8090 port).
 *
 *   node tests/integration/public-scoreboard.mjs
 *
 * Covers:
 *   - anonymous 200 on /api/footfive/public-scoreboard while /live and /world
 *     stay 401 anonymously; POST is rejected
 *   - missing world → 503 unavailable and NOTHING is created (read-only proof)
 *   - no progression: a scoreboard read never creates a tournament (tick proof)
 *   - scheduled (upcoming, no scores) → live (score + clock) → final →
 *     champion gap (hidden draw) → next announced draw transitions
 *   - shootout result shape (explicitly labelled synthetic fixture data)
 *   - whitelist: no managers/user ids/attributes/treasury/model_json/odds ever
 *   - Cache-Control: no-store on live responses
 *
 * World progression is driven exactly the way the real app drives it (an
 * authenticated client polling /api/footfive/live, plus the built-in cron);
 * the scoreboard itself is only ever OBSERVED anonymously.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = Number(process.env.SB_PORT || 8271);
const BASE = `http://127.0.0.1:${PORT}`;
const TIME_SCALE = process.env.SB_TIME_SCALE || "60";
const DATA = path.join(
  process.env.SB_DATA || fs.mkdtempSync(path.join(os.tmpdir(), "ff-sb-test-")),
);

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else {
    failures += 1;
    console.error("  FAIL -", msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startPb(extraEnv = {}) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(
    PB_BIN,
    [
      "serve",
      `--http=127.0.0.1:${PORT}`,
      `--dir=${DATA}`,
      `--hooksDir=${path.join(ROOT, "pocketbase/pb_hooks")}`,
      `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`,
    ],
    {
      env: { ...process.env, FOOTFIVE_TIME_SCALE: TIME_SCALE, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d) => process.stdout.write(`[pb] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[pb-err] ${d}`));
  return child;
}

async function req(pathname, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}

async function waitPbHealth(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await req("/api/health");
      if (r.status === 200) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("PocketBase did not become healthy");
}

/** Wait until the footfive world exists, using the endpoint DESIGNED to tick
 * (public /api/footfive/health — bootstrap defers to the 1-minute cron on a
 * fresh DB). The scoreboard itself is never used to create anything. */
async function waitFootFiveWorld(ms = 150000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await req("/api/footfive/health");
      if (r.status === 200 && r.data && r.data.worldAvailable) return;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error("footfive world never became available");
    await sleep(500);
  }
}

function db() {
  return new DatabaseSync(path.join(DATA, "data.db"));
}
function count(table, where = "1=1") {
  const d = db();
  try {
    return d.prepare(`select count(*) c from ${table} where ${where}`).get().c;
  } finally {
    d.close();
  }
}
async function waitCount(table, want, ms = 30000, where = "1=1") {
  const t0 = Date.now();
  for (;;) {
    let n = -1;
    try {
      n = count(table, where);
    } catch {}
    if (n === want) return;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${table} count ${want} (have ${n})`);
    await sleep(150);
  }
}

/** Wait until we are safely inside a minute so the */ /* cron (fires each minute
 * boundary) cannot race the assertion that follows. */
async function waitMidMinute() {
  for (;;) {
    const ms = Date.now() % 60000;
    if (ms > 5000 && ms < 52000) return;
    await sleep(400);
  }
}

async function createUser() {
  const email = `sb_${Date.now()}@test.local`;
  await req("/api/collections/users/records", {
    method: "POST",
    body: { email, password: "testpass99", passwordConfirm: "testpass99", display_name: "sb" },
  });
  const r = await req("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password: "testpass99" },
  });
  if (r.status !== 200) throw new Error("login failed: " + JSON.stringify(r.data));
  return r.data.token;
}

// Every key that must never appear anywhere in a public scoreboard payload.
const FORBIDDEN_KEYS = [
  "manager",
  "managerid",
  "managername",
  "treasury",
  "model_json",
  "odds",
  "strength",
  "grade",
  "battery_count",
  "credits",
  "state_json",
  "lineups",
  "players",
  "coach",
  "ticker",
];
function scanForbidden(node, pathStr, hits) {
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.includes(k.toLowerCase())) hits.push(`${pathStr}.${k}`);
      scanForbidden(v, `${pathStr}.${k}`, hits);
    }
  }
  return hits;
}

function validateShape(snap, label) {
  const p = `[$label]`.replace("$label", label);
  if (typeof snap.serverTimeMs !== "number") return `${p}: serverTimeMs missing`;
  if (!["idle", "fixtures", "live", "champion"].includes(snap.state)) return `${p}: bad state ${snap.state}`;
  const hits = scanForbidden(snap, "$", []);
  if (hits.length) return `${p}: forbidden keys ${hits.slice(0, 5).join(",")}`;
  if (!Array.isArray(snap.fixtures)) return `${p}: fixtures not an array`;
  for (const fx of snap.fixtures) {
    for (const side of ["home", "away"]) {
      const t = fx[side];
      if (!t || typeof t.name !== "string" || typeof t.abbreviation !== "string" || typeof t.id !== "string")
        return `${p}: fixture ${fx.id} ${side} team not whitelisted shape`;
    }
    if (snap.state === "fixtures") {
      if (fx.status !== "scheduled") return `${p}: upcoming round shows non-scheduled fixture ${fx.id} (${fx.status})`;
      if (fx.score !== null || fx.result !== null || fx.minute !== null)
        return `${p}: NO FUTURE SCORES violated for ${fx.id}`;
    }
    if (fx.status === "finished") {
      const r = fx.result;
      if (!r || typeof r.home !== "number" || typeof r.away !== "number")
        return `${p}: finished fixture ${fx.id} missing numeric result`;
      if (typeof r.shootoutHome !== "number" || typeof r.shootoutAway !== "number")
        return `${p}: finished fixture ${fx.id} missing shootout columns`;
      if (!["home", "away"].includes(r.winner)) return `${p}: finished fixture ${fx.id} bad winner`;
    }
    if (fx.minute !== null && (typeof fx.minute !== "number" || fx.minute < 0 || fx.minute > 120))
      return `${p}: fixture ${fx.id} minute out of range (${fx.minute})`;
  }
  if (snap.state === "champion") {
    if (snap.fixtures.length !== 0) return `${p}: hidden draw leaked ${snap.fixtures.length} fixtures`;
    if (!snap.champion || !snap.champion.final || typeof snap.champion.final.score?.home !== "number")
      return `${p}: champion gap must show the latest final result`;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(PB_BIN)) throw new Error("missing pocketbase binary at " + PB_BIN);
  console.log(`== public-scoreboard integration ==\nport ${PORT}, time scale x${TIME_SCALE}, data ${DATA}`);
  const child = startPb();
  const statesSeen = new Set();
  const shapeErrors = [];
  let finishedResultSeen = null;
  let lastGoalSeen = null;
  let minuteProgression = null;

  // Keep the world advancing. GET /live is read-only now (issue #17): the
  // designed-tick endpoint /api/footfive/health drives progression instead.
  let driving = false;
  let driveToken = null;
  const driver = setInterval(async () => {
    if (!driving || !driveToken) return;
    try {
      await req("/api/footfive/health", {});
    } catch {}
  }, 250);

  try {
    await waitPbHealth();
    await waitFootFiveWorld();

    console.log("\n-- auth boundaries --");
    const anonSb = await req("/api/footfive/public-scoreboard");
    ok(anonSb.status === 200, `anonymous scoreboard 200 (got ${anonSb.status})`);
    ok((anonSb.headers.get("cache-control") || "").includes("no-store"), "Cache-Control: no-store on live state");
    ok(["idle", "fixtures"].includes(anonSb.data.state), `fresh world reads as idle/fixtures (got ${anonSb.data.state})`);
    const anonLive = await req("/api/footfive/live");
    ok(anonLive.status === 401, `anonymous /live still 401 (got ${anonLive.status})`);
    const anonWorld = await req("/api/footfive/world");
    ok(anonWorld.status === 401, `anonymous /world still 401 (got ${anonWorld.status})`);
    const post = await req("/api/footfive/public-scoreboard", { method: "POST", body: {} });
    ok(post.status === 404 || post.status === 405, `POST scoreboard rejected (got ${post.status})`);

    console.log("\n-- read-only proof: five scoreboard reads change zero rows --");
    // Mid-minute (cron cannot race): snapshot every writable table, read the
    // scoreboard repeatedly, then prove the database is byte-identical.
    await waitMidMinute();
    const tables = ["world", "shared_tournaments", "shared_rounds", "shared_fixtures", "match_states", "match_events"];
    const snapshotRows = () => {
      const d = db();
      try {
        // Full-row fingerprint in JS: catches inserts, deletes AND updates on
        // any schema (some tables have no `updated` column). Tables are tiny
        // at this fresh-boot stage.
        return tables.map((t) =>
          JSON.stringify(d.prepare(`select * from ${t} order by rowid`).all()),
        );
      } finally {
        d.close();
      }
    };
    const before = JSON.stringify(snapshotRows());
    for (let i = 0; i < 5; i++) {
      const r = await req("/api/footfive/public-scoreboard");
      if (r.status !== 200) shapeErrors.push(`read-only proof: status ${r.status}`);
    }
    const after = JSON.stringify(snapshotRows());
    ok(before === after, "scoreboard reads wrote nothing (no tick/ensureWorld/progression, even transitively)");

    await waitMidMinute();
    const d = db();
    d.prepare("delete from world").run();
    d.close();
    const gone = await req("/api/footfive/public-scoreboard");
    ok(gone.status === 503, `missing world → 503 (got ${gone.status})`);
    ok(gone.data && gone.data.error === "scoreboard_unavailable", "503 carries clear unavailable error");
    ok(count("world") === 0, "scoreboard did NOT recreate the world (read-only, no ensureWorld)");
    // Restore via the endpoint that is DESIGNED to tick (public health).
    const h = await req("/api/footfive/health");
    ok(h.status === 200, "public health still works after restore path");
    await waitCount("world", 1, 15000);

    console.log("\n-- full cycle: fixtures → live → final → champion gap → next draw --");
    driveToken = await createUser();
    driving = true;
    const t0 = Date.now();
    const CYCLE_BUDGET = 9 * 60 * 1000;
    let sawChampion = false;
    let sawAnnouncedAfterChampion = false;
    let shootoutChecked = false;
    let prevMinutes = new Map();

    while (Date.now() - t0 < CYCLE_BUDGET && !(sawChampion && sawAnnouncedAfterChampion && shootoutChecked)) {
      let snap;
      try {
        const r = await req("/api/footfive/public-scoreboard");
        if (r.status !== 200) {
          shapeErrors.push(`poll: status ${r.status}`);
          await sleep(400);
          continue;
        }
        snap = r.data;
      } catch (err) {
        shapeErrors.push(`poll: ${err.message}`);
        await sleep(400);
        continue;
      }
      statesSeen.add(snap.state);
      const err = validateShape(snap, snap.state);
      if (err && shapeErrors.length < 12) shapeErrors.push(err);

      if (snap.state === "live") {
        for (const fx of snap.fixtures) {
          if (fx.minute !== null) {
            const prev = prevMinutes.get(fx.id);
            if (prev !== undefined && fx.minute > prev && !minuteProgression) {
              minuteProgression = { fixture: fx.id, from: prev, to: fx.minute };
            }
            prevMinutes.set(fx.id, fx.minute);
          }
          if (fx.last && fx.last.t === "goal" && !lastGoalSeen) lastGoalSeen = fx.last;
          if (fx.status === "finished" && !finishedResultSeen) finishedResultSeen = fx.result;
        }
        // Shootout contract: label and inject a synthetic pens decision into ONE
        // already-finished fixture of the current round (test-instance data only)
        // so the finished-shootout shape is covered deterministically.
        if (!shootoutChecked) {
          const fin = snap.fixtures.find((f) => f.status === "finished");
          if (fin) {
            try {
              const d2 = db();
              d2.prepare(
                "update shared_fixtures set score_home=1, score_away=1, shootout_home=4, shootout_away=3, decided_by='pens' where id=?",
              ).run(fin.id);
              d2.close();
              const r2 = await req("/api/footfive/public-scoreboard");
              const fx2 = r2.data.fixtures.find((f) => f.id === fin.id);
              if (
                fx2 &&
                fx2.result &&
                fx2.result.shootoutHome === 4 &&
                fx2.result.shootoutAway === 3 &&
                fx2.result.by === "pens" &&
                fx2.shootout &&
                fx2.shootout.home === 4
              ) {
                shootoutChecked = true;
                console.log("  ok - shootout result shape (synthetic pens fixture):", JSON.stringify(fx2.result));
              } else {
                shapeErrors.push("shootout synthetic fixture did not project: " + JSON.stringify(fx2 && fx2.result));
                shootoutChecked = true; // do not spam the DB
              }
            } catch (e2) {
              shapeErrors.push("shootout injection failed: " + e2.message);
              shootoutChecked = true;
            }
          }
        }
      }
      if (snap.state === "champion") {
        sawChampion = true;
      }
      if (sawChampion && snap.state === "fixtures" && snap.round && snap.round.key === "r16") {
        if (snap.fixtures.length === 8 && snap.fixtures.every((f) => f.home && f.away)) {
          sawAnnouncedAfterChampion = true;
        }
      }
      await sleep(400);
    }

    console.log("\n-- cycle observations --");
    ok(statesSeen.has("fixtures"), "upcoming/announced round observed (state=fixtures, scheduled only)");
    ok(statesSeen.has("live"), "live round observed");
    ok(finishedResultSeen !== null, `finished fixture result observed live: ${JSON.stringify(finishedResultSeen)}`);
    ok(minuteProgression !== null, `match clock advanced publicly: ${JSON.stringify(minuteProgression)}`);
    if (lastGoalSeen) console.log("  ok - last-goal indicator observed:", JSON.stringify(lastGoalSeen));
    else console.log("  note - no goal landed exactly on a poll boundary (optional field, shape covered by contract)");
    ok(sawChampion, "champion gap observed (hidden next draw, latest final shown)");
    ok(sawAnnouncedAfterChampion, "next R16 draw announced after the window (8 fixtures, both teams)");
    ok(shootoutChecked, "shootout result contract checked");

    console.log("\n-- shape violations across all polls --");
    if (shapeErrors.length === 0) console.log("  ok - zero violations in every observed snapshot");
    else {
      failures += shapeErrors.length;
      for (const e of shapeErrors.slice(0, 15)) console.error("  FAIL -", e);
    }

    console.log("\n-- static read-only audit of the scoreboard code path --");
    const src = fs.readFileSync(path.join(ROOT, "pocketbase/pb_hooks/lib/worldService.js"), "utf8");
    const section = src.slice(src.indexOf("function scoreboardTeam"), src.indexOf("function liveCoachCooldownMs"));
    for (const bad of ["tickIfDue(", "ensureWorld(", "runInTransaction(", ".save(", "advanceMatch(", "kickOff("]) {
      ok(!section.includes(bad), `scoreboard path never references ${bad}`);
    }
    ok(!/(^|[^A-Za-z])tick\(/.test(section), "scoreboard path never calls tick(");
  } finally {
    driving = false;
    clearInterval(driver);
    try {
      child.kill("SIGTERM");
    } catch {}
    await sleep(500);
    if (failures === 0) fs.rmSync(DATA, { recursive: true, force: true });
    else console.error("test data kept for inspection:", DATA);
  }

  console.log(failures === 0 ? "\npublic-scoreboard OK" : `\nFAIL (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
