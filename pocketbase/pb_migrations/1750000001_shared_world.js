/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 2: shared 24/7 Proball world.
 * Adds global teams, match_states, coaching, user credits.
 * Phase 1 career_* collections left unused (dev data disposable).
 */
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    const ensureField = (col, fieldDef) => {
      let exists = false;
      col.fields.forEach((f) => {
        if (f.name === fieldDef.name) exists = true;
      });
      if (!exists) {
        if (fieldDef.type === "number") {
          col.fields.add(
            new NumberField({
              name: fieldDef.name,
              required: fieldDef.required || false,
              min: fieldDef.min,
              max: fieldDef.max,
              onlyInt: fieldDef.onlyInt !== false,
            }),
          );
        } else if (fieldDef.type === "text") {
          col.fields.add(
            new TextField({
              name: fieldDef.name,
              required: fieldDef.required || false,
              max: fieldDef.max || 200,
            }),
          );
        } else if (fieldDef.type === "select") {
          col.fields.add(
            new SelectField({
              name: fieldDef.name,
              required: fieldDef.required || false,
              maxSelect: 1,
              values: fieldDef.values,
            }),
          );
        } else if (fieldDef.type === "bool") {
          col.fields.add(new BoolField({ name: fieldDef.name, required: false }));
        } else if (fieldDef.type === "date") {
          col.fields.add(new DateField({ name: fieldDef.name, required: false }));
        } else if (fieldDef.type === "json") {
          col.fields.add(new JSONField({ name: fieldDef.name, required: fieldDef.required || false }));
        } else if (fieldDef.type === "relation") {
          col.fields.add(
            new RelationField({
              name: fieldDef.name,
              required: fieldDef.required || false,
              maxSelect: 1,
              collectionId: fieldDef.collectionId,
              cascadeDelete: fieldDef.cascadeDelete || false,
            }),
          );
        }
      }
    };

    ensureField(users, { type: "number", name: "credits", min: 0, onlyInt: true });
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.updateRule = "id = @request.auth.id";
    app.save(users);

    const usersId = users.id;

    // --- world (singleton settings) ---
    let world;
    try {
      world = app.findCollectionByNameOrId("world");
    } catch (_) {
      world = new Collection({
        type: "base",
        name: "world",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "key", required: true, max: 40 },
          {
            type: "select",
            name: "pace",
            required: true,
            maxSelect: 1,
            values: ["normal", "dev"],
          },
          { type: "number", name: "round_interval_ms", required: false, onlyInt: true },
          { type: "number", name: "tournament_interval_ms", required: false, onlyInt: true },
          { type: "number", name: "segment_minutes", required: false, onlyInt: true },
          { type: "number", name: "match_minute_real_ms", required: false, onlyInt: true },
          { type: "date", name: "next_action_at", required: false },
          {
            type: "select",
            name: "processing_status",
            required: false,
            maxSelect: 1,
            values: ["idle", "processing", "error"],
          },
          { type: "number", name: "processing_version", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(world);
      try {
        app
          .db()
          .newQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_world_key ON world (key)")
          .execute();
      } catch (_) {}
    }

    // --- proball_teams (global 16) ---
    let teams;
    try {
      teams = app.findCollectionByNameOrId("proball_teams");
    } catch (_) {
      teams = new Collection({
        type: "base",
        name: "proball_teams",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "slug", required: true, max: 40 },
          { type: "text", name: "name", required: true, max: 60 },
          { type: "text", name: "grade", required: true, max: 8 },
          { type: "number", name: "strength", required: true, onlyInt: true },
          { type: "text", name: "primary_color", required: true, max: 20 },
          { type: "text", name: "secondary_color", required: true, max: 20 },
          { type: "text", name: "badge_key", required: true, max: 40 },
          {
            type: "relation",
            name: "manager",
            required: false,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: false,
          },
          { type: "bool", name: "eliminated", required: false },
          { type: "number", name: "sort_order", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(teams);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_proball_teams_slug ON proball_teams (slug)",
          )
          .execute();
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_proball_teams_manager ON proball_teams (manager) WHERE manager != ''",
          )
          .execute();
      } catch (_) {}
    }

    // --- proball_players ---
    let players;
    try {
      players = app.findCollectionByNameOrId("proball_players");
    } catch (_) {
      players = new Collection({
        type: "base",
        name: "proball_players",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: true,
          },
          { type: "text", name: "name", required: true, max: 40 },
          {
            type: "select",
            name: "role",
            required: true,
            maxSelect: 1,
            values: ["gk", "def", "mid", "att", "util"],
          },
          { type: "number", name: "attack", required: true, onlyInt: true },
          { type: "number", name: "defence", required: true, onlyInt: true },
          { type: "number", name: "energy", required: false, onlyInt: true },
          { type: "number", name: "condition", required: false, onlyInt: true },
          { type: "bool", name: "is_starter", required: false },
          {
            type: "select",
            name: "intensity",
            required: false,
            maxSelect: 1,
            values: ["passive", "balanced", "aggressive"],
          },
          { type: "number", name: "sort_order", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(players);
    }

    // --- shared_tournaments ---
    let tournaments;
    try {
      tournaments = app.findCollectionByNameOrId("shared_tournaments");
    } catch (_) {
      tournaments = new Collection({
        type: "base",
        name: "shared_tournaments",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "number", name: "number", required: true, onlyInt: true },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: ["active", "complete"],
          },
          {
            type: "select",
            name: "current_round",
            required: true,
            maxSelect: 1,
            values: ["r16", "qf", "sf", "final", "complete"],
          },
          {
            type: "relation",
            name: "champion_team",
            required: false,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(tournaments);
    }

    // --- shared_rounds ---
    let rounds;
    try {
      rounds = app.findCollectionByNameOrId("shared_rounds");
    } catch (_) {
      rounds = new Collection({
        type: "base",
        name: "shared_rounds",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "tournament",
            required: true,
            maxSelect: 1,
            collectionId: tournaments.id,
            cascadeDelete: true,
          },
          {
            type: "select",
            name: "round_key",
            required: true,
            maxSelect: 1,
            values: ["r16", "qf", "sf", "final"],
          },
          { type: "text", name: "label", required: true, max: 40 },
          { type: "date", name: "scheduled_at", required: true },
          { type: "date", name: "started_at", required: false },
          { type: "date", name: "completed_at", required: false },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: [
              "scheduled",
              "management",
              "live",
              "completing",
              "completed",
            ],
          },
          { type: "text", name: "idempotency_key", required: true, max: 80 },
          { type: "bool", name: "progression_done", required: false },
          { type: "number", name: "processing_version", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(rounds);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_rounds_idem ON shared_rounds (idempotency_key)",
          )
          .execute();
      } catch (_) {}
    }

    // --- shared_fixtures ---
    let fixtures;
    try {
      fixtures = app.findCollectionByNameOrId("shared_fixtures");
    } catch (_) {
      fixtures = new Collection({
        type: "base",
        name: "shared_fixtures",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "tournament",
            required: true,
            maxSelect: 1,
            collectionId: tournaments.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "round",
            required: true,
            maxSelect: 1,
            collectionId: rounds.id,
            cascadeDelete: true,
          },
          { type: "text", name: "slot", required: true, max: 16 },
          { type: "number", name: "bracket_index", required: false, onlyInt: true },
          {
            type: "relation",
            name: "home_team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          {
            type: "relation",
            name: "away_team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "text", name: "feeds_into", required: false, max: 16 },
          { type: "text", name: "feeds_position", required: false, max: 8 },
          { type: "date", name: "scheduled_at", required: true },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: ["scheduled", "live", "finished"],
          },
          {
            type: "relation",
            name: "winner_team",
            required: false,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "json", name: "home_lineup_json", required: false },
          { type: "json", name: "away_lineup_json", required: false },
          { type: "bool", name: "lineups_frozen", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(fixtures);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_fx_slot ON shared_fixtures (round, slot)",
          )
          .execute();
      } catch (_) {}
    }

    // --- match_states (incremental) ---
    let matchStates;
    try {
      matchStates = app.findCollectionByNameOrId("match_states");
    } catch (_) {
      matchStates = new Collection({
        type: "base",
        name: "match_states",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "fixture",
            required: true,
            maxSelect: 1,
            collectionId: fixtures.id,
            cascadeDelete: true,
          },
          { type: "number", name: "seed", required: true, onlyInt: true },
          { type: "number", name: "sim_version", required: false, onlyInt: true },
          { type: "number", name: "processing_version", required: false, onlyInt: true },
          { type: "text", name: "phase", required: false, max: 40 },
          { type: "number", name: "sim_minute", required: false, onlyInt: true },
          { type: "number", name: "score_home", required: false, onlyInt: true },
          { type: "number", name: "score_away", required: false, onlyInt: true },
          { type: "number", name: "shootout_home", required: false, onlyInt: true },
          { type: "number", name: "shootout_away", required: false, onlyInt: true },
          { type: "text", name: "home_coaching", required: false, max: 20 },
          { type: "text", name: "away_coaching", required: false, max: 20 },
          { type: "json", name: "state_json", required: false },
          { type: "json", name: "events_json", required: false },
          { type: "json", name: "stats_json", required: false },
          { type: "date", name: "started_at", required: false },
          { type: "date", name: "next_segment_due_at", required: false },
          { type: "date", name: "last_processed_at", required: false },
          { type: "bool", name: "finalised", required: false },
          { type: "bool", name: "progression_settled", required: false },
          {
            type: "relation",
            name: "winner_team",
            required: false,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "number", name: "segment_index", required: false, onlyInt: true },
          { type: "text", name: "last_segment_key", required: false, max: 80 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(matchStates);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_match_states_fx ON match_states (fixture)",
          )
          .execute();
      } catch (_) {}
    }

    // --- coaching_commands ---
    let coaching;
    try {
      coaching = app.findCollectionByNameOrId("coaching_commands");
    } catch (_) {
      coaching = new Collection({
        type: "base",
        name: "coaching_commands",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "fixture",
            required: true,
            maxSelect: 1,
            collectionId: fixtures.id,
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
          {
            type: "relation",
            name: "user",
            required: true,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: false,
          },
          {
            type: "select",
            name: "stance",
            required: true,
            maxSelect: 1,
            values: ["defend", "balanced", "attack"],
          },
          { type: "number", name: "effective_from_minute", required: false, onlyInt: true },
          { type: "number", name: "segment_index", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(coaching);
    }

    // --- shared_bets ---
    let sharedBets;
    try {
      sharedBets = app.findCollectionByNameOrId("shared_bets");
    } catch (_) {
      sharedBets = new Collection({
        type: "base",
        name: "shared_bets",
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "user",
            required: true,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "fixture",
            required: true,
            maxSelect: 1,
            collectionId: fixtures.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "selection_team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "number", name: "stake", required: true, min: 1, onlyInt: true },
          { type: "number", name: "odds", required: true, min: 1 },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: ["open", "locked", "won", "lost", "void", "settled"],
          },
          { type: "bool", name: "settled", required: false },
          { type: "text", name: "settlement_key", required: false, max: 80 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(sharedBets);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_bets_user_fx ON shared_bets (user, fixture)",
          )
          .execute();
      } catch (_) {}
    }

    // --- credit_ledger (simple financial log without career) ---
    let ledger;
    try {
      ledger = app.findCollectionByNameOrId("credit_ledger");
    } catch (_) {
      ledger = new Collection({
        type: "base",
        name: "credit_ledger",
        listRule: "user = @request.auth.id",
        viewRule: "user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "user",
            required: true,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: true,
          },
          { type: "text", name: "type", required: true, max: 40 },
          { type: "number", name: "amount", required: true, onlyInt: true },
          { type: "text", name: "description", required: false, max: 200 },
          { type: "text", name: "idempotency_key", required: false, max: 80 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(ledger);
    }

    // team records global
    let teamRecords;
    try {
      teamRecords = app.findCollectionByNameOrId("global_team_records");
    } catch (_) {
      teamRecords = new Collection({
        type: "base",
        name: "global_team_records",
        listRule: "@request.auth.id != ''",
        viewRule: "@request.auth.id != ''",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: true,
          },
          { type: "number", name: "played", required: false, onlyInt: true },
          { type: "number", name: "wins", required: false, onlyInt: true },
          { type: "number", name: "draws", required: false, onlyInt: true },
          { type: "number", name: "losses", required: false, onlyInt: true },
          { type: "number", name: "goals_for", required: false, onlyInt: true },
          { type: "number", name: "goals_against", required: false, onlyInt: true },
          { type: "number", name: "shootout_wins", required: false, onlyInt: true },
          { type: "number", name: "shootout_losses", required: false, onlyInt: true },
          { type: "number", name: "championships", required: false, onlyInt: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(teamRecords);
    }
  },
  (app) => {},
);
