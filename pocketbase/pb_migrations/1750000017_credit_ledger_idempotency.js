/// <reference path="../pb_data/types.d.ts" />
/**
 * Issue #15 (review B4): credit_ledger idempotency is enforced by the schema.
 *
 * 1750000014 created idx_credit_ledger_idem with raw SQL, outside PocketBase's
 * collection metadata, so the collection schema (admin UI, exports/imports) does
 * not know the constraint exists. This registers the same partial unique index on
 * the collection itself. Additive: no row is modified or deleted.
 *
 * Preflight (non-destructive, fail closed): if any non-empty idempotency_key is
 * duplicated — possible only on a database where the raw index was lost — the
 * migration throws before changing anything, naming the keys. Duplicate ledger rows
 * are money history and must be reconciled by an operator, never auto-deleted.
 */
migrate(
  (app) => {
    var NAME = "idx_credit_ledger_idem";
    var dups = arrayOf(new DynamicModel({ k: "", n: 0 }));
    app
      .db()
      .newQuery(
        "SELECT idempotency_key AS k, COUNT(*) AS n FROM credit_ledger WHERE idempotency_key != '' GROUP BY idempotency_key HAVING COUNT(*) > 1 ORDER BY n DESC, k LIMIT 20",
      )
      .all(dups);
    if (dups.length) {
      var list = [];
      for (var i = 0; i < dups.length; i++) list.push(dups[i].k + " x" + dups[i].n);
      throw new Error(
        "credit_ledger has duplicate idempotency keys (" +
          list.join(", ") +
          "). Reconcile them manually before upgrading; this migration changed nothing.",
      );
    }

    var col = app.findCollectionByNameOrId("credit_ledger");
    if (col.getIndex(NAME)) return;
    // Replace the raw copy with the same definition owned by the collection (same
    // migration transaction, so the constraint is never absent on commit).
    app.db().newQuery("DROP INDEX IF EXISTS " + NAME).execute();
    col.addIndex(NAME, true, "idempotency_key", "idempotency_key != ''");
    app.save(col);
  },
  (app) => {
    var NAME = "idx_credit_ledger_idem";
    var col = app.findCollectionByNameOrId("credit_ledger");
    col.removeIndex(NAME);
    app.save(col);
    // Back to the 1750000014 state: the raw index, not the constraint's absence.
    app
      .db()
      .newQuery("CREATE UNIQUE INDEX IF NOT EXISTS " + NAME + " ON credit_ledger (idempotency_key) WHERE idempotency_key != ''")
      .execute();
  },
);
