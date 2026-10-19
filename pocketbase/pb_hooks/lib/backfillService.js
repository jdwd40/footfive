/**
 * Idempotent historical summary + player-record backfill.
 * Never fabricates player attribution when events lack player names.
 */
var recMod;
try {
  recMod = require(__hooks + "/lib/recordsService.js");
} catch (e) {
  recMod = require("./recordsService.js");
}

function listFinishedWithoutSummary($app, limit) {
  limit = limit || 40;
  var states = $app.findRecordsByFilter(
    "match_states",
    "finalised = true",
    "-updated",
    200,
    0,
  );
  var eligible = [];
  var cannot = [];
  for (var i = 0; i < (states || []).length && eligible.length < limit; i++) {
    var ms = states[i];
    var fxId = ms.get("fixture");
    if (!fxId) {
      cannot.push({ matchStateId: ms.id, reason: "no_fixture" });
      continue;
    }
    var existing = $app.findRecordsByFilter(
      "match_summaries",
      "fixture_id = {:f}",
      "",
      1,
      0,
      { f: fxId },
    );
    if (existing && existing.length) {
      cannot.push({ fixtureId: fxId, reason: "summary_exists" });
      continue;
    }
    try {
      var fx = $app.findRecordById("shared_fixtures", fxId);
      if (fx.get("status") === "live" || fx.get("status") === "scheduled") {
        cannot.push({ fixtureId: fxId, reason: "fixture_active" });
        continue;
      }
      eligible.push({
        fixtureId: fxId,
        matchStateId: ms.id,
        score: (ms.get("score_home") || 0) + "-" + (ms.get("score_away") || 0),
        tournamentId: fx.get("tournament") || "",
      });
    } catch (err) {
      cannot.push({ fixtureId: fxId, reason: "fixture_missing" });
    }
  }
  return { eligible: eligible, cannot: cannot.slice(0, 50) };
}

function ensureTournamentSummaries($app, preview) {
  var created = 0;
  var tours = $app.findRecordsByFilter(
    "shared_tournaments",
    'status = "complete"',
    "-number",
    50,
    0,
  );
  for (var i = 0; i < (tours || []).length; i++) {
    var t = tours[i];
    var ex = $app.findRecordsByFilter(
      "tournament_summaries",
      "tournament_id = {:t}",
      "",
      1,
      0,
      { t: t.id },
    );
    if (ex && ex.length) continue;
    if (!preview) {
      try {
        recMod.ensureTournamentSummary($app, t, []);
        created++;
      } catch (_) {}
    } else {
      created++;
    }
  }
  return created;
}

/**
 * Run backfill. preview=true does not write.
 */
function runBackfill($app, opts) {
  opts = opts || {};
  var preview = !!opts.preview;
  var adminId = opts.adminId || null;
  var batch = opts.batch || 25;
  var result = {
    preview: preview,
    examined: 0,
    created_summaries: 0,
    player_updates: 0,
    tournament_summaries: 0,
    skipped: 0,
    eligible: [],
    cannot: [],
    error: "",
  };

  var listed = listFinishedWithoutSummary($app, batch);
  result.eligible = listed.eligible;
  result.cannot = listed.cannot;
  result.examined = listed.eligible.length + listed.cannot.length;

  for (var i = 0; i < listed.eligible.length; i++) {
    var item = listed.eligible[i];
    if (preview) {
      result.created_summaries++;
      continue;
    }
    try {
      var fx = $app.findRecordById("shared_fixtures", item.fixtureId);
      var ms = $app.findRecordById("match_states", item.matchStateId);
      var roundKey = "";
      try {
        var rd = $app.findRecordById("shared_rounds", fx.get("round"));
        roundKey = rd.get("round_key") || "";
      } catch (_) {}
      var sumRes = recMod.ensureMatchSummary(
        $app,
        fx,
        ms,
        roundKey,
        fx.get("tournament") || "",
      );
      if (sumRes && sumRes.created) {
        result.created_summaries++;
        try {
          recMod.settlePlayerRecordsFromMatch($app, fx, ms);
          result.player_updates++;
        } catch (errP) {
          result.error += "player:" + String(errP) + "; ";
        }
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.error += String(err) + "; ";
      result.skipped++;
    }
  }

  try {
    result.tournament_summaries = ensureTournamentSummaries($app, preview);
  } catch (errT) {
    result.error += "tourney:" + String(errT) + "; ";
  }

  try {
    var col = $app.findCollectionByNameOrId("backfill_runs");
    var rec = new Record(col);
    rec.set("preview", preview);
    rec.set("examined", result.examined);
    rec.set("created_summaries", result.created_summaries);
    rec.set("player_updates", result.player_updates);
    rec.set("skipped", result.skipped);
    rec.set("details", {
      eligible: result.eligible,
      cannot: result.cannot,
      tournament_summaries: result.tournament_summaries,
    });
    rec.set("error", result.error || "");
    if (adminId) rec.set("admin", adminId);
    $app.save(rec);
  } catch (_) {}

  return result;
}

function backfillStatus($app) {
  var finished = 0;
  var summaries = 0;
  var missing = 0;
  try {
    finished = $app.findRecordsByFilter(
      "match_states",
      "finalised = true",
      "",
      500,
      0,
    ).length;
  } catch (_) {}
  try {
    summaries = $app.findRecordsByFilter(
      "match_summaries",
      "id != ''",
      "",
      500,
      0,
    ).length;
  } catch (_) {}
  missing = Math.max(0, finished - summaries);
  var last = null;
  try {
    var runs = $app.findRecordsByFilter(
      "backfill_runs",
      "id != ''",
      "-created",
      1,
      0,
    );
    if (runs && runs.length) {
      last = {
        preview: !!runs[0].get("preview"),
        created_summaries: runs[0].get("created_summaries"),
        player_updates: runs[0].get("player_updates"),
        created: runs[0].get("created"),
      };
    }
  } catch (_) {}
  return {
    finalised_match_states: finished,
    match_summaries: summaries,
    estimated_missing_summaries: missing,
    last_run: last,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    runBackfill: runBackfill,
    backfillStatus: backfillStatus,
    listFinishedWithoutSummary: listFinishedWithoutSummary,
  };
}
