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
var teamsMod, tourneyMod, eng, balMod, mgmtMod, recMod, oddsMod, mkt, betMod, logger;
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
  logger = require(__hooks + "/lib/logger.js");
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
  logger = require("./logger.js");
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

// Structured logs go through lib/logger.js (scrubs sensitive keys); the event
// names stay stable because ops dashboards and tests match on them (review D11).
function log(event, fields) {
  logger.info(event, fields);
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
  var minuteSec = intIn(world.get("match_minute_real_seconds"), 1, 60, BALANCE.matchMinuteRealSeconds);
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
  ensureTeams($app); // creates missing teams and re-syncs template colours onto existing ones (runs on every bootstrap, so colour edits in teams.js self-heal deployed DBs)
  var w = one($app, "world", "key = 'main'");
  if (w) return w;
  var rec = new Record($app.findCollectionByNameOrId("world"));
  rec.set("key", "main");
  rec.set("pace", "normal");
  rec.set("between_round_minutes", 1);
  rec.set("round_interval_ms", 60000);
  rec.set("championship_gap_minutes", 10);
  rec.set("fixtures_window_minutes", 5);
  rec.set("match_minute_real_seconds", BALANCE.matchMinuteRealSeconds);
  rec.set("match_minute_real_ms", BALANCE.matchMinuteRealSeconds * 1000);
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

/** teams.js owns kit colours: bring an existing team row in line, saving only on drift. */
function syncTeamColours($app, rec, t) {
  if (rec.get("primary_color") === t.primary && rec.get("secondary_color") === t.secondary) return;
  rec.set("primary_color", t.primary);
  rec.set("secondary_color", t.secondary);
  $app.save(rec);
}

/**
 * Every team is saved with its players and record in one transaction. A team row left
 * without them by a pre-transaction build (its record is saved last) gets the missing
 * pieces; existing players and records are never touched.
 */
function ensureTeams($app) {
  var existing = all($app, "proball_teams", "id != ''", "sort_order", {}, 50);
  if (existing.length >= 16 && all($app, "global_team_records", "id != ''", "", {}, 50).length >= existing.length) {
    for (var s = 0; s < existing.length; s++) {
      var tmpl = teamsMod.getTeamBySlug(existing[s].get("slug"));
      if (tmpl) syncTeamColours($app, existing[s], tmpl);
    }
    return existing;
  }
  var TEAMS = teamsMod.TEAMS;
  var created = [];
  for (var i = 0; i < TEAMS.length; i++) {
    var t = TEAMS[i];
    var found = one($app, "proball_teams", "slug = {:s}", "", { s: t.slug });
    if (found) {
      syncTeamColours($app, found, t);
      if (!one($app, "global_team_records", "team = {:t}", "", { t: found.id })) {
        $app.runInTransaction(function (tx) {
          completeTeamSetup(tx, found, t);
        });
      }
      created.push(found);
      continue;
    }
    $app.runInTransaction(function (tx) {
      var team = new Record(tx.findCollectionByNameOrId("proball_teams"));
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
      tx.save(team);
      completeTeamSetup(tx, team, t);
      created.push(team);
    });
  }
  return created;
}

/** Add a team's template squad (only if it has no players) and its zeroed record (if missing). */
function completeTeamSetup(tx, team, t) {
  if (!one(tx, "proball_players", "team = {:t}", "", { t: team.id })) {
    var players = tourneyMod.defaultStarters(t.players || []);
    for (var p = 0; p < players.length; p++) {
      var pr = new Record(tx.findCollectionByNameOrId("proball_players"));
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
      tx.save(pr);
    }
  }
  if (one(tx, "global_team_records", "team = {:t}", "", { t: team.id })) return;
  var tr = new Record(tx.findCollectionByNameOrId("global_team_records"));
  tr.set("team", team.id);
  ["played", "wins", "draws", "losses", "goals_for", "goals_against", "shootout_wins", "shootout_losses", "championships"].forEach(function (f) {
    tr.set(f, 0);
  });
  tx.save(tr);
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
    createFirstRound(tx, t, teams, startAt);
    created = t;
  });
  if (created) log("championship_created", { number: created.get("number"), startsAt: toPbDate(startAt), ms: Date.now() - t0 });
  return created;
}

function createFirstRound(tx, t, teams, startAt) {
  var ids = teams.map(function (x) {
    return x.id;
  });
  var round = createRound(tx, t, "r16", tourneyMod.drawRoundOf16(ids, eng.hashSeed(t.id + ":r16")), startAt);
  t.set("odds_json", championshipOdds(tx, round));
  tx.save(t);
  return round;
}

/**
 * Idempotent per tournament and round key. A still-scheduled round that already exists
 * (e.g. left partial by a pre-transaction build) gets its missing slots; it is never redrawn.
 */
function createRound(tx, tournament, key, pairings, scheduledAt) {
  var idem = tournament.id + ":" + key + ":v2";
  var round = one(tx, "shared_rounds", "idempotency_key = {:k}", "", { k: idem });
  if (!round) {
    round = new Record(tx.findCollectionByNameOrId("shared_rounds"));
    round.set("tournament", tournament.id);
    round.set("round_key", key);
    round.set("label", ROUND_LABELS[key] || key);
    round.set("scheduled_at", toPbDate(scheduledAt));
    round.set("status", "scheduled");
    round.set("idempotency_key", idem);
    round.set("progression_done", false);
    tx.save(round);
  } else if (round.get("status") !== "scheduled") {
    return round;
  } else {
    pairings = roundPairings(tx, tournament, round);
  }
  addMissingFixtures(tx, tournament, round, pairings);
  return round;
}

/** Save a fixture for every pairing whose slot the round lacks ((round, slot) is unique). */
function addMissingFixtures(tx, tournament, round, pairings) {
  var have = {};
  fixturesOf(tx, round.id).forEach(function (f) {
    have[f.get("slot")] = true;
  });
  var teams = teamMap(tx);
  var scheduledAt = toPbDate(parsePbDate(round.get("scheduled_at")));
  var added = 0;
  for (var i = 0; i < pairings.length; i++) {
    var p = pairings[i];
    if (have[p.slot]) continue;
    if (!teams[p.homeId] || !teams[p.awayId]) throw new Error("round_setup_incomplete: " + round.get("round_key") + " " + p.slot);
    var fx = new Record(tx.findCollectionByNameOrId("shared_fixtures"));
    fx.set("tournament", tournament.id);
    fx.set("round", round.id);
    fx.set("slot", p.slot);
    fx.set("bracket_index", p.bracketIndex);
    fx.set("home_team", p.homeId);
    fx.set("away_team", p.awayId);
    fx.set("feeds_into", p.feedsInto || "");
    fx.set("feeds_position", p.feedsPosition || "");
    fx.set("scheduled_at", scheduledAt);
    fx.set("status", "scheduled");
    fx.set("lineups_frozen", false);
    fx.set("model_json", pairModel(engineTeam(tx, teams[p.homeId]), engineTeam(tx, teams[p.awayId])));
    tx.save(fx);
    added++;
  }
  return added;
}

/**
 * The pairings a round should hold. Later rounds follow the previous round's winners.
 * R16 keeps every team already placed (legacy rows used another draw seed) and pairs
 * the remaining teams into the empty slots in this tournament's draw order.
 */
function roundPairings(tx, t, round) {
  var key = round.get("round_key");
  var idx = ROUND_ORDER.indexOf(key);
  if (idx > 0) {
    var prevKey = ROUND_ORDER[idx - 1];
    var prev = one(tx, "shared_rounds", "tournament = {:t} && round_key = {:k}", "", { t: t.id, k: prevKey });
    var winners = {};
    if (prev) {
      fixturesOf(tx, prev.id).forEach(function (f) {
        winners[f.get("slot")] = f.get("winner_team");
      });
    }
    return tourneyMod.buildNextRoundFixtures(prevKey, winners);
  }
  var placed = {};
  var slots = {};
  fixturesOf(tx, round.id).forEach(function (f) {
    placed[f.get("home_team")] = true;
    placed[f.get("away_team")] = true;
    slots[f.get("slot")] = true;
  });
  var ids = all(tx, "proball_teams", "id != ''", "sort_order", {}, 50).map(function (x) {
    return x.id;
  });
  var draw = tourneyMod.drawRoundOf16(ids, eng.hashSeed(t.id + ":r16"));
  var rest = [];
  draw.forEach(function (p) {
    if (!placed[p.homeId]) rest.push(p.homeId);
    if (!placed[p.awayId]) rest.push(p.awayId);
  });
  var next = 0;
  return draw.map(function (p) {
    if (slots[p.slot]) return p;
    var q = { slot: p.slot, homeId: rest[next], awayId: rest[next + 1], feedsInto: p.feedsInto, feedsPosition: p.feedsPosition, bracketIndex: p.bracketIndex };
    next += 2;
    return q;
  });
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
    var fixtures = fixturesOf(tx, round.id);
    // A round left partial by a pre-transaction build is completed before anything kicks off.
    if (fixtures.length < (BRACKET[round.get("round_key")] || []).length) {
      var tour = tx.findRecordById("shared_tournaments", round.get("tournament"));
      addMissingFixtures(tx, tour, round, roundPairings(tx, tour, round));
      fixtures = fixturesOf(tx, round.id);
    }
    var teams = teamMap(tx);
    var timingSnap = eng.buildTiming(T.minuteSec * 1000, T.scale);
    for (var i = 0; i < fixtures.length; i++) {
      var fx = fixtures[i];
      var ms = one(tx, "match_states", "fixture = {:f}", "", { f: fx.id });
      // A fixture with a persisted engine state was already started (or finished) by an
      // earlier kick-off: keep its lineups, state, result, events and RNG/timing exactly
      // as they are. Restarting it would collide with the retained event sequences.
      if (ms) continue;
      // Marked started/finished but no state row: an inconsistent mix we cannot repair
      // safely. Fail closed — the transaction (including the slot repair above) rolls
      // back and the round stays scheduled rather than rewriting played data.
      if (fx.get("status") !== "scheduled") throw new Error("kickoff_fixture_mixed: " + fx.id);
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
      ms = new Record(tx.findCollectionByNameOrId("match_states"));
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

/** Latest tail of a fixture's public events, returned ascending (settlement needs the final snapshot). */
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

/** Lossless match-history page: earliest unread events, plus one row to detect continuation. */
function publishedEventPage($app, fixtureId, throughMs, sinceSeq) {
  var rows = $app.findRecordsByFilter(
    "match_events",
    "fixture = {:f} && at <= {:n} && seq > {:s}",
    "seq",
    301,
    0,
    { f: fixtureId, n: throughMs, s: sinceSeq },
  ) || [];
  var events = rows.slice(0, 300).map(function (r) { return readJson(r, "data", {}); });
  return {
    events: events,
    nextSeq: events.length ? events[events.length - 1].seq : sinceSeq,
    hasMore: rows.length > 300,
    throughMs: throughMs,
  };
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

/**
 * Close a round once every fixture is finalised; schedule the next one. One
 * transaction: any failure rolls the whole step back and the next tick retries.
 *
 * Legacy resume: pre-v2 code marked a round progression_done inside its transaction
 * and only then (outside it) settled bets, paid rewards and created the next round.
 * If that tail failed, the round is completed with no successor and the tournament
 * would stall. tick() passes resume=true for exactly that state (completed, still the
 * current round of the active tournament): the successor is created, or the
 * tournament closed, and round/championship markets are settled. Ruling: the
 * non-idempotent championship counters and awards (team/player championships, the
 * champion reward) are NOT re-run on resume — the pre-v2 tail ran them before the
 * tournament save, so re-running would risk double counting.
 */
function completeRound($app, roundId, now, T, resume) {
  var out = null;
  $app.runInTransaction(function (tx) {
    var round = tx.findRecordById("shared_rounds", roundId);
    var t = tx.findRecordById("shared_tournaments", round.get("tournament"));
    if (resume) {
      if (!round.get("progression_done") || round.get("status") !== "completed" || t.get("status") !== "active") return;
      var latest = currentRound(tx, t.id);
      if (!latest || latest.id !== round.id) return;
    } else if (round.get("progression_done")) return;
    var fixtures = fixturesOf(tx, round.id);
    var winners = {};
    var finished = 0;
    for (var i = 0; i < fixtures.length; i++) {
      if (fixtures[i].get("status") !== "finished" || !fixtures[i].get("winner_team")) return;
      winners[fixtures[i].get("slot")] = fixtures[i].get("winner_team");
      finished = Math.max(finished, fixtures[i].get("finished_ms") || 0);
    }
    if (!fixtures.length) return;
    if (!resume) {
      round.set("status", "completed");
      round.set("progression_done", true);
      round.set("completed_at", toPbDate(now));
      round.set("finished_ms", finished);
      tx.save(round);
    }
    var key = round.get("round_key");
    betMod.settleRoundFirst(tx, round, fixtures, true);
    if (key === "qf") betMod.settleSemis(tx, t, fixtures);
    var nextKey = tourneyMod.nextRoundKey(key);
    if (nextKey) {
      out = scheduleNextRound(tx, t, key, winners, finished, now, T);
      return;
    }
    var champ = fixtures[0].get("winner_team");
    t.set("status", "complete");
    t.set("current_round", "complete");
    t.set("champion_team", champ);
    t.set("completed_at", toPbDate(finished || now));
    tx.save(t);
    if (!resume) {
      updateTeamRecord(tx, champ, { championships: 1 });
      mgmtMod.rewardChampion(tx, champ, t.id);
      recMod.awardChampionshipPlayers(tx, champ);
    }
    recMod.ensureTournamentSummary(tx, t, fixtures);
    betMod.settleChampion(tx, t, champ);
    var world = one(tx, "world", "key = 'main'");
    var nextStart = Math.max(finished, now) + T.gapMs;
    world.set("next_action_at", toPbDate(nextStart));
    tx.save(world);
    out = { champion: champ, nextStart: nextStart };
  });
  if (out) log(resume ? "legacy_round_resumed" : "round_completed", { roundId: roundId, result: out });
  return out;
}

function scheduleNextRound(tx, t, key, winners, finished, now, T) {
  var nextKey = tourneyMod.nextRoundKey(key);
  var at = Math.max(finished + T.betweenMs, now + Math.min(T.betweenMs, 30000 / T.scale));
  createRound(tx, t, nextKey, tourneyMod.buildNextRoundFixtures(key, winners), at);
  t.set("current_round", nextKey);
  tx.save(t);
  return { next: nextKey, at: at };
}

/**
 * Pre-transaction builds could commit a championship without its first round, or close
 * a round without creating the next. Create the missing round (all-or-nothing) from the
 * draw or the closed round's winners; played rounds and fixtures are left as they are.
 */
function repairMissingRound($app, tournamentId, now, T) {
  var out = null;
  $app.runInTransaction(function (tx) {
    var t = tx.findRecordById("shared_tournaments", tournamentId);
    if (t.get("status") !== "active") return;
    var last = currentRound(tx, t.id);
    if (!last) {
      var at = parsePbDate(t.get("starts_at"));
      if (isNaN(at) || at < now) at = now + T.windowMs;
      createFirstRound(tx, t, ensureTeams(tx), at);
      out = { next: "r16", at: at };
      return;
    }
    if (last.get("status") !== "completed" || !tourneyMod.nextRoundKey(last.get("round_key"))) return;
    var fixtures = fixturesOf(tx, last.id);
    var winners = {};
    var finished = 0;
    for (var i = 0; i < fixtures.length; i++) {
      if (fixtures[i].get("status") !== "finished") return;
      winners[fixtures[i].get("slot")] = fixtures[i].get("winner_team");
      finished = Math.max(finished, fixtures[i].get("finished_ms") || 0);
    }
    out = scheduleNextRound(tx, t, last.get("round_key"), winners, finished, now, T);
  });
  if (out) log("round_repaired", { tournamentId: tournamentId, result: out });
  return out;
}

/**
 * Bring the shared world up to `now`. Called by cron, the /health designed-tick
 * endpoint, admin catch-up, recovery and bet placement.
 *
 * Single-flight: one worker holds the world progression lease at a time (review
 * B3/O12). The lease is one atomic conditional UPDATE on the world row inside a
 * transaction — SQLite serialises writers, so exactly one claimant transitions
 * the row. processing_version doubles as the lease expiry (epoch ms) and the
 * ownership token; a crashed holder's lease expires and the next tick reclaims
 * it (stale-lease recovery), no separate sweep needed.
 */
// A crashed holder (process killed mid-tick) orphans the lease until expiry, so
// keep it short: a normal tick is milliseconds, and even if a slow tick is
// reclaimed early the per-step transactions still prevent double work.
var LEASE_MS = 30000;
// ponytail: per-process jitter keeps same-millisecond claims from sharing a
// token; a collision (p ≈ 1/1000 per same-ms pair) just lets two workers run
// idempotent steps concurrently — per-step transactions still prevent doubles.
var leaseNonce = Math.floor(Math.random() * 1000);

function claimLease($app, worldId, now) {
  var token = now + LEASE_MS + leaseNonce;
  var claimed = false;
  $app.runInTransaction(function (tx) {
    tx.db()
      .newQuery(
        "UPDATE world SET processing_status = 'processing', processing_version = {:token} " +
          "WHERE id = {:id} AND (processing_status IS NULL OR processing_status != 'processing' OR processing_version < {:now})",
      )
      .bind({ token: token, id: worldId, now: now })
      .execute();
    var w = tx.findRecordById("world", worldId);
    claimed = w.get("processing_version") === token;
  });
  return claimed ? token : 0;
}

function releaseLease($app, worldId, token, status) {
  try {
    // Ownership fence: only the lease holder (matching token) changes the state,
    // so a slow worker cannot clobber a reclaimer's fresh lease.
    $app
      .db()
      .newQuery("UPDATE world SET processing_status = {:status} WHERE id = {:id} AND processing_version = {:token}")
      .bind({ status: status, id: worldId, token: token })
      .execute();
  } catch (_) {}
}

function tick($app, now) {
  now = now || Date.now();
  var world = ensureWorld($app);
  if (world.get("progression_paused")) return { paused: true };
  var token = claimLease($app, world.id, now);
  if (!token) return { locked: true }; // another worker is progressing the world
  var result, failed;
  try {
    result = tickLocked($app, world, now);
  } catch (err) {
    failed = err;
  }
  releaseLease($app, world.id, token, failed ? "error" : "idle");
  if (failed) throw failed;
  return result;
}

function tickLocked($app, world, now) {
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
    if (!round) {
      try {
        if (!repairMissingRound($app, t.id, now, T)) break;
      } catch (err3) {
        log("round_repair_error", { tournamentId: t.id, message: String(err3).slice(0, 300) });
        break;
      }
      actions.push("round_repaired");
      continue;
    }
    var status = round.get("status");
    if (status === "scheduled" || status === "management") {
      if (now < parsePbDate(round.get("scheduled_at"))) break;
      if (kickOff($app, round.id, now, T)) actions.push("kickoff:" + round.get("round_key"));
      continue;
    }
    if (status === "completed") {
      // Only a pre-v2 tail failure leaves a completed round as the current one.
      var resumed = completeRound($app, round.id, now, T, true);
      if (!resumed) break;
      actions.push("round_resumed:" + round.get("round_key"));
      if (resumed.champion) {
        if (createTournament($app, resumed.nextStart)) actions.push("championship_created");
        break;
      }
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

/** Throttled tick for the /health designed-tick endpoint (one per second per process). */
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

/** Main screen state: champion → fixtures → live, all from server time. Read-only (review B3). */
function liveView($app) {
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

/** Individual match view. Ascending cursor pages; hold throughMs across a finite backlog drain. Read-only (review B3). */
function matchView($app, fixtureId, sinceSeq, userId, throughMs) {
  var now = Date.now();
  sinceSeq = Math.max(0, sinceSeq || 0);
  throughMs = typeof throughMs === "number" && isFinite(throughMs) && throughMs >= 0 ? Math.min(now, throughMs) : now;
  var world = ensureWorld($app);
  var T = timing(world);
  var teams = teamMap($app);
  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  var round = $app.findRecordById("shared_rounds", fx.get("round"));
  if (drawHidden($app, round, now)) throw new Error("fixture not announced");
  var card = fixtureCard($app, fx, teams, throughMs, T);
  var managed = getManagerTeam($app, userId);
  var side = managed ? (managed.id === fx.get("home_team") ? "home" : managed.id === fx.get("away_team") ? "away" : null) : null;
  var events = [];
  var page = { nextSeq: sinceSeq, hasMore: false, throughMs: throughMs };
  var lineups = null;
  var coach = null;
  var sentOff = [];
  if (fx.get("status") !== "scheduled") {
    page = publishedEventPage($app, fixtureId, throughMs, sinceSeq);
    events = page.events;
    // Sent-off players from published events only (the engine state may already know a
    // red card that is a few seconds from publication).
    var reds = $app.findRecordsByFilter("match_events", 'fixture = {:f} && type = "red_card" && at <= {:n}', "seq", 10, 0, { f: fixtureId, n: throughMs }) || [];
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
    eventsPage: { nextSeq: page.nextSeq, hasMore: page.hasMore, throughMs: page.throughMs },
    lineups: lineups,
    sentOff: sentOff,
    managedSide: side,
    coach: coach,
  };
}

function numbered(p, i) {
  return { name: p.name, role: p.role, is_starter: p.is_starter, no: p.role === "gk" && p.is_starter ? 1 : i + 2 };
}

// ------------------------------------------------------------------ public scoreboard
//
// Anonymous read-only snapshot for external observers (the JDWD40 app
// dashboard). STRICTLY read-only: it never calls tick/tickIfDue/ensureWorld or
// any other write/progression path, even transitively — with no existing world
// the caller gets null (the route answers 503) and nothing is created.
// Reveal policy mirrors liveView exactly: the next championship's draw stays
// hidden until its fixture window opens, only events with at <= now are
// revealed, and final columns are read only for finished fixtures.
// Fields are whitelisted: team id/name/abbreviation, revealed score, minute,
// status, scheduled time, finished/shootout scores, last goal. Never managers,
// user ids, player attributes, treasury, model_json, odds or future events.

/** Whitelisted team shape — reuses teamPublic's abbreviation fallback. */
function scoreboardTeam(t) {
  if (!t) return null;
  var pub = teamPublic(t);
  return { id: pub.id, name: pub.name, abbreviation: pub.abbreviation };
}

function scoreboardSide(pub) {
  return pub ? { id: pub.id, name: pub.name, abbreviation: pub.abbreviation } : null;
}

/** Last championship + final result, narrowed to public fields. */
function scoreboardChampion($app, t, teams) {
  var c = championView($app, t, teams); // reuse reveal/shape logic, then narrow
  if (!c) return null;
  return {
    tournamentId: c.tournamentId,
    number: c.number,
    team: scoreboardSide(c.team),
    final: c.final
      ? {
          fixtureId: c.final.fixtureId,
          home: scoreboardSide(c.final.home),
          away: scoreboardSide(c.final.away),
          score: { home: c.final.sh, away: c.final.sa },
          shootout: c.final.soh + c.final.soa > 0 ? { home: c.final.soh, away: c.final.soa } : null,
          by: c.final.by,
        }
      : null,
    completedAt: c.completedAt,
  };
}

/** Public card for one fixture: revealed state only, never engine internals. */
function scoreboardCard($app, fx, teams, now, T) {
  var status = fx.get("status");
  var card = {
    id: fx.id,
    slot: fx.get("slot"),
    index: fx.get("bracket_index"),
    home: scoreboardTeam(teams[fx.get("home_team")]),
    away: scoreboardTeam(teams[fx.get("away_team")]),
    status: status,
    kickoffAt: parsePbDate(fx.get("scheduled_at")),
    minute: null,
    score: null,
    shootout: null,
    phase: status === "scheduled" ? "pre" : null,
    last: null,
    result: null,
  };
  if (status === "scheduled") return card;
  if (status === "finished") {
    // Final columns are only written once the result is public (finaliseFixture).
    var sh = fx.get("score_home");
    var sa = fx.get("score_away");
    var soh = fx.get("shootout_home") || 0;
    var soa = fx.get("shootout_away") || 0;
    card.phase = "finished";
    card.minute = 120;
    card.score = { home: sh, away: sa };
    if (soh + soa > 0) card.shootout = { home: soh, away: soa };
    card.result = {
      home: sh,
      away: sa,
      shootoutHome: soh,
      shootoutAway: soa,
      winner: fx.get("winner_team") === fx.get("home_team") ? "home" : "away",
      by: fx.get("decided_by") || null,
    };
    return card;
  }
  // Live: reveal only events already published (at <= now) — same boundary as liveView.
  var ev = lastPublished($app, fx.id, now);
  if (ev && ev.st && ev.st.sc) {
    card.phase = ev.st.ph || null;
    card.score = { home: ev.st.sc[0], away: ev.st.sc[1] };
    if (ev.st.so) card.shootout = { home: ev.st.so.h, away: ev.st.so.a };
    card.minute =
      ev.st.ph === "finished"
        ? 120
        : Math.max(0, Math.floor(oddsMod.clockMinute(ev.st.clk, ev.at, now, minuteMsOf(fx, T))));
    if (ev.t === "goal" || ev.t === "penalty_goal") {
      card.last = { t: ev.t, text: ev.text || null, side: ev.side || null, minute: ev.min != null ? ev.min : null };
    }
  }
  return card;
}

/**
 * Read-only scoreboard snapshot. Returns null when no schema/world exists —
 * the caller reports "unavailable" and nothing is created.
 */
function publicScoreboard($app) {
  if (!isSchemaReady($app)) return null;
  var world = one($app, "world", "key = 'main'");
  if (!world) return null;
  var now = Date.now();
  var T = timing(world);
  var teams = teamMap($app);
  var t = activeTournament($app);
  var last = lastCompleteTournament($app);
  var view = {
    serverTime: new Date(now).toISOString(),
    serverTimeMs: now,
    state: "idle", // idle | fixtures | live | champion (liveView vocabulary)
    tournament: null,
    round: null,
    fixtures: [],
    champion: null,
    nextChampionshipAt: null,
    fixturesAt: null,
  };
  var round = t ? currentRound($app, t.id) : null;
  // Same hidden-draw rule as drawHidden(), evaluated against the existing world
  // record (drawHidden itself calls ensureWorld, which is a write path).
  var hidden =
    round &&
    round.get("status") === "scheduled" &&
    round.get("round_key") === "r16" &&
    now < drawVisibleAt(round, T);
  if (!t || hidden) {
    // Champion gap: latest final stays visible; the unannounced draw never leaks.
    var start = t ? parsePbDate(t.get("starts_at")) : nextStartMs(world);
    view.state = last && last.get("champion_team") ? "champion" : "idle";
    view.nextChampionshipAt = isNaN(start) ? null : start;
    view.fixturesAt = isNaN(start) ? null : start - T.windowMs;
    if (view.state === "champion") view.champion = scoreboardChampion($app, last, teams);
    return view;
  }
  view.tournament = { id: t.id, number: t.get("number"), status: t.get("status") };
  if (!round) return view;
  var rs = round.get("status");
  view.state = rs === "live" ? "live" : "fixtures";
  view.round = {
    id: round.id,
    key: round.get("round_key"),
    label: round.get("label"),
    status: rs,
    scheduledAt: parsePbDate(round.get("scheduled_at")),
    finishedAt: round.get("finished_ms") || null,
  };
  view.fixtures = fixturesOf($app, round.id).map(function (fx) {
    return scoreboardCard($app, fx, teams, now, T);
  });
  // Once the next draw is out the champion stays visible during the R16 window
  // (mirrors liveView's recentChampion).
  if (rs === "scheduled" && round.get("round_key") === "r16" && last && last.get("champion_team")) {
    view.recentChampion = scoreboardChampion($app, last, teams);
  }
  return view;
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

/** Personal context: wallet, team, next fixture. Read-only (review B3). */
function worldSnapshot($app, userId) {
  var world = ensureWorld($app);
  var T = timing(world);
  var managed = getManagerTeam($app, userId);
  // Credits are set at signup/admin-creation; read them, never grant on a GET.
  var credits = 0;
  if (userId) {
    var u = $app.findRecordById("users", userId);
    var c = u.get("credits");
    credits = c == null || c === "" ? 0 : c;
  }
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
    publicScoreboard: publicScoreboard,
    drawVisibleAt: drawVisibleAt,
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
    resultOf: resultOf,
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
