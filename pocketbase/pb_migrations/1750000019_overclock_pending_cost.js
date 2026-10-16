/// <reference path="../pb_data/types.d.ts" />
/**
 * Issue #121: overclock's energy cost moves from arming to kick-off, where it is paid by
 * the five players who actually start. `overclock_cost_pending` marks an arm whose cost
 * is still owed. Existing rows read false: an overclock armed before this upgrade was
 * already paid by that arm's starters, so kick-off consumes it without charging again.
 * Who paid for such an arm was never recorded; no refund or re-charge is attempted.
 * Additive and idempotent: no row is modified.
 */
migrate(
  (app) => {
    var teams = app.findCollectionByNameOrId("proball_teams");
    if (teams.fields.getByName("overclock_cost_pending")) return;
    teams.fields.add(new BoolField({ name: "overclock_cost_pending", required: false }));
    app.save(teams);
  },
  (app) => {
    var teams = app.findCollectionByNameOrId("proball_teams");
    var field = teams.fields.getByName("overclock_cost_pending");
    if (!field) return;
    teams.fields.removeById(field.id);
    app.save(teams);
  },
);
