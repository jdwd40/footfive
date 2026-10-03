/// <reference path="../pb_data/types.d.ts" />
/**
 * Broadcast overhaul (engine v2, markets, championship timing, team modes).
 * Additive only: no rows are deleted or rewritten except the obsolete unique
 * bet index (one bet per fixture) and legacy timing defaults noted below.
 * The down migration removes everything added here.
 */
migrate(
  (app) => {
    function has(col, name) {
      var ok = false;
      col.fields.forEach(function (f) {
        if (f.name === name) ok = true;
      });
      return ok;
    }
    function add(colName, fields) {
      var col = app.findCollectionByNameOrId(colName);
      for (var i = 0; i < fields.length; i++) if (!has(col, fields[i].name)) col.fields.add(fields[i]);
      app.save(col);
      return col;
    }
    function sql(q) {
      app.db().newQuery(q).execute();
    }

    add("world", [
      new NumberField({ name: "championship_gap_minutes", required: false, onlyInt: true, min: 1, max: 1440 }),
      new NumberField({ name: "fixtures_window_minutes", required: false, onlyInt: true, min: 1, max: 1440 }),
      new NumberField({ name: "next_tick_ms", required: false, onlyInt: true }),
    ]);
    sql("UPDATE world SET championship_gap_minutes = 10 WHERE championship_gap_minutes IS NULL OR championship_gap_minutes = 0");
    sql("UPDATE world SET fixtures_window_minutes = 5 WHERE fixtures_window_minutes IS NULL OR fixtures_window_minutes = 0");

    add("shared_tournaments", [
      new DateField({ name: "starts_at", required: false }),
      new DateField({ name: "completed_at", required: false }),
      new JSONField({ name: "odds_json", required: false, maxSize: 200000 }),
    ]);
    add("shared_rounds", [new NumberField({ name: "finished_ms", required: false, onlyInt: true })]);
    add("shared_fixtures", [
      new JSONField({ name: "model_json", required: false, maxSize: 20000 }),
      new NumberField({ name: "score_home", required: false, onlyInt: true }),
      new NumberField({ name: "score_away", required: false, onlyInt: true }),
      new NumberField({ name: "shootout_home", required: false, onlyInt: true }),
      new NumberField({ name: "shootout_away", required: false, onlyInt: true }),
      new TextField({ name: "decided_by", required: false, max: 10 }),
      new NumberField({ name: "finished_ms", required: false, onlyInt: true }),
    ]);
    add("proball_teams", [
      new SelectField({ name: "manager_mode", required: false, maxSelect: 1, values: ["manual", "ai"] }),
      new SelectField({ name: "default_stance", required: false, maxSelect: 1, values: ["defend", "balanced", "attack"] }),
    ]);
    add("users", [new DateField({ name: "last_topup_at", required: false })]);

    // Bets: many markets, several bets per fixture, idempotent placement.
    var bets = app.findCollectionByNameOrId("shared_bets");
    bets.fields.forEach(function (f) {
      if (f.name === "fixture" || f.name === "selection_team") f.required = false;
    });
    var tournaments = app.findCollectionByNameOrId("shared_tournaments");
    var rounds = app.findCollectionByNameOrId("shared_rounds");
    if (!has(bets, "market")) bets.fields.add(new TextField({ name: "market", required: false, max: 24 }));
    if (!has(bets, "selection")) bets.fields.add(new TextField({ name: "selection", required: false, max: 200 }));
    if (!has(bets, "label")) bets.fields.add(new TextField({ name: "label", required: false, max: 300 }));
    if (!has(bets, "tournament"))
      bets.fields.add(new RelationField({ name: "tournament", required: false, maxSelect: 1, collectionId: tournaments.id, cascadeDelete: false }));
    if (!has(bets, "round"))
      bets.fields.add(new RelationField({ name: "round", required: false, maxSelect: 1, collectionId: rounds.id, cascadeDelete: false }));
    if (!has(bets, "placed_ms")) bets.fields.add(new NumberField({ name: "placed_ms", required: false, onlyInt: true }));
    if (!has(bets, "payout")) bets.fields.add(new NumberField({ name: "payout", required: false, onlyInt: true, min: 0 }));
    if (!has(bets, "settled_at")) bets.fields.add(new DateField({ name: "settled_at", required: false }));
    if (!has(bets, "result_note")) bets.fields.add(new TextField({ name: "result_note", required: false, max: 200 }));
    if (!has(bets, "idempotency_key")) bets.fields.add(new TextField({ name: "idempotency_key", required: false, max: 120 }));
    app.save(bets);
    sql("DROP INDEX IF EXISTS idx_shared_bets_user_fx");
    sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_bets_idem ON shared_bets (idempotency_key) WHERE idempotency_key != ''");
    sql("CREATE INDEX IF NOT EXISTS idx_shared_bets_open ON shared_bets (status, fixture)");

    add("credit_ledger", [new NumberField({ name: "balance_after", required: false, onlyInt: true })]);
    sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_idem ON credit_ledger (idempotency_key) WHERE idempotency_key != ''");

    // One row per published-or-pending match event (the single match truth).
    var ev = null;
    try {
      ev = app.findCollectionByNameOrId("match_events");
    } catch (_) {}
    if (!ev) {
      ev = new Collection({
        type: "base",
        name: "match_events",
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { type: "text", name: "fixture", required: true, max: 40 },
          { type: "text", name: "round", required: false, max: 40 },
          { type: "number", name: "seq", required: true, onlyInt: true },
          { type: "number", name: "at", required: true, onlyInt: true },
          { type: "text", name: "type", required: true, max: 32 },
          { type: "bool", name: "major", required: false },
          { type: "json", name: "data", required: true, maxSize: 20000 },
        ],
      });
      app.save(ev);
    }
    sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_match_events_fx_seq ON match_events (fixture, seq)");
    sql("CREATE INDEX IF NOT EXISTS idx_match_events_round_at ON match_events (round, major, at)");
  },
  (app) => {
    function drop(colName, names) {
      try {
        var col = app.findCollectionByNameOrId(colName);
        for (var i = 0; i < names.length; i++) {
          var f = col.fields.getByName(names[i]);
          if (f) col.fields.removeById(f.id);
        }
        app.save(col);
      } catch (e) {
        console.log("[migrate down] " + colName + ": " + e);
      }
    }
    try {
      app.delete(app.findCollectionByNameOrId("match_events"));
    } catch (_) {}
    app.db().newQuery("DROP INDEX IF EXISTS idx_shared_bets_idem").execute();
    app.db().newQuery("DROP INDEX IF EXISTS idx_shared_bets_open").execute();
    app.db().newQuery("DROP INDEX IF EXISTS idx_credit_ledger_idem").execute();
    drop("shared_bets", ["market", "selection", "label", "tournament", "round", "placed_ms", "payout", "settled_at", "result_note", "idempotency_key"]);
    drop("credit_ledger", ["balance_after"]);
    drop("world", ["championship_gap_minutes", "fixtures_window_minutes", "next_tick_ms"]);
    drop("shared_tournaments", ["starts_at", "completed_at", "odds_json"]);
    drop("shared_rounds", ["finished_ms"]);
    drop("shared_fixtures", ["model_json", "score_home", "score_away", "shootout_home", "shootout_away", "decided_by", "finished_ms"]);
    drop("proball_teams", ["manager_mode", "default_stance"]);
    drop("users", ["last_topup_at"]);
  },
);
