/// <reference path="../pb_data/types.d.ts" />
/**
 * Prompt 12: official team abbreviations (unique, uppercase, max 3).
 */
migrate(
  (app) => {
    var abbrBySlug = {
      new_metro_city: "MET",
      mega_city_one: "MC1",
      mega_city_two: "MC2",
      airway_city: "AIR",
      virgin: "VIR",
      port_hilo: "PHL",
      metro_bay: "MBY",
      green_bay: "GRN",
      tripper_city: "TRI",
      atlan: "ATL",
      redstone: "RED",
      swirl: "SWR",
      st_marry: "STM",
      orlean_city: "ORL",
      outside_city: "OUT",
      doge_city: "DOG",
    };
    var abbrByName = {
      "New Metro City": "MET",
      "Mega City One": "MC1",
      "Mega City Two": "MC2",
      "Airway City": "AIR",
      Virgin: "VIR",
      "Port Hilo": "PHL",
      "Metro Bay": "MBY",
      "Green Bay": "GRN",
      "Tripper City": "TRI",
      Atlan: "ATL",
      Redstone: "RED",
      Swirl: "SWR",
      "St Marry": "STM",
      "Orlean City": "ORL",
      "Outside City": "OUT",
      "Doge City": "DOG",
    };

    try {
      var teams = app.findCollectionByNameOrId("proball_teams");
      var has = false;
      for (var i = 0; i < teams.fields.length; i++) {
        if (teams.fields[i].name === "abbreviation") has = true;
      }
      if (!has) {
        teams.fields.add(
          new TextField({
            name: "abbreviation",
            required: false,
            max: 3,
            min: 2,
            pattern: "^[A-Z0-9]{2,3}$",
          }),
        );
        app.save(teams);
      }
    } catch (e1) {
      console.log("[migrate] abbr field: " + e1);
    }

    try {
      var rows = app.findRecordsByFilter("proball_teams", "id != ''", "sort_order", 50, 0);
      for (var r = 0; r < (rows || []).length; r++) {
        var rec = rows[r];
        var ab =
          abbrBySlug[rec.get("slug")] ||
          abbrByName[rec.get("name")] ||
          "";
        if (!ab) continue;
        if (String(rec.get("abbreviation") || "") === ab) continue;
        rec.set("abbreviation", ab);
        app.save(rec);
      }
    } catch (e2) {
      console.log("[migrate] abbr backfill: " + e2);
    }

    try {
      app
        .db()
        .newQuery(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_proball_teams_abbr ON proball_teams (abbreviation) WHERE abbreviation != '' AND abbreviation IS NOT NULL",
        )
        .execute();
    } catch (_) {}
  },
  (app) => {},
);
