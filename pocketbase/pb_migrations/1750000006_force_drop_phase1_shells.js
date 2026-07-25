/// <reference path="../pb_data/types.d.ts" />

/**
 * Force-remove Phase 1 shell collections by stripping ALL relation fields first.
 */
migrate(
  (app) => {
    function nukeRelations(name) {
      try {
        const col = app.findCollectionByNameOrId(name);
        const names = [];
        col.fields.forEach((f) => {
          if (f.type === "relation") names.push(f.name);
        });
        for (let i = 0; i < names.length; i++) {
          col.fields.removeByName(names[i]);
        }
        app.save(col);
        console.log("[migrate] stripped relations from " + name + ": " + names.join(","));
      } catch (err) {
        console.log("[migrate] strip " + name + ": " + err);
      }
    }

    // Order: strip both sides of cycle
    nukeRelations("careers");
    nukeRelations("career_teams");

    // Re-fetch and delete children then parents
    const order = ["career_teams", "careers", "team_templates"];
    for (let i = 0; i < order.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(order[i]);
        if (col && col.name === order[i]) {
          app.delete(col);
          console.log("[migrate] deleted " + order[i]);
        }
      } catch (err) {
        console.log("[migrate] drop " + order[i] + ": " + err);
      }
    }
  },
  (app) => {},
);
