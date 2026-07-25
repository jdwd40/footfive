/// <reference path="../pb_data/types.d.ts" />

/**
 * Drop Phase 1 shells: clear API rules, strip relations, delete.
 */
migrate(
  (app) => {
    function prepAndDelete(name) {
      try {
        const col = app.findCollectionByNameOrId(name);
        col.listRule = null;
        col.viewRule = null;
        col.createRule = null;
        col.updateRule = null;
        col.deleteRule = null;
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
        console.log("[migrate] prepped " + name + " stripped " + names.join(","));
      } catch (err) {
        console.log("[migrate] prep " + name + ": " + err);
      }
    }

    prepAndDelete("careers");
    prepAndDelete("career_teams");

    const order = ["career_teams", "careers", "team_templates"];
    for (let i = 0; i < order.length; i++) {
      try {
        const col = app.findCollectionByNameOrId(order[i]);
        if (col && col.name === order[i]) {
          col.listRule = null;
          col.viewRule = null;
          col.createRule = null;
          col.updateRule = null;
          col.deleteRule = null;
          try {
            app.save(col);
          } catch (_) {}
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
