/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 3: team treasury, energy timestamps, batteries, Command Charge, team finance ledger.
 * Does not wipe pb_data. Does not drop Phase 1 tables automatically (documented cleanup).
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

    // --- proball_teams: treasury, batteries, overclock flag ---
    const teams = app.findCollectionByNameOrId("proball_teams");
    if (!hasField(teams, "treasury")) {
      teams.fields.add(
        new NumberField({ name: "treasury", required: false, min: 0, onlyInt: true }),
      );
    }
    if (!hasField(teams, "battery_count")) {
      teams.fields.add(
        new NumberField({ name: "battery_count", required: false, min: 0, onlyInt: true }),
      );
    }
    if (!hasField(teams, "overclock_ready")) {
      teams.fields.add(new BoolField({ name: "overclock_ready", required: false }));
    }
    if (!hasField(teams, "overclock_fixture")) {
      teams.fields.add(
        new TextField({ name: "overclock_fixture", required: false, max: 40 }),
      );
    }
    app.save(teams);

    // Seed treasury/batteries for existing teams
    try {
      app
        .db()
        .newQuery(
          "UPDATE proball_teams SET treasury = 2500 WHERE treasury IS NULL OR treasury = 0",
        )
        .execute();
    } catch (_) {}
    try {
      app
        .db()
        .newQuery(
          "UPDATE proball_teams SET battery_count = 2 WHERE battery_count IS NULL",
        )
        .execute();
    } catch (_) {}

    // --- proball_players: energy timestamp ---
    const players = app.findCollectionByNameOrId("proball_players");
    if (!hasField(players, "energy_updated_at")) {
      players.fields.add(new DateField({ name: "energy_updated_at", required: false }));
    }
    app.save(players);

    // --- world: ai_progression ---
    const world = app.findCollectionByNameOrId("world");
    if (!hasField(world, "ai_progression_enabled")) {
      world.fields.add(new BoolField({ name: "ai_progression_enabled", required: false }));
    }
    app.save(world);

    // --- command_charge (per user manager) ---
    let cc;
    try {
      cc = app.findCollectionByNameOrId("command_charge");
    } catch (_) {
      cc = new Collection({
        type: "base",
        name: "command_charge",
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
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_command_charge_user ON command_charge (user)",
          )
          .execute();
      } catch (_) {}
    }

    // --- tactical_scans ---
    let scans;
    try {
      scans = app.findCollectionByNameOrId("tactical_scans");
    } catch (_) {
      // need shared_fixtures for relation — use text fixture id for simplicity
      scans = new Collection({
        type: "base",
        name: "tactical_scans",
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
            name: "team",
            required: true,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: true,
          },
          { type: "text", name: "fixture_id", required: true, max: 40 },
          { type: "json", name: "report_json", required: true },
          { type: "bool", name: "consumed", required: false },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(scans);
    }

    // --- team_finance_ledger ---
    let ledger;
    try {
      ledger = app.findCollectionByNameOrId("team_finance_ledger");
    } catch (_) {
      ledger = new Collection({
        type: "base",
        name: "team_finance_ledger",
        listRule:
          "@request.auth.id != '' && team.manager = @request.auth.id",
        viewRule:
          "@request.auth.id != '' && team.manager = @request.auth.id",
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
          { type: "number", name: "amount", required: true, onlyInt: true },
          { type: "text", name: "type", required: true, max: 40 },
          { type: "text", name: "description", required: false, max: 200 },
          { type: "number", name: "balance_after", required: false, onlyInt: true },
          { type: "text", name: "tournament_id", required: false, max: 40 },
          { type: "text", name: "fixture_id", required: false, max: 40 },
          { type: "text", name: "player_id", required: false, max: 40 },
          { type: "text", name: "idempotency_key", required: true, max: 100 },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(ledger);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_team_fin_idem ON team_finance_ledger (idempotency_key)",
          )
          .execute();
      } catch (_) {}
    }

    // --- reward_settlements (exactly-once flags) ---
    let rewards;
    try {
      rewards = app.findCollectionByNameOrId("reward_settlements");
    } catch (_) {
      rewards = new Collection({
        type: "base",
        name: "reward_settlements",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "settlement_key", required: true, max: 120 },
          { type: "text", name: "kind", required: true, max: 40 },
          {
            type: "relation",
            name: "team",
            required: false,
            maxSelect: 1,
            collectionId: teams.id,
            cascadeDelete: false,
          },
          { type: "autodate", name: "created", onCreate: true, onUpdate: false },
        ],
      });
      app.save(rewards);
      try {
        app
          .db()
          .newQuery(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_settlement_key ON reward_settlements (settlement_key)",
          )
          .execute();
      } catch (_) {}
    }
  },
  (app) => {},
);
