/**
 * Detailed event retention — never deletes active or permanent summaries.
 */
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

function getRetentionDays($app) {
  try {
    var w = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    var d = w.get("retention_days");
    if (d == null) return 30;
    return parseInt(d, 10) || 0;
  } catch (_) {
    return 30;
  }
}

/**
 * Preview or run cleanup. days=0 means Never.
 */
function runRetention($app, opts) {
  opts = opts || {};
  var preview = !!opts.preview;
  var adminId = opts.adminId || null;
  var days = opts.days != null ? opts.days : getRetentionDays($app);
  var result = {
    preview: preview,
    retention_days: days,
    examined: 0,
    deleted: 0,
    eligible: [],
    skipped: [],
    error: "",
  };

  if (days === 0) {
    result.skipped.push("Retention set to Never");
    saveRun($app, result, adminId);
    return result;
  }

  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var batch = 40;

  // Only purge events_json from match_states that have a summary and completed tournament
  try {
    var summaries = $app.findRecordsByFilter(
      "match_summaries",
      "id != ''",
      "completed_at",
      200,
      0,
    );
    for (var i = 0; i < (summaries || []).length && result.examined < batch * 5; i++) {
      var sum = summaries[i];
      result.examined++;
      if (sum.get("events_purged")) {
        result.skipped.push(sum.get("fixture_id") + ":already_purged");
        continue;
      }
      var doneAt = parsePbDate(sum.get("completed_at"));
      if (isNaN(doneAt) || doneAt > cutoff) {
        result.skipped.push(sum.get("fixture_id") + ":too_recent");
        continue;
      }
      // Tournament must be complete
      var tid = sum.get("tournament_id");
      if (tid) {
        try {
          var t = $app.findRecordById("shared_tournaments", tid);
          if (t.get("status") !== "complete") {
            result.skipped.push(sum.get("fixture_id") + ":tournament_active");
            continue;
          }
        } catch (_) {
          // summary-only ok
        }
      }
      // Do not touch live fixtures
      try {
        var fx = $app.findRecordById("shared_fixtures", sum.get("fixture_id"));
        if (fx.get("status") === "live" || fx.get("status") === "scheduled") {
          result.skipped.push(sum.get("fixture_id") + ":fixture_active");
          continue;
        }
      } catch (_) {}

      result.eligible.push(sum.get("fixture_id"));
      if (!preview) {
        try {
          var ms = $app.findRecordsByFilter(
            "match_states",
            "fixture = {:f}",
            "",
            1,
            0,
            { f: sum.get("fixture_id") },
          );
          if (ms && ms.length) {
            // Keep state_json stats but clear heavy events
            ms[0].set("events_json", []);
            $app.save(ms[0]);
          }
          sum.set("events_purged", true);
          $app.save(sum);
          // Old coaching commands for fixture
          try {
            var cmds = $app.findRecordsByFilter(
              "coaching_commands",
              "fixture = {:f}",
              "",
              100,
              0,
              { f: sum.get("fixture_id") },
            );
            for (var c = 0; c < (cmds || []).length; c++) {
              $app.delete(cmds[c]);
            }
          } catch (_) {}
          result.deleted++;
        } catch (err) {
          result.error += String(err) + "; ";
        }
      }
      if (result.deleted >= batch) break;
    }
  } catch (err) {
    result.error += String(err);
  }

  // Expired tactical scans
  if (!preview) {
    try {
      var scans = $app.findRecordsByFilter("tactical_scans", "id != ''", "", 50, 0);
      for (var s = 0; s < (scans || []).length; s++) {
        var created = parsePbDate(scans[s].get("created"));
        if (!isNaN(created) && created < cutoff) {
          $app.delete(scans[s]);
          result.deleted++;
        }
      }
    } catch (_) {}
  }

  // Update world
  try {
    var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
    if (!preview) {
      world.set("last_retention_at", toPbDate(new Date()));
      world.set("last_retention_result", result);
      $app.save(world);
    }
  } catch (_) {}

  saveRun($app, result, adminId);
  return result;
}

function saveRun($app, result, adminId) {
  try {
    var col = $app.findCollectionByNameOrId("retention_runs");
    var rec = new Record(col);
    rec.set("preview", !!result.preview);
    rec.set("retention_days", result.retention_days);
    rec.set("examined", result.examined);
    rec.set("deleted", result.deleted);
    rec.set("details", {
      eligible: result.eligible,
      skipped: result.skipped.slice(0, 50),
    });
    rec.set("error", result.error || "");
    if (adminId) rec.set("admin", adminId);
    $app.save(rec);
  } catch (_) {}
}

function retentionStatus($app) {
  var days = getRetentionDays($app);
  var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
  var summaries = 0;
  var purged = 0;
  try {
    var all = $app.findRecordsByFilter("match_summaries", "id != ''", "", 500, 0);
    summaries = (all || []).length;
    for (var i = 0; i < (all || []).length; i++) {
      if (all[i].get("events_purged")) purged++;
    }
  } catch (_) {}
  return {
    retention_days: days,
    never: days === 0,
    match_summaries: summaries,
    events_purged: purged,
    last_retention_at: world ? world.get("last_retention_at") : null,
    last_retention_result: world ? world.get("last_retention_result") : null,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    runRetention: runRetention,
    retentionStatus: retentionStatus,
    getRetentionDays: getRetentionDays,
  };
}
