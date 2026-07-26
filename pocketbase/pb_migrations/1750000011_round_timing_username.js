/// <reference path="../pb_data/types.d.ts" />
/**
 * Prompt 10: between-round timing, round announce fields, username, JSON maxSize.
 */
migrate(
  (app) => {
    // --- world: between_round_minutes ---
    try {
      var world = app.findCollectionByNameOrId("world");
      var hasBetween = false;
      for (var i = 0; i < world.fields.length; i++) {
        if (world.fields[i].name === "between_round_minutes") hasBetween = true;
      }
      if (!hasBetween) {
        world.fields.add(
          new NumberField({
            name: "between_round_minutes",
            required: false,
            onlyInt: true,
            min: 1,
            max: 1440,
          }),
        );
        app.save(world);
      }
      // Backfill existing world rows
      try {
        var rows = app.findRecordsByFilter("world", "id != ''", "", 10, 0);
        for (var w = 0; w < (rows || []).length; w++) {
          var rec = rows[w];
          var cur = rec.get("between_round_minutes");
          if (cur == null || cur === 0) {
            rec.set("between_round_minutes", 3);
            var rms = rec.get("round_interval_ms");
            if (!rms || rms < 60000) rec.set("round_interval_ms", 3 * 60 * 1000);
            app.save(rec);
          }
        }
      } catch (e0) {
        console.log("[migrate] world backfill: " + e0);
      }
    } catch (e1) {
      console.log("[migrate] world between_round: " + e1);
    }

    // --- shared_rounds: announce fields ---
    try {
      var rounds = app.findCollectionByNameOrId("shared_rounds");
      var names = {};
      for (var r = 0; r < rounds.fields.length; r++) names[rounds.fields[r].name] = true;
      if (!names.announce_key) {
        rounds.fields.add(new TextField({ name: "announce_key", required: false, max: 120 }));
      }
      if (!names.announced_at) {
        rounds.fields.add(new DateField({ name: "announced_at", required: false }));
      }
      app.save(rounds);
    } catch (e2) {
      console.log("[migrate] shared_rounds announce: " + e2);
    }

    // --- users: username + allow 7-char bootstrap password (must_change) ---
    try {
      var users = app.findCollectionByNameOrId("users");
      var hasUser = false;
      for (var u = 0; u < users.fields.length; u++) {
        if (users.fields[u].name === "username") hasUser = true;
        if (users.fields[u].name === "password" && users.fields[u].min > 7) {
          users.fields[u].min = 7;
        }
      }
      if (!hasUser) {
        users.fields.add(
          new TextField({
            name: "username",
            required: false,
            max: 64,
            pattern: "^[a-zA-Z0-9_\\-.]{2,64}$",
          }),
        );
      }
      app.save(users);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username) WHERE username != '' AND username IS NOT NULL",
          )
          .execute();
      } catch (_) {}
    } catch (e3) {
      console.log("[migrate] users username: " + e3);
    }

    // --- match_states / fixtures JSON maxSize ---
    function bumpJsonMax(colName, fieldNames, maxSize) {
      try {
        var col = app.findCollectionByNameOrId(colName);
        var changed = false;
        for (var i = 0; i < col.fields.length; i++) {
          var f = col.fields[i];
          if (f.type === "json" && fieldNames.indexOf(f.name) >= 0) {
            if (!f.maxSize || f.maxSize < maxSize) {
              f.maxSize = maxSize;
              changed = true;
            }
          }
        }
        if (changed) app.save(col);
      } catch (err) {
        console.log("[migrate] json max " + colName + ": " + err);
      }
    }
    bumpJsonMax("match_states", ["state_json", "events_json", "stats_json"], 5000000);
    bumpJsonMax("shared_fixtures", ["home_lineup_json", "away_lineup_json"], 2000000);
  },
  (app) => {
    // non-destructive down: leave fields
  },
);
