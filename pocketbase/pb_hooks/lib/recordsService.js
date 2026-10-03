/**
 * Shared records, match/tournament summaries, history APIs.
 */
var balMod;
try {
  balMod = require(__hooks + "/lib/balance.js");
} catch (e) {
  balMod = require("./balance.js");
}

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function parseJson(v, fb) {
  if (v == null || v === "") return fb;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch (_) {
      return fb;
    }
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (_) {
    return v || fb;
  }
}

function extractGoalsFromEvents(events) {
  var goals = [];
  for (var i = 0; i < (events || []).length; i++) {
    var e = events[i];
    if (e.type === "goal" || e.type === "penalty_scored") {
      goals.push({
        minute: e.minute,
        team: e.team,
        player: e.player,
        type: e.type,
      });
    }
  }
  return goals;
}

function extractCards(events) {
  var cards = [];
  for (var i = 0; i < (events || []).length; i++) {
    var e = events[i];
    if (e.type === "yellow_card" || e.type === "red_card") {
      cards.push({
        minute: e.minute,
        team: e.team,
        player: e.player,
        type: e.type,
      });
    }
  }
  return cards;
}

/**
 * Upsert compact match summary after fixture completion.
 * `extra` (engine v2): { events (legacy-shaped), wentExtraTime, wentShootout, shootoutKicks, stats }.
 */
function ensureMatchSummary($app, fixture, matchState, roundKey, tournamentId, extra) {
  var fxId = fixture.id;
  var existing = $app.findRecordsByFilter(
    "match_summaries",
    "fixture_id = {:f}",
    "",
    1,
    0,
    { f: fxId },
  );
  if (existing && existing.length) {
    return { record: existing[0], created: false };
  }

  var events = [];
  if (extra) events = extra.events || [];
  else {
    try {
      events = parseJson(matchState.get("events_json"), []);
      if (!Array.isArray(events)) events = [];
    } catch (_) {}
  }

  var state = extra ? {} : parseJson(matchState.get("state_json"), {});
  var home = $app.findRecordById("proball_teams", fixture.get("home_team"));
  var away = $app.findRecordById("proball_teams", fixture.get("away_team"));

  var col = $app.findCollectionByNameOrId("match_summaries");
  var rec = new Record(col);
  rec.set("fixture_id", fxId);
  rec.set("tournament_id", tournamentId || fixture.get("tournament") || "");
  rec.set("round_key", roundKey || "");
  rec.set("slot", fixture.get("slot") || "");
  rec.set("home_team", home.id);
  rec.set("away_team", away.id);
  rec.set("home_name", home.get("name"));
  rec.set("away_name", away.get("name"));
  rec.set("score_home", matchState.get("score_home") || 0);
  rec.set("score_away", matchState.get("score_away") || 0);
  rec.set("shootout_home", matchState.get("shootout_home") || 0);
  rec.set("shootout_away", matchState.get("shootout_away") || 0);
  rec.set("winner_team", matchState.get("winner_team") || "");
  rec.set("went_extra_time", extra ? !!extra.wentExtraTime : !!state.wentExtraTime);
  rec.set("went_shootout", extra ? !!extra.wentShootout : !!(state.wentShootout || matchState.get("shootout_home")));
  rec.set("stats_json", extra ? extra.stats : matchState.get("stats_json") || state.stats || {});
  rec.set("goals_json", extractGoalsFromEvents(events));
  rec.set("cards_json", extractCards(events));
  rec.set("shootout_kicks_json", extra ? extra.shootoutKicks : state.shootoutKicks || []);
  rec.set("coaching_json", {
    home: matchState.get("home_coaching"),
    away: matchState.get("away_coaching"),
  });
  rec.set("completed_at", toPbDate(new Date()));
  rec.set("events_purged", false);
  $app.save(rec);
  return { record: rec, created: true };
}

function ensureTournamentSummary($app, tournament, fixturesMeta) {
  var tid = tournament.id;
  var existing = $app.findRecordsByFilter(
    "tournament_summaries",
    "tournament_id = {:t}",
    "",
    1,
    0,
    { t: tid },
  );
  if (existing && existing.length) return existing[0];

  var summaries = $app.findRecordsByFilter(
    "match_summaries",
    "tournament_id = {:t}",
    "",
    50,
    0,
    { t: tid },
  );
  var totalGoals = 0;
  var et = 0;
  var so = 0;
  var bracket = [];
  var biggest = null;
  for (var i = 0; i < (summaries || []).length; i++) {
    var s = summaries[i];
    var gh = s.get("score_home") || 0;
    var ga = s.get("score_away") || 0;
    totalGoals += gh + ga;
    if (s.get("went_extra_time")) et++;
    if (s.get("went_shootout")) so++;
    bracket.push({
      slot: s.get("slot"),
      round: s.get("round_key"),
      home: s.get("home_name"),
      away: s.get("away_name"),
      score: gh + "-" + ga,
      pens:
        (s.get("shootout_home") || 0) + "-" + (s.get("shootout_away") || 0),
      winner: s.get("winner_team"),
    });
    var margin = Math.abs(gh - ga);
    if (!biggest || margin > biggest.margin) {
      biggest = {
        margin: margin,
        home: s.get("home_name"),
        away: s.get("away_name"),
        score: gh + "-" + ga,
      };
    }
  }

  var champId = tournament.get("champion_team");
  var champName = "";
  var runner = "";
  var runnerId = "";
  try {
    if (champId) {
      champName = $app.findRecordById("proball_teams", champId).get("name");
    }
    // final fixture for runner-up
    for (var j = 0; j < (summaries || []).length; j++) {
      if (summaries[j].get("round_key") === "final") {
        var w = summaries[j].get("winner_team");
        runnerId =
          w === summaries[j].get("home_team")
            ? summaries[j].get("away_team")
            : summaries[j].get("home_team");
        runner = $app.findRecordById("proball_teams", runnerId).get("name");
      }
    }
  } catch (_) {}

  var col = $app.findCollectionByNameOrId("tournament_summaries");
  var rec = new Record(col);
  rec.set("tournament_id", tid);
  rec.set("number", tournament.get("number") || 0);
  rec.set("champion_team", champId || "");
  rec.set("runner_up_team", runnerId || "");
  rec.set("champion_name", champName);
  rec.set("runner_up_name", runner);
  rec.set("semi_finalists_json", []);
  rec.set("bracket_json", bracket);
  rec.set("total_goals", totalGoals);
  rec.set("extra_time_matches", et);
  rec.set("shootout_matches", so);
  rec.set("highlights_json", { biggestWin: biggest });
  rec.set("completed_at", toPbDate(new Date()));
  $app.save(rec);
  return rec;
}

function recordsOverview($app) {
  var teams = $app.findRecordsByFilter("proball_teams", "id != ''", "sort_order", 20, 0);
  var records = $app.findRecordsByFilter("global_team_records", "id != ''", "", 50, 0);
  var byTeam = {};
  for (var i = 0; i < (records || []).length; i++) {
    byTeam[records[i].get("team")] = records[i];
  }

  var mostChamp = null;
  var mostWins = null;
  var mostGoals = null;
  var bestDef = null;
  var mostSO = null;
  var list = [];

  for (var t = 0; t < teams.length; t++) {
    var team = teams[t];
    var r = byTeam[team.id];
    var row = {
      id: team.id,
      name: team.get("name"),
      grade: team.get("grade"),
      badge_key: team.get("badge_key"),
      primary_color: team.get("primary_color"),
      managerId: team.get("manager") || null,
      managerName: null,
      championships: r ? r.get("championships") || 0 : 0,
      wins: r ? r.get("wins") || 0 : 0,
      draws: r ? r.get("draws") || 0 : 0,
      losses: r ? r.get("losses") || 0 : 0,
      played: r ? r.get("played") || 0 : 0,
      goals_for: r ? r.get("goals_for") || 0 : 0,
      goals_against: r ? r.get("goals_against") || 0 : 0,
      shootout_wins: r ? r.get("shootout_wins") || 0 : 0,
      shootout_losses: r ? r.get("shootout_losses") || 0 : 0,
      treasury: team.get("treasury") != null ? team.get("treasury") : 0,
    };
    row.goal_diff = row.goals_for - row.goals_against;
    row.win_pct = row.played
      ? Math.round((row.wins / row.played) * 1000) / 10
      : 0;
    if (row.managerId) {
      try {
        row.managerName =
          $app.findRecordById("users", row.managerId).get("display_name") ||
          "Manager";
      } catch (_) {
        row.managerName = "Manager";
      }
    }
    list.push(row);
    if (!mostChamp || row.championships > mostChamp.championships) mostChamp = row;
    if (!mostWins || row.wins > mostWins.wins) mostWins = row;
    if (!mostGoals || row.goals_for > mostGoals.goals_for) mostGoals = row;
    if (
      !bestDef ||
      (row.played > 0 &&
        (!bestDef.played || row.goals_against < bestDef.goals_against))
    )
      bestDef = row;
    if (!mostSO || row.shootout_wins > mostSO.shootout_wins) mostSO = row;
  }

  var tournaments = $app.findRecordsByFilter(
    "tournament_summaries",
    "id != ''",
    "-number",
    20,
    0,
  );
  var current = null;
  try {
    var act = $app.findRecordsByFilter(
      "shared_tournaments",
      'status = "active"',
      "-number",
      1,
      0,
    );
    if (act && act.length) {
      current = {
        id: act[0].id,
        number: act[0].get("number"),
        round: act[0].get("current_round"),
      };
    }
  } catch (_) {}

  var champions = [];
  for (var c = 0; c < Math.min((tournaments || []).length, 8); c++) {
    champions.push({
      number: tournaments[c].get("number"),
      champion: tournaments[c].get("champion_name"),
      runnerUp: tournaments[c].get("runner_up_name"),
      completedAt: tournaments[c].get("completed_at"),
    });
  }

  var topPlayer = null;
  var topScorer = null;
  var mostCarded = null;
  try {
    var players = listPlayerRecords($app, { leaders: true });
    for (var pi = 0; pi < players.length; pi++) {
      var pr = players[pi];
      if (!topScorer || pr.goals > topScorer.goals) topScorer = pr;
      var cards =
        (pr.yellowCards || 0) + (pr.redCards || 0) * 2;
      var bestCards =
        mostCarded
          ? (mostCarded.yellowCards || 0) + (mostCarded.redCards || 0) * 2
          : -1;
      if (!mostCarded || cards > bestCards) mostCarded = pr;
      if (!topPlayer || pr.championships > (topPlayer.championships || 0))
        topPlayer = pr;
    }
    if (!topPlayer && topScorer) topPlayer = topScorer;
  } catch (_) {}

  return {
    currentTournament: current,
    completedTournaments: (tournaments || []).length,
    highlights: {
      mostChampionships: mostChamp,
      mostWins: mostWins,
      mostGoals: mostGoals,
      bestDefence: bestDef,
      mostShootoutWins: mostSO,
      mostSuccessfulPlayer: topPlayer,
      leadingScorer: topScorer,
      mostCarded: mostCarded,
    },
    recentChampions: champions,
    teams: list,
  };
}

function listMatchArchive($app, filters) {
  filters = filters || {};
  var rows = $app.findRecordsByFilter(
    "match_summaries",
    "id != ''",
    "-completed_at",
    100,
    0,
  );
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var s = rows[i];
    if (filters.tournamentId && s.get("tournament_id") !== filters.tournamentId)
      continue;
    if (filters.roundKey && s.get("round_key") !== filters.roundKey) continue;
    if (filters.teamId) {
      if (
        s.get("home_team") !== filters.teamId &&
        s.get("away_team") !== filters.teamId
      )
        continue;
    }
    if (filters.shootoutOnly && !s.get("went_shootout")) continue;
    if (filters.etOnly && !s.get("went_extra_time")) continue;
    out.push({
      id: s.id,
      fixtureId: s.get("fixture_id"),
      tournamentId: s.get("tournament_id"),
      roundKey: s.get("round_key"),
      slot: s.get("slot"),
      homeName: s.get("home_name"),
      awayName: s.get("away_name"),
      homeTeamId: s.get("home_team"),
      awayTeamId: s.get("away_team"),
      scoreHome: s.get("score_home"),
      scoreAway: s.get("score_away"),
      shootoutHome: s.get("shootout_home"),
      shootoutAway: s.get("shootout_away"),
      winnerTeamId: s.get("winner_team"),
      wentExtraTime: !!s.get("went_extra_time"),
      wentShootout: !!s.get("went_shootout"),
      goals: parseJson(s.get("goals_json"), []),
      cards: parseJson(s.get("cards_json"), []),
      shootoutKicks: parseJson(s.get("shootout_kicks_json"), []),
      eventsPurged: !!s.get("events_purged"),
      completedAt: s.get("completed_at"),
      stats: parseJson(s.get("stats_json"), null),
    });
  }
  return out;
}

function listTournaments($app) {
  var rows = $app.findRecordsByFilter(
    "tournament_summaries",
    "id != ''",
    "-number",
    50,
    0,
  );
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var t = rows[i];
    out.push({
      id: t.id,
      tournamentId: t.get("tournament_id"),
      number: t.get("number"),
      champion: t.get("champion_name"),
      runnerUp: t.get("runner_up_name"),
      totalGoals: t.get("total_goals"),
      extraTimeMatches: t.get("extra_time_matches"),
      shootoutMatches: t.get("shootout_matches"),
      bracket: parseJson(t.get("bracket_json"), []),
      highlights: parseJson(t.get("highlights_json"), {}),
      completedAt: t.get("completed_at"),
    });
  }
  return out;
}

/**
 * Upsert permanent player stats from a completed match (idempotent via fixture flag on summary).
 */
function settlePlayerRecordsFromMatch($app, fixture, matchState, extra) {
  var state = extra ? { homePlayers: extra.players.home, awayPlayers: extra.players.away } : parseJson(matchState.get("state_json"), {});
  var events = extra ? extra.events : parseJson(matchState.get("events_json"), []);
  if (!Array.isArray(events)) events = [];
  var sides = [
    { teamId: fixture.get("home_team"), players: state.homePlayers || [] },
    { teamId: fixture.get("away_team"), players: state.awayPlayers || [] },
  ];
  for (var s = 0; s < sides.length; s++) {
    var teamId = sides[s].teamId;
    var plist = sides[s].players || [];
    for (var i = 0; i < plist.length; i++) {
      var p = plist[i];
      if (!p || !p.name) continue;
      var appeared = p.is_starter !== false; // engine usually only lists active; count all present
      if (p.energy == null && p.is_starter === false) appeared = false;
      // Prefer id match when present
      var prec = null;
      try {
        if (p.id) {
          prec = $app.findRecordById("proball_players", p.id);
        }
      } catch (_) {
        prec = null;
      }
      if (!prec) {
        try {
          var found = $app.findRecordsByFilter(
            "proball_players",
            "team = {:t} && name = {:n}",
            "",
            1,
            0,
            { t: teamId, n: p.name },
          );
          if (found && found.length) prec = found[0];
        } catch (_) {}
      }
      if (!prec) continue;

      var goals = 0;
      var yellows = 0;
      var reds = 0;
      var fouls = 0;
      var penTaken = 0;
      var penScored = 0;
      var penMissed = 0;
      var soTaken = 0;
      var soScored = 0;
      var soMissed = 0;
      for (var e = 0; e < events.length; e++) {
        var ev = events[e];
        if (ev.player !== p.name && !(ev.meta && ev.meta.player === p.name)) continue;
        if (ev.type === "goal") goals++;
        if (ev.type === "penalty_scored") {
          goals++;
          penTaken++;
          penScored++;
        }
        if (ev.type === "penalty_missed" || ev.type === "penalty_saved") {
          penTaken++;
          penMissed++;
        }
        if (ev.type === "yellow_card") yellows++;
        if (ev.type === "red_card") reds++;
        if (ev.type === "foul") fouls++;
        if (ev.type === "shootout_goal") {
          soTaken++;
          soScored++;
        }
        if (ev.type === "shootout_miss" || ev.type === "shootout_save") {
          soTaken++;
          soMissed++;
        }
      }

      var rows = $app.findRecordsByFilter(
        "global_player_records",
        "player = {:p}",
        "",
        1,
        0,
        { p: prec.id },
      );
      var rec;
      if (rows && rows.length) {
        rec = rows[0];
      } else {
        try {
          var col = $app.findCollectionByNameOrId("global_player_records");
          rec = new Record(col);
          rec.set("player", prec.id);
          rec.set("team", teamId);
          rec.set("player_name", prec.get("name"));
          rec.set("role", prec.get("role"));
          rec.set("appearances", 0);
          rec.set("goals", 0);
          rec.set("fouls", 0);
          rec.set("yellow_cards", 0);
          rec.set("red_cards", 0);
          rec.set("penalties_taken", 0);
          rec.set("penalties_scored", 0);
          rec.set("penalties_missed", 0);
          rec.set("shootout_taken", 0);
          rec.set("shootout_scored", 0);
          rec.set("shootout_missed", 0);
          rec.set("championships", 0);
        } catch (_) {
          continue;
        }
      }
      if (appeared) rec.set("appearances", (rec.get("appearances") || 0) + 1);
      rec.set("goals", (rec.get("goals") || 0) + goals);
      rec.set("fouls", (rec.get("fouls") || 0) + fouls);
      rec.set("yellow_cards", (rec.get("yellow_cards") || 0) + yellows);
      rec.set("red_cards", (rec.get("red_cards") || 0) + reds);
      rec.set("penalties_taken", (rec.get("penalties_taken") || 0) + penTaken);
      rec.set("penalties_scored", (rec.get("penalties_scored") || 0) + penScored);
      rec.set("penalties_missed", (rec.get("penalties_missed") || 0) + penMissed);
      rec.set("shootout_taken", (rec.get("shootout_taken") || 0) + soTaken);
      rec.set("shootout_scored", (rec.get("shootout_scored") || 0) + soScored);
      rec.set("shootout_missed", (rec.get("shootout_missed") || 0) + soMissed);
      rec.set("player_name", prec.get("name"));
      rec.set("team", teamId);
      rec.set("role", prec.get("role"));
      try {
        $app.save(rec);
      } catch (_) {}
    }
  }
}

function awardChampionshipPlayers($app, teamId) {
  try {
    var rows = $app.findRecordsByFilter(
      "global_player_records",
      "team = {:t}",
      "",
      20,
      0,
      { t: teamId },
    );
    for (var i = 0; i < (rows || []).length; i++) {
      rows[i].set("championships", (rows[i].get("championships") || 0) + 1);
      $app.save(rows[i]);
    }
  } catch (_) {}
}

function listPlayerRecords($app, filters) {
  filters = filters || {};
  var rows = [];
  try {
    rows = $app.findRecordsByFilter("global_player_records", "id != ''", "-goals", 200, 0);
  } catch (_) {
    return [];
  }
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    var teamName = "";
    try {
      teamName = $app.findRecordById("proball_teams", r.get("team")).get("name");
    } catch (_) {}
    if (filters.teamId && r.get("team") !== filters.teamId) continue;
    if (filters.role && r.get("role") !== filters.role) continue;
    var apps = r.get("appearances") || 0;
    var goals = r.get("goals") || 0;
    out.push({
      id: r.id,
      playerId: r.get("player"),
      name: r.get("player_name"),
      teamId: r.get("team"),
      teamName: teamName,
      role: r.get("role"),
      appearances: apps,
      goals: goals,
      goalsPerApp: apps ? Math.round((goals / apps) * 100) / 100 : 0,
      fouls: r.get("fouls") || 0,
      yellowCards: r.get("yellow_cards") || 0,
      redCards: r.get("red_cards") || 0,
      penaltiesTaken: r.get("penalties_taken") || 0,
      penaltiesScored: r.get("penalties_scored") || 0,
      penaltiesMissed: r.get("penalties_missed") || 0,
      shootoutTaken: r.get("shootout_taken") || 0,
      shootoutScored: r.get("shootout_scored") || 0,
      shootoutMissed: r.get("shootout_missed") || 0,
      championships: r.get("championships") || 0,
    });
  }
  if (filters.leaders) {
    out.sort(function (a, b) {
      return b.goals - a.goals;
    });
    out = out.slice(0, 25);
  }
  return out;
}

function userBettingHistory($app, userId) {
  var bets = $app.findRecordsByFilter(
    "shared_bets",
    "user = {:u}",
    "-created",
    100,
    0,
    { u: userId },
  );
  var ledger = [];
  try {
    ledger = $app.findRecordsByFilter(
      "credit_ledger",
      "user = {:u}",
      "-created",
      50,
      0,
      { u: userId },
    );
  } catch (_) {}
  var user = $app.findRecordById("users", userId);
  var list = [];
  var net = 0;
  for (var i = 0; i < (bets || []).length; i++) {
    var b = bets[i];
    var stake = b.get("stake") || 0;
    var odds = b.get("odds") || 1;
    var st = b.get("status");
    var ret = 0;
    if (st === "won") ret = Math.floor(stake * odds);
    if (st === "won") net += ret - stake;
    else if (st === "lost") net -= stake;
    list.push({
      id: b.id,
      fixtureId: b.get("fixture"),
      selectionTeamId: b.get("selection_team"),
      stake: stake,
      odds: odds,
      status: st,
      settled: !!b.get("settled"),
      return: ret,
      created: b.get("created"),
    });
  }
  var led = [];
  for (var j = 0; j < (ledger || []).length; j++) {
    led.push({
      type: ledger[j].get("type"),
      amount: ledger[j].get("amount"),
      description: ledger[j].get("description"),
      created: ledger[j].get("created"),
    });
  }
  return {
    balance: user.get("credits") || 0,
    netBetting: net,
    bets: list,
    ledger: led,
  };
}

function teamDetail($app, teamId) {
  var team = $app.findRecordById("proball_teams", teamId);
  var recRows = $app.findRecordsByFilter(
    "global_team_records",
    "team = {:t}",
    "",
    1,
    0,
    { t: teamId },
  );
  var r = recRows && recRows.length ? recRows[0] : null;
  var managerName = null;
  if (team.get("manager")) {
    try {
      managerName =
        $app.findRecordById("users", team.get("manager")).get("display_name") ||
        "Manager";
    } catch (_) {
      managerName = "Manager";
    }
  }
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "sort_order",
    20,
    0,
    { t: teamId },
  );
  var squad = [];
  for (var i = 0; i < (players || []).length; i++) {
    var p = players[i];
    var pr = null;
    try {
      var prs = $app.findRecordsByFilter(
        "global_player_records",
        "player = {:p}",
        "",
        1,
        0,
        { p: p.id },
      );
      if (prs && prs.length) pr = prs[0];
    } catch (_) {}
    squad.push({
      id: p.id,
      name: p.get("name"),
      role: p.get("role"),
      attack: p.get("attack"),
      defence: p.get("defence"),
      energy: p.get("energy"),
      condition: p.get("condition"),
      is_starter: !!p.get("is_starter"),
      intensity: p.get("intensity"),
      appearances: pr ? pr.get("appearances") || 0 : 0,
      goals: pr ? pr.get("goals") || 0 : 0,
    });
  }
  var recent = listMatchArchive($app, { teamId: teamId }).slice(0, 12);
  var form = [];
  for (var m = 0; m < Math.min(recent.length, 5); m++) {
    var match = recent[m];
    var isHome = match.homeTeamId === teamId;
    var won =
      match.winnerTeamId === teamId
        ? "W"
        : match.scoreHome === match.scoreAway && !match.wentShootout
          ? "D"
          : "L";
    if (match.wentShootout) won = match.winnerTeamId === teamId ? "W" : "L";
    form.push(won);
  }
  var finance = [];
  try {
    var led = $app.findRecordsByFilter(
      "team_finance_ledger",
      "team = {:t}",
      "-created",
      15,
      0,
      { t: teamId },
    );
    for (var f = 0; f < (led || []).length; f++) {
      finance.push({
        type: led[f].get("type"),
        amount: led[f].get("amount"),
        description: led[f].get("description"),
        balance_after: led[f].get("balance_after"),
        created: led[f].get("created"),
      });
    }
  } catch (_) {}
  var biggest = null;
  for (var b = 0; b < recent.length; b++) {
    var mm = recent[b];
    var isH = mm.homeTeamId === teamId;
    var gf = isH ? mm.scoreHome : mm.scoreAway;
    var ga = isH ? mm.scoreAway : mm.scoreHome;
    var margin = gf - ga;
    if (margin > 0 && (!biggest || margin > biggest.margin)) {
      biggest = {
        margin: margin,
        score: gf + "-" + ga,
        opponent: isH ? mm.awayName : mm.homeName,
        round: mm.roundKey,
      };
    }
  }
  var tourneys = [];
  try {
    var ts = $app.findRecordsByFilter(
      "tournament_summaries",
      "id != ''",
      "-number",
      20,
      0,
    );
    for (var t = 0; t < (ts || []).length; t++) {
      var champ = ts[t].get("champion_team");
      var runner = ts[t].get("runner_up_team");
      if (champ === teamId || runner === teamId) {
        tourneys.push({
          number: ts[t].get("number"),
          result: champ === teamId ? "Champion" : "Runner-up",
        });
      }
    }
  } catch (_) {}

  return {
    id: team.id,
    name: team.get("name"),
    grade: team.get("grade"),
    badge_key: team.get("badge_key"),
    primary_color: team.get("primary_color"),
    secondary_color: team.get("secondary_color"),
    managerId: team.get("manager") || null,
    managerName: managerName,
    aiControlled: !team.get("manager"),
    treasury: team.get("treasury") != null ? team.get("treasury") : 0,
    battery_count: team.get("battery_count") || 0,
    championships: r ? r.get("championships") || 0 : 0,
    finals_reached: r ? r.get("finals_reached") || 0 : 0,
    played: r ? r.get("played") || 0 : 0,
    wins: r ? r.get("wins") || 0 : 0,
    draws: r ? r.get("draws") || 0 : 0,
    losses: r ? r.get("losses") || 0 : 0,
    goals_for: r ? r.get("goals_for") || 0 : 0,
    goals_against: r ? r.get("goals_against") || 0 : 0,
    shootout_wins: r ? r.get("shootout_wins") || 0 : 0,
    shootout_losses: r ? r.get("shootout_losses") || 0 : 0,
    normal_time_wins: r ? r.get("normal_time_wins") || 0 : 0,
    extra_time_wins: r ? r.get("extra_time_wins") || 0 : 0,
    best_round: r ? r.get("best_round") || "" : "",
    squad: squad,
    recentForm: form,
    recentMatches: recent,
    finance: finance,
    biggestWin: biggest,
    tournamentResults: tourneys,
  };
}

function tournamentDetail($app, tournamentId) {
  var tSum = null;
  try {
    var rows = $app.findRecordsByFilter(
      "tournament_summaries",
      "tournament_id = {:t} || id = {:t}",
      "",
      1,
      0,
      { t: tournamentId },
    );
    if (rows && rows.length) tSum = rows[0];
  } catch (_) {}
  var tournament = null;
  try {
    tournament = $app.findRecordById(
      "shared_tournaments",
      tSum ? tSum.get("tournament_id") : tournamentId,
    );
  } catch (_) {
    try {
      tournament = $app.findRecordById("shared_tournaments", tournamentId);
    } catch (_) {}
  }
  var tid = tournament ? tournament.id : tSum ? tSum.get("tournament_id") : tournamentId;
  var matches = listMatchArchive($app, { tournamentId: tid });
  var byRound = { r16: [], qf: [], sf: [], final: [] };
  for (var i = 0; i < matches.length; i++) {
    var rk = matches[i].roundKey || "";
    if (byRound[rk]) byRound[rk].push(matches[i]);
    else if (!byRound.other) byRound.other = [];
  }
  var bracket = tSum ? parseJson(tSum.get("bracket_json"), []) : [];
  if (!bracket.length) {
    for (var k in byRound) {
      if (!Object.prototype.hasOwnProperty.call(byRound, k)) continue;
      for (var j = 0; j < byRound[k].length; j++) {
        var m = byRound[k][j];
        bracket.push({
          slot: m.slot,
          round: m.roundKey,
          home: m.homeName,
          away: m.awayName,
          score: m.scoreHome + "-" + m.scoreAway,
          pens: m.wentShootout
            ? m.shootoutHome + "-" + m.shootoutAway
            : "",
          winner: m.winnerTeamId,
        });
      }
    }
  }
  var topScorer = null;
  var goalMap = {};
  for (var g = 0; g < matches.length; g++) {
    var goals = matches[g].goals || [];
    for (var gi = 0; gi < goals.length; gi++) {
      var pl = goals[gi].player || "Unknown";
      if (pl === "Unknown") continue;
      goalMap[pl] = (goalMap[pl] || 0) + 1;
    }
  }
  for (var name in goalMap) {
    if (!Object.prototype.hasOwnProperty.call(goalMap, name)) continue;
    if (!topScorer || goalMap[name] > topScorer.goals) {
      topScorer = { name: name, goals: goalMap[name] };
    }
  }
  return {
    id: tSum ? tSum.id : tid,
    tournamentId: tid,
    number: tSum
      ? tSum.get("number")
      : tournament
        ? tournament.get("number")
        : 0,
    status: tournament ? tournament.get("status") : "complete",
    champion: tSum ? tSum.get("champion_name") : "",
    runnerUp: tSum ? tSum.get("runner_up_name") : "",
    championTeamId: tSum ? tSum.get("champion_team") : tournament ? tournament.get("champion_team") : null,
    totalGoals: tSum ? tSum.get("total_goals") : 0,
    extraTimeMatches: tSum ? tSum.get("extra_time_matches") : 0,
    shootoutMatches: tSum ? tSum.get("shootout_matches") : 0,
    highlights: tSum ? parseJson(tSum.get("highlights_json"), {}) : {},
    completedAt: tSum ? tSum.get("completed_at") : null,
    bracket: bracket,
    rounds: byRound,
    matches: matches,
    topScorer: topScorer,
  };
}

function matchDetail($app, summaryOrFixtureId) {
  var sum = null;
  try {
    sum = $app.findRecordById("match_summaries", summaryOrFixtureId);
  } catch (_) {}
  if (!sum) {
    var rows = $app.findRecordsByFilter(
      "match_summaries",
      "fixture_id = {:f}",
      "",
      1,
      0,
      { f: summaryOrFixtureId },
    );
    if (rows && rows.length) sum = rows[0];
  }
  var events = [];
  var eventsPurged = true;
  var lineups = { home: null, away: null };
  var fixtureId = sum ? sum.get("fixture_id") : summaryOrFixtureId;
  try {
    var ms = $app.findRecordsByFilter(
      "match_states",
      "fixture = {:f}",
      "",
      1,
      0,
      { f: fixtureId },
    );
    if (ms && ms.length) {
      var raw = parseJson(ms[0].get("events_json"), []);
      if (Array.isArray(raw) && raw.length) {
        events = raw;
        eventsPurged = false;
      }
      var st = parseJson(ms[0].get("state_json"), {});
      lineups = {
        home: st.homePlayers || null,
        away: st.awayPlayers || null,
      };
    }
  } catch (_) {}
  try {
    var fx = $app.findRecordById("shared_fixtures", fixtureId);
    if (!lineups.home) lineups.home = parseJson(fx.get("home_lineup_json"), null);
    if (!lineups.away) lineups.away = parseJson(fx.get("away_lineup_json"), null);
  } catch (_) {}

  if (!sum) {
    return {
      fixtureId: fixtureId,
      missing: true,
      events: events.slice(0, 80),
      eventsPurged: eventsPurged,
      lineups: lineups,
    };
  }
  return {
    id: sum.id,
    fixtureId: sum.get("fixture_id"),
    tournamentId: sum.get("tournament_id"),
    roundKey: sum.get("round_key"),
    slot: sum.get("slot"),
    homeName: sum.get("home_name"),
    awayName: sum.get("away_name"),
    homeTeamId: sum.get("home_team"),
    awayTeamId: sum.get("away_team"),
    scoreHome: sum.get("score_home"),
    scoreAway: sum.get("score_away"),
    shootoutHome: sum.get("shootout_home"),
    shootoutAway: sum.get("shootout_away"),
    winnerTeamId: sum.get("winner_team"),
    wentExtraTime: !!sum.get("went_extra_time"),
    wentShootout: !!sum.get("went_shootout"),
    goals: parseJson(sum.get("goals_json"), []),
    cards: parseJson(sum.get("cards_json"), []),
    shootoutKicks: parseJson(sum.get("shootout_kicks_json"), []),
    coaching: parseJson(sum.get("coaching_json"), {}),
    stats: parseJson(sum.get("stats_json"), null),
    completedAt: sum.get("completed_at"),
    eventsPurged: eventsPurged || !!sum.get("events_purged"),
    events: eventsPurged ? [] : events.slice(0, 100),
    lineups: lineups,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    ensureMatchSummary: ensureMatchSummary,
    ensureTournamentSummary: ensureTournamentSummary,
    recordsOverview: recordsOverview,
    listMatchArchive: listMatchArchive,
    listTournaments: listTournaments,
    userBettingHistory: userBettingHistory,
    settlePlayerRecordsFromMatch: settlePlayerRecordsFromMatch,
    awardChampionshipPlayers: awardChampionshipPlayers,
    listPlayerRecords: listPlayerRecords,
    teamDetail: teamDetail,
    tournamentDetail: tournamentDetail,
    matchDetail: matchDetail,
  };
}
