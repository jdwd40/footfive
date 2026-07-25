/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop Phase 1 shells using Field.type() method (not property).
 */
migrate(
  (app) => {
    function nukeRelations(name) {
      try {
        const col = app.findCollectionByNameOrId(name);
        const names = [];
        col.fields.forEach((f) => {
          try {
            const t = typeof f.type === "function" ? f.type() : f.type;
            const n = typeof f.getName === "function" ? f.getName() : f.name;
            if (t === "relation") names.push(n);
          } catch (_) {}
        });
        for (let i = 0; i < names.length; i++) {
          col.fields.removeByName(names[i]);
        }
        app.save(col);
        console.log("[migrate] stripped " + name + ": " + names.join(","));
      } catch (err) {
        console.log("[migrate] strip " + name + ": " + err);
      }
    }

    nukeRelations("careers");
    nukeRelations("career_teams");

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
