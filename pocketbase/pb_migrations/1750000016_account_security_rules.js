/// <reference path="../pb_data/types.d.ts" />
/**
 * Issue #14 fix wave (review F2/F3) — additive; no data reset, no old
 * migrations touched.
 *
 * F2: every client-exposed collection rule now also requires a healthy
 * account: a disabled or must_change_password auth record satisfies no
 * list/view rule (and the users self update/delete rules). Login,
 * auth-refresh and session discovery (/me, change-password) are unaffected —
 * they do not traverse collection rules.
 *
 * F3: users already disabled under the base implementation kept valid
 * pre-upgrade tokens. Rotate their tokenKey here so those tokens die at
 * upgrade. Fail closed: if rotation is impossible the migration fails rather
 * than shipping a silently unrevoked state. Records, IDs and business data
 * are preserved — only tokenKey changes.
 */
migrate(
  (app) => {
    var GUARD =
      "@request.auth.disabled = false && @request.auth.must_change_password = false";
    var RULE_PROPS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];

    var cols = app.findAllCollections();
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      if (col.system) continue;
      var changed = false;
      for (var p = 0; p < RULE_PROPS.length; p++) {
        var prop = RULE_PROPS[p];
        // PB exposes rules as wrapped *string (typeof "object") — normalize.
        var raw = col[prop];
        if (raw === null || raw === undefined) continue;
        var rule = String(raw);
        if (rule === "") continue;
        if (rule.indexOf("must_change_password") >= 0) continue;
        // Forced-password session discovery stays possible: users list/view
        // are how a client reads its own record while must_change_password is
        // set, so they keep a self-only shape — but a DISABLED account is
        // excluded from session discovery too (review F7). Every other
        // exposed rule gets the full account-state guard.
        if (col.name === "users" && (prop === "listRule" || prop === "viewRule")) {
          col[prop] = "(" + rule + ") && @request.auth.disabled = false";
          changed = true;
          continue;
        }
        col[prop] = "(" + rule + ") && " + GUARD;
        changed = true;
      }
      if (changed) app.save(col);
    }

    // Revoke outstanding tokens of ALL already-disabled accounts (upgrade
    // path). Paginate the whole result set: a single capped page silently
    // leaves legacy tokens unrevoked, and re-enable would resurrect them
    // (review F6). Rotation does not change the filter, so offset paging is
    // stable. Fail closed: if rotation is impossible the migration fails
    // rather than shipping a silently unrevoked state.
    var PAGE = 500;
    var offset = 0;
    var disabled;
    do {
      disabled = app.findRecordsByFilter("users", "disabled = true", "", PAGE, offset) || [];
      for (var d = 0; d < disabled.length; d++) {
        var u = disabled[d];
        if (typeof u.refreshTokenKey === "function") {
          u.refreshTokenKey();
        } else if (typeof $security !== "undefined" && $security.randomString) {
          u.set("tokenKey", $security.randomString(50));
        } else {
          throw new Error("token rotation unavailable for disabled user " + u.id);
        }
        app.save(u);
      }
      offset += disabled.length;
    } while (disabled.length === PAGE);
  },
  (app) => {
    // Down: remove the guard clauses (tokenKey rotation is intentionally not
    // reversed — re-enabling old tokens would reintroduce the F3 defect).
    var GUARD =
      "@request.auth.disabled = false && @request.auth.must_change_password = false";
    var RULE_PROPS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
    var cols = app.findAllCollections();
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      if (col.system) continue;
      var changed = false;
      for (var p = 0; p < RULE_PROPS.length; p++) {
        var prop = RULE_PROPS[p];
        var raw = col[prop];
        if (raw === null || raw === undefined) continue;
        var rule = String(raw);
        var suffix = ") && " + GUARD;
        var disabledSuffix = ") && @request.auth.disabled = false";
        if (rule.indexOf("(") === 0 && rule.slice(-suffix.length) === suffix) {
          col[prop] = rule.slice(1, rule.length - suffix.length);
          changed = true;
        } else if (rule.indexOf("(") === 0 && rule.slice(-disabledSuffix.length) === disabledSuffix) {
          // users list/view self-discovery shape (see up migration).
          col[prop] = rule.slice(1, rule.length - disabledSuffix.length);
          changed = true;
        }
      }
      if (changed) app.save(col);
    }
  },
);
