/// <reference path="../pb_data/types.d.ts" />

/**
 * FootFive Phase 1 schema: users, templates, careers, tournaments, fixtures, matches.
 * Hidden timelines live on matches; normal API rules block future/final data.
 */
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // --- extend users ---
    const ensureField = (col, field) => {
      let exists = false;
      col.fields.forEach((f) => {
        if (f.name === field.name) exists = true;
      });
      if (!exists) col.fields.add(field);
    };

    ensureField(
      users,
      new TextField({
        name: "display_name",
        required: false,
        min: 1,
        max: 40,
      }),
    );
    ensureField(
      users,
      new SelectField({
        name: "role",
        required: false,
        maxSelect: 1,
        values: ["user", "admin"],
      }),
    );
    // default role via hook; migration sets field only
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    users.createRule = "";
    users.updateRule = "id = @request.auth.id";
    users.deleteRule = "id = @request.auth.id";
    app.save(users);

    // Force default role on create will be hook; set existing if needed
    try {
      app
        .db()
        .newQuery("UPDATE users SET role = 'user' WHERE role = '' OR role IS NULL")
        .execute();
    } catch (_) {}

    const usersId = users.id;

    // --- team_templates (public read) ---
    let teamTemplates;
    try {
      teamTemplates = app.findCollectionByNameOrId("team_templates");
    } catch (_) {
      teamTemplates = new Collection({
        type: "base",
        name: "team_templates",
        listRule: "",
        viewRule: "",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "slug", required: true, min: 2, max: 40 },
          { type: "text", name: "name", required: true, min: 2, max: 60 },
          {
            type: "select",
            name: "grade",
            required: true,
            maxSelect: 1,
            values: ["A++", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"],
          },
          { type: "number", name: "strength", required: true, min: 1, max: 100, onlyInt: true },
          { type: "text", name: "primary_color", required: true, max: 20 },
          { type: "text", name: "secondary_color", required: true, max: 20 },
          { type: "text", name: "badge_key", required: true, max: 40 },
          { type: "json", name: "players_json", required: true },
          { type: "number", name: "sort_order", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(teamTemplates);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_team_templates_slug ON team_templates (slug)",
          )
          .execute();
      } catch (_) {}
    }

    // --- careers ---
    let careers;
    try {
      careers = app.findCollectionByNameOrId("careers");
    } catch (_) {
      careers = new Collection({
        type: "base",
        name: "careers",
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
            name: "managed_template",
            required: true,
            maxSelect: 1,
            collectionId: teamTemplates.id,
            cascadeDelete: false,
          },
          { type: "number", name: "credits", required: false, min: 0, onlyInt: true },
          {
            type: "select",
            name: "pace",
            required: true,
            maxSelect: 1,
            values: ["normal", "dev"],
          },
          { type: "bool", name: "ai_progression_enabled", required: false },
          { type: "number", name: "round_interval_ms", required: false, min: 1000, onlyInt: true },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: ["active", "archived"],
          },
          { type: "date", name: "next_round_at", required: false },
          { type: "number", name: "processing_version", required: false, onlyInt: true },
          {
            type: "select",
            name: "processing_status",
            required: false,
            maxSelect: 1,
            values: ["idle", "processing", "error"],
          },
          { type: "date", name: "processing_claimed_at", required: false },
          { type: "text", name: "processing_error", required: false, max: 500 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(careers);
      try {
        app
          .db()
          .newQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_careers_user ON careers (user)")
          .execute();
      } catch (_) {}
    }

    // --- career_teams ---
    let careerTeams;
    try {
      careerTeams = app.findCollectionByNameOrId("career_teams");
    } catch (_) {
      careerTeams = new Collection({
        type: "base",
        name: "career_teams",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "template",
            required: true,
            maxSelect: 1,
            collectionId: teamTemplates.id,
            cascadeDelete: false,
          },
          { type: "text", name: "name", required: true, max: 60 },
          { type: "text", name: "grade", required: true, max: 8 },
          { type: "number", name: "strength", required: true, onlyInt: true },
          { type: "text", name: "primary_color", required: true, max: 20 },
          { type: "text", name: "secondary_color", required: true, max: 20 },
          { type: "text", name: "badge_key", required: true, max: 40 },
          { type: "bool", name: "is_user_managed", required: false },
          { type: "bool", name: "eliminated", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(careerTeams);
    }

    // patch careers.managed_team relation
    try {
      const careers2 = app.findCollectionByNameOrId("careers");
      let hasManagedTeam = false;
      careers2.fields.forEach((f) => {
        if (f.name === "managed_team") {
          hasManagedTeam = true;
          f.collectionId = careerTeams.id;
        }
      });
      if (!hasManagedTeam) {
        careers2.fields.add(
          new RelationField({
            name: "managed_team",
            required: false,
            maxSelect: 1,
            collectionId: careerTeams.id,
            cascadeDelete: false,
          }),
        );
      }
      app.save(careers2);
    } catch (_) {}

    // --- career_players ---
    let careerPlayers;
    try {
      careerPlayers = app.findCollectionByNameOrId("career_players");
    } catch (_) {
      careerPlayers = new Collection({
        type: "base",
        name: "career_players",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: careerTeams.id,
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
          { type: "number", name: "attack", required: true, min: 1, max: 99, onlyInt: true },
          { type: "number", name: "defence", required: true, min: 1, max: 99, onlyInt: true },
          { type: "number", name: "energy", required: false, min: 0, max: 100, onlyInt: true },
          { type: "number", name: "condition", required: false, min: 0, max: 100, onlyInt: true },
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
      app.save(careerPlayers);
    }

    // --- tournaments ---
    let tournaments;
    try {
      tournaments = app.findCollectionByNameOrId("tournaments");
    } catch (_) {
      tournaments = new Collection({
        type: "base",
        name: "tournaments",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          { type: "number", name: "number", required: true, min: 1, onlyInt: true },
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
            collectionId: careerTeams.id,
            cascadeDelete: false,
          },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(tournaments);
    }

    // --- rounds ---
    let rounds;
    try {
      rounds = app.findCollectionByNameOrId("rounds");
    } catch (_) {
      rounds = new Collection({
        type: "base",
        name: "rounds",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
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
          { type: "date", name: "expected_finish_at", required: false },
          { type: "date", name: "completed_at", required: false },
          {
            type: "select",
            name: "status",
            required: true,
            maxSelect: 1,
            values: [
              "scheduled",
              "generating",
              "generated",
              "live",
              "completing",
              "completed",
              "error",
            ],
          },
          { type: "number", name: "processing_version", required: false, onlyInt: true },
          { type: "text", name: "idempotency_key", required: true, max: 80 },
          { type: "bool", name: "progression_done", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(rounds);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_idem ON rounds (idempotency_key)",
          )
          .execute();
      } catch (_) {}
    }

    // --- fixtures ---
    let fixtures;
    try {
      fixtures = app.findCollectionByNameOrId("fixtures");
    } catch (_) {
      fixtures = new Collection({
        type: "base",
        name: "fixtures",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
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
            collectionId: careerTeams.id,
            cascadeDelete: false,
          },
          {
            type: "relation",
            name: "away_team",
            required: true,
            maxSelect: 1,
            collectionId: careerTeams.id,
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
            collectionId: careerTeams.id,
            cascadeDelete: false,
          },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(fixtures);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_fixtures_round_slot ON fixtures (round, slot)",
          )
          .execute();
      } catch (_) {}
    }

    // --- matches (hidden final data — list/view blocked for clients) ---
    let matches;
    try {
      matches = app.findCollectionByNameOrId("matches");
    } catch (_) {
      matches = new Collection({
        type: "base",
        name: "matches",
        // No direct client access to full records (timelines + finals)
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
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
            name: "round",
            required: true,
            maxSelect: 1,
            collectionId: rounds.id,
            cascadeDelete: true,
          },
          { type: "date", name: "started_at", required: false },
          { type: "date", name: "expected_finish_at", required: false },
          { type: "json", name: "events_json", required: false },
          { type: "json", name: "stats_json", required: false },
          { type: "number", name: "home_score_final", required: false, onlyInt: true },
          { type: "number", name: "away_score_final", required: false, onlyInt: true },
          { type: "number", name: "home_shootout_final", required: false, onlyInt: true },
          { type: "number", name: "away_shootout_final", required: false, onlyInt: true },
          {
            type: "relation",
            name: "winner_team",
            required: false,
            maxSelect: 1,
            collectionId: careerTeams.id,
            cascadeDelete: false,
          },
          { type: "bool", name: "went_extra_time", required: false },
          { type: "bool", name: "went_shootout", required: false },
          { type: "bool", name: "settled", required: false },
          { type: "number", name: "duration_ms", required: false, onlyInt: true },
          { type: "text", name: "generation_key", required: true, max: 80 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(matches);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_fixture ON matches (fixture)",
          )
          .execute();
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_gen ON matches (generation_key)",
          )
          .execute();
      } catch (_) {}
    }

    // --- team_records ---
    let teamRecords;
    try {
      teamRecords = app.findCollectionByNameOrId("team_records");
    } catch (_) {
      teamRecords = new Collection({
        type: "base",
        name: "team_records",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: careerTeams.id,
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
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(teamRecords);
    }

    // --- player_records ---
    let playerRecords;
    try {
      playerRecords = app.findCollectionByNameOrId("player_records");
    } catch (_) {
      playerRecords = new Collection({
        type: "base",
        name: "player_records",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          {
            type: "relation",
            name: "player",
            required: true,
            maxSelect: 1,
            collectionId: careerPlayers.id,
            cascadeDelete: true,
          },
          { type: "number", name: "appearances", required: false, onlyInt: true },
          { type: "number", name: "goals", required: false, onlyInt: true },
          { type: "number", name: "yellow_cards", required: false, onlyInt: true },
          { type: "number", name: "red_cards", required: false, onlyInt: true },
          { type: "number", name: "penalties_scored", required: false, onlyInt: true },
          { type: "number", name: "penalties_missed", required: false, onlyInt: true },
          { type: "number", name: "shootout_goals", required: false, onlyInt: true },
          { type: "number", name: "shootout_misses", required: false, onlyInt: true },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(playerRecords);
    }

    // --- financial_transactions foundation ---
    let fin;
    try {
      fin = app.findCollectionByNameOrId("financial_transactions");
    } catch (_) {
      fin = new Collection({
        type: "base",
        name: "financial_transactions",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
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
      app.save(fin);
    }

    // --- bets foundation ---
    let bets;
    try {
      bets = app.findCollectionByNameOrId("bets");
    } catch (_) {
      bets = new Collection({
        type: "base",
        name: "bets",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
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
            collectionId: careerTeams.id,
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
      app.save(bets);
    }

    // --- app_settings ---
    let appSettings;
    try {
      appSettings = app.findCollectionByNameOrId("app_settings");
    } catch (_) {
      appSettings = new Collection({
        type: "base",
        name: "app_settings",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "key", required: true, max: 60 },
          { type: "json", name: "value", required: true },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(appSettings);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_key ON app_settings (key)",
          )
          .execute();
      } catch (_) {}
      const col = app.findCollectionByNameOrId("app_settings");
      const rec = new Record(col);
      rec.set("key", "detailed_data_retention");
      rec.set("value", { days: 30 });
      app.save(rec);
    }

    // --- admin_audit_logs ---
    let audit;
    try {
      audit = app.findCollectionByNameOrId("admin_audit_logs");
    } catch (_) {
      audit = new Collection({
        type: "base",
        name: "admin_audit_logs",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "admin",
            required: true,
            maxSelect: 1,
            collectionId: usersId,
            cascadeDelete: false,
          },
          { type: "text", name: "action", required: true, max: 80 },
          { type: "text", name: "target_type", required: false, max: 40 },
          { type: "text", name: "target_id", required: false, max: 40 },
          { type: "json", name: "meta", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(audit);
    }

    // --- command_charge_state foundation ---
    let cc;
    try {
      cc = app.findCollectionByNameOrId("command_charge_state");
    } catch (_) {
      cc = new Collection({
        type: "base",
        name: "command_charge_state",
        listRule: "career.user = @request.auth.id",
        viewRule: "career.user = @request.auth.id",
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          {
            type: "relation",
            name: "career",
            required: true,
            maxSelect: 1,
            collectionId: careers.id,
            cascadeDelete: true,
          },
          { type: "number", name: "points", required: false, min: 0, max: 5, onlyInt: true },
          { type: "date", name: "last_regen_at", required: false },
          { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
        ],
      });
      app.save(cc);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_career ON command_charge_state (career)",
          )
          .execute();
      } catch (_) {}
    }
  },
  (app) => {
    // down: leave collections (destructive down not used in prod)
  },
);
