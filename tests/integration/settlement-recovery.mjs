/**
 * Settlement atomicity / idempotency / recovery regression (issue #15, review B4).
 *
 * Real PocketBase (current hooks + migrations) on a scratch DB, accelerated time.
 * Failures are injected at each settlement stage with SQLite triggers (RAISE ABORT)
 * — the hooks are not modified or mocked. For every stage the test proves:
 *   - the failing stage leaves NO partial state (whole transaction rolled back),
 *   - the stage is retried by later ticks and succeeds once the fault is removed,
 *   - nothing is paid twice (one ledger row per settlement key, balances reconcile).
 * Also: >1000 bets on one fixture all settle; legacy (pre-v2) partial rounds are
 * resumed; legacy stranded bets are settled by the recovery sweep exactly once;
 * player-record and championship-award write failures roll back their fixture /
 * completion transaction and are retried (review R2);
 * the stranded-bet sweep progresses past not-yet-progressed and failing fixtures,
 * reporting failures (review R1);
 * credit_ledger's unique idempotency index is collection-owned (migration 17) and
 * its duplicate preflight fails closed without modifying data.
 *
 * Standalone:  node tests/integration/settlement-recovery.mjs
 * Env: SETTLE_PB_PORT (default 8294). Own PB instance and scratch DB only.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = process.env.SETTLE_PB_PORT || "8294";
const URL = `http://127.0.0.1:${PORT}`;
const SCALE = "160"; // 50 ms match minutes: a championship in ~30 s

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
    headers: { ...(token ? { Authorization: token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
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

// ---- SQLite access (python3 stdlib), JSON in/out
let DB = "";
const PY = `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1], timeout=30, isolation_level=None)
c.row_factory = sqlite3.Row
out = []
stmts = json.loads(sys.stdin.read())
write = any(not s.lstrip().upper().startswith("SELECT") for s, _ in stmts)
if write: c.execute("BEGIN IMMEDIATE")  # take the write lock up front (busy timeout applies; no upgrade deadlock)
for stmt, params in stmts:
    cur = c.execute(stmt, params)
    out = [dict(r) for r in cur.fetchall()] if cur.description else out
if write: c.execute("COMMIT")
print(json.dumps(out))
`;
function sqlMany(stmts) {
  const t0 = Date.now();
  const r = spawnSync("python3", ["-c", PY, DB], { input: JSON.stringify(stmts), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status) throw new Error((r.error ? String(r.error) : r.stderr) + " after " + (Date.now() - t0) + "ms: " + JSON.stringify(stmts).slice(0, 200));
  return JSON.parse(r.stdout);
}
const q = (s, p = []) => sqlMany([[s, p]]);
const one = (s, p = []) => q(s, p)[0] || null;
const num = (s, p = []) => Number(Object.values(one(s, p) || { n: 0 })[0] || 0);

// ---- fault injection: one named trigger per stage
function inject(name, table, event, when) {
  return write([[`CREATE TRIGGER inj_${name} BEFORE ${event} ON ${table} ${when ? "WHEN " + when : ""} BEGIN SELECT RAISE(ABORT, 'injected:${name}'); END`, []]]);
}
function clear(name) {
  return write([[`DROP TRIGGER IF EXISTS inj_${name}`, []]]);
}

// ---- PocketBase process + a ticker driving the world through /health
let child = null;
let ticking = false;
async function start(dataDir) {
  child = spawn(PB_BIN, ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${dataDir}`, `--hooksDir=${ROOT}/pocketbase/pb_hooks`, `--migrationsDir=${ROOT}/pocketbase/pb_migrations`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FOOTFIVE_TIME_SCALE: SCALE },
  });
  const sink = process.env.SETTLE_PB_LOG ? (await import("node:fs")).createWriteStream(process.env.SETTLE_PB_LOG, { flags: "a" }) : null;
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
  ticking = false;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  child = null;
}
let tickGen = 0;
async function ticker() {
  const gen = ++tickGen;
  ticking = true;
  while (ticking && gen === tickGen) {
    try {
      await fetch(`${URL}/api/footfive/health`);
    } catch {
      /* restarting */
    }
    await sleep(40);
  }
}
/**
 * External writes (fault triggers, legacy-state emulation, seeding) happen with
 * PocketBase stopped: SQLite has one writer, and an outside writer racing PB's
 * write connection is not a production condition (PB is the only writer there).
 * World state is persisted, so ticking resumes where it left off on restart.
 */
let DATA_DIR = "";
async function write(stmts) {
  const wasTicking = ticking;
  await stop();
  try {
    return sqlMany(stmts);
  } finally {
    await start(DATA_DIR);
    if (wasTicking) ticker();
  }
}
async function until(label, fn, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(150);
  }
  throw new Error("timeout waiting for " + label);
}
const pause = (on) => write([["UPDATE world SET progression_paused = ? WHERE key = 'main'", [on ? 1 : 0]]]);

// ---- domain reads
const activeT = () => one("SELECT * FROM shared_tournaments WHERE status = 'active' ORDER BY number DESC LIMIT 1");
const roundOf = (tid, key) => one("SELECT * FROM shared_rounds WHERE tournament = ? AND round_key = ?", [tid, key]);
const fixturesOfRound = (rid) => q("SELECT * FROM shared_fixtures WHERE round = ? ORDER BY bracket_index", [rid]);
const allEngineFinished = (rid) =>
  num("SELECT COUNT(*) n FROM match_states m JOIN shared_fixtures f ON f.id = m.fixture WHERE f.round = ? AND m.phase = 'finished'", [rid]) ===
  fixturesOfRound(rid).length && fixturesOfRound(rid).length > 0;

function rid15() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 15; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

/** Insert bets as if placed through the API: bet row, stake ledger row, balance debit. */
function insertBets(rows) {
  const now = new Date().toISOString().replace("T", " ");
  const stmts = [];
  for (const b of rows) {
    const id = rid15();
    b.id = id;
    stmts.push([
      "INSERT INTO shared_bets (id, created, updated, user, fixture, round, tournament, market, selection, selection_team, label, stake, odds, status, settled, settlement_key, placed_ms, payout, settled_at, result_note, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'',?,0,'','',?)",
      [id, now, now, b.user, b.fixture || "", b.round || "", b.tournament || "", b.market, b.selection || "", b.selection_team || "", "test bet", b.stake, b.odds, b.status || "open", Date.now(), "bet:test:" + id],
    ]);
    stmts.push(["UPDATE users SET credits = credits - ? WHERE id = ?", [b.stake, b.user]]);
    stmts.push([
      "INSERT INTO credit_ledger (id, created, user, type, amount, description, idempotency_key, balance_after) VALUES (?,?,?,'bet_stake',?,'Stake: test',?, (SELECT credits FROM users WHERE id = ?))",
      [rid15(), now, b.user, -b.stake, id + ":stake", b.user],
    ]);
  }
  return { rows, stmts };
}
async function seedBets(rows) {
  const r = insertBets(rows);
  await write(r.stmts);
  return r.rows;
}

// ---- invariants (checked after every stage)
let creditBase = {};
let treasuryBase = {};
function snapshotBalances() {
  creditBase = Object.fromEntries(q("SELECT u.id, u.credits - COALESCE((SELECT SUM(amount) FROM credit_ledger l WHERE l.user = u.id), 0) AS base FROM users u").map((r) => [r.id, r.base]));
  treasuryBase = Object.fromEntries(
    q("SELECT t.id, t.treasury - COALESCE((SELECT SUM(amount) FROM team_finance_ledger l WHERE l.team = t.id), 0) AS base FROM proball_teams t").map((r) => [r.id, r.base]),
  );
}
function checkInvariants(stage) {
  const cr = q("SELECT u.id, u.credits - COALESCE((SELECT SUM(amount) FROM credit_ledger l WHERE l.user = u.id), 0) AS base FROM users u");
  const badC = cr.filter((r) => creditBase[r.id] !== undefined && r.base !== creditBase[r.id]);
  ok(`${stage}: every user balance == base + ledger (no unledgered credit move)`, badC.length === 0, JSON.stringify(badC.slice(0, 3)));
  const tr = q("SELECT t.id, t.treasury - COALESCE((SELECT SUM(amount) FROM team_finance_ledger l WHERE l.team = t.id), 0) AS base FROM proball_teams t");
  const badT = tr.filter((r) => treasuryBase[r.id] !== undefined && r.base !== treasuryBase[r.id]);
  ok(`${stage}: every treasury == base + ledger (no half-paid reward)`, badT.length === 0, JSON.stringify(badT.slice(0, 3)));
  const dupC = num("SELECT COUNT(*) n FROM (SELECT idempotency_key FROM credit_ledger WHERE idempotency_key != '' GROUP BY 1 HAVING COUNT(*) > 1)");
  const dupT = num("SELECT COUNT(*) n FROM (SELECT idempotency_key FROM team_finance_ledger GROUP BY 1 HAVING COUNT(*) > 1)");
  ok(`${stage}: no duplicate ledger keys`, dupC === 0 && dupT === 0, `credit=${dupC} team=${dupT}`);
  const unpaired = num(
    "SELECT COUNT(*) n FROM shared_bets b WHERE b.settled = 1 AND b.payout > 0 AND (SELECT COUNT(*) FROM credit_ledger l WHERE l.idempotency_key = b.id || ':settle' AND l.amount = b.payout) != 1",
  );
  const stray = num("SELECT COUNT(*) n FROM credit_ledger l WHERE l.idempotency_key LIKE '%:settle' AND NOT EXISTS (SELECT 1 FROM shared_bets b WHERE b.id || ':settle' = l.idempotency_key AND b.settled = 1)");
  ok(`${stage}: every paid bet has exactly one matching payout row, no payout without a settled bet`, unpaired === 0 && stray === 0, `unpaired=${unpaired} stray=${stray}`);
  const rewardsUnledgered = num("SELECT COUNT(*) n FROM reward_settlements r WHERE (SELECT COUNT(*) FROM team_finance_ledger l WHERE l.idempotency_key = r.settlement_key) != 1");
  ok(`${stage}: every reward settlement has exactly one ledger row`, rewardsUnledgered === 0, `n=${rewardsUnledgered}`);
}

async function main() {
  const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "footfive-settle-"));
  const dataDir = path.join(work, "pb_data");
  mkdirSync(dataDir, { recursive: true });
  DB = path.join(dataDir, "data.db");
  DATA_DIR = dataDir;
  try {
    await start(dataDir);
    console.log(`Settlement recovery: db=${dataDir} scale=${SCALE}`);

    // --- migration 17: collection-owned unique index on credit_ledger
    const idx = one("SELECT sql FROM sqlite_master WHERE name = 'idx_credit_ledger_idem'");
    const meta = one("SELECT indexes FROM _collections WHERE name = 'credit_ledger'");
    ok("migration 17: unique partial index present", !!idx && /UNIQUE/.test(idx.sql) && /idempotency_key != ''/.test(idx.sql), JSON.stringify(idx));
    ok("migration 17: index owned by the collection schema", (meta.indexes || "").includes("idx_credit_ledger_idem"), meta.indexes);

    // --- users (API) and world
    const stamp = Date.now();
    const mk = async (email) => {
      await req("/api/collections/users/records", "POST", null, { email, password: "testpass99", passwordConfirm: "testpass99" });
      const r = await req("/api/collections/users/auth-with-password", "POST", null, { identity: email, password: "testpass99" });
      if (!r.ok) throw new Error("login " + email);
      return { id: r.data.record.id, token: r.data.token };
    };
    const admin = await mk(`st_admin_${stamp}@t.local`);
    const u1 = await mk(`st_u1_${stamp}@t.local`);
    const u2 = await mk(`st_u2_${stamp}@t.local`);
    await write([["UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]]]);
    const adminTok = (await req("/api/collections/users/auth-with-password", "POST", null, { identity: `st_admin_${stamp}@t.local`, password: "testpass99" })).data.token;
    await write([["UPDATE users SET credits = 1000000 WHERE id IN (?, ?)", [u1.id, u2.id]]]);

    await req("/api/footfive/health"); // creates world + championship #1
    await pause(true);
    let t = activeT();
    ok("championship #1 drawn", !!t);
    let r16 = roundOf(t.id, "r16");
    ok("R16 still scheduled while paused", r16 && r16.status === "scheduled", r16 && r16.status);
    const fx = fixturesOfRound(r16.id);

    // --- bets: >1000 on one fixture, legacy-shaped bets, round/championship markets
    const many = [];
    for (let i = 0; i < 1200; i++) {
      many.push({ user: i % 2 ? u1.id : u2.id, fixture: fx[0].id, round: r16.id, tournament: t.id, market: "winner", selection: i % 2 ? "home" : "away", stake: 10, odds: 2.5, status: i % 5 ? "open" : "locked" });
    }
    await seedBets(many);
    const legacyStyle = await seedBets([
      { user: u1.id, fixture: fx[1].id, market: "", selection_team: fx[1].home_team, stake: 7, odds: 1.9, status: "locked" },
      { user: u2.id, fixture: fx[1].id, market: "", selection_team: fx[1].away_team, stake: 7, odds: 1.9, status: "locked" },
    ]);
    const teamsAll = q("SELECT id FROM proball_teams ORDER BY id").map((r) => r.id);
    await seedBets(fx.flatMap((f) => [{ user: u1.id, round: r16.id, tournament: t.id, market: "round_first", selection: f.home_team, selection_team: f.home_team, stake: 5, odds: 9 }]));
    const quarters = JSON.parse(t.odds_json).quarters;
    await seedBets([{ user: u2.id, round: r16.id, tournament: t.id, market: "semis", selection: quarters.map((qq) => qq[0]).join(","), stake: 5, odds: 30 }]);
    await seedBets(teamsAll.map((id) => ({ user: u2.id, round: r16.id, tournament: t.id, market: "champion", selection: id, selection_team: id, stake: 3, odds: 12 })));
    const totalBets = num("SELECT COUNT(*) n FROM shared_bets");
    ok("seeded > 1000 bets on one fixture", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ?", [fx[0].id]) === 1200, String(totalBets));
    snapshotBalances();
    checkInvariants("seed");

    const REWARD_TYPES = "('goal_bonus','match_win','progress','consolation')";
    // ===== Stage A: R16 fixture finalisation fails at the reward ledger write
    await inject("A", "team_finance_ledger", "INSERT", `NEW.type IN ${REWARD_TYPES}`);
    await pause(false);
    ticker();
    await until("R16 engines finished", () => allEngineFinished(r16.id));
    await sleep(1500); // many ticks retry and fail
    ok("A: no R16 fixture finalised while rewards fail", num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [r16.id]) === 0);
    ok("A: no reward rows, no progression_settled", num("SELECT COUNT(*) n FROM reward_settlements") === 0 && num("SELECT COUNT(*) n FROM match_states WHERE progression_settled = 1") === 0);
    ok("A: no fixture bet settled (rolled back with the rewards)", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture != '' AND settled = 1") === 0);
    ok("A: no summaries / team records written", num("SELECT COUNT(*) n FROM match_summaries") === 0 && num("SELECT COALESCE(SUM(played),0) n FROM global_team_records") === 0);
    checkInvariants("A");

    // ===== Stage B: rewards work; bet payouts fail (fixtures with bets) and round completion fails
    await write([
      ["DROP TRIGGER inj_A", []],
      [`CREATE TRIGGER inj_B BEFORE INSERT ON credit_ledger WHEN NEW.type IN ('bet_win','bet_refund') BEGIN SELECT RAISE(ABORT, 'injected:B'); END`, []],
      [`CREATE TRIGGER inj_C BEFORE INSERT ON shared_rounds BEGIN SELECT RAISE(ABORT, 'injected:C'); END`, []],
    ]);
    const betFx = [fx[0].id, fx[1].id];
    await until("R16 fixtures without bets finalised", () => num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [r16.id]) === fx.length - 2);
    await sleep(1000);
    ok(
      "B: fixtures whose bet payout fails are not finalised",
      num("SELECT COUNT(*) n FROM shared_fixtures WHERE id IN (?, ?) AND status = 'finished'", betFx) === 0,
    );
    ok(
      "B: their rewards rolled back with the failed payout (atomic fixture stage)",
      num("SELECT COUNT(*) n FROM reward_settlements WHERE settlement_key LIKE 'rew:' || ? || ':%' OR settlement_key LIKE 'rew:' || ? || ':%'", betFx) === 0,
    );
    ok("B: their bets untouched", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture IN (?, ?) AND settled = 1", betFx) === 0);
    ok("B: other fixtures rewarded", num("SELECT COUNT(*) n FROM reward_settlements WHERE kind = 'match_win'") === fx.length - 2);
    checkInvariants("B");

    // ===== Stage C: payouts work; next-round creation still fails
    await clear("B");
    await until("all R16 fixtures finalised", () => num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [r16.id]) === fx.length);
    await sleep(1000);
    ok("C: all 1200 bets on the busy fixture settled", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND settled = 1", [fx[0].id]) === 1200);
    ok("C: legacy-shaped (market='', locked) bets settled", num("SELECT COUNT(*) n FROM shared_bets WHERE id IN (?, ?) AND settled = 1", legacyStyle.map((b) => b.id)) === 2);
    const winners0 = num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND status = 'won'", [fx[0].id]);
    ok("C: busy fixture paid exactly its 600 winners once", winners0 === 600 && num("SELECT COUNT(*) n FROM credit_ledger WHERE type = 'bet_win' AND idempotency_key IN (SELECT id || ':settle' FROM shared_bets WHERE fixture = ?)", [fx[0].id]) === 600, String(winners0));
    r16 = roundOf(t.id, "r16");
    ok("C: R16 not completed while next-round creation fails", r16.status === "live" && !r16.progression_done, `${r16.status}/${r16.progression_done}`);
    ok("C: no QF round, semis bet still open", !roundOf(t.id, "qf") && num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'semis' AND settled = 0") === 1);
    checkInvariants("C");

    // ===== Stage D: R16 completes; QF finalisation fails at the match summary
    await write([
      ["DROP TRIGGER inj_C", []],
      [`CREATE TRIGGER inj_D BEFORE INSERT ON match_summaries WHEN (SELECT round_key FROM shared_rounds WHERE id = (SELECT round FROM shared_fixtures WHERE id = NEW.fixture_id)) = 'qf' BEGIN SELECT RAISE(ABORT, 'injected:D'); END`, []],
      [`CREATE TRIGGER inj_E BEFORE UPDATE ON shared_bets WHEN NEW.market = 'semis' AND NEW.status != OLD.status BEGIN SELECT RAISE(ABORT, 'injected:E'); END`, []],
    ]);
    await until("QF created", () => !!roundOf(t.id, "qf"));
    r16 = roundOf(t.id, "r16");
    ok("D: R16 completed exactly once (one QF round)", r16.progression_done === 1 && num("SELECT COUNT(*) n FROM shared_rounds WHERE tournament = ? AND round_key = 'qf'", [t.id]) === 1);
    ok("D: round-first bets all settled", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'round_first' AND settled = 0") === 0);
    const qf = roundOf(t.id, "qf");
    const qfFx = fixturesOfRound(qf.id).map((f) => f.id);
    const rewardsBeforeQf = num("SELECT COUNT(*) n FROM reward_settlements");
    await until("QF engines finished", () => allEngineFinished(qf.id));
    await sleep(1500);
    ok("D: no QF fixture finalised while its summary fails", num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [qf.id]) === 0);
    ok("D: no QF reward paid (rolled back with the summary)", num("SELECT COUNT(*) n FROM reward_settlements") === rewardsBeforeQf);
    checkInvariants("D");

    // ===== Stage E: QF fixtures finalise; QF completion fails settling the semis market
    await clear("D");
    await until("QF fixtures finalised", () => num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [qf.id]) === qfFx.length);
    await sleep(1000);
    const qfR = roundOf(t.id, "qf");
    ok("E: QF not completed while semis settlement fails", !qfR.progression_done && !roundOf(t.id, "sf"), `${qfR.status}`);
    ok("E: semis bet still open", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'semis' AND settled = 0") === 1);
    checkInvariants("E");

    // ===== Stage F: semis settle; final completion fails at the tournament summary.
    // Also, once the final exists: its player-record update fails (P1, fixture stage)
    // and every player championship award fails (P2, completion stage).
    const finalExists = `(SELECT COUNT(*) FROM shared_rounds WHERE tournament = '${t.id}' AND round_key = 'final') > 0`;
    await write([
      ["DROP TRIGGER inj_E", []],
      [`CREATE TRIGGER inj_F BEFORE INSERT ON tournament_summaries BEGIN SELECT RAISE(ABORT, 'injected:F'); END`, []],
      [`CREATE TRIGGER inj_P1 BEFORE UPDATE ON global_player_records WHEN NEW.appearances != OLD.appearances AND ${finalExists} BEGIN SELECT RAISE(ABORT, 'injected:P1'); END`, []],
      [`CREATE TRIGGER inj_P2 BEFORE UPDATE ON global_player_records WHEN NEW.championships != OLD.championships BEGIN SELECT RAISE(ABORT, 'injected:P2'); END`, []],
    ]);
    await until("final created", () => !!roundOf(t.id, "final"));
    ok("F: semis bet settled once", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'semis' AND settled = 1") === 1);
    const fin = roundOf(t.id, "final");
    const finFx = fixturesOfRound(fin.id)[0];
    const champsBefore = num("SELECT COALESCE(SUM(championships),0) n FROM global_team_records");
    const finAppsBefore = num("SELECT COALESCE(SUM(appearances),0) n FROM global_player_records WHERE team IN (?, ?)", [finFx.home_team, finFx.away_team]);
    await until("final engine finished", () => allEngineFinished(fin.id));
    await sleep(1500);
    ok(
      "P1: final not finalised while its player-record write fails (no summary, no settle flag, records untouched)",
      num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [fin.id]) === 0 &&
        num("SELECT COUNT(*) n FROM match_summaries WHERE fixture_id = ?", [finFx.id]) === 0 &&
        num("SELECT COUNT(*) n FROM match_states WHERE fixture = ? AND progression_settled = 1", [finFx.id]) === 0 &&
        num("SELECT COALESCE(SUM(appearances),0) n FROM global_player_records WHERE team IN (?, ?)", [finFx.home_team, finFx.away_team]) === finAppsBefore,
    );
    checkInvariants("P1");
    await clear("P1");
    await until("final fixture finalised", () => num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [fin.id]) === 1);
    ok("P1: retried final records its player appearances once", num("SELECT COALESCE(SUM(appearances),0) n FROM global_player_records WHERE team IN (?, ?)", [finFx.home_team, finFx.away_team]) > finAppsBefore && num("SELECT COUNT(*) n FROM match_summaries WHERE fixture_id = ?", [finFx.id]) === 1);
    await sleep(1500);
    ok("F: tournament still active while its completion fails", one("SELECT status FROM shared_tournaments WHERE id = ?", [t.id]).status === "active");
    ok("F: champion bets open, no champion reward, no championship counted", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'champion' AND settled = 1") === 0 && num("SELECT COUNT(*) n FROM reward_settlements WHERE kind = 'champion'") === 0 && num("SELECT COALESCE(SUM(championships),0) n FROM global_team_records") === champsBefore);
    checkInvariants("F");

    // ===== Stage P2: summary works; the player championship award still fails
    const champTeam = one("SELECT winner_team FROM shared_fixtures WHERE round = ?", [fin.id]).winner_team;
    const champPlayers = num("SELECT COUNT(*) n FROM global_player_records WHERE team = ?", [champTeam]);
    const playerChampsBefore = num("SELECT COALESCE(SUM(championships),0) n FROM global_player_records");
    await clear("F");
    await sleep(2000);
    ok("P2: tournament not completed while player awards fail", one("SELECT status FROM shared_tournaments WHERE id = ?", [t.id]).status === "active" && num("SELECT COUNT(*) n FROM tournament_summaries WHERE tournament_id = ?", [t.id]) === 0);
    ok("P2: nothing of the completion committed (bets, rewards, counters)", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'champion' AND settled = 1") === 0 && num("SELECT COUNT(*) n FROM reward_settlements WHERE kind = 'champion'") === 0 && num("SELECT COALESCE(SUM(championships),0) n FROM global_team_records") === champsBefore);
    checkInvariants("P2");

    // ===== Stage G: fault removed — the championship completes exactly once
    await clear("P2");
    await until("championship #1 complete", () => one("SELECT status FROM shared_tournaments WHERE id = ?", [t.id]).status === "complete");
    await sleep(1000);
    const t1 = one("SELECT * FROM shared_tournaments WHERE id = ?", [t.id]);
    ok("G: champion recorded", !!t1.champion_team);
    ok("G: champion bets all settled, exactly one winner", num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'champion' AND settled = 0") === 0 && num("SELECT COUNT(*) n FROM shared_bets WHERE market = 'champion' AND status = 'won'") === 1);
    ok("G: one champion reward, one finalist reward", num("SELECT COUNT(*) n FROM reward_settlements WHERE kind = 'champion'") === 1 && num("SELECT COUNT(*) n FROM reward_settlements WHERE kind = 'finalist'") === 1);
    ok("G: championship counted once", num("SELECT COALESCE(SUM(championships),0) n FROM global_team_records") === champsBefore + 1);
    ok("G: champion's players awarded once each", champPlayers > 0 && num("SELECT COALESCE(SUM(championships),0) n FROM global_player_records") === playerChampsBefore + champPlayers, `players=${champPlayers}`);
    ok("G: one tournament summary", num("SELECT COUNT(*) n FROM tournament_summaries WHERE tournament_id = ?", [t.id]) === 1);
    ok("G: no bet of championship #1 left open", num("SELECT COUNT(*) n FROM shared_bets WHERE tournament = ? AND settled = 0", [t.id]) === 0);
    ok("G: next championship drawn", num("SELECT COUNT(*) n FROM shared_tournaments WHERE status = 'active'") === 1);
    checkInvariants("G");

    // ===== Legacy: stranded bets on an already-progressed fixture (pre-v2 200-cap / tail failure)
    const oldFx = one("SELECT * FROM shared_fixtures WHERE id = ?", [fx[2].id]); // finished: winner known
    const stranded = await seedBets(
      Array.from({ length: 3 }, (_, i) => ({ user: u1.id, fixture: oldFx.id, round: r16.id, tournament: t.id, market: "", selection_team: i ? oldFx.winner_team : oldFx.home_team === oldFx.winner_team ? oldFx.away_team : oldFx.home_team, stake: 4, odds: 3, status: "locked" })),
    );
    const sweep1 = await req("/api/footfive/admin/recovery/run", "POST", adminTok);
    const sw = (sweep1.data.actions || []).find((a) => a.strandedBets);
    ok("legacy: recovery run settles stranded bets", sweep1.ok && sw && sw.strandedBets.settled === 3, JSON.stringify(sw));
    ok("legacy: 2 winners paid once, 1 loser", num("SELECT COUNT(*) n FROM shared_bets WHERE id IN (?,?,?) AND status = 'won'", stranded.map((b) => b.id)) === 2 && num("SELECT COUNT(*) n FROM shared_bets WHERE id IN (?,?,?) AND status = 'lost'", stranded.map((b) => b.id)) === 1);
    const sweep2 = await req("/api/footfive/admin/recovery/run", "POST", adminTok);
    const sw2 = (sweep2.data.actions || []).find((a) => a.strandedBets);
    ok("legacy: second sweep is a no-op", sw2 && sw2.strandedBets.settled === 0, JSON.stringify(sw2));
    checkInvariants("legacy stranded");

    // ===== Sweep progress: a not-yet-progressed fixture (>= one page of bets) and a
    // failing fixture, both ordered before a healthy one, must not starve it.
    // World paused so championship #2 stays where the legacy-resume stage expects it.
    await pause(true);
    const sweep = async () => {
      const res = await req("/api/footfive/admin/recovery/run", "POST", adminTok);
      return { res, sw: ((res.data.actions || []).find((a) => a.strandedBets) || {}).strandedBets };
    };
    const [fA, fB] = q("SELECT * FROM shared_fixtures WHERE id IN (?, ?, ?, ?, ?) ORDER BY id", fx.slice(3).map((f) => f.id));
    const betsOn = (f, n) =>
      Array.from({ length: n }, (_, i) => ({ user: i % 2 ? u1.id : u2.id, fixture: f.id, round: r16.id, tournament: t.id, market: "winner", selection: i % 2 ? "home" : "away", stake: 2, odds: 2, status: "locked" }));
    await write([["UPDATE match_states SET progression_settled = 0 WHERE fixture = ?", [fA.id]]]); // finished, progression not yet run
    const blockedBets = await seedBets(betsOn(fA, 201));
    const [healthy] = await seedBets(betsOn(fB, 1));
    const s1 = await sweep();
    ok("sweep: not-ready fixture's bets stay open (readiness guard)", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND settled = 0", [fA.id]) === 201);
    ok("sweep: healthy later fixture settles despite 201 not-ready bets before it", num("SELECT settled n FROM shared_bets WHERE id = ?", [healthy.id]) === 1, JSON.stringify(s1.sw));
    checkInvariants("sweep starvation");

    const [healthy2] = await seedBets(betsOn(fB, 1));
    await write([
      ["UPDATE match_states SET progression_settled = 1 WHERE fixture = ?", [fA.id]],
      [`CREATE TRIGGER inj_S BEFORE INSERT ON credit_ledger WHEN (SELECT fixture FROM shared_bets WHERE id || ':settle' = NEW.idempotency_key) = '${fA.id}' BEGIN SELECT RAISE(ABORT, 'injected:S'); END`, []],
    ]);
    const s2 = await sweep();
    ok("sweep: failing fixture rolled back whole (no bet of it settled)", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND settled = 1", [fA.id]) === 0);
    ok("sweep: failure isolated — later fixture still settles", num("SELECT settled n FROM shared_bets WHERE id = ?", [healthy2.id]) === 1, JSON.stringify(s2.sw));
    ok("sweep: failure reported, not swallowed", !!s2.sw && s2.sw.failed >= 1 && /injected:S/.test(JSON.stringify(s2.sw.errors)) && /strandedBets/.test(s2.res.data.error || ""), JSON.stringify(s2.res.data).slice(0, 400));
    checkInvariants("sweep failure");
    await clear("S");
    const s3 = await sweep();
    ok("sweep: fault removed — the failed fixture settles", num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND settled = 1", [fA.id]) === 201, JSON.stringify(s3.sw));
    const s4 = await sweep();
    ok("sweep: repeat is a no-op (no double payout)", s4.sw && s4.sw.settled === 0 && !s4.sw.failed, JSON.stringify(s4.sw));
    ok("sweep: blocked fixture's winners paid exactly once", num("SELECT COUNT(*) n FROM credit_ledger WHERE type = 'bet_win' AND idempotency_key IN (SELECT id || ':settle' FROM shared_bets WHERE fixture = ? AND status = 'won')", [fA.id]) === num("SELECT COUNT(*) n FROM shared_bets WHERE fixture = ? AND status = 'won'", [fA.id]) && blockedBets.length === 201);
    checkInvariants("sweep retry");
    await pause(false);

    // ===== Legacy: pre-v2 tail failure — R16 marked completed with no QF created
    t = activeT();
    await inject("L1", "shared_rounds", "INSERT");
    let l16 = null;
    await until("championship #2 R16 played", () => {
      l16 = roundOf(t.id, "r16");
      return l16 && num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [l16.id]) === 8;
    });
    await pause(true);
    // Emulate the pre-v2 commit: progression_done inside the transaction, the tail lost.
    await write([["UPDATE shared_rounds SET status = 'completed', progression_done = 1 WHERE id = ?", [l16.id]]]);
    await clear("L1");
    await sleep(500);
    ok("legacy: stalled completed round has no successor yet", !roundOf(t.id, "qf"));
    await pause(false);
    await until("legacy R16 resumed into QF", () => !!roundOf(t.id, "qf"));
    await sleep(500);
    ok("legacy: exactly one QF created by resume", num("SELECT COUNT(*) n FROM shared_rounds WHERE tournament = ? AND round_key = 'qf'", [t.id]) === 1);

    // ===== Legacy: pre-v2 tail failure on the final — tournament never closed
    await inject("L2", "tournament_summaries", "INSERT");
    let lf = null;
    await until("championship #2 final played", () => {
      lf = roundOf(t.id, "final");
      return lf && num("SELECT COUNT(*) n FROM shared_fixtures WHERE round = ? AND status = 'finished'", [lf.id]) === 1;
    }, 120000);
    await pause(true);
    // Pre-v2 ran the champion counters/reward before the failing tournament save.
    const champ2 = one("SELECT winner_team FROM shared_fixtures WHERE round = ?", [lf.id]).winner_team;
    const champs2Before = num("SELECT COALESCE(championships,0) n FROM global_team_records WHERE team = ?", [champ2]);
    await write([["UPDATE shared_rounds SET status = 'completed', progression_done = 1 WHERE id = ?", [lf.id]]]);
    await clear("L2");
    await pause(false);
    await until("legacy final resumed", () => one("SELECT status FROM shared_tournaments WHERE id = ?", [t.id]).status === "complete");
    await sleep(500);
    const t2 = one("SELECT * FROM shared_tournaments WHERE id = ?", [t.id]);
    ok("legacy: resumed final records the champion", t2.champion_team === champ2);
    ok("legacy: ruling — championship counter not re-run on resume", num("SELECT COALESCE(championships,0) n FROM global_team_records WHERE team = ?", [champ2]) === champs2Before);
    ok("legacy: tournament summary written once", num("SELECT COUNT(*) n FROM tournament_summaries WHERE tournament_id = ?", [t.id]) === 1);
    ok("legacy: next championship drawn after resume", num("SELECT COUNT(*) n FROM shared_tournaments WHERE status = 'active'") === 1);
    checkInvariants("legacy resume");
    await stop();

    // ===== Migration 17 preflight: duplicate keys fail closed, nothing modified
    const pre = path.join(work, "pre17");
    mkdirSync(path.join(pre, "migrations"), { recursive: true });
    const migDir = path.join(ROOT, "pocketbase", "pb_migrations");
    for (const f of readdirSync(migDir)) if (!f.startsWith("1750000017")) copyFileSync(path.join(migDir, f), path.join(pre, "migrations", f));
    const preData = path.join(pre, "pb_data");
    const mig = (dir) => spawnSync(PB_BIN, ["migrate", "up", `--dir=${preData}`, `--migrationsDir=${dir}`], { encoding: "utf8" });
    ok("preflight: base schema migrates (pre-17)", mig(path.join(pre, "migrations")).status === 0);
    DB = path.join(preData, "data.db");
    const now = new Date().toISOString().replace("T", " ");
    sqlMany([
      ["DROP INDEX idx_credit_ledger_idem", []], // a database that lost the raw index
      ["INSERT INTO credit_ledger (id, created, user, type, amount, description, idempotency_key) VALUES ('dupa00000000001', ?, 'u', 'bet_win', 5, 'x', 'dup:key')", [now]],
      ["INSERT INTO credit_ledger (id, created, user, type, amount, description, idempotency_key) VALUES ('dupa00000000002', ?, 'u', 'bet_win', 5, 'x', 'dup:key')", [now]],
    ]);
    const before = JSON.stringify(q("SELECT * FROM credit_ledger ORDER BY id"));
    const bad = mig(migDir);
    // `pocketbase migrate up` (and `serve`, which then refuses to start) exit 0 on a
    // failed migration, so assert on the error and the _migrations record instead.
    ok("preflight: migration 17 refuses duplicate keys", /duplicate idempotency keys \(dup:key x2\)/.test(bad.stdout + bad.stderr), (bad.stdout + bad.stderr).slice(-300));
    ok("preflight: ledger rows unchanged", JSON.stringify(q("SELECT * FROM credit_ledger ORDER BY id")) === before);
    ok("preflight: migration not recorded", num("SELECT COUNT(*) n FROM _migrations WHERE file LIKE '1750000017%'") === 0);
    q("UPDATE credit_ledger SET idempotency_key = 'dup:key:reconciled' WHERE id = 'dupa00000000002'"); // operator reconciliation
    ok("preflight: applies once duplicates are reconciled", mig(migDir).status === 0 && num("SELECT COUNT(*) n FROM _migrations WHERE file LIKE '1750000017%'") === 1);
    ok("preflight: index then enforced", (() => {
      try {
        q("INSERT INTO credit_ledger (id, created, user, type, amount, description, idempotency_key) VALUES ('dupa00000000003', ?, 'u', 'bet_win', 5, 'x', 'dup:key')", [now]);
        return false;
      } catch (e) {
        return /UNIQUE/.test(String(e));
      }
    })());

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    await stop();
  } catch {
    /* already stopped */
  }
  process.exitCode = 1;
});
