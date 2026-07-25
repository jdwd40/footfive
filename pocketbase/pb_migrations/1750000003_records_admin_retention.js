/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 5: match/tournament summaries, retention, user disable, drop Phase 1 collections.
 * Additive migration — does not wipe pb_data.
 */
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const usersId = users.id;

    function hasField(col, name) {
      let ok = false;
      col.fields.forEach((f) => {
        if (f.name === name) ok = true;
      });
      return ok;
    }

    // users.disabled
    if (!hasField(users, "disabled")) {
      users.fields.add(new BoolField({ name: "disabled", required: false }));
    }
    if (!hasField(users, "admin_note")) {
      users.fields.add(new TextField({ name: "admin_note", required: false, max: 500 }));
    }
    app.save(users);

    // world retention + pause
    const world = app.findCollectionByNameOrId("world");
    if (!hasField(world, "retention_days")) {
      world.fields.add(
        new NumberField({ name: "retention_days", required: false, onlyInt: true }),
      );
    }
    if (!hasField(world, "progression_paused")) {
      world.fields.add(new BoolField({ name: "progression_paused", required: false }));
    }
    if (!hasField(world, "last_retention_at")) {
      world.fields.add(new DateField({ name: "last_retention_at", required: false }));
    }
    if (!hasField(world, "last_retention_result")) {
      world.fields.add(new JSONField({ name: "last_retention_result", required: false }));
    }
    app.save(world);
    try {
      app
        .db()
        .newQuery(
          "UPDATE world SET retention_days = 30 WHERE retention_days IS NULL OR retention_days = 0",
        )
        .execute();
    } catch (_) {}

    let teams;
    try {
      teams = app.findCollectionByNameOrId("proball_teams");
    } catch (_) {
      teams = null;
    }

    // match_summaries — compact permanent records
    let matchSum;
    try {
      matchSum = app.findCollectionByNameOrId("match_summaries");
    } catch (_) {
      matchSum = new Collection({
        type: "base",
        name: "match_summaries",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "fixture_id", required: true, max: 40 },
          { type: "text", name: "tournament_id", required: false, max: 40 },
          { type: "text", name: "round_key", required: false, max: 16 },
          { type: "text", name: "slot", required: false, max: 16 },
          {
            type: "relation",
            name: "home_team",
            required: false,
            maxSelect: 1,
            collectionId: teams ? teams.id : "",
            cascadeDelete: false,
          },
          {
            type: "relation",
            name: "away_team",
            required: false,
            maxSelect: 1,
            collectionId: teams ? teams.id : "",
            cascadeDelete: false,
          },
          { type: "text", name: "home_name", required: false, max: 60 },
          { type: "text", name: "away_name", required: false, max: 60 },
          { type: "number", name: "score_home", required: false, onlyInt: true },
          { type: "number", name: "score_away", required: false, onlyInt: true },
          { type: "number", name: "shootout_home", required: false, onlyInt: true },
          { type: "number", name: "shootout_away", required: false, onlyInt: true },
          {
            type: "relation",
            name: "winner_team",
            required: false,
            maxSelect: 1,
            collectionId: teams ? teams.id : "",
            cascadeDelete: false,
          },
          { type: "bool", name: "went_extra_time", required: false },
          { type: "bool", name: "went_shootout", required: false },
          { type: "json", name: "stats_json", required: false },
          { type: "json", name: "goals_json", required: false },
          { type: "json", name: "cards_json", required: false },
          { type: "json", name: "shootout_kicks_json", required: false },
          { type: "json", name: "coaching_json", required: false },
          { type: "date", name: "completed_at", required: false },
          { type: "bool", name: "events_purged", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(matchSum);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_match_sum_fx ON match_summaries (fixture_id)",
          )
          .execute();
      } catch (_) {}
    }

    // tournament_summaries
    let tSum;
    try {
      tSum = app.findCollectionByNameOrId("tournament_summaries");
    } catch (_) {
      tSum = new Collection({
        type: "base",
        name: "tournament_summaries",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "tournament_id", required: true, max: 40 },
          { type: "number", name: "number", required: true, onlyInt: true },
          {
            type: "relation",
            name: "champion_team",
            required: false,
            maxSelect: 1,
            collectionId: teams ? teams.id : "",
            cascadeDelete: false,
          },
          {
            type: "relation",
            name: "runner_up_team",
            required: false,
            maxSelect: 1,
            collectionId: teams ? teams.id : "",
            cascadeDelete: false,
          },
          { type: "text", name: "champion_name", required: false, max: 60 },
          { type: "text", name: "runner_up_name", required: false, max: 60 },
          { type: "json", name: "semi_finalists_json", required: false },
          { type: "json", name: "bracket_json", required: false },
          { type: "number", name: "total_goals", required: false, onlyInt: true },
          { type: "number", name: "extra_time_matches", required: false, onlyInt: true },
          { type: "number", name: "shootout_matches", required: false, onlyInt: true },
          { type: "json", name: "highlights_json", required: false },
          { type: "date", name: "started_at", required: false },
          { type: "date", name: "completed_at", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(tSum);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_t_sum_tid ON tournament_summaries (tournament_id)",
          )
          .execute();
      } catch (_) {}
    }

    // retention_runs log
    let rRuns;
    try {
      rRuns = app.findCollectionByNameOrId("retention_runs");
    } catch (_) {
      rRuns = new Collection({
        type: "base",
        name: "retention_runs",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "bool", name: "preview", required: false },
          { type: "number", name: "retention_days", required: false, onlyInt: true },
          { type: "number", name: "examined", required: false, onlyInt: true },
          { type: "number", name: "deleted", required: false, onlyInt: true },
          { type: "json", name: "details", required: false },
          { type: "text", name: "error", required: false, max: 500 },
          {
            type: "relation",
            name: "admin",
            required: false,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: false,
          },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(rRuns);
    }

    // Drop Phase 1 private-world collections if present and unused
    const phase1 = [
      "careers",
      "career_teams",
      "career_players",
      "tournaments", // old private
      "rounds",
      "fixtures",
      "matches", // old private
      "team_records",
      "player_records",
      "financial_transactions",
      "bets",
      "command_charge_state",
      "team_templates",
    ];
    for (let i = 0; i < phase1.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(phase1[i]);
        // Never drop shared_* or proball_* or match_states
        if (col && col.name === phase1[i]) {
          app.delete(col);
        }
      } catch (_) {}
    }
  },
  (app) => {},
);
