/// <reference path="../pb_data/types.d.ts" />
/**
 * Issue #195: move every world to 6 real seconds per match minute.
 * Only world defaults change; kicked-off rounds, fixtures and match states keep
 * their existing speed snapshots. Down is best-effort: prior overrides were not
 * recorded, so unchanged 6s/6000ms rows return to the former 8s/8000ms default.
 */
migrate(
  (app) => {
    var world = app.findCollectionByNameOrId("world");
    for (var offset = 0; ; offset += 200) {
      var rows = app.findRecordsByFilter(world.id, "id != ''", "id", 200, offset);
      for (var i = 0; i < rows.length; i++) {
        var rec = rows[i];
        if (rec.get("match_minute_real_seconds") === 6 && rec.get("match_minute_real_ms") === 6000) continue;
        rec.set("match_minute_real_seconds", 6);
        rec.set("match_minute_real_ms", 6000);
        app.save(rec);
      }
      if (rows.length < 200) break;
    }
  },
  (app) => {
    var world = app.findCollectionByNameOrId("world");
    for (var offset = 0; ; offset += 200) {
      var rows = app.findRecordsByFilter(world.id, "id != ''", "id", 200, offset);
      for (var i = 0; i < rows.length; i++) {
        var rec = rows[i];
        // Preserve settings changed by an admin since the migration.
        if (rec.get("match_minute_real_seconds") !== 6 || rec.get("match_minute_real_ms") !== 6000) continue;
        rec.set("match_minute_real_seconds", 8);
        rec.set("match_minute_real_ms", 8000);
        app.save(rec);
      }
      if (rows.length < 200) break;
    }
  },
);
