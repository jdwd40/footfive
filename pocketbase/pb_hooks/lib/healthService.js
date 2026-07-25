/**
 * Public + admin health snapshots.
 */
var recoveryMod;
try {
  recoveryMod = require(__hooks + "/lib/recoveryService.js");
} catch (e) {
  recoveryMod = require("./recoveryService.js");
}

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function publicHealth($app) {
  var ok = true;
  var worldAvailable = false;
  var tournament = null;
  try {
    var w = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0);
    worldAvailable = !!(w && w.length);
  } catch (_) {
    ok = false;
  }
  try {
    var t = $app.findRecordsByFilter(
      "shared_tournaments",
      'status = "active"',
      "-number",
      1,
      0,
    );
    if (t && t.length) {
      tournament = {
        number: t[0].get("number"),
        round: t[0].get("current_round"),
        status: t[0].get("status"),
      };
    }
  } catch (_) {}
  return {
    status: ok ? "ok" : "degraded",
    app: "footfive",
    serverTime: new Date().toISOString(),
    serverTimeMs: Date.now(),
    worldAvailable: worldAvailable,
    tournament: tournament,
  };
}

function adminHealth($app) {
  var base = publicHealth($app);
  var world = null;
  try {
    world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
  } catch (_) {}
  var stalls = { hasStalls: false, stalledMatches: [], stalledRounds: [] };
  try {
    stalls = recoveryMod.detectStalls($app);
  } catch (_) {}
  var live = 0;
  try {
    live = $app.findRecordsByFilter(
      "shared_fixtures",
      'status = "live"',
      "",
      50,
      0,
    ).length;
  } catch (_) {}
  var paused = world ? !!world.get("progression_paused") : false;
  var lastErr =
    (world && (world.get("last_catchup_error") || world.get("last_recovery_error"))) ||
    "";
  var level = "healthy";
  if (stalls.hasStalls || lastErr) level = "warning";
  if (!base.worldAvailable) level = "failed";

  return {
    status: level,
    serverTime: base.serverTime,
    serverTimeMs: base.serverTimeMs,
    worldAvailable: base.worldAvailable,
    tournament: base.tournament,
    progressionPaused: paused,
    liveFixtures: live,
    stalledFixtures: (stalls.stalledMatches || []).length,
    stalledRounds: (stalls.stalledRounds || []).length,
    hasStalls: !!stalls.hasStalls,
    lastCatchUpAt: world ? world.get("last_catchup_at") : null,
    lastCatchUpDurationMs: world ? world.get("last_catchup_duration_ms") : null,
    lastCatchUpError: world ? world.get("last_catchup_error") || "" : "",
    lastCatchUpSummary: world ? world.get("last_catchup_summary") : null,
    lastRetentionAt: world ? world.get("last_retention_at") : null,
    lastRetentionResult: world ? world.get("last_retention_result") : null,
    lastRecoveryAt: world ? world.get("last_recovery_at") : null,
    lastRecoveryResult: world ? world.get("last_recovery_result") : null,
    lastRecoveryError: world ? world.get("last_recovery_error") || "" : "",
    retentionDays: world ? world.get("retention_days") : null,
    pace: world ? world.get("pace") : null,
    nextActionAt: world ? world.get("next_action_at") : null,
  };
}

function recordCatchUp($app, summary, durationMs, errMsg) {
  try {
    var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    world.set("last_catchup_at", toPbDate(new Date()));
    world.set("last_catchup_duration_ms", durationMs || 0);
    world.set("last_catchup_error", errMsg || "");
    world.set("last_catchup_summary", summary || {});
    world.set("health_status", errMsg ? "warning" : "healthy");
    $app.save(world);
  } catch (_) {}
}

if (typeof module !== "undefined") {
  module.exports = {
    publicHealth: publicHealth,
    adminHealth: adminHealth,
    recordCatchUp: recordCatchUp,
  };
}
