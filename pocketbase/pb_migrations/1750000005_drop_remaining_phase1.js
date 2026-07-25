/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop remaining Phase 1 collections that failed due to circular relations.
 * Strip relation fields first, then delete collections.
 */
migrate(
  (app) => {
    function stripRelations(name) {
      try {
        const col = app.findCollectionByNameOrId(name);
        const keep = [];
        col.fields.forEach((f) => {
          if (f.type !== "relation") keep.push(f);
        });
        // Rebuild fields without relations where possible
        // PocketBase collection fields API: remove relation fields by name
        const toRemove = [];
        col.fields.forEach((f) => {
          if (f.type === "relation") toRemove.push(f.name);
        });
        for (let i = 0; i < toRemove.length; i++) {
          try {
            col.fields.removeByName(toRemove[i]);
          } catch (_) {
            try {
              // older API
              const idx = col.fields.findIndex
                ? col.fields.findIndex((f) => f.name === toRemove[i])
                : -1;
              if (idx >= 0) col.fields.splice(idx, 1);
            } catch (_) {}
          }
        }
        app.save(col);
      } catch (_) {}
    }

    // Break cycles
    stripRelations("careers");
    stripRelations("career_teams");

    const order = ["career_teams", "careers", "team_templates"];
    for (let i = 0; i < order.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(order[i]);
        if (col && col.name === order[i]) app.delete(col);
      } catch (err) {
        console.log("[migrate] drop " + order[i] + ": " + err);
      }
    }
  },
  (app) => {},
);
