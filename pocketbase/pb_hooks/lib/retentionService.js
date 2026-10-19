/**
 * Detailed event retention — never deletes active or permanent summaries.
 *
 * A run freezes its cutoff once, then drains every eligible summary in (completed_at, id)
 * keyset pages. Each fixture is rechecked and purged in its own transaction, and the
 * cursor moves past every attempted row (purged, no longer eligible or failed), so no row
 * can hold back the ones behind it. A purge clears match_states.events_json, deletes the
 * fixture's match_events and flags the summary; summary content, match state, lineups,
 * records, bets and coaching history are kept.
 */
var PAGE = 50;
var DIAG = 50;
var DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Summaries whose detailed events may go: not yet purged, completed (canonical PocketBase
 * date) at or before the cutoff, for a finished fixture of a completed round and complete
 * tournament, whose match state (if any) is finalised and progression-settled, with no
 * unsettled bet that still reads the events (fixture bets: next_goal; round_first: the
 * round's first goal). A missing fixture, round or tournament never qualifies.
 */
var ELIGIBLE =
  "match_summaries.events_purged IS NOT TRUE" +
  " AND match_summaries.completed_at = strftime('%Y-%m-%d %H:%M:%fZ', match_summaries.completed_at)" +
  " AND match_summaries.completed_at <= {:cutoff}" +
  " AND EXISTS (SELECT 1 FROM shared_fixtures f" +
  " JOIN shared_rounds r ON r.id = f.round" +
  " JOIN shared_tournaments t ON t.id = f.tournament" +
  " WHERE f.id = match_summaries.fixture_id" +
  " AND f.status = 'finished' AND r.status = 'completed' AND t.status = 'complete'" +
  " AND (match_summaries.tournament_id = '' OR match_summaries.tournament_id = f.tournament)" +
  " AND NOT EXISTS (SELECT 1 FROM match_states m WHERE m.fixture = f.id" +
  " AND (m.finalised IS NOT TRUE OR m.progression_settled IS NOT TRUE))" +
  " AND NOT EXISTS (SELECT 1 FROM shared_bets b WHERE b.status IN ('open', 'locked')" +
  " AND (b.fixture = f.id OR (b.round = f.round AND b.market = 'round_first'))))";

/** Tactical scans created (canonical date) before the cutoff. */
var EXPIRED_SCAN =
  "tactical_scans.created = strftime('%Y-%m-%d %H:%M:%fZ', tactical_scans.created)" +
  " AND tactical_scans.created < {:cutoff}";

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
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

function eligibleExp(cutoff) {
  return $dbx.exp(ELIGIBLE, { cutoff: cutoff });
}

function expiredScanExp(cutoff) {
  return $dbx.exp(EXPIRED_SCAN, { cutoff: cutoff });
}

/** Rows strictly after (at, id) in (col, id) order. */
function afterExp(table, col, at, id) {
  var c = table + "." + col;
  return $dbx.exp("(" + c + " > {:at} OR (" + c + " = {:at} AND " + table + ".id > {:id}))", { at: at, id: id });
}

/** One keyset page, ordered by (col, id). */
function page($app, table, col, exp, at, id) {
  var rows = arrayOf(new Record());
  $app
    .recordQuery(table)
    .andWhere(exp)
    .andWhere(afterExp(table, col, at, id))
    .orderBy(col + " ASC", "id ASC")
    .limit(PAGE)
    .all(rows);
  return rows;
}

function listed(list, value) {
  if (list.length < DIAG) list.push(value);
}

/** Diagnostic error text stays bounded; `failed` keeps the exact count. */
function note(result, message) {
  if (result.error.length < 2000) result.error += String(message).slice(0, 200) + "; ";
}

/**
 * Recheck one summary in a transaction and purge it there: false when it is no longer
 * eligible. Only the events_json column, the fixture's event rows and the summary flag
 * are written, all through `tx`.
 */
function purgeFixture($app, summaryId, fixtureId, cutoff) {
  var purged = false;
  $app.runInTransaction(function (tx) {
    // Same summary, still for the fixture whose rows are written below, and still eligible.
    var same = $dbx.exp("match_summaries.id = {:sid} AND match_summaries.fixture_id = {:fid}", { sid: summaryId, fid: fixtureId });
    var still = tx.countRecords("match_summaries", same, eligibleExp(cutoff));
    if (still !== 1) return;
    var db = tx.db();
    db.newQuery("UPDATE match_states SET events_json = '[]' WHERE fixture = {:f}").bind({ f: fixtureId }).execute();
    db.newQuery("DELETE FROM match_events WHERE fixture = {:f}").bind({ f: fixtureId }).execute();
    db.newQuery("UPDATE match_summaries SET events_purged = TRUE WHERE id = {:sid}").bind({ sid: summaryId }).execute();
    purged = true;
  });
  return purged;
}

/**
 * Walk a keyset to exhaustion, calling `visit(row)` once per row. Stops (with an error
 * note) if a page fails or the cursor would not move forward.
 */
function sweep($app, table, col, exp, result, visit) {
  var at = "";
  var id = "";
  for (;;) {
    var rows;
    try {
      rows = page($app, table, col, exp, at, id);
    } catch (err) {
      note(result, table + ": " + String(err));
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var nextAt = rows[i].getString(col);
      if (!(nextAt > at || (nextAt === at && rows[i].id > id))) {
        note(result, table + ": cursor did not advance at " + rows[i].id);
        return;
      }
      at = nextAt;
      id = rows[i].id;
      visit(rows[i]);
    }
    if (rows.length < PAGE) return;
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
    fixtures_deleted: 0,
    scans_deleted: 0,
    eligible_total: 0,
    scans_eligible: 0,
    failed: 0,
  };

  if (days === 0) {
    result.skipped.push("Retention set to Never");
    saveRun($app, result, adminId);
    return result;
  }

  // Frozen for the whole run: summaries and scans created later stay out of it.
  var cutoff = toPbDate(Date.now() - days * DAY_MS);
  try {
    result.eligible_total = $app.countRecords("match_summaries", eligibleExp(cutoff));
    result.scans_eligible = $app.countRecords("tactical_scans", expiredScanExp(cutoff));
  } catch (err) {
    note(result, "count: " + String(err));
  }

  if (preview) {
    try {
      var first = page($app, "match_summaries", "completed_at", eligibleExp(cutoff), "", "");
      for (var p = 0; p < first.length; p++) {
        result.examined++;
        listed(result.eligible, first[p].getString("fixture_id"));
      }
    } catch (err) {
      note(result, "match_summaries: " + String(err));
    }
  } else {
    sweep($app, "match_summaries", "completed_at", eligibleExp(cutoff), result, function (sum) {
      var fixtureId = sum.getString("fixture_id");
      result.examined++;
      listed(result.eligible, fixtureId);
      try {
        if (purgeFixture($app, sum.id, fixtureId, cutoff)) result.fixtures_deleted++;
        else listed(result.skipped, fixtureId + ":no_longer_eligible");
      } catch (err) {
        result.failed++;
        note(result, fixtureId + ": " + String(err));
      }
    });
    sweep($app, "tactical_scans", "created", expiredScanExp(cutoff), result, function (scan) {
      try {
        $app.db().newQuery("DELETE FROM tactical_scans WHERE id = {:id}").bind({ id: scan.id }).execute();
        result.scans_deleted++;
      } catch (err) {
        result.failed++;
        note(result, "scan " + scan.id + ": " + String(err));
      }
    });
    result.deleted = result.fixtures_deleted + result.scans_deleted;
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
    summaries = $app.countRecords("match_summaries");
    purged = $app.countRecords("match_summaries", $dbx.exp("match_summaries.events_purged IS TRUE"));
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
