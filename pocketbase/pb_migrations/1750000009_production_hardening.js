/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 6: password-reset flag, backfill runs, recovery indexes.
 * Additive — does not wipe pb_data.
 */
migrate(
  (app) => {
    function hasField(col, name) {
      let ok = false;
      col.fields.forEach((f) => {
        const n = typeof f.getName === "function" ? f.getName() : f.name;
        if (n === name) ok = true;
      });
      return ok;
    }

    const users = app.findCollectionByNameOrId("users");
    if (!hasField(users, "must_change_password")) {
      users.fields.add(
        new BoolField({ name: "must_change_password", required: false }),
      );
    }
    app.save(users);

    const world = app.findCollectionByNameOrId("world");
    if (!hasField(world, "last_recovery_at")) {
      world.fields.add(new DateField({ name: "last_recovery_at", required: false }));
    }
    if (!hasField(world, "last_recovery_result")) {
      world.fields.add(new JSONField({ name: "last_recovery_result", required: false }));
    }
    if (!hasField(world, "stall_threshold_ms")) {
      world.fields.add(
        new NumberField({ name: "stall_threshold_ms", required: false, onlyInt: true }),
      );
    }
    app.save(world);
    try {
      app
        .db()
        .newQuery(
          "UPDATE world SET stall_threshold_ms = 120000 WHERE stall_threshold_ms IS NULL OR stall_threshold_ms = 0",
        )
        .execute();
    } catch (_) {}

    let usersId = users.id;
    let bf;
    try {
      bf = app.findCollectionByNameOrId("backfill_runs");
    } catch (_) {
      bf = null;
    }
    if (!bf) {
      bf = new Collection({
        type: "base",
        name: "backfill_runs",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "bool", name: "preview", required: false },
          { type: "number", name: "examined", required: false, onlyInt: true },
          { type: "number", name: "created_summaries", required: false, onlyInt: true },
          { type: "number", name: "player_updates", required: false, onlyInt: true },
          { type: "number", name: "skipped", required: false, onlyInt: true },
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
      app.save(bf);
    }

    // Helpful indexes (ignore if already exist)
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_match_states_finalised ON match_states (finalised)",
      "CREATE INDEX IF NOT EXISTS idx_shared_fixtures_status ON shared_fixtures (status)",
      "CREATE INDEX IF NOT EXISTS idx_match_sum_completed ON match_summaries (completed_at)",
      "CREATE INDEX IF NOT EXISTS idx_shared_bets_user ON shared_bets (user)",
      "CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user)",
    ];
    for (let i = 0; i < indexes.length; i++) {
      try {
        app.db().newQuery(indexes[i]).execute();
      } catch (_) {}
    }
  },
  (app) => {},
);
