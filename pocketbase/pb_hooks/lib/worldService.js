/**
 * Shared global Proball world service.
 */
var teamsMod, tourneyMod, matchMod, balMod, mgmtMod, recMod;
try {
  teamsMod = require(__hooks + "/lib/teams.js");
  tourneyMod = require(__hooks + "/lib/tournament.js");
  matchMod = require(__hooks + "/lib/matchEngine.js");
  balMod = require(__hooks + "/lib/balance.js");
  mgmtMod = require(__hooks + "/lib/managementService.js");
  recMod = require(__hooks + "/lib/recordsService.js");
} catch (e) {
  teamsMod = require("./teams.js");
  tourneyMod = require("./tournament.js");
  matchMod = require("./matchEngine.js");
  balMod = require("./balance.js");
  mgmtMod = require("./managementService.js");
  recMod = require("./recordsService.js");
}

var TEAMS = teamsMod.TEAMS;
var BALANCE = balMod.BALANCE;
var getTiming = balMod.getTiming;
var drawRoundOf16 = tourneyMod.drawRoundOf16;
var buildNextRoundFixtures = tourneyMod.buildNextRoundFixtures;
var nextRoundKey = tourneyMod.nextRoundKey;
var ROUND_LABELS = tourneyMod.ROUND_LABELS;
var defaultStarters = tourneyMod.defaultStarters;
var createMatchState = matchMod.createMatchState;
var advanceSegment = matchMod.advanceSegment;
var reconstructVisible = matchMod.reconstructVisible;
var hashSeed = matchMod.hashSeed;

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function parsePbDate(v) {
  if (v == null || v === "") return NaN;
  if (Object.prototype.toString.call(v) === "[object Date]") return v.getTime();
  var s = String(v).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  return new Date(s).getTime();
}

function parseJson(val, fallback) {
  if (val == null || val === "") return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch (_) {
      return fallback;
    }
  }
  try {
    return JSON.parse(JSON.stringify(val));
  } catch (_) {
    return val || fallback;
  }
}

function loadEventsFromDb($app, matchStateId) {
  try {
    var ms = $app.findRecordById("match_states", matchStateId);
    var raw = ms.get("events_json");
    if (raw == null || raw === "") return [];
    if (typeof raw === "string") {
      try {
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? filterEvents(arr) : [];
      } catch (_) {
        return [];
      }
    }
    // Prefer JSON round-trip for goja host arrays
    try {
      var s = JSON.stringify(raw);
      if (s && s.charAt(0) === "[") {
        return filterEvents(JSON.parse(s));
      }
    } catch (_) {}
    return filterEvents(raw);
  } catch (err) {
    console.log("[footfive] loadEventsFromDb: " + err);
    return [];
  }
}

function filterEvents(list) {
  var out = [];
  if (!list || typeof list.length !== "number") return out;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item && typeof item === "object" && (item.type || item.seq != null)) {
      out.push(item);
    }
  }
  return out;
}

function audit($app, adminId, action, targetType, targetId, meta) {
  try {
    var col = $app.findCollectionByNameOrId("admin_audit_logs");
    var rec = new Record(col);
    rec.set("admin", adminId);
    rec.set("action", action);
    rec.set("target_type", targetType || "");
    rec.set("target_id", targetId || "");
    rec.set("meta", meta || {});
    $app.save(rec);
  } catch (_) {}
}

/**
 * True when required shared-world collections exist (migrations applied).
 */
function isSchemaReady($app) {
  var need = [
    "world",
    "proball_teams",
    "proball_players",
    "shared_tournaments",
    "shared_rounds",
    "shared_fixtures",
    "match_states",
    "global_team_records",
  ];
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
  if (!isSchemaReady($app)) {
    throw new Error("schema_not_ready");
  }
  var rows = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0);
  if (rows && rows.length) {
    // Existing production world — never create duplicate
    return rows[0];
  }

  ensureTeams($app);

  // Re-check no concurrent create
  rows = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0);
  if (rows && rows.length) return rows[0];

  var col = $app.findCollectionByNameOrId("world");
  var w = new Record(col);
  w.set("key", "main");
  // Fresh installs use production-like pace (not dev turbo)
  w.set("pace", "normal");
  w.set("round_interval_ms", BALANCE.roundIntervalMs);
  w.set("tournament_interval_ms", BALANCE.tournamentIntervalMs);
  w.set("segment_minutes", 5);
  w.set("match_minute_real_ms", BALANCE.matchMinuteRealMs);
  w.set("processing_status", "idle");
  w.set("processing_version", 0);
  w.set("retention_days", 30);
  w.set("progression_paused", false);
  $app.save(w);

  // Start first tournament if none
  var t = getActiveTournament($app);
  if (!t) createTournament($app, w);
  return w;
}

function ensureTeams($app) {
  var existing = $app.findRecordsByFilter("proball_teams", "id != ''", "sort_order", 50, 0);
  if (existing && existing.length >= 16) return existing;

  var teamsCol = $app.findCollectionByNameOrId("proball_teams");
  var playersCol = $app.findCollectionByNameOrId("proball_players");
  var recordsCol = $app.findCollectionByNameOrId("global_team_records");
  var created = [];

  for (var i = 0; i < TEAMS.length; i++) {
    var t = TEAMS[i];
    var found = $app.findRecordsByFilter(
      "proball_teams",
      "slug = {:s}",
      "",
      1,
      0,
      { s: t.slug },
    );
    if (found && found.length) {
      created.push(found[0]);
      continue;
    }
    var team = new Record(teamsCol);
    team.set("slug", t.slug);
    team.set("name", t.name);
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

    var players = defaultStarters(t.players || []);
    for (var p = 0; p < players.length; p++) {
      var pl = players[p];
      var prec = new Record(playersCol);
      prec.set("team", team.id);
      prec.set("name", pl.name);
      prec.set("role", pl.role || "util");
      prec.set("attack", pl.attack || 50);
      prec.set("defence", pl.defence || 50);
      prec.set("energy", 100);
      prec.set("condition", 100);
      prec.set("is_starter", !!pl.is_starter);
      prec.set("intensity", pl.intensity || "balanced");
      prec.set("sort_order", p);
      $app.save(prec);
    }

    var tr = new Record(recordsCol);
    tr.set("team", team.id);
    tr.set("played", 0);
    tr.set("wins", 0);
    tr.set("draws", 0);
    tr.set("losses", 0);
    tr.set("goals_for", 0);
    tr.set("goals_against", 0);
    tr.set("shootout_wins", 0);
    tr.set("shootout_losses", 0);
    tr.set("championships", 0);
    $app.save(tr);
  }
  return created;
}

function getActiveTournament($app) {
  var rows = $app.findRecordsByFilter(
    "shared_tournaments",
    'status = "active"',
    "-number",
    1,
    0,
  );
  return rows && rows.length ? rows[0] : null;
}

function createTournament($app, world) {
  var teams = ensureTeams($app);
  // reset eliminated
  for (var i = 0; i < teams.length; i++) {
    teams[i].set("eliminated", false);
    $app.save(teams[i]);
  }

  var existing = $app.findRecordsByFilter(
    "shared_tournaments",
    "id != ''",
    "-number",
    1,
    0,
  );
  var num = 1;
  if (existing && existing.length) num = (existing[0].get("number") || 0) + 1;

  var tCol = $app.findCollectionByNameOrId("shared_tournaments");
  var tournament = new Record(tCol);
  tournament.set("number", num);
  tournament.set("status", "active");
  tournament.set("current_round", "r16");
  $app.save(tournament);

  var pace = world.get("pace") || "dev";
  var timing = getTiming(pace);
  var delay = timing.firstKickoffDelayMs;
  var scheduled = new Date(Date.now() + delay);
  var teamIds = teams.map(function (t) {
    return t.id;
  });
  createRound($app, tournament, "r16", teamIds, null, scheduled, pace);
  world.set("next_action_at", toPbDate(scheduled));
  $app.save(world);
  return tournament;
}

function createRound($app, tournament, roundKey, teamIds, winnersBySlot, scheduledAt, pace) {
  var rCol = $app.findCollectionByNameOrId("shared_rounds");
  var fCol = $app.findCollectionByNameOrId("shared_fixtures");
  var idem = tournament.id + ":" + roundKey + ":v2";

  var existing = $app.findRecordsByFilter(
    "shared_rounds",
    "idempotency_key = {:k}",
    "",
    1,
    0,
    { k: idem },
  );
  if (existing && existing.length) return existing[0];

  var round = new Record(rCol);
  round.set("tournament", tournament.id);
  round.set("round_key", roundKey);
  round.set("label", ROUND_LABELS[roundKey] || roundKey);
  round.set("scheduled_at", toPbDate(scheduledAt));
  round.set("status", "scheduled");
  round.set("idempotency_key", idem);
  round.set("progression_done", false);
  round.set("processing_version", 0);
  $app.save(round);

  var pairings;
  if (roundKey === "r16") {
    pairings = drawRoundOf16(teamIds, hashSeed(tournament.id + roundKey));
  } else {
    var prev =
      roundKey === "qf" ? "r16" : roundKey === "sf" ? "qf" : "sf";
    pairings = buildNextRoundFixtures(prev, winnersBySlot);
  }

  for (var i = 0; i < pairings.length; i++) {
    var p = pairings[i];
    if (!p.homeId || !p.awayId) continue;
    var fx = new Record(fCol);
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
    $app.save(fx);
  }
  return round;
}

function teamPublic(t, managerName) {
  return {
    id: t.id,
    name: t.get("name"),
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
  };
}

function getManagerTeam($app, userId) {
  var rows = $app.findRecordsByFilter(
    "proball_teams",
    "manager = {:u}",
    "",
    1,
    0,
    { u: userId },
  );
  return rows && rows.length ? rows[0] : null;
}

function claimTeam($app, userId, teamId) {
  var owned = getManagerTeam($app, userId);
  if (owned) throw new BadRequestError("You already manage a team");

  var result = null;
  $app.runInTransaction(function (txApp) {
    var team = txApp.findRecordById("proball_teams", teamId);
    if (team.get("manager")) {
      throw new BadRequestError("Team already claimed");
    }
    // re-check user has no team
    var again = txApp.findRecordsByFilter(
      "proball_teams",
      "manager = {:u}",
      "",
      1,
      0,
      { u: userId },
    );
    if (again && again.length) throw new BadRequestError("You already manage a team");

    team.set("manager", userId);
    txApp.save(team);
    result = team;
  });

  try {
    audit($app, userId, "team_claim", "proball_teams", teamId, {});
  } catch (_) {}
  return result;
}

function releaseTeam($app, adminId, teamId) {
  var team = $app.findRecordById("proball_teams", teamId);
  var prev = team.get("manager");
  team.set("manager", "");
  $app.save(team);
  audit($app, adminId, "team_release", "proball_teams", teamId, { previous: prev });
  return team;
}

function loadTeamForSim($app, teamId) {
  return mgmtMod.loadTeamSnapshot($app, teamId);
}

function freezeLineups($app, fixture) {
  if (fixture.get("lineups_frozen")) return;
  var home = loadTeamForSim($app, fixture.get("home_team"));
  var away = loadTeamForSim($app, fixture.get("away_team"));
  fixture.set("home_lineup_json", home.players);
  fixture.set("away_lineup_json", away.players);
  fixture.set("lineups_frozen", true);
  $app.save(fixture);

  // Consume overclock flags into next match (mark fixture on team)
  try {
    if (home.overclock) {
      var ht = $app.findRecordById("proball_teams", home.id);
      ht.set("overclock_ready", false);
      ht.set("overclock_fixture", fixture.id);
      $app.save(ht);
    }
    if (away.overclock) {
      var at = $app.findRecordById("proball_teams", away.id);
      at.set("overclock_ready", false);
      at.set("overclock_fixture", fixture.id);
      $app.save(at);
    }
  } catch (_) {}
}

function segmentRealMs(world) {
  var pace = world.get("pace") || "dev";
  var timing = getTiming(pace);
  var mins = timing.segmentMatchMinutes || 5;
  return mins * timing.matchMinuteRealMs;
}

/**
 * Start live fixtures for a due round: freeze lineups, create match_states.
 */
function kickOffRound($app, round, world) {
  if (round.get("status") === "live" || round.get("status") === "completed") {
    return { skipped: true };
  }
  var scheduled = parsePbDate(round.get("scheduled_at"));
  if (isNaN(scheduled) || Date.now() < scheduled) return { waiting: true };

  var fixtures = $app.findRecordsByFilter(
    "shared_fixtures",
    "round = {:r}",
    "bracket_index",
    20,
    0,
    { r: round.id },
  );
  var pace = world.get("pace") || "dev";
  var startedAt = new Date(Math.max(scheduled, Date.now() - 1000));
  var msCol = $app.findCollectionByNameOrId("match_states");
  var segMs = segmentRealMs(world);

  for (var i = 0; i < fixtures.length; i++) {
    var fx = fixtures[i];
    freezeLineups($app, fx);

    var existing = $app.findRecordsByFilter(
      "match_states",
      "fixture = {:f}",
      "",
      1,
      0,
      { f: fx.id },
    );
    if (existing && existing.length) continue;

    var homePlayers = parseJson(fx.get("home_lineup_json"), []);
    var awayPlayers = parseJson(fx.get("away_lineup_json"), []);
    var homeTeam = $app.findRecordById("proball_teams", fx.get("home_team"));
    var awayTeam = $app.findRecordById("proball_teams", fx.get("away_team"));
    var homeOc =
      homeTeam.get("overclock_fixture") === fx.id ||
      !!homeTeam.get("overclock_ready");
    var awayOc =
      awayTeam.get("overclock_fixture") === fx.id ||
      !!awayTeam.get("overclock_ready");

    var state = createMatchState({
      home: {
        id: homeTeam.id,
        name: homeTeam.get("name"),
        grade: homeTeam.get("grade"),
        players: homePlayers,
      },
      away: {
        id: awayTeam.id,
        name: awayTeam.get("name"),
        grade: awayTeam.get("grade"),
        players: awayPlayers,
      },
      seed: hashSeed(fx.id + ":" + round.id),
      pace: pace,
      homeCoaching: "balanced",
      awayCoaching: "balanced",
      homeOverclock: homeOc,
      awayOverclock: awayOc,
    });

    // First segment at kickoff
    var advanced = advanceSegment(state, {});
    var ms = new Record(msCol);
    ms.set("fixture", fx.id);
    ms.set("seed", state.seed);
    ms.set("sim_version", 1);
    ms.set("processing_version", 0);
    ms.set("phase", state.phase);
    ms.set("sim_minute", state.simMinute);
    ms.set("score_home", state.scoreHome);
    ms.set("score_away", state.scoreAway);
    ms.set("shootout_home", state.shootoutHome);
    ms.set("shootout_away", state.shootoutAway);
    ms.set("home_coaching", state.homeCoaching);
    ms.set("away_coaching", state.awayCoaching);
    ms.set("state_json", stripEvents(state));
    ms.set("events_json", state.events);
    ms.set("stats_json", state.stats);
    ms.set("started_at", toPbDate(startedAt));
    ms.set("next_segment_due_at", toPbDate(startedAt.getTime() + segMs));
    ms.set("last_processed_at", toPbDate(new Date()));
    ms.set("finalised", !!state.finalised);
    ms.set("progression_settled", false);
    ms.set("segment_index", state.segmentIndex);
    ms.set("last_segment_key", fx.id + ":seg:0");
    if (state.finalised && state.winnerSide) {
      ms.set(
        "winner_team",
        state.winnerSide === "home" ? fx.get("home_team") : fx.get("away_team"),
      );
    }
    $app.save(ms);

    fx.set("status", state.finalised ? "finished" : "live");
    if (state.finalised && state.winnerSide) {
      fx.set(
        "winner_team",
        state.winnerSide === "home" ? fx.get("home_team") : fx.get("away_team"),
      );
    }
    $app.save(fx);

    // Lock bets at kickoff
    lockBetsForFixture($app, fx.id);
  }

  round.set("status", "live");
  round.set("started_at", toPbDate(startedAt));
  $app.save(round);
  return { kicked: true };
}

function stripEvents(state) {
  var copy = {};
  for (var k in state) {
    if (k === "events") continue;
    if (Object.prototype.hasOwnProperty.call(state, k)) copy[k] = state[k];
  }
  return copy;
}

function hydrateState(ms, events, app) {
  var raw = parseJson(ms.get("state_json"), {});
  if (!raw || typeof raw !== "object") raw = {};
  raw.events = events || [];
  raw.scoreHome = ms.get("score_home") || 0;
  raw.scoreAway = ms.get("score_away") || 0;
  raw.shootoutHome = ms.get("shootout_home") || 0;
  raw.shootoutAway = ms.get("shootout_away") || 0;
  raw.homeCoaching = ms.get("home_coaching") || "balanced";
  raw.awayCoaching = ms.get("away_coaching") || "balanced";
  raw.phase = ms.get("phase") || raw.phase || "first_half";
  raw.simMinute = ms.get("sim_minute") || 0;
  raw.finalised = !!ms.get("finalised");
  raw.segmentIndex = ms.get("segment_index") || 0;
  raw.seed = ms.get("seed") || 1;
  raw.homePlayers = Array.isArray(raw.homePlayers) ? raw.homePlayers : [];
  raw.awayPlayers = Array.isArray(raw.awayPlayers) ? raw.awayPlayers : [];
  raw.homeName = raw.homeName || "Home";
  raw.awayName = raw.awayName || "Away";
  raw.homeGrade = raw.homeGrade || "C";
  raw.awayGrade = raw.awayGrade || "C";
  raw.yellows = raw.yellows || {};
  raw.sentOff = raw.sentOff || {};
  raw.stats = raw.stats || {
    home: { goals: 0 },
    away: { goals: 0 },
  };
  if (!raw.timing) {
    raw.timing = getTiming(raw.pace || "dev");
  }
  // If players missing (legacy state), try lineup from fixture
  if ((!raw.homePlayers.length || !raw.awayPlayers.length) && app) {
    try {
      var fx = app.findRecordById("shared_fixtures", ms.get("fixture"));
      if (!raw.homePlayers.length) {
        raw.homePlayers = parseJson(fx.get("home_lineup_json"), []) || [];
      }
      if (!raw.awayPlayers.length) {
        raw.awayPlayers = parseJson(fx.get("away_lineup_json"), []) || [];
      }
    } catch (_) {}
  }
  return raw;
}

/**
 * Advance due segments for all live match_states. Idempotent.
 */
function advanceDueMatches($app, world, limit) {
  limit = limit || 40;
  var now = Date.now();
  var due = $app.findRecordsByFilter(
    "match_states",
    'finalised = false && next_segment_due_at <= {:n}',
    "next_segment_due_at",
    limit,
    0,
    { n: toPbDate(new Date(now + 500)) },
  );
  // Also find any with empty next or past
  if (!due || !due.length) {
    due = $app.findRecordsByFilter(
      "match_states",
      "finalised = false",
      "next_segment_due_at",
      limit,
      0,
    );
  }

  var advanced = 0;
  var segMs = segmentRealMs(world);

  for (var i = 0; i < (due || []).length; i++) {
    var ms = due[i];
    if (ms.get("finalised")) continue;
    var nextDue = parsePbDate(ms.get("next_segment_due_at"));
    if (!isNaN(nextDue) && nextDue > now + 50) continue;

    try {
      if (advanceOneMatch($app, ms, world, segMs)) advanced++;
    } catch (err) {
      console.log("[footfive] advance match " + ms.id + ": " + err);
    }
  }
  return advanced;
}

function advanceOneMatch($app, ms, world, segMs) {
  var version = ms.get("processing_version") || 0;
  var segIndex = ms.get("segment_index") || 0;
  var segKey = ms.get("fixture") + ":seg:" + (segIndex + 1);

  if (ms.get("last_segment_key") === segKey) {
    // already processed this segment id
    return false;
  }

  var events = loadEventsFromDb($app, ms.id);
  if (!events.length) events = filterEvents(parseJson(ms.get("events_json"), []));
  var state = hydrateState(ms, events, $app);
  if (!state.homePlayers.length || !state.awayPlayers.length) {
    console.log("[footfive] skip advance — missing players for " + ms.id);
    return false;
  }

  var result = advanceSegment(state, {
    homeCoaching: ms.get("home_coaching") || "balanced",
    awayCoaching: ms.get("away_coaching") || "balanced",
  });

  var started = parsePbDate(ms.get("started_at"));
  if (isNaN(started)) started = Date.now();
  var nextDue = Date.now() + segMs;
  // Align to started + segment_index * segMs for determinism
  var aligned = started + state.segmentIndex * segMs;
  if (aligned > Date.now()) nextDue = aligned;
  else nextDue = Date.now() + 50;

  $app.runInTransaction(function (txApp) {
    var fresh = txApp.findRecordById("match_states", ms.id);
    if (fresh.get("finalised")) return;
    if ((fresh.get("processing_version") || 0) !== version) return;
    if (fresh.get("last_segment_key") === segKey) return;

    fresh.set("processing_version", version + 1);
    fresh.set("phase", state.phase);
    fresh.set("sim_minute", state.simMinute);
    fresh.set("score_home", state.scoreHome);
    fresh.set("score_away", state.scoreAway);
    fresh.set("shootout_home", state.shootoutHome);
    fresh.set("shootout_away", state.shootoutAway);
    fresh.set("state_json", stripEvents(state));
    fresh.set("events_json", state.events);
    fresh.set("stats_json", state.stats);
    fresh.set("segment_index", state.segmentIndex);
    fresh.set("last_segment_key", segKey);
    fresh.set("last_processed_at", toPbDate(new Date()));
    fresh.set("next_segment_due_at", toPbDate(nextDue));
    fresh.set("finalised", !!state.finalised);
    if (state.finalised && state.winnerSide) {
      var fx = txApp.findRecordById("shared_fixtures", fresh.get("fixture"));
      var winnerId =
        state.winnerSide === "home" ? fx.get("home_team") : fx.get("away_team");
      fresh.set("winner_team", winnerId);
      fx.set("status", "finished");
      fx.set("winner_team", winnerId);
      txApp.save(fx);
    }
    txApp.save(fresh);
  });

  return true;
}

function lockBetsForFixture($app, fixtureId) {
  try {
    var bets = $app.findRecordsByFilter(
      "shared_bets",
      'fixture = {:f} && status = "open"',
      "",
      200,
      0,
      { f: fixtureId },
    );
    for (var i = 0; i < (bets || []).length; i++) {
      bets[i].set("status", "locked");
      $app.save(bets[i]);
    }
  } catch (_) {}
}

function settleBetsForFixture($app, fixture, winnerTeamId) {
  var bets;
  try {
    bets = $app.findRecordsByFilter(
      "shared_bets",
      "fixture = {:f} && settled != true",
      "",
      200,
      0,
      { f: fixture.id },
    );
  } catch (_) {
    return;
  }
  for (var i = 0; i < (bets || []).length; i++) {
    settleOneBet($app, bets[i], winnerTeamId);
  }
}

function settleOneBet($app, bet, winnerTeamId) {
  var key = bet.id + ":settle:v1";
  if (bet.get("settled") || bet.get("settlement_key") === key) return;

  $app.runInTransaction(function (txApp) {
    var fresh = txApp.findRecordById("shared_bets", bet.id);
    if (fresh.get("settled")) return;
    var stake = fresh.get("stake") || 0;
    var odds = fresh.get("odds") || 1;
    var won = fresh.get("selection_team") === winnerTeamId;
    var userId = fresh.get("user");
    var user = txApp.findRecordById("users", userId);
    var credits = user.get("credits") || 0;

    if (won) {
      var payout = Math.floor(stake * odds);
      user.set("credits", credits + payout);
      txApp.save(user);
      writeTx(txApp, userId, "bet_win", payout, "Bet win " + fresh.id, key + ":win");
      fresh.set("status", "won");
    } else {
      fresh.set("status", "lost");
      writeTx(txApp, userId, "bet_loss", 0, "Bet lost " + fresh.id, key + ":loss");
    }
    fresh.set("settled", true);
    fresh.set("settlement_key", key);
    txApp.save(fresh);
  });
}

function writeTx(txApp, userId, type, amount, description, idem) {
  try {
    var col = txApp.findCollectionByNameOrId("credit_ledger");
    var rec = new Record(col);
    rec.set("user", userId);
    rec.set("type", type);
    rec.set("amount", amount);
    rec.set("description", description);
    rec.set("idempotency_key", idem);
    txApp.save(rec);
  } catch (err) {
    console.log("[footfive] writeTx: " + err);
  }
}

function completeRoundIfReady($app, round, world) {
  if (round.get("progression_done") || round.get("status") === "completed") {
    return { skipped: true };
  }
  var fixtures = $app.findRecordsByFilter(
    "shared_fixtures",
    "round = {:r}",
    "bracket_index",
    20,
    0,
    { r: round.id },
  );
  if (!fixtures.length) return { waiting: true };

  var allDone = true;
  var winnersBySlot = {};
  for (var i = 0; i < fixtures.length; i++) {
    var fx = fixtures[i];
    var msRows = $app.findRecordsByFilter(
      "match_states",
      "fixture = {:f}",
      "",
      1,
      0,
      { f: fx.id },
    );
    if (!msRows.length || !msRows[0].get("finalised")) {
      allDone = false;
      break;
    }
    winnersBySlot[fx.get("slot")] = msRows[0].get("winner_team");
  }
  if (!allDone) return { waiting: true };

  $app.runInTransaction(function (txApp) {
    var fresh = txApp.findRecordById("shared_rounds", round.id);
    if (fresh.get("progression_done")) return;

    for (var j = 0; j < fixtures.length; j++) {
      var f = txApp.findRecordById("shared_fixtures", fixtures[j].id);
      var ms = txApp.findRecordsByFilter(
        "match_states",
        "fixture = {:f}",
        "",
        1,
        0,
        { f: f.id },
      )[0];
      if (!ms || ms.get("progression_settled")) continue;

      var winnerId = ms.get("winner_team");
      var homeId = f.get("home_team");
      var awayId = f.get("away_team");
      var hs = ms.get("score_home") || 0;
      var as_ = ms.get("score_away") || 0;
      var wentSo =
        (ms.get("shootout_home") || 0) + (ms.get("shootout_away") || 0) > 0;
      var drawFT = hs === as_;

      var stJson = parseJson(ms.get("state_json"), {});
      var wentEt = !!stJson.wentExtraTime;
      var homeWon = winnerId === homeId;
      var awayWon = winnerId === awayId;
      updateTeamRecord(txApp, homeId, {
        played: 1,
        wins: !drawFT && homeWon ? 1 : 0,
        draws: drawFT ? 1 : 0,
        losses: !drawFT && !homeWon ? 1 : 0,
        goals_for: hs,
        goals_against: as_,
        shootout_wins: wentSo && homeWon ? 1 : 0,
        shootout_losses: wentSo && !homeWon ? 1 : 0,
        normal_time_wins: !drawFT && homeWon && !wentEt && !wentSo ? 1 : 0,
        extra_time_wins: homeWon && wentEt && !wentSo ? 1 : 0,
        finals_reached: fresh.get("round_key") === "final" ? 1 : 0,
      });
      updateTeamRecord(txApp, awayId, {
        played: 1,
        wins: !drawFT && awayWon ? 1 : 0,
        draws: drawFT ? 1 : 0,
        losses: !drawFT && !awayWon ? 1 : 0,
        goals_for: as_,
        goals_against: hs,
        shootout_wins: wentSo && awayWon ? 1 : 0,
        shootout_losses: wentSo && !awayWon ? 1 : 0,
        normal_time_wins: !drawFT && awayWon && !wentEt && !wentSo ? 1 : 0,
        extra_time_wins: awayWon && wentEt && !wentSo ? 1 : 0,
        finals_reached: fresh.get("round_key") === "final" ? 1 : 0,
      });

      var loserId = winnerId === homeId ? awayId : homeId;
      try {
        var loser = txApp.findRecordById("proball_teams", loserId);
        loser.set("eliminated", true);
        txApp.save(loser);
      } catch (_) {}

      ms.set("progression_settled", true);
      txApp.save(ms);
      f.set("status", "finished");
      f.set("winner_team", winnerId);
      txApp.save(f);
    }

    fresh.set("status", "completed");
    fresh.set("progression_done", true);
    fresh.set("completed_at", toPbDate(new Date()));
    txApp.save(fresh);
  });

  // Settle bets, rewards, player wear outside tight path
  var tournament = $app.findRecordById(
    "shared_tournaments",
    round.get("tournament"),
  );
  var roundKey = round.get("round_key");
  for (var b = 0; b < fixtures.length; b++) {
    var fx2 = fixtures[b];
    var w = winnersBySlot[fx2.get("slot")];
    if (w) settleBetsForFixture($app, fx2, w);
    try {
      var msR = $app.findRecordsByFilter(
        "match_states",
        "fixture = {:f}",
        "",
        1,
        0,
        { f: fx2.id },
      );
      if (msR && msR.length) {
        mgmtMod.rewardFixture($app, fx2, msR[0], tournament.id, roundKey);
        // Persist wear from state players
        var st = parseJson(msR[0].get("state_json"), {});
        if (st.homePlayers) {
          mgmtMod.applyPostMatchPlayerWear($app, fx2.get("home_team"), st.homePlayers);
        }
        if (st.awayPlayers) {
          mgmtMod.applyPostMatchPlayerWear($app, fx2.get("away_team"), st.awayPlayers);
        }
        var loserId =
          w === fx2.get("home_team") ? fx2.get("away_team") : fx2.get("home_team");
        if (loserId) {
          mgmtMod.rewardElimination($app, loserId, roundKey, tournament.id);
        }
        try {
          var sumRes = recMod.ensureMatchSummary(
            $app,
            fx2,
            msR[0],
            roundKey,
            tournament.id,
          );
          if (sumRes && sumRes.created) {
            recMod.settlePlayerRecordsFromMatch($app, fx2, msR[0]);
          }
        } catch (err2) {
          console.log("[footfive] match summary: " + err2);
        }
      }
    } catch (err) {
      console.log("[footfive] reward/wear: " + err);
    }
  }

  var pace = world.get("pace") || "dev";
  var timing = getTiming(pace);
  var nextKey = nextRoundKey(round.get("round_key"));
  var nextAt = new Date(Date.now() + timing.roundIntervalMs);

  if (nextKey) {
    createRound($app, tournament, nextKey, null, winnersBySlot, nextAt, pace);
    tournament.set("current_round", nextKey);
    $app.save(tournament);
    world.set("next_action_at", toPbDate(nextAt));
    $app.save(world);
    // AI prep for next round
    try {
      var allTeams = $app.findRecordsByFilter("proball_teams", "id != ''", "", 20, 0);
      for (var ai = 0; ai < allTeams.length; ai++) {
        mgmtMod.aiMaintainTeam($app, allTeams[ai], world);
      }
    } catch (_) {}
  } else {
    var finalFx = fixtures[0];
    var champ = finalFx ? finalFx.get("winner_team") : null;
    tournament.set("status", "complete");
    tournament.set("current_round", "complete");
    if (champ) {
      tournament.set("champion_team", champ);
      try {
        updateTeamRecord($app, champ, { championships: 1 });
        mgmtMod.rewardChampion($app, champ, tournament.id);
        recMod.awardChampionshipPlayers($app, champ);
      } catch (_) {}
    }
    $app.save(tournament);
    try {
      recMod.ensureTournamentSummary($app, tournament, fixtures);
    } catch (err3) {
      console.log("[footfive] tournament summary: " + err3);
    }
    var tourneyAt = new Date(Date.now() + timing.tournamentIntervalMs);
    world.set("next_action_at", toPbDate(tourneyAt));
    $app.save(world);
  }

  return { completed: true, next: nextKey };
}

function updateTeamRecord(appOrTx, teamId, patch) {
  var rows = appOrTx.findRecordsByFilter(
    "global_team_records",
    "team = {:t}",
    "",
    1,
    0,
    { t: teamId },
  );
  if (!rows || !rows.length) return;
  var rec = rows[0];
  for (var k in patch) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      rec.set(k, (rec.get(k) || 0) + patch[k]);
    }
  }
  appOrTx.save(rec);
}

/**
 * Full world catch-up: kickoff due rounds, advance segments, complete rounds, restart tournaments.
 */
function catchUpWorld($app) {
  var world = ensureWorld($app);
  var actions = [];
  if (world.get("progression_paused")) {
    return { ok: true, paused: true, actions: [] };
  }

  // New tournament if none active and next_action due
  var active = getActiveTournament($app);
  if (!active) {
    var nextAt = parsePbDate(world.get("next_action_at"));
    if (isNaN(nextAt) || Date.now() >= nextAt) {
      createTournament($app, world);
      actions.push({ tournamentCreated: true });
      active = getActiveTournament($app);
    }
  }

  if (active) {
    var rounds = $app.findRecordsByFilter(
      "shared_rounds",
      "tournament = {:t}",
      "-created",
      10,
      0,
      { t: active.id },
    );
    for (var i = 0; i < (rounds || []).length; i++) {
      var r = rounds[i];
      var st = r.get("status");
      if (st === "scheduled" || st === "management") {
        var ko = kickOffRound($app, r, world);
        actions.push({ kickoff: ko, round: r.get("round_key") });
        r = $app.findRecordById("shared_rounds", r.id);
        st = r.get("status");
      }
      if (st === "live") {
        var n = advanceDueMatches($app, world, 40);
        actions.push({ advanced: n });
        var done = completeRoundIfReady($app, r, world);
        actions.push({ complete: done });
      }
    }
  }

  // Always advance any live matches
  var n2 = advanceDueMatches($app, world, 40);
  if (n2) actions.push({ advancedExtra: n2 });

  return { ok: true, actions: actions };
}

function getActiveRound($app) {
  var t = getActiveTournament($app);
  if (!t) return null;
  var rounds = $app.findRecordsByFilter(
    "shared_rounds",
    'tournament = {:t} && status != "completed"',
    "-created",
    5,
    0,
    { t: t.id },
  );
  if (rounds && rounds.length) {
    for (var i = 0; i < rounds.length; i++) {
      var s = rounds[i].get("status");
      if (s === "live" || s === "scheduled" || s === "management") return rounds[i];
    }
    return rounds[0];
  }
  var done = $app.findRecordsByFilter(
    "shared_rounds",
    "tournament = {:t}",
    "-created",
    1,
    0,
    { t: t.id },
  );
  return done && done.length ? done[0] : null;
}

function buildScoreboard($app) {
  catchUpWorld($app);
  var round = getActiveRound($app);
  var serverNow = Date.now();
  if (!round) {
    return {
      serverTime: new Date(serverNow).toISOString(),
      serverTimeMs: serverNow,
      round: null,
      fixtures: [],
    };
  }

  var fixtures = $app.findRecordsByFilter(
    "shared_fixtures",
    "round = {:r}",
    "bracket_index",
    20,
    0,
    { r: round.id },
  );
  var items = [];
  for (var j = 0; j < fixtures.length; j++) {
    var fx = fixtures[j];
    var home = $app.findRecordById("proball_teams", fx.get("home_team"));
    var away = $app.findRecordById("proball_teams", fx.get("away_team"));
    var entry = {
      fixtureId: fx.id,
      slot: fx.get("slot"),
      bracketIndex: fx.get("bracket_index"),
      home: teamPublic(home),
      away: teamPublic(away),
      scheduledAt: fx.get("scheduled_at"),
      status: "scheduled",
      scoreHome: 0,
      scoreAway: 0,
      shootoutHome: 0,
      shootoutAway: 0,
      minute: 0,
      phase: "scheduled",
      finished: false,
    };

    var msRows = $app.findRecordsByFilter(
      "match_states",
      "fixture = {:f}",
      "",
      1,
      0,
      { f: fx.id },
    );
    if (msRows && msRows.length) {
      var match = msRows[0];
      // Advance this match if due before reading
      try {
        var world = ensureWorld($app);
        var nd = parsePbDate(match.get("next_segment_due_at"));
        if (!match.get("finalised") && (isNaN(nd) || nd <= serverNow)) {
          advanceOneMatch($app, match, world, segmentRealMs(world));
          match = $app.findRecordById("match_states", match.id);
        }
      } catch (_) {}

      var started = parsePbDate(match.get("started_at"));
      var elapsed = isNaN(started) ? 0 : serverNow - started;
      var events = loadEventsFromDb($app, match.id);
      if (!events.length) events = filterEvents(parseJson(match.get("events_json"), []));
      var vis = reconstructVisible(events, elapsed);
      entry.scoreHome = vis.scoreHome;
      entry.scoreAway = vis.scoreAway;
      entry.shootoutHome = vis.shootoutHome;
      entry.shootoutAway = vis.shootoutAway;
      entry.minute = vis.minute;
      entry.phase = vis.phase;
      entry.status = vis.status;
      entry.finished = vis.finished || !!match.get("finalised");
      if (entry.finished) entry.winnerTeamId = match.get("winner_team");
      entry.homeCoaching = match.get("home_coaching");
      entry.awayCoaching = match.get("away_coaching");
    }
    items.push(entry);
  }

  return {
    serverTime: new Date(serverNow).toISOString(),
    serverTimeMs: serverNow,
    round: {
      id: round.id,
      key: round.get("round_key"),
      label: round.get("label"),
      status: round.get("status"),
      scheduledAt: round.get("scheduled_at"),
      startedAt: round.get("started_at"),
    },
    fixtures: items,
  };
}

function buildMatchView($app, fixtureId, sinceSeq, userId) {
  catchUpWorld($app);
  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  var home = $app.findRecordById("proball_teams", fx.get("home_team"));
  var away = $app.findRecordById("proball_teams", fx.get("away_team"));
  var serverNow = Date.now();

  var msRows = $app.findRecordsByFilter(
    "match_states",
    "fixture = {:f}",
    "",
    1,
    0,
    { f: fixtureId },
  );

  var managedSide = null;
  if (userId) {
    if (home.get("manager") === userId) managedSide = "home";
    if (away.get("manager") === userId) managedSide = "away";
  }

  if (!msRows || !msRows.length) {
    return {
      serverTime: new Date(serverNow).toISOString(),
      serverTimeMs: serverNow,
      fixtureId: fixtureId,
      home: teamPublic(home),
      away: teamPublic(away),
      status: "scheduled",
      scoreHome: 0,
      scoreAway: 0,
      shootoutHome: 0,
      shootoutAway: 0,
      minute: 0,
      phase: "scheduled",
      events: [],
      newEvents: [],
      lastSeq: 0,
      finished: false,
      stats: null,
      managedSide: managedSide,
      homeCoaching: "balanced",
      awayCoaching: "balanced",
      canCoach: false,
    };
  }

  var match = msRows[0];
  try {
    var world = ensureWorld($app);
    var nd = parsePbDate(match.get("next_segment_due_at"));
    if (!match.get("finalised") && (isNaN(nd) || nd <= serverNow)) {
      advanceOneMatch($app, match, world, segmentRealMs(world));
      match = $app.findRecordById("match_states", match.id);
    }
  } catch (_) {}

  var started = parsePbDate(match.get("started_at"));
  var elapsed = isNaN(started) ? 0 : serverNow - started;
  var events = loadEventsFromDb($app, match.id);
  if (!events.length) events = filterEvents(parseJson(match.get("events_json"), []));
  var vis = reconstructVisible(events, elapsed, { sinceSeq: sinceSeq || 0 });
  var newEvents = sinceSeq
    ? events.filter(function (e) {
        return (e.offsetMs || 0) <= elapsed && (e.seq || 0) > sinceSeq;
      })
    : vis.events;

  var finished = vis.finished || !!match.get("finalised");
  var stateRaw = parseJson(match.get("state_json"), {});
  var kicks = stateRaw.shootoutKicks || [];
  // Only expose kicks that have been "played" (all stored kicks are past)
  // Future kicks are never stored until simulated.

  return {
    serverTime: new Date(serverNow).toISOString(),
    serverTimeMs: serverNow,
    fixtureId: fixtureId,
    home: teamPublic(home),
    away: teamPublic(away),
    status: vis.status,
    scoreHome: vis.scoreHome,
    scoreAway: vis.scoreAway,
    shootoutHome: vis.shootoutHome,
    shootoutAway: vis.shootoutAway,
    shootoutTakenHome: stateRaw.shootoutTakenHome || 0,
    shootoutTakenAway: stateRaw.shootoutTakenAway || 0,
    shootoutSide: stateRaw.shootoutSide || null,
    shootoutKicks: finished || vis.phase === "shootout" || vis.status === "shootout" ? kicks : [],
    minute: vis.minute,
    phase: vis.phase,
    events: vis.events,
    newEvents: newEvents,
    lastSeq: vis.lastSeq,
    finished: finished,
    caughtUp: true,
    stats: finished ? parseJson(match.get("stats_json"), null) : null,
    winnerTeamId: finished ? match.get("winner_team") : null,
    managedSide: managedSide,
    homeCoaching: match.get("home_coaching") || "balanced",
    awayCoaching: match.get("away_coaching") || "balanced",
    canCoach:
      !!managedSide &&
      !finished &&
      (vis.status === "live" ||
        vis.status === "extra_time" ||
        vis.status === "half_time" ||
        vis.status === "shootout"),
  };
}

function setCoaching($app, userId, fixtureId, stance) {
  if (["defend", "balanced", "attack"].indexOf(stance) < 0) {
    throw new BadRequestError("Invalid stance");
  }
  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  var home = $app.findRecordById("proball_teams", fx.get("home_team"));
  var away = $app.findRecordById("proball_teams", fx.get("away_team"));
  var side = null;
  if (home.get("manager") === userId) side = "home";
  if (away.get("manager") === userId) side = "away";
  if (!side) throw new ForbiddenError("You do not manage a team in this fixture");

  var msRows = $app.findRecordsByFilter(
    "match_states",
    "fixture = {:f}",
    "",
    1,
    0,
    { f: fixtureId },
  );
  if (!msRows.length) throw new BadRequestError("Match not started");
  var ms = msRows[0];
  if (ms.get("finalised")) throw new BadRequestError("Match finished");

  // Cooldown: last command for this team/fixture
  var world = ensureWorld($app);
  var timing = getTiming(world.get("pace") || "dev");
  var recent = $app.findRecordsByFilter(
    "coaching_commands",
    "fixture = {:f} && team = {:t}",
    "-created",
    1,
    0,
    {
      f: fixtureId,
      t: side === "home" ? home.id : away.id,
    },
  );
  if (recent && recent.length) {
    var last = parsePbDate(recent[0].get("created"));
    if (!isNaN(last) && Date.now() - last < timing.coachingCooldownMs) {
      throw new BadRequestError("Coaching cooldown active");
    }
  }

  var teamId = side === "home" ? home.id : away.id;
  var teamName = side === "home" ? home.get("name") : away.get("name");
  var label =
    stance === "defend"
      ? "Defend"
      : stance === "attack"
        ? "Attack"
        : "Balanced";
  var message =
    stance === "defend"
      ? teamName + " drop into a defensive shape."
      : stance === "attack"
        ? teamName + " switch to Attack."
        : teamName + " return to a balanced setup.";

  if (side === "home") ms.set("home_coaching", stance);
  else ms.set("away_coaching", stance);
  $app.save(ms);

  var col = $app.findCollectionByNameOrId("coaching_commands");
  var cmd = new Record(col);
  cmd.set("fixture", fixtureId);
  cmd.set("team", teamId);
  cmd.set("user", userId);
  cmd.set("stance", stance);
  cmd.set("effective_from_minute", (ms.get("sim_minute") || 0) + 1);
  cmd.set("segment_index", (ms.get("segment_index") || 0) + 1);
  $app.save(cmd);

  // Append coaching event for next segment announcement stored now for visibility
  var events = loadEventsFromDb($app, ms.id);
  if (!events.length) events = filterEvents(parseJson(ms.get("events_json"), []));
  var state = hydrateState(ms, events);
  // Don't advance — just record message as event with current clock for live feed
  state.seq = events.length ? events[events.length - 1].seq : 0;
  state.events = events;
  state.clockMs = events.length ? events[events.length - 1].offsetMs : 0;
  state.seq += 1;
  var ev = {
    seq: state.seq,
    minute: state.simMinute,
    phase: state.phase,
    offsetMs: state.clockMs,
    type: "coaching_change",
    team: side,
    player: null,
    message: message,
    scoreHome: state.scoreHome,
    scoreAway: state.scoreAway,
    shootoutHome: state.shootoutHome,
    shootoutAway: state.shootoutAway,
  };
  events.push(ev);
  ms.set("events_json", events);
  $app.save(ms);

  return { ok: true, stance: stance, side: side, message: message };
}

function saveLineup($app, userId, teamId, starterIds, subIds) {
  var team = $app.findRecordById("proball_teams", teamId);
  if (team.get("manager") !== userId) throw new ForbiddenError("Not your team");
  return mgmtMod.setLineup($app, userId, starterIds, subIds);
}

function calcOdds(homeStrength, awayStrength, side) {
  var diff = homeStrength - awayStrength;
  if (side === "away") diff = -diff;
  // positive diff → shorter odds for that side
  var raw = 2.2 - diff * 0.02;
  return Math.round(clamp(raw, BALANCE.minOdds, BALANCE.maxOdds) * 100) / 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function placeBet($app, userId, fixtureId, selectionTeamId, stake) {
  stake = parseInt(stake, 10);
  if (!stake || stake < 1) throw new BadRequestError("Invalid stake");

  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  if (fx.get("status") === "live" || fx.get("status") === "finished") {
    throw new BadRequestError("Bets locked for this fixture");
  }
  var sched = parsePbDate(fx.get("scheduled_at"));
  if (!isNaN(sched) && Date.now() >= sched) {
    throw new BadRequestError("Bets locked — kickoff passed");
  }

  var managed = getManagerTeam($app, userId);
  if (
    managed &&
    (managed.id === fx.get("home_team") || managed.id === fx.get("away_team"))
  ) {
    throw new BadRequestError("Cannot bet on your own fixture");
  }

  if (
    selectionTeamId !== fx.get("home_team") &&
    selectionTeamId !== fx.get("away_team")
  ) {
    throw new BadRequestError("Selection must be a team in the fixture");
  }

  var existing = $app.findRecordsByFilter(
    "shared_bets",
    "user = {:u} && fixture = {:f}",
    "",
    5,
    0,
    { u: userId, f: fixtureId },
  );
  if (existing && existing.length) {
    throw new BadRequestError("You already have a bet on this fixture");
  }

  var home = $app.findRecordById("proball_teams", fx.get("home_team"));
  var away = $app.findRecordById("proball_teams", fx.get("away_team"));
  var side = selectionTeamId === home.id ? "home" : "away";
  var odds = calcOdds(home.get("strength"), away.get("strength"), side);

  var bet = null;
  $app.runInTransaction(function (txApp) {
    var user = txApp.findRecordById("users", userId);
    var credits = user.get("credits") || 0;
    if (credits < stake) throw new BadRequestError("Insufficient credits");
    user.set("credits", credits - stake);
    txApp.save(user);

    var col = txApp.findCollectionByNameOrId("shared_bets");
    bet = new Record(col);
    bet.set("user", userId);
    bet.set("fixture", fixtureId);
    bet.set("selection_team", selectionTeamId);
    bet.set("stake", stake);
    bet.set("odds", odds);
    bet.set("status", "open");
    bet.set("settled", false);
    txApp.save(bet);

    writeTx(
      txApp,
      userId,
      "bet_stake",
      -stake,
      "Bet stake on fixture " + fixtureId,
      bet.id + ":stake",
    );
  });

  return {
    id: bet.id,
    stake: stake,
    odds: odds,
    selectionTeamId: selectionTeamId,
    status: "open",
  };
}

function listBettingFixtures($app, userId) {
  var board = buildScoreboard($app);
  var managed = getManagerTeam($app, userId);
  var out = [];
  for (var i = 0; i < (board.fixtures || []).length; i++) {
    var f = board.fixtures[i];
    if (f.status !== "scheduled") continue;
    var own =
      managed &&
      (managed.id === f.home.id || managed.id === f.away.id);
    if (own) continue;
    out.push({
      fixtureId: f.fixtureId,
      home: f.home,
      away: f.away,
      scheduledAt: f.scheduledAt,
      homeOdds: calcOdds(f.home.strength || 60, f.away.strength || 60, "home"),
      awayOdds: calcOdds(f.home.strength || 60, f.away.strength || 60, "away"),
    });
  }
  return out;
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

function listTeams($app) {
  ensureTeams($app);
  var teams = $app.findRecordsByFilter("proball_teams", "id != ''", "sort_order", 50, 0);
  var out = [];
  for (var i = 0; i < teams.length; i++) {
    var t = teams[i];
    var managerName = null;
    if (t.get("manager")) {
      try {
        var u = $app.findRecordById("users", t.get("manager"));
        managerName = u.get("display_name") || "Manager";
      } catch (_) {
        managerName = "Manager";
      }
    }
    out.push(teamPublic(t, managerName));
  }
  return out;
}

function worldSnapshot($app, userId) {
  catchUpWorld($app);
  var world = ensureWorld($app);
  var t = getActiveTournament($app);
  var round = getActiveRound($app);
  var managed = userId ? getManagerTeam($app, userId) : null;
  var credits = userId ? ensureUserCredits($app, userId) : 0;
  var managementOpen = mgmtMod.isManagementOpen($app);
  var treasury = null;
  var batteries = null;
  var avgEnergy = null;
  var avgCondition = null;
  var commandCharge = null;
  if (managed) {
    treasury =
      managed.get("treasury") != null ? managed.get("treasury") : BALANCE.startingTreasury;
    batteries = managed.get("battery_count") || 0;
    try {
      var sq = mgmtMod.getSquad($app, userId);
      avgEnergy = sq.averages.energy;
      avgCondition = sq.averages.condition;
    } catch (_) {}
  }
  if (userId && managed) {
    try {
      commandCharge = mgmtMod.getCommandChargeState($app, userId);
    } catch (_) {}
  }

  return {
    serverTime: new Date().toISOString(),
    serverTimeMs: Date.now(),
    world: {
      pace: world.get("pace"),
      nextActionAt: world.get("next_action_at"),
      roundIntervalMs: world.get("round_interval_ms"),
      aiProgressionEnabled: !!world.get("ai_progression_enabled"),
    },
    tournament: t
      ? {
          id: t.id,
          number: t.get("number"),
          status: t.get("status"),
          current_round: t.get("current_round"),
          champion_team: t.get("champion_team"),
        }
      : null,
    activeRound: round
      ? {
          id: round.id,
          key: round.get("round_key"),
          label: round.get("label"),
          status: round.get("status"),
          scheduledAt: round.get("scheduled_at"),
          startedAt: round.get("started_at"),
        }
      : null,
    managedTeam: managed
      ? Object.assign(teamPublic(managed), {
          treasury: treasury,
          battery_count: batteries,
        })
      : null,
    isSpectator: !managed,
    managementOpen: managementOpen,
    credits: credits,
    bettingCredits: credits,
    teamTreasury: treasury,
    startingCredits: BALANCE.startingCredits,
    squadAverages: managed
      ? { energy: avgEnergy, condition: avgCondition }
      : null,
    commandCharge: commandCharge,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    ensureWorld: ensureWorld,
    isSchemaReady: isSchemaReady,
    ensureTeams: ensureTeams,
    catchUpWorld: catchUpWorld,
    claimTeam: claimTeam,
    releaseTeam: releaseTeam,
    getManagerTeam: getManagerTeam,
    listTeams: listTeams,
    worldSnapshot: worldSnapshot,
    buildScoreboard: buildScoreboard,
    buildMatchView: buildMatchView,
    setCoaching: setCoaching,
    saveLineup: saveLineup,
    placeBet: placeBet,
    listBettingFixtures: listBettingFixtures,
    ensureUserCredits: ensureUserCredits,
    getActiveTournament: getActiveTournament,
    getActiveRound: getActiveRound,
    teamPublic: teamPublic,
    calcOdds: calcOdds,
    BALANCE: BALANCE,
    mgmt: mgmtMod,
  };
}
