/// <reference path="../pb_data/types.d.ts" />

/**
 * Phase 7: world health fields for catch-up / observability.
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

    const world = app.findCollectionByNameOrId("world");
    const fields = [
      ["last_catchup_at", "date"],
      ["last_catchup_duration_ms", "number"],
      ["last_catchup_error", "text"],
      ["last_catchup_summary", "json"],
      ["last_recovery_error", "text"],
      ["health_status", "text"],
    ];
    for (let i = 0; i < fields.length; i++) {
      const [name, type] = fields[i];
      if (hasField(world, name)) continue;
      if (type === "date") {
        world.fields.add(new DateField({ name: name, required: false }));
      } else if (type === "number") {
        world.fields.add(
          new NumberField({ name: name, required: false, onlyInt: true }),
        );
      } else if (type === "json") {
        world.fields.add(new JSONField({ name: name, required: false }));
      } else {
        world.fields.add(new TextField({ name: name, required: false, max: 500 }));
      }
    }
    app.save(world);
  },
  (app) => {},
);
