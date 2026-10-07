/**
 * Stall detection and safe recovery for shared world progression.
 */
function loadWorldMod() {
  try {
    return require(__hooks + "/lib/worldService.js");
  } catch (e) {
    return require("./worldService.js");
  }
}

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

function getThreshold($app) {
  try {
    var w = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    var t = w.get("stall_threshold_ms");
    if (t && t > 0) return parseInt(t, 10);
  } catch (_) {}
  return 120000; // 2 minutes default
}

/**
 * Detect stalled matches / rounds / world locks without mutating.
 */
function detectStalls($app) {
  var now = Date.now();
  var thr = getThreshold($app);
  var stalledMatches = [];
  var stalledRounds = [];
  var worldIssues = [];

  try {
    var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    var ps = world.get("processing_status");
    // The progression lease (worldService.tick) stores its expiry in
    // processing_version: a "processing" row past expiry is a crashed holder.
    if (ps === "processing") {
      var expiry = parseInt(world.get("processing_version"), 10) || 0;
      if (expiry > 0 && now > expiry) {
        worldIssues.push({
          type: "stale_world_lock",
          status: ps,
          overdueMs: now - expiry,
        });
      }
    } else if (ps === "error") {
      // The last tick failed; the next tick already reclaims automatically, so
      // this is informational for the admin dashboard.
      worldIssues.push({ type: "world_lock_error", status: ps });
    }
  } catch (_) {}

  try {
    var live = $app.findRecordsByFilter(
      "match_states",
      "finalised = false",
      "next_segment_due_at", // most overdue first: the sweep sees the real stalls even past the row cap (review B23)
      50,
      0,
    );
    for (var i = 0; i < (live || []).length; i++) {
      var ms = live[i];
      var due = parsePbDate(ms.get("next_segment_due_at"));
      var last = parsePbDate(ms.get("last_processed_at"));
      var age = !isNaN(due) ? now - due : !isNaN(last) ? now - last : 0;
      if (age > thr) {
        stalledMatches.push({
          fixtureId: ms.get("fixture"),
          matchStateId: ms.id,
          phase: ms.get("phase"),
          simMinute: ms.get("sim_minute"),
          overdueMs: age,
          finalised: !!ms.get("finalised"),
        });
      }
    }
  } catch (_) {}

  try {
    var rounds = $app.findRecordsByFilter(
      "shared_rounds",
      'status = "live" || status = "scheduled"',
      "",
      20,
      0,
    );
    for (var r = 0; r < (rounds || []).length; r++) {
      var rd = rounds[r];
      if (rd.get("progression_done")) continue;
      var fixtures = $app.findRecordsByFilter(
        "shared_fixtures",
        "round = {:r}",
        "",
        20,
        0,
        { r: rd.id },
      );
      var allFinished = fixtures && fixtures.length > 0;
      var anyLive = false;
      for (var f = 0; f < (fixtures || []).length; f++) {
        var st = fixtures[f].get("status");
        if (st === "live") anyLive = true;
        if (st !== "finished" && st !== "complete") allFinished = false;
      }
      // All match states finalised but round not progressed
      var allMsDone = fixtures && fixtures.length > 0;
      for (var j = 0; j < (fixtures || []).length; j++) {
        var msr = $app.findRecordsByFilter(
          "match_states",
          "fixture = {:fx}",
          "",
          1,
          0,
          { fx: fixtures[j].id },
        );
        if (!msr.length || !msr[0].get("finalised")) allMsDone = false;
      }
      if (allMsDone && !rd.get("progression_done")) {
        stalledRounds.push({
          roundId: rd.id,
          key: rd.get("round_key"),
          status: rd.get("status"),
          reason: "fixtures_done_not_progressed",
        });
      } else if (anyLive) {
        // live round with overdue matches already listed
      }
    }
  } catch (_) {}

  // Completed tournament without next scheduled
  try {
    var active = $app.findRecordsByFilter(
      "shared_tournaments",
      'status = "active"',
      "",
      1,
      0,
    );
    if (!active || !active.length) {
      var world2 = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
      var nextAt = parsePbDate(world2.get("next_action_at"));
      if (isNaN(nextAt) || nextAt < now - thr) {
        worldIssues.push({
          type: "no_active_tournament_due",
          nextActionAt: world2.get("next_action_at"),
        });
      }
    }
  } catch (_) {}

  return {
    thresholdMs: thr,
    stalledMatches: stalledMatches,
    stalledRounds: stalledRounds,
    worldIssues: worldIssues,
    hasStalls:
      stalledMatches.length > 0 ||
      stalledRounds.length > 0 ||
      worldIssues.length > 0,
  };
}

/**
 * Safe recovery: clear stale locks, run catch-up. Does not rewrite scores.
 */
function recoverAll($app, opts) {
  opts = opts || {};
  var preview = !!opts.preview;
  var report = detectStalls($app);
  report.preview = preview;
  report.actions = [];
  report.error = "";

  if (preview) return report;

  try {
    var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    var ps = world.get("processing_status");
    // Only clear a lock that cannot have a live holder: expired leases and the
    // failed-tick "error" state. Never yank an active lease mid-tick.
    var expiry = parseInt(world.get("processing_version"), 10) || 0;
    if (ps === "error" || (ps === "processing" && expiry > 0 && Date.now() > expiry)) {
      world.set("processing_status", "idle");
      $app.save(world);
      report.actions.push({ clear_world_lock: true, was: ps });
    }
  } catch (err) {
    report.error += String(err) + "; ";
  }

  // Advance overdue live matches via catch-up (idempotent segments)
  try {
    var r = loadWorldMod().catchUpWorld($app);
    report.actions.push({ catchUp: r });
  } catch (err2) {
    report.error += "catchUp:" + String(err2) + "; ";
  }

  // Bets left open on already-finished fixtures (pre-v2 tail failures)
  try {
    var bets;
    try {
      bets = require(__hooks + "/lib/bettingService.js");
    } catch (e) {
      bets = require("./bettingService.js");
    }
    var stranded = bets.settleStrandedBets($app, Date.now());
    report.actions.push({ strandedBets: stranded });
    if (stranded.failed) report.error += "strandedBets:" + stranded.errors.join(" | ") + "; ";
  } catch (err4) {
    report.error += "strandedBets:" + String(err4) + "; ";
  }

  try {
    var world3 = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    world3.set("last_recovery_at", toPbDate(new Date()));
    world3.set("last_recovery_result", {
      actions: report.actions,
      error: report.error,
      at: new Date().toISOString(),
    });
    $app.save(world3);
  } catch (_) {}

  // re-detect after
  var after = detectStalls($app);
  report.after = after;
  return report;
}

function clearWorldLock($app) {
  var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
  var before = world.get("processing_status");
  world.set("processing_status", "idle");
  $app.save(world);
  return { ok: true, before: before, after: "idle" };
}

function retryMatch($app, fixtureId) {
  // Safe: invoke catch-up which advances due segments only
  var r = loadWorldMod().catchUpWorld($app);
  return { ok: true, fixtureId: fixtureId, catchUp: r };
}

function retryRound($app, roundId) {
  var r = loadWorldMod().catchUpWorld($app);
  return { ok: true, roundId: roundId, catchUp: r };
}

if (typeof module !== "undefined") {
  module.exports = {
    detectStalls: detectStalls,
    recoverAll: recoverAll,
    clearWorldLock: clearWorldLock,
    retryMatch: retryMatch,
    retryRound: retryRound,
    getThreshold: getThreshold,
  };
}
