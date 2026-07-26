/// <reference path="../pb_data/types.d.ts" />
/**
 * Prompt 11: match_minute_real_seconds + per-match/round speed snapshots.
 */
migrate(
  (app) => {
    // world
    try {
      var world = app.findCollectionByNameOrId("world");
      var hasSec = false;
      for (var i = 0; i < world.fields.length; i++) {
        if (world.fields[i].name === "match_minute_real_seconds") hasSec = true;
      }
      if (!hasSec) {
        world.fields.add(
          new NumberField({
            name: "match_minute_real_seconds",
            required: false,
            onlyInt: true,
            min: 1,
            max: 60,
          }),
        );
        app.save(world);
      }
      var rows = app.findRecordsByFilter("world", "id != ''", "", 10, 0);
      for (var w = 0; w < (rows || []).length; w++) {
        var rec = rows[w];
        var cur = parseInt(rec.get("match_minute_real_seconds"), 10);
        if (isNaN(cur) || cur < 1) {
          rec.set("match_minute_real_seconds", 15);
          rec.set("match_minute_real_ms", 15000);
          app.save(rec);
        }
      }
    } catch (e1) {
      console.log("[migrate] match speed world: " + e1);
    }

    function addNumberField(colName, fieldName) {
      try {
        var col = app.findCollectionByNameOrId(colName);
        var has = false;
        for (var i = 0; i < col.fields.length; i++) {
          if (col.fields[i].name === fieldName) has = true;
        }
        if (!has) {
          col.fields.add(
            new NumberField({
              name: fieldName,
              required: false,
              onlyInt: true,
              min: 0,
            }),
          );
          app.save(col);
        }
      } catch (err) {
        console.log("[migrate] " + colName + "." + fieldName + ": " + err);
      }
    }
    addNumberField("shared_fixtures", "match_minute_real_ms");
    addNumberField("match_states", "match_minute_real_ms");
    addNumberField("shared_rounds", "match_minute_real_ms");

    // Snapshot live matches at their current (legacy) speed so mid-match doesn't jump
    try {
      var live = app.findRecordsByFilter(
        "match_states",
        "finalised = false",
        "",
        100,
        0,
      );
      for (var m = 0; m < (live || []).length; m++) {
        var ms = live[m];
        var existing = parseInt(ms.get("match_minute_real_ms"), 10);
        if (!isNaN(existing) && existing > 0) continue;
        var legacy = 200; // prior prod dev turbo
        try {
          var raw = ms.get("state_json");
          if (raw && typeof raw === "object" && raw.timing && raw.timing.matchMinuteRealMs) {
            legacy = raw.timing.matchMinuteRealMs;
          }
        } catch (_) {}
        ms.set("match_minute_real_ms", legacy);
        app.save(ms);
        try {
          var fx = app.findRecordById("shared_fixtures", ms.get("fixture"));
          if (!parseInt(fx.get("match_minute_real_ms"), 10)) {
            fx.set("match_minute_real_ms", legacy);
            app.save(fx);
          }
        } catch (_) {}
      }
    } catch (e2) {
      console.log("[migrate] live snapshot: " + e2);
    }
  },
  (app) => {},
);
