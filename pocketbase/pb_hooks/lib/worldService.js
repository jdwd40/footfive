/**
 * FootFive shared world — championship lifecycle, match ticking, publication.
 *
 * Truth model
 *   match_states.state_json   private engine state (never exposed)
 *   match_events              one row per event; public once at <= now
 *   shared_fixtures           public summary, written only when the result is public
 *
 * tick(now) is idempotent and safe to call from any request or cron: every step
 * re-reads its rows inside a write transaction (SQLite serialises writers), so two
 * concurrent ticks cannot double-advance a match, double-settle or double-create.
 */
var teamsMod, tourneyMod, eng, balMod, mgmtMod, recMod, oddsMod, mkt, betMod;
try {
  teamsMod = require(__hooks + "/lib/teams.js");
  tourneyMod = require(__hooks + "/lib/tournament.js");
  eng = require(__hooks + "/lib/matchEngine.js");
  balMod = require(__hooks + "/lib/balance.js");
  mgmtMod = require(__hooks + "/lib/managementService.js");
  recMod = require(__hooks + "/lib/recordsService.js");
  oddsMod = require(__hooks + "/lib/odds.js");
  mkt = require(__hooks + "/lib/markets.js");
  betMod = require(__hooks + "/lib/bettingService.js");
} catch (e) {
  teamsMod = require("./teams.js");
  tourneyMod = require("./tournament.js");
  eng = require("./matchEngine.js");
  balMod = require("./balance.js");
  mgmtMod = require("./managementService.js");
  recMod = require("./recordsService.js");
  oddsMod = require("./odds.js");
  mkt = require("./markets.js");
  betMod = require("./bettingService.js");
}

var BALANCE = balMod.BALANCE;
var ROUND_LABELS = tourneyMod.ROUND_LABELS;
var ROUND_ORDER = tourneyMod.ROUND_ORDER;
var BRACKET = tourneyMod.BRACKET;

// ------------------------------------------------------------------ helpers

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function parsePbDate(v) {
  if (v == null || v === "") return NaN;
  var s = String(v).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  return new Date(s).getTime();
}

/** Legacy-tolerant JSON field reader (goja may hand back byte arrays). */
function parseJson(val, fallback) {
  if (val == null || val === "") return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (_) {
      return fallback;
    }
  }
  if (Array.isArray(val) && val.length > 2 && typeof val[0] === "number") {
    try {
      return JSON.parse(String.fromCharCode.apply(null, val));
    } catch (_) {}
  }
  try {
    return JSON.parse(JSON.stringify(val));
  } catch (_) {
    return fallback;
  }
}

function readJson(rec, key, fallback) {
  try {
    var s = rec.getString(key);
    if (s && s !== "null") return JSON.parse(s);
  } catch (_) {}
  return parseJson(rec.get(key), fallback);
}

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function log(event, fields) {
  try {
    var o = { ts: new Date().toISOString(), level: "info", event: event, app: "footfive" };
    for (var k in fields || {}) o[k] = fields[k];
    console.log("[footfive-json] " + JSON.stringify(o));
  } catch (_) {}
}

/** FOOTFIVE_TIME_SCALE (env) divides every duration — accelerated tests only. */
function timeScale() {
  try {
    var s = parseFloat($os.getenv("FOOTFIVE_TIME_SCALE"));
    return s > 0 ? s : 1;
  } catch (_) {
    return 1;
  }
}

function intIn(v, lo, hi, dflt) {
  var n = parseInt(v, 10);
  return isNaN(n) || n < lo || n > hi ? dflt : n;
}

/** All wall-clock timing for the world, from admin settings. */
function timing(world) {
  var k = timeScale();
  var minuteSec = intIn(world.get("match_minute_real_seconds"), 1, 60, BALANCE.matchMinuteRealSeconds || 15);
  var between = intIn(world.get("between_round_minutes"), 1, 1440, 1);
  var gap = intIn(world.get("championship_gap_minutes"), 1, 1440, 10);
  var win = Math.min(intIn(world.get("fixtures_window_minutes"), 1, 1440, 5), gap);
  return {
    scale: k,
    minuteSec: minuteSec,
    minuteMs: (minuteSec * 1000) / k,
    betweenMs: (between * 60000) / k,
    gapMs: (gap * 60000) / k,
    windowMs: (win * 60000) / k,
    betweenMinutes: between,
    gapMinutes: gap,
    windowMinutes: win,
  };
}

function one($app, col, filter, sort, params) {
  var rows = $app.findRecordsByFilter(col, filter, sort || "", 1, 0, params || {});
  return rows && rows.length ? rows[0] : null;
}

function all($app, col, filter, sort, params, limit) {
  return $app.findRecordsByFilter(col, filter, sort || "", limit || 200, 0, params || {}) || [];
}

// ------------------------------------------------------------------ world & teams

function isSchemaReady($app) {
  var need = ["world", "proball_teams", "proball_players", "shared_tournaments", "shared_rounds", "shared_fixtures", "match_states", "match_events", "global_team_records"];
  for (var i = 0; i < need.length; i++) {
    try {
      $app.findCollectionByNameOrId(need[i]);
    } catch (_) {
      return false;
    }
  }
  return true;
}

function ensureWorld($app) {
  if (!isSchemaReady($app)) throw new Error("schema_not_ready");
  var w = one($app, "world", "key = 'main'");
  if (w) return w;
  ensureTeams($app);
  var rec = new Record($app.findCollectionByNameOrId("world"));
  rec.set("key", "main");
  rec.set("pace", "normal");
  rec.set("between_round_minutes", 1);
  rec.set("round_interval_ms", 60000);
  rec.set("championship_gap_minutes", 10);
  rec.set("fixtures_window_minutes", 5);
  rec.set("match_minute_real_seconds", BALANCE.matchMinuteRealSeconds || 15);
  rec.set("match_minute_real_ms", (BALANCE.matchMinuteRealSeconds || 15) * 1000);
  rec.set("processing_status", "idle");
  rec.set("retention_days", 30);
  rec.set("progression_paused", false);
  try {
    $app.save(rec);
  } catch (err) {
    var again = one($app, "world", "key = 'main'"); // unique key: a concurrent create won
    if (again) return again;
    throw err;
  }
  return rec;
}

function ensureTeams($app) {
  var existing = all($app, "proball_teams", "id != ''", "sort_order", {}, 50);
  if (existing.length >= 16) return existing;
  var TEAMS = teamsMod.TEAMS;
  var created = [];
  for (var i = 0; i < TEAMS.length; i++) {
    var t = TEAMS[i];
    var found = one($app, "proball_teams", "slug = {:s}", "", { s: t.slug });
    if (found) {
      created.push(found);
      continue;
    }
    var team = new Record($app.findCollectionByNameOrId("proball_teams"));
    team.set("slug", t.slug);
    team.set("name", t.name);
    team.set("abbreviation", t.abbreviation);
    team.set("grade", t.grade);
    team.set("strength", BALANCE.gradeStrength[t.grade] || 60);
    team.set("primary_color", t.primary);
    team.set("secondary_color", t.secondary);
    team.set("badge_key", t.badge);
    team.set("eliminated", false);
    team.set("sort_order", i + 1);
    team.set("treasury", BALANCE.startingTreasury || 2500);
    team.set("battery_count", 2);
    team.set("overclock_ready", false);
    $app.save(team);
    created.push(team);
    var players = tourneyMod.defaultStarters(t.players || []);
    for (var p = 0; p < players.length; p++) {
      var pr = new Record($app.findCollectionByNameOrId("proball_players"));
      pr.set("team", team.id);
      pr.set("name", players[p].name);
      pr.set("role", players[p].role || "util");
      pr.set("attack", players[p].attack || 50);
      pr.set("defence", players[p].defence || 50);
      pr.set("energy", 100);
      pr.set("condition", 100);
      pr.set("is_starter", !!players[p].is_starter);
      pr.set("intensity", "balanced");
      pr.set("sort_order", p);
      $app.save(pr);
    }
    var tr = new Record($app.findCollectionByNameOrId("global_team_records"));
    tr.set("team", team.id);
    ["played", "wins", "draws", "losses", "goals_for", "goals_against", "shootout_wins", "shootout_losses", "championships"].forEach(function (f) {
      tr.set(f, 0);
    });
    $app.save(tr);
  }
  return created;
}

function teamPublic(t, managerName) {
  var abbr = String(t.get("abbreviation") || "").toUpperCase();
  if (!abbr) {
    var tmpl = teamsMod.getTeamBySlug(t.get("slug"));
    abbr = tmpl ? tmpl.abbreviation : String(t.get("name") || "").slice(0, 3).toUpperCase();
  }
  return {
    id: t.id,
    name: t.get("name"),
    abbreviation: abbr,
    grade: t.get("grade"),
    primary_color: t.get("primary_color"),
    secondary_color: t.get("secondary_color"),
    badge_key: t.get("badge_key"),
    strength: t.get("strength"),
    managerId: t.get("manager") || null,
    managerName: managerName || null,
    available: !t.get("manager"),
    eliminated: !!t.get("eliminated"),
    slug: t.get("slug"),
    mode: t.get("manager") ? t.get("manager_mode") || "manual" : "ai",
  };
}

function teamMap($app) {
  var rows = all($app, "proball_teams", "id != ''", "sort_order", {}, 50);
  var m = {};
  for (var i = 0; i < rows.length; i++) m[rows[i].id] = rows[i];
  return m;
}

function getManagerTeam($app, userId) {
  return userId ? one($app, "proball_teams", "manager = {:u}", "", { u: userId }) : null;
}

function listTeams($app) {
  ensureTeams($app);
  var teams = all($app, "proball_teams", "id != ''", "sort_order", {}, 50);
  var out = [];
  for (var i = 0; i < teams.length; i++) {
    var name = null;
    if (teams[i].get("manager")) {
      try {
        name = $app.findRecordById("users", teams[i].get("manager")).get("display_name") || "Manager";
      } catch (_) {
        name = "Manager";
      }
    }
    out.push(teamPublic(teams[i], name));
  }
  return out;
}

// ------------------------------------------------------------------ engine inputs

/**
 * Team snapshot for the engine. AI-controlled sides (unmanaged or Full AI) pick their
 * five from fitness without touching the manager's saved lineup.
 */
function engineTeam($app, team) {
  var snap = mgmtMod.loadTeamSnapshot($app, team.id);
  var manager = team.get("manager");
  var ai = !manager || team.get("manager_mode") === "ai";
  var players = ai ? mgmtMod.aiLineup(snap.players) : snap.players;
  return {
    id: team.id,
    name: team.get("name"),
    abbr: teamPublic(team).abbreviation,
    grade: team.get("grade"),
    players: players,
    stance: ai ? "balanced" : team.get("default_stance") || "balanced",
    ai: ai,
    oc: !!snap.overclock,
  };
}

function pairModel(homeT, awayT) {
  var st = eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: homeT, away: awayT });
  var r = eng.goalRates(st);
  return { lh: Math.round(r.home * 1e6) / 1e6, la: Math.round(r.away * 1e6) / 1e6 };
}

// ------------------------------------------------------------------ lifecycle

function activeTournament($app) {
  return one($app, "shared_tournaments", 'status = "active"', "-number");
}

function lastCompleteTournament($app) {
  return one($app, "shared_tournaments", 'status = "complete"', "-number");
}

function roundsOf($app, tournamentId) {
  var rows = all($app, "shared_rounds", "tournament = {:t}", "created", { t: tournamentId }, 10);
  return rows.sort(function (a, b) {
    return ROUND_ORDER.indexOf(a.get("round_key")) - ROUND_ORDER.indexOf(b.get("round_key"));
  });
}

function currentRound($app, tournamentId) {
  var rs = roundsOf($app, tournamentId);
  return rs.length ? rs[rs.length - 1] : null;
}

function fixturesOf($app, roundId) {
  return all($app, "shared_fixtures", "round = {:r}", "bracket_index", { r: roundId }, 20);
}

/** Next championship kick-off (ms). Stored on world.next_action_at. */
function nextStartMs(world) {
  return parsePbDate(world.get("next_action_at"));
}

function createTournament($app, startAt) {
  var created = null;
  var t0 = Date.now();
  $app.runInTransaction(function (tx) {
    if (activeTournament(tx)) return;
    var teams = ensureTeams(tx);
    var last = one(tx, "shared_tournaments", "id != ''", "-number");
    var num = last ? (last.get("number") || 0) + 1 : 1;
    for (var i = 0; i < teams.length; i++) {
      teams[i].set("eliminated", false);
      tx.save(teams[i]);
    }
    var t = new Record(tx.findCollectionByNameOrId("shared_tournaments"));
    t.set("number", num);
    t.set("status", "active");
    t.set("current_round", "r16");
    t.set("starts_at", toPbDate(startAt));
    tx.save(t);
    var ids = teams.map(function (x) {
      return x.id;
    });
    var pairs = tourneyMod.drawRoundOf16(ids, eng.hashSeed(t.id + ":r16"));
    var round = createRound(tx, t, "r16", pairs, startAt);
    t.set("odds_json", championshipOdds(tx, round));
    tx.save(t);
    created = t;
  });
  if (created) log("championship_created", { number: created.get("number"), startsAt: toPbDate(startAt), ms: Date.now() - t0 });
  return created;
}

function createRound(tx, tournament, key, pairings, scheduledAt) {
  var idem = tournament.id + ":" + key + ":v2";
  var existing = one(tx, "shared_rounds", "idempotency_key = {:k}", "", { k: idem });
  if (existing) return existing;
  var round = new Record(tx.findCollectionByNameOrId("shared_rounds"));
  round.set("tournament", tournament.id);
  round.set("round_key", key);
  round.set("label", ROUND_LABELS[key] || key);
  round.set("scheduled_at", toPbDate(scheduledAt));
  round.set("status", "scheduled");
  round.set("idempotency_key", idem);
  round.set("progression_done", false);
  tx.save(round);
  var teams = teamMap(tx);
  for (var i = 0; i < pairings.length; i++) {
    var p = pairings[i];
    var fx = new Record(tx.findCollectionByNameOrId("shared_fixtures"));
    fx.set("tournament", tournament.id);
    fx.set("round", round.id);
    fx.set("slot", p.slot);
    fx.set("bracket_index", p.bracketIndex);
    fx.set("home_team", p.homeId);
    fx.set("away_team", p.awayId);
    fx.set("feeds_into", p.feedsInto || "");
    fx.set("feeds_position", p.feedsPosition || "");
    fx.set("scheduled_at", toPbDate(scheduledAt));
    fx.set("status", "scheduled");
    fx.set("lineups_frozen", false);
    fx.set("model_json", pairModel(engineTeam(tx, teams[p.homeId]), engineTeam(tx, teams[p.awayId])));
    tx.save(fx);
  }
  return round;
}

/** Champion and semi-finalist probabilities from the R16 draw (pairwise engine models). */
function championshipOdds(tx, r16Round) {
  var fixtures = fixturesOf(tx, r16Round.id);
  var teams = teamMap(tx);
  var snaps = {};
  for (var id in teams) snaps[id] = engineTeam(tx, teams[id]);
  var cache = {};
  function q(i, j) {
    var key = i + ":" + j;
    if (cache[key] == null) {
      cache[key] = oddsMod.pairQualify(pairModel(snaps[i], snaps[j]));
      cache[j + ":" + i] = 1 - cache[key];
    }
    return cache[key];
  }
  var r16 = fixtures.map(function (f) {
    return { home: f.get("home_team"), away: f.get("away_team") };
  });
  var b = oddsMod.bracket(r16, q);
  return { champion: b.champion, reachSF: b.reachSF, quarters: b.quarters };
}

/** Kick off a due round: freeze lineups, create engine states. */
function kickOff($app, roundId, now, T) {
  var kicked = false;
  $app.runInTransaction(function (tx) {
    var round = tx.findRecordById("shared_rounds", roundId);
    if (round.get("status") !== "scheduled") return;
    var at = parsePbDate(round.get("scheduled_at"));
    if (now < at) return;
    var teams = teamMap(tx);
    var fixtures = fixturesOf(tx, round.id);
    var timingSnap = eng.buildTiming(T.minuteSec * 1000, T.scale);
    for (var i = 0; i < fixtures.length; i++) {
      var fx = fixtures[i];
      var homeRec = teams[fx.get("home_team")];
      var awayRec = teams[fx.get("away_team")];
      // Full AI and unmanaged teams use the treasury between matches (visible rules).
      [homeRec, awayRec].forEach(function (t) {
        if (!t.get("manager") || t.get("manager_mode") === "ai") mgmtMod.aiMaintainTeam(tx, t);
      });
      var home = engineTeam(tx, homeRec);
      var away = engineTeam(tx, awayRec);
      [homeRec, awayRec].forEach(function (t) {
        if (t.get("overclock_ready")) {
          t.set("overclock_ready", false);
          t.set("overclock_fixture", fx.id);
          tx.save(t);
        }
      });
      var state = eng.createMatch({
        fixtureId: fx.id,
        seed: eng.hashSeed(fx.id + ":" + round.id + ":v2"),
        kickoffAt: at,
        timing: timingSnap,
        home: home,
        away: away,
      });
      var ms = one(tx, "match_states", "fixture = {:f}", "", { f: fx.id });
      if (!ms) ms = new Record(tx.findCollectionByNameOrId("match_states"));
      ms.set("fixture", fx.id);
      ms.set("seed", state.seed);
      ms.set("sim_version", 2);
      ms.set("phase", state.phase);
      ms.set("state_json", plain(state));
      ms.set("events_json", []);
      ms.set("started_at", toPbDate(at));
      ms.set("next_segment_due_at", toPbDate(at));
      ms.set("finalised", false);
      ms.set("progression_settled", false);
      ms.set("match_minute_real_ms", Math.round(timingSnap.minuteMs));
      tx.save(ms);
      fx.set("home_lineup_json", home.players);
      fx.set("away_lineup_json", away.players);
      fx.set("lineups_frozen", true);
      fx.set("model_json", pairModel(home, away));
      fx.set("match_minute_real_ms", Math.round(timingSnap.minuteMs));
      fx.set("status", "live");
      tx.save(fx);
    }
    round.set("status", "live");
    round.set("started_at", toPbDate(at));
    round.set("match_minute_real_ms", Math.round(timingSnap.minuteMs));
    tx.save(round);
    kicked = true;
  });
  if (kicked) log("round_kickoff", { roundId: roundId });
  return kicked;
}

/** Advance one match to `now`, persisting new events. */
function advanceMatch($app, msId, roundId, now) {
  var res = { events: 0, finished: false };
  $app.runInTransaction(function (tx) {
    var ms = tx.findRecordById("match_states", msId);
    if (ms.get("finalised")) {
      res.finished = true;
      return;
    }
    if (ms.get("sim_version") !== 2) return;
    var st = readJson(ms, "state_json", null);
    if (!st || st.nextAt > now) return;
    var evs = eng.advanceTo(st, now);
    var col = tx.findCollectionByNameOrId("match_events");
    for (var i = 0; i < evs.length; i++) {
      var r = new Record(col);
      r.set("fixture", st.fx);
      r.set("round", roundId);
      r.set("seq", evs[i].seq);
      r.set("at", evs[i].at);
      r.set("type", evs[i].t);
      r.set("major", !!evs[i].major);
      r.set("data", plain(evs[i]));
      tx.save(r);
    }
    ms.set("state_json", plain(st));
    ms.set("phase", st.phase);
    ms.set("sim_minute", st.minute);
    ms.set("score_home", st.score[0]);
    ms.set("score_away", st.score[1]);
    ms.set("shootout_home", st.so ? st.so.h : 0);
    ms.set("shootout_away", st.so ? st.so.a : 0);
    ms.set("home_coaching", st.teams.home.stance);
    ms.set("away_coaching", st.teams.away.stance);
    ms.set("next_segment_due_at", toPbDate(isFinite(st.nextAt) ? st.nextAt : st.finishedAt || now));
    ms.set("last_processed_at", toPbDate(now));
    ms.set("finalised", st.phase === "finished");
    tx.save(ms);
    res.events = evs.length;
    res.finished = st.phase === "finished";
  });
  return res;
}

/** Restart a match left half-played by the pre-v2 engine (only after an upgrade mid-round). */
function restartLegacyMatch($app, ms, startAt, T) {
  var fx = $app.findRecordById("shared_fixtures", ms.get("fixture"));
  var teams = teamMap($app);
  var home = engineTeam($app, teams[fx.get("home_team")]);
  var away = engineTeam($app, teams[fx.get("away_team")]);
  var timingSnap = eng.buildTiming(T.minuteSec * 1000, T.scale);
  var st = eng.createMatch({ fixtureId: fx.id, seed: eng.hashSeed(fx.id + ":legacy"), kickoffAt: startAt, timing: timingSnap, home: home, away: away });
  ms.set("sim_version", 2);
  ms.set("state_json", plain(st));
  ms.set("events_json", []);
  ms.set("phase", "pre");
  ms.set("started_at", toPbDate(startAt));
  ms.set("finalised", false);
  ms.set("winner_team", "");
  ms.set("match_minute_real_ms", Math.round(timingSnap.minuteMs));
  $app.save(ms);
  fx.set("model_json", pairModel(home, away));
  fx.set("scheduled_at", toPbDate(startAt));
  $app.save(fx);
  log("legacy_match_restarted", { fixtureId: fx.id });
}

/** Result of a finished match (v2 state or legacy columns). */
function resultOf(ms, fx) {
  if (ms.get("sim_version") === 2) {
    var st = readJson(ms, "state_json", {});
    if (st.phase !== "finished") return null;
    return {
      sh: st.score[0],
      sa: st.score[1],
      soh: st.so ? st.so.h : 0,
      soa: st.so ? st.so.a : 0,
      winner: st.winner,
      winnerId: st.winner === "home" ? fx.get("home_team") : fx.get("away_team"),
      by: st.by,
      at: st.finishedAt,
      state: st,
    };
  }
  if (!ms.get("finalised") || !ms.get("winner_team")) return null;
  var soh = ms.get("shootout_home") || 0;
  var soa = ms.get("shootout_away") || 0;
  var legacy = readJson(ms, "state_json", {});
  return {
    sh: ms.get("score_home") || 0,
    sa: ms.get("score_away") || 0,
    soh: soh,
    soa: soa,
    winner: ms.get("winner_team") === fx.get("home_team") ? "home" : "away",
    winnerId: ms.get("winner_team"),
    by: soh + soa > 0 ? "pens" : legacy.wentExtraTime ? "aet" : "normal",
    at: parsePbDate(ms.get("last_processed_at")) || 0,
    legacy: true,
  };
}

/** Events of a fixture already public at `now` (ascending). */
function publishedEvents($app, fixtureId, now, sinceSeq, limit) {
  var rows = $app.findRecordsByFilter(
    "match_events",
    "fixture = {:f} && at <= {:n} && seq > {:s}",
    "-seq",
    limit || 500,
    0,
    { f: fixtureId, n: now, s: sinceSeq || 0 },
  );
  var out = [];
  for (var i = (rows || []).length - 1; i >= 0; i--) out.push(readJson(rows[i], "data", {}));
  return out;
}

function lastPublished($app, fixtureId, now) {
  var r = one($app, "match_events", "fixture = {:f} && at <= {:n}", "-seq", { f: fixtureId, n: now });
  return r ? readJson(r, "data", null) : null;
}

/** Legacy-shaped event list for records/summary helpers. */
function legacyEvents(events) {
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var type = null;
    if (e.t === "goal") type = "goal";
    else if (e.t === "penalty_goal") type = "penalty_scored";
    else if (e.t === "penalty_saved") type = "penalty_saved";
    else if (e.t === "penalty_missed" || e.t === "penalty_woodwork") type = "penalty_missed";
    else if (e.t === "yellow_card" || e.t === "red_card" || e.t === "foul") type = e.t;
    else if (e.t === "shootout_kick") type = e.kick && e.kick.outcome === "goal" ? "shootout_goal" : "shootout_miss";
    if (!type) continue;
    out.push({ type: type, team: e.side, player: e.p, minute: e.min, message: e.text });
  }
  return out;
}

function namedStats(x, pos) {
  function side(a, p) {
    return { possession: p, shots: a[0], shots_on_target: a[1], saves: a[2], corners: a[3], fouls: a[4], yellow_cards: a[5], red_cards: a[6], penalties_awarded: a[7] };
  }
  return { home: side(x[0], pos), away: side(x[1], 100 - pos) };
}

function updateTeamRecord(tx, teamId, patch) {
  var rec = one(tx, "global_team_records", "team = {:t}", "", { t: teamId });
  if (!rec) return;
  for (var k in patch) rec.set(k, (rec.get(k) || 0) + patch[k]);
  tx.save(rec);
}

/**
 * Finalise one fixture once its final whistle is public: fixture result, records,
 * elimination, rewards, wear, summaries and fixture bets — one transaction, once.
 */
function finaliseFixture($app, fixtureId, roundKey, now) {
  var done = false;
  $app.runInTransaction(function (tx) {
    var fx = tx.findRecordById("shared_fixtures", fixtureId);
    var ms = one(tx, "match_states", "fixture = {:f}", "", { f: fixtureId });
    if (!ms || ms.get("progression_settled")) return;
    var r = resultOf(ms, fx);
    if (!r || r.at > now) return;
    var homeId = fx.get("home_team");
    var awayId = fx.get("away_team");
    var loserId = r.winnerId === homeId ? awayId : homeId;

    fx.set("status", "finished");
    fx.set("winner_team", r.winnerId);
    fx.set("score_home", r.sh);
    fx.set("score_away", r.sa);
    fx.set("shootout_home", r.soh);
    fx.set("shootout_away", r.soa);
    fx.set("decided_by", r.by);
    fx.set("finished_ms", Math.round(r.at));
    tx.save(fx);
    ms.set("winner_team", r.winnerId);
    ms.set("finalised", true);
    ms.set("progression_settled", true);
    tx.save(ms);

    var level = r.sh === r.sa;
    [
      [homeId, r.sh, r.sa, r.winnerId === homeId],
      [awayId, r.sa, r.sh, r.winnerId === awayId],
    ].forEach(function (s) {
      updateTeamRecord(tx, s[0], {
        played: 1,
        wins: !level && s[3] ? 1 : 0,
        draws: level ? 1 : 0,
        losses: !level && !s[3] ? 1 : 0,
        goals_for: s[1],
        goals_against: s[2],
        shootout_wins: r.by === "pens" && s[3] ? 1 : 0,
        shootout_losses: r.by === "pens" && !s[3] ? 1 : 0,
        normal_time_wins: r.by === "normal" && s[3] ? 1 : 0,
        extra_time_wins: r.by === "aet" && s[3] ? 1 : 0,
        finals_reached: roundKey === "final" ? 1 : 0,
      });
    });
    var loser = tx.findRecordById("proball_teams", loserId);
    loser.set("eliminated", true);
    tx.save(loser);

    var tournamentId = fx.get("tournament");
    var extra = null;
    if (!r.legacy) {
      // Wear first, so an eliminated team's consolation energy restore wins.
      mgmtMod.applyWearDelta(tx, r.state.teams.home.players);
      mgmtMod.applyWearDelta(tx, r.state.teams.away.players);
    }
    mgmtMod.rewardFixture(tx, fx, ms, tournamentId, roundKey);
    mgmtMod.rewardElimination(tx, loserId, roundKey, tournamentId);

    if (!r.legacy) {
      var events = publishedEvents(tx, fixtureId, 9e15, 0, 2000);
      var st = r.state;
      extra = {
        events: legacyEvents(events),
        wentExtraTime: r.by !== "normal",
        wentShootout: r.by === "pens",
        shootoutKicks: st.so
          ? st.so.kicks.map(function (k, i) {
              return { kickIndex: i + 1, team: k.side, player: k.taker, outcome: k.outcome === "goal" ? "goal" : k.outcome === "save" ? "save" : "miss" };
            })
          : [],
        stats: namedStats(events.length ? events[events.length - 1].st.x : [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], events.length ? events[events.length - 1].st.pos : 50),
        players: { home: st.teams.home.players, away: st.teams.away.players },
      };
    }
    var sum = recMod.ensureMatchSummary(tx, fx, ms, roundKey, tournamentId, extra);
    if (sum && sum.created) recMod.settlePlayerRecordsFromMatch(tx, fx, ms, extra);
    betMod.settleFixtureBets(tx, fx, r, now);
    done = true;
  });
  if (done) log("fixture_finalised", { fixtureId: fixtureId });
  return done;
}

/** Close a round once every fixture is finalised; schedule the next one. */
function completeRound($app, roundId, now, T) {
  var out = null;
  $app.runInTransaction(function (tx) {
    var round = tx.findRecordById("shared_rounds", roundId);
    if (round.get("progression_done")) return;
    var fixtures = fixturesOf(tx, round.id);
    var winners = {};
    var finished = 0;
    for (var i = 0; i < fixtures.length; i++) {
      if (fixtures[i].get("status") !== "finished") return;
      winners[fixtures[i].get("slot")] = fixtures[i].get("winner_team");
      finished = Math.max(finished, fixtures[i].get("finished_ms") || 0);
    }
    if (!fixtures.length) return;
    round.set("status", "completed");
    round.set("progression_done", true);
    round.set("completed_at", toPbDate(now));
    round.set("finished_ms", finished);
    tx.save(round);
    var t = tx.findRecordById("shared_tournaments", round.get("tournament"));
    var key = round.get("round_key");
    betMod.settleRoundFirst(tx, round, fixtures, true);
    if (key === "qf") betMod.settleSemis(tx, t, fixtures);
    var nextKey = tourneyMod.nextRoundKey(key);
    if (nextKey) {
      var at = Math.max(finished + T.betweenMs, now + Math.min(T.betweenMs, 30000 / T.scale));
      createRound(tx, t, nextKey, tourneyMod.buildNextRoundFixtures(key, winners), at);
      t.set("current_round", nextKey);
      tx.save(t);
      out = { next: nextKey, at: at };
      return;
    }
    var champ = fixtures[0].get("winner_team");
    t.set("status", "complete");
    t.set("current_round", "complete");
    t.set("champion_team", champ);
    t.set("completed_at", toPbDate(finished || now));
    tx.save(t);
    updateTeamRecord(tx, champ, { championships: 1 });
    mgmtMod.rewardChampion(tx, champ, t.id);
    recMod.awardChampionshipPlayers(tx, champ);
    recMod.ensureTournamentSummary(tx, t, fixtures);
    betMod.settleChampion(tx, t, champ);
    var world = one(tx, "world", "key = 'main'");
    var nextStart = Math.max(finished, now) + T.gapMs;
    world.set("next_action_at", toPbDate(nextStart));
    tx.save(world);
    out = { champion: champ, nextStart: nextStart };
  });
  if (out) log("round_completed", { roundId: roundId, result: out });
  return out;
}

/**
 * Bring the shared world up to `now`. Called by cron and (throttled) by reads.
 */
function tick($app, now) {
  now = now || Date.now();
  var world = ensureWorld($app);
  if (world.get("progression_paused")) return { paused: true };
  var T = timing(world);
  var actions = [];
  var t = activeTournament($app);

  if (!t) {
    // The next championship is drawn as soon as the previous one ends; its fixtures
    // stay hidden (and closed to betting) until the fixture window opens.
    var start = nextStartMs(world);
    if (isNaN(start)) start = now + T.windowMs; // fresh install: open the fixture window now
    t = createTournament($app, Math.max(start, now + 1000));
    if (t) actions.push("championship_created");
    if (!t) return { actions: actions };
  }

  for (var guard = 0; guard < 6; guard++) {
    var round = currentRound($app, t.id);
    if (!round) break;
    var status = round.get("status");
    if (status === "scheduled" || status === "management") {
      if (now < parsePbDate(round.get("scheduled_at"))) break;
      if (kickOff($app, round.id, now, T)) actions.push("kickoff:" + round.get("round_key"));
      continue;
    }
    if (status !== "live") break;
    var fixtures = fixturesOf($app, round.id);
    var allDone = true;
    for (var i = 0; i < fixtures.length; i++) {
      var fx = fixtures[i];
      try {
        if (fx.get("status") === "finished") {
          // Pre-v2 fixtures were marked finished before their progression ran.
          if (!fx.get("finished_ms")) finaliseFixture($app, fx.id, round.get("round_key"), now);
          continue;
        }
        allDone = false;
        var ms = one($app, "match_states", "fixture = {:f}", "", { f: fx.id });
        if (!ms) continue;
        if (ms.get("sim_version") !== 2 && !ms.get("finalised")) {
          restartLegacyMatch($app, ms, now + T.betweenMs, T);
          continue;
        }
        var adv = ms.get("sim_version") === 2 && !ms.get("finalised") ? advanceMatch($app, ms.id, round.id, now) : { finished: true };
        betMod.settleNextGoal($app, fx.id, now);
        if (adv.finished && finaliseFixture($app, fx.id, round.get("round_key"), now)) actions.push("final:" + fx.get("slot"));
      } catch (err) {
        log("tick_fixture_error", { fixtureId: fx.id, message: String(err).slice(0, 300) });
      }
    }
    try {
      betMod.settleRoundFirst($app, round, fixturesOf($app, round.id), false, now);
    } catch (err2) {
      log("tick_round_first_error", { message: String(err2).slice(0, 200) });
    }
    if (!allDone) break;
    var done = completeRound($app, round.id, now, T);
    if (!done) break;
    actions.push("round_complete:" + round.get("round_key"));
    if (done.champion) {
      if (createTournament($app, done.nextStart)) actions.push("championship_created");
      break;
    }
  }
  return { actions: actions };
}

/** Kick-off of the current championship's draw is public from this time (ms). */
function drawVisibleAt(round, T) {
  if (!round || round.get("round_key") !== "r16") return 0;
  return parsePbDate(round.get("scheduled_at")) - T.windowMs;
}

/** True while a pre-drawn championship's fixtures are still private (champion screen). */
function drawHidden($app, round, now) {
  if (!round || round.get("status") !== "scheduled" || round.get("round_key") !== "r16") return false;
  return (now || Date.now()) < drawVisibleAt(round, timing(ensureWorld($app)));
}

/** Throttled tick for read paths (one per second per process). */
function tickIfDue($app) {
  var now = Date.now();
  try {
    var last = $app.store().get("ff_last_tick") || 0;
    if (now - last < 1000 / timeScale()) return;
    $app.store().set("ff_last_tick", now);
  } catch (_) {}
  try {
    tick($app, now);
  } catch (err) {
    log("tick_error", { message: String(err).slice(0, 300) });
  }
}

// ------------------------------------------------------------------ projections

function fixtureTeams(fx, teams) {
  var h = teams[fx.get("home_team")];
  var a = teams[fx.get("away_team")];
  return { home: h ? teamPublic(h) : null, away: a ? teamPublic(a) : null };
}

function modelOf(fx) {
  var m = readJson(fx, "model_json", null);
  return m && m.lh != null ? m : null;
}

function minuteMsOf(fx, T) {
  return fx.get("match_minute_real_ms") || T.minuteMs;
}

/** Public card for one fixture at `now`. */
function fixtureCard($app, fx, teams, now, T) {
  var tm = fixtureTeams(fx, teams);
  var kickoffAt = parsePbDate(fx.get("scheduled_at"));
  var card = {
    id: fx.id,
    slot: fx.get("slot"),
    index: fx.get("bracket_index"),
    home: tm.home,
    away: tm.away,
    status: fx.get("status"),
    kickoffAt: kickoffAt,
    minuteMs: minuteMsOf(fx, T),
    st: null,
    at: null,
    seq: 0,
    last: null,
    odds: null,
  };
  if (fx.get("status") !== "scheduled") {
    var ev = lastPublished($app, fx.id, now);
    if (ev) {
      card.st = ev.st;
      card.at = ev.at;
      card.seq = ev.seq;
      card.last = { t: ev.t, text: ev.text, side: ev.side || null };
    }
    if (fx.get("status") === "finished") {
      card.result = {
        sh: fx.get("score_home"),
        sa: fx.get("score_away"),
        soh: fx.get("shootout_home"),
        soa: fx.get("shootout_away"),
        winner: fx.get("winner_team") === fx.get("home_team") ? "home" : "away",
        by: fx.get("decided_by") || null,
      };
    }
  }
  var model = modelOf(fx);
  if (model && fx.get("status") !== "finished") {
    var fake = { status: fx.get("status"), kickoffAt: kickoffAt };
    var stx = card.st;
    var state = mkt.fixtureState(fake, stx, now);
    if (state.phase !== "finished") {
      var minute = stx ? Math.floor(oddsMod.clockMinute(stx.clk, card.at, now, card.minuteMs)) : 0;
      var fd = oddsMod.finalDist(model, stx || { sc: [0, 0], ph: "pre" }, minute, true);
      card.odds = {
        home: mkt.okP(fd.qualifyHome),
        away: mkt.okP(1 - fd.qualifyHome),
        closed: state.closed,
      };
    }
  }
  return card;
}

/** Bracket for the current championship with honest pending slots. */
function bracketView($app, t, teams) {
  var rounds = roundsOf($app, t.id);
  var byKey = {};
  rounds.forEach(function (r) {
    byKey[r.get("round_key")] = fixturesOf($app, r.id);
  });
  var out = [];
  var winnersPrev = null;
  var labelsPrev = null;
  ROUND_ORDER.forEach(function (key) {
    var list = [];
    var fxs = byKey[key];
    if (fxs && fxs.length) {
      fxs.forEach(function (fx) {
        var tm = fixtureTeams(fx, teams);
        list.push({
          slot: fx.get("slot"),
          fixtureId: fx.id,
          home: tm.home,
          away: tm.away,
          status: fx.get("status"),
          sh: fx.get("status") === "finished" ? fx.get("score_home") : null,
          sa: fx.get("status") === "finished" ? fx.get("score_away") : null,
          soh: fx.get("shootout_home") || 0,
          soa: fx.get("shootout_away") || 0,
          by: fx.get("decided_by") || null,
          winner: fx.get("status") === "finished" ? (fx.get("winner_team") === fx.get("home_team") ? "home" : "away") : null,
        });
      });
    } else {
      BRACKET[key].forEach(function (s) {
        var feeders = BRACKET[ROUND_ORDER[ROUND_ORDER.indexOf(key) - 1]].filter(function (p) {
          return p.feeds === s.slot;
        });
        function pending(pos) {
          var f = feeders.filter(function (p) {
            return p.pos === pos;
          })[0];
          var w = f && winnersPrev ? winnersPrev[f.slot] : null;
          return w ? { team: w } : { pending: "Winner " + (labelsPrev && f ? labelsPrev[f.slot] : f ? f.slot : "") };
        }
        var h = pending("home");
        var a = pending("away");
        list.push({ slot: s.slot, home: h.team || null, away: a.team || null, homePending: h.pending || null, awayPending: a.pending || null, status: "pending" });
      });
    }
    winnersPrev = {};
    labelsPrev = {};
    list.forEach(function (f) {
      if (f.winner) winnersPrev[f.slot] = f.winner === "home" ? f.home : f.away;
      // Unknown sides fall back to their round label ("QF1", "SF2" …), never "?".
      var hl = f.home ? f.home.abbreviation : f.slot;
      var al = f.away ? f.away.abbreviation : f.slot;
      labelsPrev[f.slot] = f.home || f.away ? hl + " v " + al : f.slot.toUpperCase();
    });
    out.push({ key: key, label: ROUND_LABELS[key], fixtures: list });
  });
  return out;
}

function tickerFor($app, roundId, now, limit) {
  var rows = $app.findRecordsByFilter("match_events", "round = {:r} && major = true && at <= {:n}", "-at,-seq", limit || 40, 0, { r: roundId, n: now }) || [];
  return rows.map(function (r) {
    var d = readJson(r, "data", {});
    return { id: r.get("fixture") + ":" + d.seq, fixtureId: r.get("fixture"), seq: d.seq, at: d.at, t: d.t, side: d.side || null, text: d.tick || d.text, min: d.min };
  });
}

function championView($app, t, teams) {
  if (!t || !t.get("champion_team")) return null;
  var champ = teams[t.get("champion_team")];
  var rounds = roundsOf($app, t.id);
  var final = null;
  rounds.forEach(function (r) {
    if (r.get("round_key") !== "final") return;
    var f = fixturesOf($app, r.id)[0];
    if (!f) return;
    var tm = fixtureTeams(f, teams);
    final = {
      fixtureId: f.id,
      home: tm.home,
      away: tm.away,
      sh: f.get("score_home"),
      sa: f.get("score_away"),
      soh: f.get("shootout_home") || 0,
      soa: f.get("shootout_away") || 0,
      by: f.get("decided_by") || null,
    };
  });
  return {
    tournamentId: t.id,
    number: t.get("number"),
    team: champ ? teamPublic(champ) : null,
    final: final,
    completedAt: parsePbDate(t.get("completed_at")) || parsePbDate(t.get("updated")),
  };
}

/** Main screen state: champion → fixtures → live, all from server time. */
function liveView($app) {
  tickIfDue($app);
  var now = Date.now();
  var world = ensureWorld($app);
  var T = timing(world);
  var teams = teamMap($app);
  var t = activeTournament($app);
  var last = lastCompleteTournament($app);
  var view = {
    serverTimeMs: now,
    paused: !!world.get("progression_paused"),
    timing: { betweenMs: T.betweenMs, gapMs: T.gapMs, windowMs: T.windowMs, minuteMs: T.minuteMs, betweenMinutes: T.betweenMinutes, gapMinutes: T.gapMinutes, windowMinutes: T.windowMinutes, minuteSec: T.minuteSec },
    mode: "idle",
    championship: null,
    round: null,
    fixtures: [],
    bracket: [],
    ticker: [],
    champion: championView($app, last, teams),
    nextChampionshipAt: null,
  };
  var round = t ? currentRound($app, t.id) : null;
  var hidden = drawHidden($app, round, now);
  if (!t || hidden) {
    // Champion celebration: the next draw exists but stays private until the window opens.
    var start = t ? parsePbDate(t.get("starts_at")) : nextStartMs(world);
    view.mode = view.champion ? "champion" : "idle";
    view.nextChampionshipAt = isNaN(start) ? null : start;
    view.fixturesAt = isNaN(start) ? null : start - T.windowMs;
    if (view.champion && last) {
      var lr = currentRound($app, last.id);
      if (lr) view.ticker = tickerFor($app, lr.id, now, 30);
    }
    return view;
  }
  view.championship = { id: t.id, number: t.get("number"), startsAt: parsePbDate(t.get("starts_at")), status: t.get("status") };
  if (!round) return view;
  var rs = round.get("status");
  view.mode = rs === "live" ? "live" : "fixtures";
  view.round = {
    id: round.id,
    key: round.get("round_key"),
    label: round.get("label"),
    status: rs,
    scheduledAt: parsePbDate(round.get("scheduled_at")),
    finishedAt: round.get("finished_ms") || null,
  };
  view.fixtures = fixturesOf($app, round.id).map(function (fx) {
    return fixtureCard($app, fx, teams, now, T);
  });
  view.bracket = bracketView($app, t, teams);
  var tickRound = round;
  if (rs === "scheduled") {
    var rounds = roundsOf($app, t.id);
    tickRound = rounds.length > 1 ? rounds[rounds.length - 2] : null;
  }
  view.ticker = tickRound ? tickerFor($app, tickRound.id, now, 40) : [];
  // The big champion screen belongs to the gap between championships; once the next
  // draw is out the champion stays visible in a smaller form during the R16 window.
  if (rs === "scheduled" && round.get("round_key") === "r16") view.recentChampion = view.champion;
  view.champion = null;
  return view;
}

function lineupPublic(players) {
  return (players || []).map(function (p) {
    return { name: p.name, no: p.no, role: p.role, starter: !!p.is_starter };
  });
}

/** Individual match view. Events after `sinceSeq`; first load returns the latest 60. */
function matchView($app, fixtureId, sinceSeq, userId) {
  tickIfDue($app);
  var now = Date.now();
  var world = ensureWorld($app);
  var T = timing(world);
  var teams = teamMap($app);
  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  var round = $app.findRecordById("shared_rounds", fx.get("round"));
  if (drawHidden($app, round, now)) throw new Error("fixture not announced");
  var card = fixtureCard($app, fx, teams, now, T);
  var managed = getManagerTeam($app, userId);
  var side = managed ? (managed.id === fx.get("home_team") ? "home" : managed.id === fx.get("away_team") ? "away" : null) : null;
  var events = [];
  var lineups = null;
  var coach = null;
  var sentOff = [];
  if (fx.get("status") !== "scheduled") {
    events = publishedEvents($app, fixtureId, now, sinceSeq || 0, sinceSeq ? 300 : 60);
    // Sent-off players from published events only (the engine state may already know a
    // red card that is a few seconds from publication).
    var reds = $app.findRecordsByFilter("match_events", 'fixture = {:f} && type = "red_card" && at <= {:n}', "seq", 10, 0, { f: fixtureId, n: now }) || [];
    sentOff = reds.map(function (r) {
      var d = readJson(r, "data", {});
      return { side: d.side, p: d.p };
    });
    var ms = one($app, "match_states", "fixture = {:f}", "", { f: fixtureId });
    var st = ms && ms.get("sim_version") === 2 ? readJson(ms, "state_json", null) : null;
    if (st) {
      lineups = { home: lineupPublic(st.teams.home.players), away: lineupPublic(st.teams.away.players) };
      if (side) {
        var c = st.coach && st.coach[side] ? st.coach[side] : { n: 0, last: 0 };
        coach = {
          stance: st.pending && st.pending[side] ? st.pending[side] : st.teams[side].stance,
          pending: !!(st.pending && st.pending[side]),
          ai: !!st.teams[side].ai,
          used: c.n || 0,
          max: BALANCE.liveCoachingMax,
          cooldownUntil: (c.last || 0) + liveCoachCooldownMs(T),
        };
      }
    }
  } else {
    lineups = {
      home: lineupPublic(engineTeam($app, teams[fx.get("home_team")]).players.map(numbered)),
      away: lineupPublic(engineTeam($app, teams[fx.get("away_team")]).players.map(numbered)),
    };
  }
  return {
    serverTimeMs: now,
    round: { id: round.id, key: round.get("round_key"), label: round.get("label"), status: round.get("status") },
    fixture: card,
    events: events,
    lineups: lineups,
    sentOff: sentOff,
    managedSide: side,
    coach: coach,
  };
}

function numbered(p, i) {
  return { name: p.name, role: p.role, is_starter: p.is_starter, no: p.role === "gk" && p.is_starter ? 1 : i + 2 };
}

function liveCoachCooldownMs(T) {
  return (BALANCE.liveCoachingCooldownMinutes || 3) * T.minuteMs;
}

/** Manager Defend / Balanced / Attack — applies from the next simulated minute. */
function setCoaching($app, userId, fixtureId, stance) {
  if (["defend", "balanced", "attack"].indexOf(stance) < 0) throw new BadRequestError("Choose Defend, Balanced or Attack");
  tick($app, Date.now()); // resolve everything up to now first
  var now = Date.now();
  var world = ensureWorld($app);
  var T = timing(world);
  var result = null;
  $app.runInTransaction(function (tx) {
    var fx = tx.findRecordById("shared_fixtures", fixtureId);
    var team = getManagerTeam(tx, userId);
    var side = team ? (team.id === fx.get("home_team") ? "home" : team.id === fx.get("away_team") ? "away" : null) : null;
    if (!side) throw new ForbiddenError("You do not manage a team in this match");
    if (team.get("manager_mode") === "ai") throw new BadRequestError("Your team is on Full AI. Switch to My settings to coach live.");
    var ms = one(tx, "match_states", "fixture = {:f}", "", { f: fixtureId });
    if (!ms || ms.get("sim_version") !== 2) throw new BadRequestError("Match has not kicked off");
    var st = readJson(ms, "state_json", null);
    var pub = lastPublished(tx, fixtureId, now);
    if (!pub || eng.LIVE_PHASES.indexOf(pub.st.ph) < 0 && ["half_time", "et_break", "et_half_time"].indexOf(pub.st.ph) < 0) {
      throw new BadRequestError("Coaching is available while the match is being played");
    }
    if (st.phase === "shootout" || st.phase === "finished") throw new BadRequestError("Coaching has closed for this match");
    st.coach = st.coach || {};
    var c = st.coach[side] || { n: 0, last: 0 };
    if (c.n >= BALANCE.liveCoachingMax) throw new BadRequestError("No coaching commands left this match (" + BALANCE.liveCoachingMax + " max)");
    var wait = c.last + liveCoachCooldownMs(T) - now;
    if (wait > 0) throw new BadRequestError("Command recharging — available in " + Math.ceil(wait / 1000) + "s");
    if ((st.pending[side] || st.teams[side].stance) === stance) throw new BadRequestError("Already set to " + stance);
    eng.queueStance(st, side, stance);
    st.coach[side] = { n: c.n + 1, last: now };
    ms.set("state_json", plain(st));
    tx.save(ms);
    var cmd = new Record(tx.findCollectionByNameOrId("coaching_commands"));
    cmd.set("fixture", fixtureId);
    cmd.set("team", team.id);
    cmd.set("user", userId);
    cmd.set("stance", stance);
    cmd.set("effective_from_minute", st.minute + 1);
    tx.save(cmd);
    result = { ok: true, stance: stance, fromMinute: st.minute + 1, used: c.n + 1, max: BALANCE.liveCoachingMax };
  });
  return result;
}

/** Atomic claim with the betting-conflict rule. */
function claimTeam($app, userId, teamId) {
  var result = null;
  $app.runInTransaction(function (tx) {
    var team = tx.findRecordById("proball_teams", teamId);
    if (getManagerTeam(tx, userId)) throw new BadRequestError("You already manage a team");
    if (team.get("manager")) throw new BadRequestError("Someone already manages " + team.get("name"));
    var conflict = betMod.claimConflict(tx, userId, teamId);
    if (conflict) throw new BadRequestError(conflict);
    team.set("manager", userId);
    team.set("manager_mode", "manual");
    tx.save(team);
    result = team;
  });
  try {
    var col = $app.findCollectionByNameOrId("admin_audit_logs");
    var a = new Record(col);
    a.set("admin", userId);
    a.set("action", "team_claim");
    a.set("target_type", "proball_teams");
    a.set("target_id", teamId);
    a.set("meta", {});
    $app.save(a);
  } catch (_) {}
  return result;
}

function ensureUserCredits($app, userId) {
  var user = $app.findRecordById("users", userId);
  var c = user.get("credits");
  if (c == null || c === "") {
    user.set("credits", BALANCE.startingCredits);
    $app.save(user);
  }
  return user.get("credits") || 0;
}

/** Personal context: wallet, team, next fixture. */
function worldSnapshot($app, userId) {
  tickIfDue($app);
  var world = ensureWorld($app);
  var T = timing(world);
  var managed = getManagerTeam($app, userId);
  var credits = userId ? ensureUserCredits($app, userId) : 0;
  var t = activeTournament($app);
  var round = t ? currentRound($app, t.id) : null;
  if (drawHidden($app, round)) {
    t = null; // next championship drawn but not announced yet
    round = null;
  }
  var next = null;
  if (managed && t) {
    var f = one($app, "shared_fixtures", '(home_team = {:t} || away_team = {:t}) && tournament = {:x} && status != "finished"', "-created", { t: managed.id, x: t.id });
    if (f) {
      var teams = teamMap($app);
      var tm = fixtureTeams(f, teams);
      next = { fixtureId: f.id, status: f.get("status"), kickoffAt: parsePbDate(f.get("scheduled_at")), opponent: f.get("home_team") === managed.id ? tm.away : tm.home, home: f.get("home_team") === managed.id };
    }
  }
  return {
    serverTimeMs: Date.now(),
    credits: credits,
    startingCredits: BALANCE.startingCredits,
    managedTeam: managed ? Object.assign(teamPublic(managed), { treasury: managed.get("treasury"), battery_count: managed.get("battery_count") || 0, default_stance: managed.get("default_stance") || "balanced" }) : null,
    nextFixture: next,
    tournament: t ? { id: t.id, number: t.get("number"), current_round: t.get("current_round") } : null,
    activeRound: round ? { id: round.id, key: round.get("round_key"), label: round.get("label"), status: round.get("status"), scheduledAt: round.get("scheduled_at") } : null,
    timing: { betweenMinutes: T.betweenMinutes, gapMinutes: T.gapMinutes, windowMinutes: T.windowMinutes, minuteSec: T.minuteSec },
    commandCharge: managed ? mgmtMod.getCommandChargeState($app, userId) : null,
  };
}

/** Admin: reschedule a waiting round to now + between-round break. */
function applyBetweenRoundToWaiting($app, adminId, reason) {
  var world = ensureWorld($app);
  var T = timing(world);
  var t = activeTournament($app);
  var round = t ? currentRound($app, t.id) : null;
  if (!round || round.get("status") !== "scheduled") throw new BadRequestError("No round is waiting to kick off");
  var when = Date.now() + T.betweenMs;
  $app.runInTransaction(function (tx) {
    var r = tx.findRecordById("shared_rounds", round.id);
    if (r.get("status") !== "scheduled") throw new BadRequestError("Round already kicked off");
    r.set("scheduled_at", toPbDate(when));
    tx.save(r);
    fixturesOf(tx, r.id).forEach(function (f) {
      f.set("scheduled_at", toPbDate(when));
      tx.save(f);
    });
  });
  return { ok: true, roundId: round.id, scheduledAt: toPbDate(when), reason: reason || "" };
}

if (typeof module !== "undefined") {
  module.exports = {
    ensureWorld: ensureWorld,
    isSchemaReady: isSchemaReady,
    ensureTeams: ensureTeams,
    tick: tick,
    tickIfDue: tickIfDue,
    catchUpWorld: function ($app) {
      return tick($app, Date.now());
    },
    timing: timing,
    claimTeam: claimTeam,
    getManagerTeam: getManagerTeam,
    listTeams: listTeams,
    teamPublic: teamPublic,
    teamMap: teamMap,
    worldSnapshot: worldSnapshot,
    liveView: liveView,
    matchView: matchView,
    setCoaching: setCoaching,
    ensureUserCredits: ensureUserCredits,
    activeTournament: activeTournament,
    currentRound: currentRound,
    roundsOf: roundsOf,
    fixturesOf: fixturesOf,
    getActiveRound: function ($app) {
      var t = activeTournament($app);
      return t ? currentRound($app, t.id) : null;
    },
    lastPublished: lastPublished,
    publishedEvents: publishedEvents,
    fixtureCard: fixtureCard,
    drawHidden: drawHidden,
    modelOf: modelOf,
    readJson: readJson,
    parsePbDate: parsePbDate,
    toPbDate: toPbDate,
    applyBetweenRoundToWaiting: applyBetweenRoundToWaiting,
    BALANCE: BALANCE,
  };
}
