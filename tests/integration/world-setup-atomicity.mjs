/**
 * World setup is all-or-nothing and partial legacy setup is repaired (issue #16, review B17).
 * Runs against a REAL disposable PocketBase (temp data dir, never production data).
 *
 *   node tests/integration/world-setup-atomicity.mjs
 *
 * Env: WORLD_SETUP_PB_PORT (default 8296), WORLD_SETUP_HOOKS (hooks dir under test,
 * default pocketbase/pb_hooks — point it at an older checkout for red-on-base evidence),
 * WORLD_SETUP_ROUNDS_ONLY=1 (skip the S1 team faults so S2–S5 run on their own).
 *
 * Failures are injected between writes by a test-only onRecordCreate hook added to a
 * temp copy of the hooks dir: while the fault file exists, creating more than `after`
 * records of `collection` throws. Each scenario proves nothing partial is committed,
 * then disarms the fault and proves the retry completes setup without touching rows
 * that already existed.
 *
 * Covered:
 *   S1 fresh install: a team failing between its players and record leaves no partial team;
 *      a legacy team row without squad/record is completed on retry, keeping its id
 *   S2 championship creation failing between fixtures leaves no tournament/round/fixtures
 *   S3 legacy R16 round with missing fixtures → completed at kick-off, placed teams kept
 *   S4 legacy completed round without its successor → next round built from its winners
 *   S5 legacy championship with no round → repaired with the same tournament
 *   S6 completed R16 + empty scheduled QF (issue15 parked shape) → QF repaired and kicked off
 *   S7 scheduled partial round with an already-live fixture → played state/events/RNG preserved
 *   S8 scheduled partial round with a persisted v1 finished result → never restarted as v2
 *   S9 kick-off failing at the second match state commits nothing (states, lineups, AI
 *      condition/treasury repair and its ledger row, overclock flag, fixture status)
 *   S10 kick-off failing at the final round-live update rolls back every earlier write;
 *      the retry kicks off once, with exactly one state per fixture
 *   S11 a live or finished fixture without a state fails closed: the slot repair and every
 *      other kick-off write roll back and the retained rows stay byte-identical
 *
 * The fault spec may instead name {op: "update", field, value}: updating a record of
 * `collection` whose `field` becomes `value` throws once more than `after` have passed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PB_BIN = path.join(ROOT, "pocketbase", "pocketbase");
const PORT = Number(process.env.WORLD_SETUP_PB_PORT || 8296);
const BASE = `http://127.0.0.1:${PORT}`;
const HOOKS_SRC = process.env.WORLD_SETUP_HOOKS || path.join(ROOT, "pocketbase/pb_hooks");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ff-world-setup-"));
const DATA = path.join(TMP, "pb_data");
const HOOKS = path.join(TMP, "pb_hooks");
const FAULT = path.join(TMP, "fault.json");
const ROUNDS_ONLY = process.env.WORLD_SETUP_ROUNDS_ONLY === "1";

const FAULT_HOOK = `
onRecordCreate((e) => {
  let spec = null;
  try {
    spec = JSON.parse(toString($os.readFile($os.getenv("FF_FAULT_FILE"))));
  } catch (_) {}
  if (spec && (spec.op || "create") === "create" && spec.collection === e.record.collection().name) {
    const key = "ff_fault_" + spec.id;
    const n = ($app.store().get(key) || 0) + 1;
    $app.store().set(key, n);
    if (n > spec.after) throw new Error("injected fault: " + spec.collection + " create #" + n);
  }
  e.next();
});
onRecordUpdate((e) => {
  let spec = null;
  try {
    spec = JSON.parse(toString($os.readFile($os.getenv("FF_FAULT_FILE"))));
  } catch (_) {}
  if (spec && spec.op === "update" && spec.collection === e.record.collection().name && e.record.get(spec.field) === spec.value) {
    const key = "ff_fault_" + spec.id;
    const n = ($app.store().get(key) || 0) + 1;
    $app.store().set(key, n);
    if (n > spec.after) throw new Error("injected fault: " + spec.collection + " update #" + n);
  }
  e.next();
});
`;

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ok -", msg);
  else {
    failures += 1;
    console.error("  FAIL -", msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
async function startPb() {
  child = spawn(
    PB_BIN,
    ["serve", `--http=127.0.0.1:${PORT}`, `--dir=${DATA}`, `--hooksDir=${HOOKS}`, `--migrationsDir=${path.join(ROOT, "pocketbase/pb_migrations")}`],
    { env: { ...process.env, FOOTFIVE_TIME_SCALE: "1", FF_FAULT_FILE: FAULT }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const logFile = fs.createWriteStream(path.join(TMP, "pb.log"), { flags: "a" });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(BASE + "/api/health")).status === 200) return;
    } catch {}
    if (Date.now() - t0 > 30000) throw new Error("PocketBase did not become healthy");
    await sleep(200);
  }
}
async function stopPb() {
  if (!child) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await exited;
  child = null;
}

/** Advance the world the way the app does: the public health read ticks (throttled to 1/s). */
async function tick(times = 3) {
  for (let i = 0; i < times; i++) {
    await fetch(BASE + "/api/footfive/health").catch(() => {});
    await sleep(1100);
  }
}

function arm(collection, after, id, extra = {}) {
  fs.writeFileSync(FAULT, JSON.stringify({ collection, after, id, ...extra }));
}
const pbLog = () => fs.readFileSync(path.join(TMP, "pb.log"), "utf8");
function disarm() {
  fs.rmSync(FAULT, { force: true });
}

function q(sql, ...params) {
  const d = new DatabaseSync(path.join(DATA, "data.db"));
  try {
    return d.prepare(sql).all(...params);
  } finally {
    d.close();
  }
}
function exec(sql, ...params) {
  const d = new DatabaseSync(path.join(DATA, "data.db"));
  try {
    d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}
const n = (table, where = "1=1", ...p) => q(`select count(*) c from ${table} where ${where}`, ...p)[0].c;

/** Every team has the same non-empty squad and exactly one record. */
function teamsWhole() {
  const rows = q(
    `select t.id, (select count(*) from proball_players p where p.team = t.id) players,
            (select count(*) from global_team_records r where r.team = t.id) records
       from proball_teams t`,
  );
  const squad = rows.length ? rows[0].players : 0;
  return { count: rows.length, whole: rows.every((r) => r.players === squad && squad >= 5 && r.records === 1), rows };
}

/** Every row a kick-off may write (world lease bookkeeping excluded), for byte-exact comparison. */
const SETUP_TABLES = ["shared_tournaments", "shared_rounds", "shared_fixtures", "match_states", "match_events", "proball_teams", "proball_players", "global_team_records", "team_finance_ledger"];
const setupRows = () => JSON.stringify(SETUP_TABLES.map((table) => q(`select * from ${table} order by id`)));

function r16Of(tournamentId) {
  return q("select * from shared_rounds where tournament = ? and round_key = 'r16'", tournamentId)[0];
}
function fixturesOf(roundId) {
  return q("select * from shared_fixtures where round = ? order by bracket_index", roundId);
}

const PAST = new Date(Date.now() - 60000).toISOString().replace("T", " ");

async function main() {
  console.log(`== world setup atomicity ==\nport ${PORT}, hooks ${HOOKS_SRC}, tmp ${TMP}`);
  fs.cpSync(HOOKS_SRC, HOOKS, { recursive: true });
  fs.writeFileSync(path.join(HOOKS, "zz_fault_injection.pb.js"), FAULT_HOOK);
  fs.mkdirSync(DATA, { recursive: true });

  let teams;
  let firstTeams = [];
  if (ROUNDS_ONLY) {
    await startPb();
  } else {
    console.log("S1 fresh install, failure between a team's players");
    arm("proball_players", 10, "s1"); // the second team fails after 3 of its players
    await startPb();
    await tick();
    teams = teamsWhole();
    ok(teams.count >= 1 && teams.count < 16, `setup stopped at the fault (teams=${teams.count})`);
    ok(teams.whole, "no team committed without its full squad and record: " + JSON.stringify(teams.rows.map((r) => [r.players, r.records])));
    ok(n("shared_tournaments") === 0, "no championship created while teams are incomplete");
    firstTeams = q("select id from proball_teams order by sort_order").map((r) => r.id);
    // A pre-transaction build could leave a team row without its squad and record.
    await stopPb();
    exec("delete from proball_players where team = ?", firstTeams[0]);
    exec("delete from global_team_records where team = ?", firstTeams[0]);
    await startPb();
  }

  console.log("S2 championship creation fails between fixtures");
  arm("shared_fixtures", 3, "s2");
  await tick();
  teams = teamsWhole();
  ok(teams.count === 16 && teams.whole, `retry completed all 16 teams, incl. the legacy partial one (teams=${teams.count})`);
  ok(
    firstTeams.every((id) => q("select id from proball_teams where id = ?", id).length === 1),
    "teams created before the fault keep their ids",
  );
  ok(n("shared_tournaments") === 0 && n("shared_rounds") === 0 && n("shared_fixtures") === 0, "failed championship left no tournament, round or fixture");
  disarm();
  await tick();
  ok(n("shared_tournaments") === 1, "retry created exactly one championship");
  const t = q("select * from shared_tournaments")[0];
  if (!t) throw new Error("no championship to continue with");
  const r16 = r16Of(t.id);
  let fxs = r16 ? fixturesOf(r16.id) : [];
  ok(fxs.length === 8, "retry created the R16 round with 8 fixtures");
  ok(t.odds_json && t.odds_json !== "null", "championship odds written with the draw");

  console.log("S3 legacy R16 round with missing fixtures, due to kick off");
  await stopPb();
  const kept = fxs.slice(0, 4);
  exec("delete from shared_fixtures where round = ? and bracket_index >= 4", r16.id);
  exec("update shared_rounds set scheduled_at = ? where id = ?", PAST, r16.id);
  exec("update shared_fixtures set scheduled_at = ? where round = ?", PAST, r16.id);
  arm("shared_fixtures", 1, "s3");
  await startPb();
  await tick();
  ok(q("select status from shared_rounds where id = ?", r16.id)[0].status === "scheduled", "round with missing fixtures did not kick off while repair fails");
  ok(fixturesOf(r16.id).length === 4 && n("match_states") === 0, "failed repair committed no fixture and no match state");
  disarm();
  await tick();
  fxs = fixturesOf(r16.id);
  ok(q("select status from shared_rounds where id = ?", r16.id)[0].status === "live", "repaired round kicked off");
  ok(fxs.length === 8 && n("match_states") === 8, "all 8 fixtures present with match states");
  ok(new Set(fxs.flatMap((f) => [f.home_team, f.away_team])).size === 16, "every team plays exactly once");
  ok(
    kept.every((k) => fxs.some((f) => f.id === k.id && f.slot === k.slot && f.home_team === k.home_team && f.away_team === k.away_team)),
    "existing fixtures kept their ids, slots and teams",
  );

  console.log("S4 legacy completed round without the next round");
  await stopPb();
  exec("update shared_fixtures set status = 'finished', winner_team = home_team, finished_ms = ? where round = ?", Date.now() - 1000, r16.id);
  exec("update match_states set finalised = 1");
  exec("update shared_rounds set status = 'completed', progression_done = 1 where id = ?", r16.id);
  const played = () => JSON.stringify([fixturesOf(r16.id), q("select * from match_states order by id"), q("select * from match_events order by id")]);
  const before = played();
  arm("shared_fixtures", 1, "s4");
  await startPb();
  await tick();
  ok(n("shared_rounds", "tournament = ?", t.id) === 1, "failed repair left no partial quarter-final round");
  disarm();
  await tick();
  const qf = q("select * from shared_rounds where tournament = ? and round_key = 'qf'", t.id)[0];
  const qfx = qf ? fixturesOf(qf.id) : [];
  const won = Object.fromEntries(fixturesOf(r16.id).map((f) => [f.slot, f.winner_team]));
  ok(qf && qf.status === "scheduled" && qfx.length === 4, "quarter-final round created with 4 fixtures");
  ok(
    qfx.length === 4 &&
      qfx.every((f, i) => f.home_team === won[`R16_${2 * i + 1}`] && f.away_team === won[`R16_${2 * i + 2}`]),
    "quarter-finals pair the R16 winners by bracket",
  );
  ok(q("select current_round from shared_tournaments where id = ?", t.id)[0].current_round === "qf", "championship advanced to qf");
  ok(played() === before, "played R16 fixtures, match states and events untouched");

  console.log("S6 parked issue15 exact shape: completed R16 + empty scheduled QF");
  await stopPb();
  const migrationsBefore = JSON.stringify(q("select * from _migrations order by file"));
  exec("delete from shared_fixtures where round = ?", qf.id);
  exec("update shared_rounds set scheduled_at = ? where id = ?", PAST, qf.id);
  await startPb();
  await tick();
  ok(fixturesOf(qf.id).length === 4 && q("select status from shared_rounds where id = ?", qf.id)[0].status === "live", "empty scheduled QF repaired and kicked off with all 4 fixtures");
  ok(JSON.stringify(fixturesOf(r16.id)) === JSON.stringify(JSON.parse(before)[0]), "played R16 fixture rows untouched by empty QF repair");
  ok(JSON.stringify(q("select * from _migrations order by file")) === migrationsBefore, "applied migration history unchanged across repair");

  // Review finding R1: repair of a scheduled partial round must not reinitialise fixtures
  // that already started or finished (reviewer extra-probe.mjs repro, kept byte-exact).
  console.log("S7 scheduled partial round preserves an already-live fixture");
  await stopPb();
  const live = fixturesOf(qf.id)[0];
  const msBefore = q("select * from match_states where fixture = ?", live.id)[0];
  const fxBefore = q("select * from shared_fixtures where id = ?", live.id)[0];
  const evBefore = q("select * from match_events where fixture = ? order by seq", live.id);
  ok(evBefore.length > 0, "retained fixture has real published engine events");
  exec("delete from match_events where fixture in (select id from shared_fixtures where round = ? and id != ?)", qf.id, live.id);
  exec("delete from match_states where fixture in (select id from shared_fixtures where round = ? and id != ?)", qf.id, live.id);
  exec("delete from shared_fixtures where round = ? and id != ?", qf.id, live.id);
  exec("update shared_rounds set status = 'scheduled' where id = ?", qf.id);
  // Freeze advancement to isolate kickoff overwrite from normal engine evolution.
  const state = JSON.parse(msBefore.state_json); state.nextAt = Date.now() + 3600000;
  exec("update match_states set state_json = ? where fixture = ?", JSON.stringify(state), live.id);
  const frozenBefore = q("select * from match_states where fixture = ?", live.id)[0];
  await startPb();
  await tick();
  const frozenAfter = q("select * from match_states where fixture = ?", live.id)[0];
  console.log("PRESERVATION", JSON.stringify({fixture:live.id,beforeSeed:frozenBefore.seed,afterSeed:frozenAfter.seed,beforeState:JSON.parse(frozenBefore.state_json),afterState:JSON.parse(frozenAfter.state_json),beforeEvents:evBefore.length,afterEvents:q("select * from match_events where fixture = ?",live.id).length}));
  ok(frozenAfter.state_json === frozenBefore.state_json && frozenAfter.id === frozenBefore.id, "played match state and RNG/timing snapshot preserved during incomplete scheduled round repair");
  ok(JSON.stringify(q("select * from shared_fixtures where id = ?", live.id)[0]) === JSON.stringify(fxBefore), "played fixture row bytes preserved (lineups, status, result)");
  ok(evBefore.every(e => JSON.stringify(q("select * from match_events where id = ?", e.id)[0]) === JSON.stringify(e)), "existing event IDs and bytes preserved");
  ok(fixturesOf(qf.id).length === 4, "mixed round has all expected fixtures after retry");
  ok(fixturesOf(qf.id).filter((f) => f.id !== live.id).every((f) => f.status === "live" && q("select count(*) c from match_states where fixture = ?", f.id)[0].c === 1), "genuinely unstarted fixtures were initialised");

  // Reviewer legacy-preservation-probe.mjs repro: a persisted v1 finished result inside a
  // scheduled partial parent must never be restarted as a fresh v2 match.
  console.log("S8 scheduled partial round preserves a persisted v1 finished result");
  await stopPb();
  exec("delete from match_events where fixture in (select id from shared_fixtures where round = ? and id != ?)", qf.id, live.id);
  exec("delete from match_states where fixture in (select id from shared_fixtures where round = ? and id != ?)", qf.id, live.id);
  exec("delete from shared_fixtures where round = ? and id != ?", qf.id, live.id);
  exec("update shared_rounds set status = 'scheduled' where id = ?", qf.id);
  exec("update match_states set sim_version = 1, finalised = 1, progression_settled = 1, winner_team = ?, events_json = ? where fixture = ?", live.home_team, JSON.stringify([{seq:1,type:"goal",scoreHome:2,scoreAway:0}]), live.id);
  exec("update shared_fixtures set status = 'finished', winner_team = home_team, score_home = 2, score_away = 0, finished_ms = ? where id = ?", Date.now()-1000, live.id);
  const v1Before = q("select * from match_states where fixture = ?", live.id)[0];
  const v1FxBefore = q("select * from shared_fixtures where id = ?", live.id)[0];
  await startPb();
  await tick();
  const v1After = q("select * from match_states where fixture = ?", live.id)[0];
  console.log("PRESERVATION", JSON.stringify({fixture:live.id,beforeVersion:v1Before.sim_version,afterVersion:v1After.sim_version,beforeFinalised:v1Before.finalised,afterFinalised:v1After.finalised,beforeSeed:v1Before.seed,afterSeed:v1After.seed,beforeState:JSON.parse(v1Before.state_json),afterState:JSON.parse(v1After.state_json),beforeEvents:evBefore.length,afterEvents:q("select * from match_events where fixture = ?",live.id).length}));
  ok(v1After.state_json === v1Before.state_json && v1After.events_json === v1Before.events_json && v1After.sim_version === v1Before.sim_version && v1After.finalised === v1Before.finalised && v1After.id === v1Before.id, "persisted v1 finished result preserved (not restarted as v2)");
  ok(JSON.stringify(q("select * from shared_fixtures where id = ?", live.id)[0]) === JSON.stringify(v1FxBefore), "finished fixture row bytes preserved (result untouched)");
  ok(evBefore.every(e => JSON.stringify(q("select * from match_events where id = ?", e.id)[0]) === JSON.stringify(e)), "existing event IDs and bytes preserved");
  ok(fixturesOf(qf.id).length === 4, "mixed round has all expected fixtures after retry");

  console.log("S5 legacy championship with no round");
  await stopPb();
  exec("delete from match_events");
  exec("delete from match_states");
  exec("delete from shared_fixtures where tournament = ?", t.id);
  exec("delete from shared_rounds where tournament = ?", t.id);
  exec("update shared_tournaments set current_round = 'r16', odds_json = NULL where id = ?", t.id);
  arm("shared_fixtures", 2, "s5");
  await startPb();
  await tick();
  ok(n("shared_tournaments") === 1 && q("select id from shared_tournaments")[0].id === t.id, "same single championship kept");
  ok(n("shared_rounds") === 0 && n("shared_fixtures") === 0, "failed repair left no round or fixture");
  disarm();
  await tick();
  const again = r16Of(t.id);
  fxs = again ? fixturesOf(again.id) : [];
  ok(n("shared_tournaments") === 1, "repair did not start another championship");
  ok(again && again.status === "scheduled" && fxs.length === 8, "repair created the missing R16 round with 8 fixtures");
  ok(new Set(fxs.flatMap((f) => [f.home_team, f.away_team])).size === 16, "all 16 teams drawn once");
  ok(q("select odds_json from shared_tournaments where id = ?", t.id)[0].odds_json, "championship odds written with the repaired draw");

  console.log("S9 kick-off fails creating the second match state");
  await stopPb();
  exec("update shared_rounds set scheduled_at = ? where id = ?", PAST, again.id);
  exec("update shared_fixtures set scheduled_at = ? where round = ?", PAST, again.id);
  // Make the first fixture write AI repair, ledger and overclock rows before the fault.
  const first = fixturesOf(again.id)[0];
  const tired = q("select id from proball_players where team = ? order by sort_order limit 1", first.home_team)[0].id;
  exec("update proball_teams set overclock_ready = 1, treasury = 2500 where id = ?", first.home_team);
  exec("update proball_players set condition = 40 where id = ?", tired);
  const ready = setupRows();
  arm("match_states", 1, "s9");
  let logAt = 0;
  await startPb();
  await tick();
  ok(pbLog().includes("injected fault: match_states create #2"), "fault hit the second match state, after the first fixture's writes");
  ok(setupRows() === ready, "nothing committed: no state, lineup, AI repair, ledger, overclock or fixture change; round still scheduled");

  console.log("S10 kick-off fails at the final round-live update");
  logAt = pbLog().length;
  arm("shared_rounds", 0, "s10", { op: "update", field: "status", value: "live" });
  await tick();
  ok(pbLog().slice(logAt).includes("injected fault: shared_rounds update #1"), "fault hit the round-live update, after every fixture's writes");
  ok(setupRows() === ready, "every earlier kick-off write rolled back with the round update");
  disarm();
  await tick();
  const kicked = fixturesOf(again.id);
  ok(q("select status from shared_rounds where id = ?", again.id)[0].status === "live", "retry kicked the round off");
  ok(
    kicked.length === 8 && n("match_states") === 8 &&
      kicked.every((f) => f.status === "live" && f.lineups_frozen === 1 && n("match_states", "fixture = ?", f.id) === 1),
    "retry created exactly one engine state per fixture and froze every lineup",
  );
  const boosted = q("select overclock_ready, overclock_fixture from proball_teams where id = ?", first.home_team)[0];
  ok(boosted.overclock_ready === 0 && boosted.overclock_fixture === first.id, "overclock consumed once, by the first fixture");
  ok(
    q("select condition from proball_players where id = ?", tired)[0].condition > 40 &&
      n("team_finance_ledger", "team = ? and type = 'ai_repair'", first.home_team) === 1,
    "AI repair committed exactly once, with one ledger row",
  );

  console.log("S11 fixture marked live/finished without a state fails closed");
  for (const status of ["live", "finished"]) {
    await stopPb();
    exec("delete from match_events");
    exec("delete from match_states");
    exec("delete from shared_fixtures where round = ? and bracket_index >= 6", again.id);
    exec("update shared_fixtures set status = 'scheduled' where round = ?", again.id);
    const mixed = fixturesOf(again.id)[5];
    exec("update shared_fixtures set status = ? where id = ?", status, mixed.id);
    exec("update shared_rounds set status = 'scheduled' where id = ?", again.id);
    const retained = setupRows();
    logAt = pbLog().length;
    await startPb();
    await tick();
    ok(pbLog().slice(logAt).includes("kickoff_fixture_mixed: " + mixed.id), `${status} fixture without a state stopped the kick-off`);
    ok(fixturesOf(again.id).length === 6, `${status}: slot repair rolled back (missing fixtures not committed)`);
    ok(setupRows() === retained, `${status}: no state, lineup or round change committed; retained rows byte-identical`);
  }
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error("  FAIL - aborted:", err);
} finally {
  disarm();
  await stopPb();
  if (failures) console.error(`pb log kept at ${path.join(TMP, "pb.log")}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
