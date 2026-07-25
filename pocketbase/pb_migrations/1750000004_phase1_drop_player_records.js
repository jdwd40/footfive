/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 5b: drop leftover Phase 1 collections (children first),
 * add global_player_records + team record fields for history.
 * Additive — does not wipe pb_data.
 */
migrate(
  (app) => {
    // Drop obsolete private-world collections in dependency-safe order
    const dropOrder = [
      "career_players",
      "career_teams",
      "careers",
      "fixtures",
      "rounds",
      "tournaments",
      "matches",
      "player_records",
      "team_records",
      "financial_transactions",
      "bets",
      "command_charge_state",
      "team_templates",
    ];
    for (let i = 0; i < dropOrder.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(dropOrder[i]);
        if (col && col.name === dropOrder[i]) {
          // Never touch shared_*, proball_*, match_states, world
          if (
            col.name.indexOf("shared_") === 0 ||
            col.name.indexOf("proball_") === 0 ||
            col.name === "match_states" ||
            col.name === "world"
          ) {
            continue;
          }
          app.delete(col);
        }
      } catch (_) {}
    }

    // Extend global_team_records
    let gtr;
    try {
      gtr = app.findCollectionByNameOrId("global_team_records");
    } catch (_) {
      gtr = null;
    }
    if (gtr) {
      function hasField(col, name) {
        let ok = false;
        col.fields.forEach((f) => {
          if (f.name === name) ok = true;
        });
        return ok;
      }
      if (!hasField(gtr, "finals_reached")) {
        gtr.fields.add(
          new NumberField({ name: "finals_reached", required: false, onlyInt: true }),
        );
      }
      if (!hasField(gtr, "normal_time_wins")) {
        gtr.fields.add(
          new NumberField({ name: "normal_time_wins", required: false, onlyInt: true }),
        );
      }
      if (!hasField(gtr, "extra_time_wins")) {
        gtr.fields.add(
          new NumberField({ name: "extra_time_wins", required: false, onlyInt: true }),
        );
      }
      if (!hasField(gtr, "best_round")) {
        gtr.fields.add(new TextField({ name: "best_round", required: false, max: 16 }));
      }
      app.save(gtr);
    }

    let teams;
    try {
      teams = app.findCollectionByNameOrId("proball_teams");
    } catch (_) {
      teams = null;
    }
    let players;
    try {
      players = app.findCollectionByNameOrId("proball_players");
    } catch (_) {
      players = null;
    }

    // Permanent player career stats (shared world)
    let gpr;
    try {
      gpr = app.findCollectionByNameOrId("global_player_records");
    } catch (_) {
      gpr = null;
    }
    if (!gpr && players && teams) {
      gpr = new Collection({
        type: "base",
        name: "global_player_records",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "player",
            required: true,
            maxSelect: 1,
            collectionId: players.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "text", name: "player_name", required: false, max: 40 },
          { type: "text", name: "role", required: false, max: 8 },
          { type: "number", name: "appearances", required: false, onlyInt: true },
          { type: "number", name: "goals", required: false, onlyInt: true },
          { type: "number", name: "fouls", required: false, onlyInt: true },
          { type: "number", name: "yellow_cards", required: false, onlyInt: true },
          { type: "number", name: "red_cards", required: false, onlyInt: true },
          { type: "number", name: "penalties_taken", required: false, onlyInt: true },
          { type: "number", name: "penalties_scored", required: false, onlyInt: true },
          { type: "number", name: "penalties_missed", required: false, onlyInt: true },
          { type: "number", name: "shootout_taken", required: false, onlyInt: true },
          { type: "number", name: "shootout_scored", required: false, onlyInt: true },
          { type: "number", name: "shootout_missed", required: false, onlyInt: true },
          { type: "number", name: "championships", required: false, onlyInt: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(gpr);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_gpr_player ON global_player_records (player)",
          )
          .execute();
      } catch (_) {}
    }
  },
  (app) => {},
);
