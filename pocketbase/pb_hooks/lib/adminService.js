/**
 * Administrator operations — role-checked by routes.
 */
var balMod, mgmtMod, betMod;
try {
  balMod = require(__hooks + "/lib/balance.js");
  mgmtMod = require(__hooks + "/lib/managementService.js");
  betMod = require(__hooks + "/lib/bettingService.js");
} catch (e) {
  balMod = require("./balance.js");
  mgmtMod = require("./managementService.js");
  betMod = require("./bettingService.js");
}
var BALANCE = balMod.BALANCE;

/** Suffix keeping same-millisecond admin ledger keys distinct (keys are unique). */
function uniq() {
  return Math.random().toString(36).slice(2, 10);
}

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function audit($app, adminId, action, targetType, targetId, before, after, reason, ok) {
  try {
    var col = $app.findCollectionByNameOrId("admin_audit_logs");
    var rec = new Record(col);
    rec.set("admin", adminId);
    rec.set("action", action);
    rec.set("target_type", targetType || "");
    rec.set("target_id", String(targetId || ""));
    rec.set("meta", {
      before: before || null,
      after: after || null,
      reason: reason || "",
      success: ok !== false,
    });
    $app.save(rec);
  } catch (err) {
    console.log("[footfive] audit fail: " + err);
  }
}

function requireAdmin(auth) {
  if (!auth || auth.get("role") !== "admin") {
    throw new ForbiddenError("Admin only");
  }
  if (auth.get("disabled")) throw new ForbiddenError("Account disabled");
}

/**
 * Re-reads the acting admin inside the transaction, so an admin disabled or
 * demoted by a concurrent request can no longer act (review B19).
 */
function requireFreshAdmin(txApp, adminId) {
  var rows = txApp.findRecordsByFilter("users", "id = {:id}", "", 1, 0, { id: adminId });
  requireAdmin(rows && rows.length ? rows[0] : null);
}

function activeAdminCount(txApp) {
  return txApp.countRecords("users", $dbx.hashExp({ role: "admin", disabled: false }));
}

/** Code points, as PocketBase counts text field length. */
function chars(s) {
  return s.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || [];
}

function overview($app) {
  // Exact counts (review B19): no list caps, actual unmanaged teams.
  var userCount = $app.countRecords("users");
  var available = $app.countRecords(
    "proball_teams",
    $dbx.exp("manager = '' OR manager IS NULL")
  );
  var managed = $app.countRecords("proball_teams") - available;
  var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
  var tourney = null;
  try {
    var t = $app.findRecordsByFilter(
      "shared_tournaments",
      'status = "active"',
      "-number",
      1,
      0,
    );
    if (t && t.length) {
      tourney = {
        id: t[0].id,
        number: t[0].get("number"),
        round: t[0].get("current_round"),
      };
    }
  } catch (_) {}
  var liveFx = 0;
  try {
    liveFx = $app.countRecords("shared_fixtures", $dbx.hashExp({ status: "live" }));
  } catch (_) {}
  var eventStates = 0;
  try {
    eventStates = $app.countRecords("match_states");
  } catch (_) {}
  var audits = $app.findRecordsByFilter(
    "admin_audit_logs",
    "id != ''",
    "-created",
    10,
    0,
  );
  var recent = [];
  for (var a = 0; a < (audits || []).length; a++) {
    recent.push({
      action: audits[a].get("action"),
      target: audits[a].get("target_type") + " " + audits[a].get("target_id"),
      created: audits[a].get("created"),
    });
  }
  return {
    users: userCount,
    managedTeams: managed,
    availableTeams: available,
    spectators: Math.max(0, userCount - managed),
    tournament: tourney,
    liveFixtures: liveFx,
    matchStates: eventStates,
    retentionDays: world ? world.get("retention_days") : 30,
    progressionPaused: world ? !!world.get("progression_paused") : false,
    pace: world ? world.get("pace") : "normal",
    betweenRoundMinutes: world ? world.get("between_round_minutes") || 1 : 1,
    championshipGapMinutes: world ? world.get("championship_gap_minutes") || 10 : 10,
    fixturesWindowMinutes: world ? world.get("fixtures_window_minutes") || 5 : 5,
    roundIntervalMs: world ? world.get("round_interval_ms") : null,
    matchMinuteRealSeconds: world
      ? parseInt(world.get("match_minute_real_seconds"), 10) || BALANCE.matchMinuteRealSeconds
      : BALANCE.matchMinuteRealSeconds,
    matchMinuteRealMs: world
      ? parseInt(world.get("match_minute_real_ms"), 10) || BALANCE.matchMinuteRealMs
      : BALANCE.matchMinuteRealMs,
    estimatedNormalMatchMinutes: (function () {
      var sec = world
        ? parseInt(world.get("match_minute_real_seconds"), 10) || BALANCE.matchMinuteRealSeconds
        : BALANCE.matchMinuteRealSeconds;
      return Math.round((90 * sec) / 60);
    })(),
    estimatedEtMinutes: (function () {
      var sec = world
        ? parseInt(world.get("match_minute_real_seconds"), 10) || BALANCE.matchMinuteRealSeconds
        : BALANCE.matchMinuteRealSeconds;
      return Math.round((30 * sec) / 60);
    })(),
    speedAppliesTo: "unstarted_matches",
    nextActionAt: world ? world.get("next_action_at") : null,
    lastRetention: world ? world.get("last_retention_result") : null,
    recentAudit: recent,
    serverTime: new Date().toISOString(),
    serverTimeMs: Date.now(),
    activeRound: (function () {
      try {
        var ws = require(__hooks + "/lib/worldService.js");
        var ar = ws.getActiveRound($app);
        if (!ar) return null;
        return {
          id: ar.id,
          key: ar.get("round_key"),
          label: ar.get("label"),
          status: ar.get("status"),
          scheduledAt: ar.get("scheduled_at"),
          startedAt: ar.get("started_at"),
        };
      } catch (_) {
        return null;
      }
    })(),
  };
}

function listParam(v, def, max, msg) {
  if (v == null || v === "") return def;
  var s = String(v);
  if (!/^\d{1,7}$/.test(s)) throw new BadRequestError(msg);
  var n = parseInt(s, 10);
  if (n < 1 || n > max) throw new BadRequestError(msg);
  return n;
}

/**
 * One page of users, newest first (review B19). q is a literal substring of
 * email, display name or id: LIKE with an explicit ESCAPE, because PB filter `~`
 * and $dbx.like treat % _ \ specially on SQLite. Case folding is ASCII-only
 * (SQLite LIKE); the old in-memory filter also folded other letters.
 */
function listUsers($app, q, page, perPage) {
  q = q == null ? "" : String(q).trim();
  if (q.length > 254) throw new BadRequestError("Search query is too long");
  page = listParam(page, 1, 999999, "Page must be a whole number from 1");
  perPage = listParam(perPage, 200, 200, "Page size must be a whole number from 1 to 200");
  var exp = null;
  if (q) {
    exp = $dbx.exp(
      "(email LIKE {:p} ESCAPE '\\' OR display_name LIKE {:p} ESCAPE '\\' OR id LIKE {:p} ESCAPE '\\')",
      { p: "%" + q.replace(/[\\%_]/g, "\\$&") + "%" }
    );
  }
  var query = $app.recordQuery("users");
  if (exp) query = query.andWhere(exp);
  var rows = arrayOf(new Record());
  query
    .orderBy("created DESC", "id ASC")
    .limit(perPage + 1)
    .offset((page - 1) * perPage)
    .all(rows);
  var hasMore = rows.length > perPage;
  var count = hasMore ? perPage : rows.length;
  // One team lookup for the whole page instead of one per user
  var teamOf = {};
  if (count) {
    var marks = [];
    var params = {};
    for (var m = 0; m < count; m++) {
      params["u" + m] = rows[m].id;
      marks.push("{:u" + m + "}");
    }
    var teams = arrayOf(new Record());
    $app
      .recordQuery("proball_teams")
      .andWhere($dbx.exp("manager IN (" + marks.join(",") + ")", params))
      .all(teams);
    for (var t = 0; t < teams.length; t++) {
      teamOf[teams[t].get("manager")] = { id: teams[t].id, name: teams[t].get("name") };
    }
  }
  var out = [];
  for (var i = 0; i < count; i++) {
    var u = rows[i];
    out.push({
      id: u.id,
      email: u.get("email"),
      display_name: u.get("display_name"),
      role: u.get("role") || "user",
      credits: u.get("credits") || 0,
      disabled: !!u.get("disabled"),
      admin_note: u.get("admin_note") || "",
      team: teamOf[u.id] || null,
      created: u.get("created"),
    });
  }
  // Same predicate as the page; a separate read, so the pager follows hasMore
  var totalItems = exp ? $app.countRecords("users", exp) : $app.countRecords("users");
  return { users: out, page: page, perPage: perPage, totalItems: totalItems, hasMore: hasMore };
}

/** Validates everything before any write (review B19). */
function createUser($app, adminId, body) {
  body = body || {};
  var email = typeof body.email === "string" ? body.email.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestError("Valid email required");
  }
  var password = body.password;
  if (typeof password !== "string" || password.length < 8) {
    throw new BadRequestError("Password must be at least 8 characters");
  }
  var role = body.role == null ? "user" : body.role;
  if (role !== "user" && role !== "admin") {
    throw new BadRequestError("Role must be user or admin");
  }
  var name = body.display_name;
  if (name == null || name === "") {
    name = chars(email.split("@")[0]).slice(0, 40).join("");
  } else if (typeof name !== "string" || chars(name).length > 40) {
    throw new BadRequestError("Display name must be 1 to 40 characters");
  }
  // Only an omitted value takes the default; null is not a credit amount.
  var credits = body.credits === undefined ? BALANCE.startingCredits : body.credits;
  if (
    typeof credits !== "number" ||
    !isFinite(credits) ||
    Math.floor(credits) !== credits ||
    credits < 0 ||
    credits > 9007199254740991
  ) {
    throw new BadRequestError("Credits must be a whole number of 0 or more");
  }
  var rec;
  $app.runInTransaction(function (txApp) {
    var existing = null;
    try {
      existing = txApp.findAuthRecordByEmail("users", email);
    } catch (err) {
      if (String((err && err.message) || err).indexOf("no rows in result set") < 0) throw err;
    }
    if (existing) throw new BadRequestError("Email already in use");
    rec = new Record(txApp.findCollectionByNameOrId("users"));
    rec.set("email", email);
    rec.set("password", password);
    rec.set("passwordConfirm", password);
    rec.set("display_name", name);
    rec.set("role", role);
    rec.set("credits", credits);
    rec.set("disabled", false);
    txApp.save(rec);
  });
  audit($app, adminId, "user_create", "users", rec.id, null, { email: email }, body.reason || "create", true);
  return { id: rec.id, email: rec.get("email") };
}

function rotateTokenKey(u) {
  // Fail closed (review F3): never save an account-state change whose token
  // revocation silently failed — that would leave old tokens valid.
  if (typeof u.refreshTokenKey === "function") {
    u.refreshTokenKey();
    return;
  }
  if (typeof $security !== "undefined" && $security.randomString) {
    u.set("tokenKey", $security.randomString(50));
    return;
  }
  throw new Error("token rotation unavailable");
}

/**
 * One transaction with fresh actor, target and admin-count reads: SQLite
 * serialises writers, so two admins disabling each other cannot leave none.
 */
function setUserDisabled($app, adminId, userId, disabled, reason) {
  var before = false;
  $app.runInTransaction(function (txApp) {
    requireFreshAdmin(txApp, adminId);
    var u = txApp.findRecordById("users", userId);
    before = !!u.get("disabled");
    if (disabled) {
      if (u.id === adminId) throw new BadRequestError("You cannot disable your own account");
      if (!before && u.get("role") === "admin" && activeAdminCount(txApp) <= 1) {
        throw new BadRequestError("Cannot disable the last active admin");
      }
    }
    u.set("disabled", !!disabled);
    if (disabled && !before) {
      // Revoke outstanding auth tokens: PB validates tokens against tokenKey (review B2)
      rotateTokenKey(u);
    }
    txApp.save(u);
  });
  audit(
    $app,
    adminId,
    disabled ? "user_disable" : "user_enable",
    "users",
    userId,
    { disabled: before },
    { disabled: !!disabled },
    reason,
    true,
  );
  return { ok: true, disabled: !!disabled };
}

/**
 * Release and delete commit together or not at all. Audit actors and coaching
 * users are required, non-cascading references, so PB would refuse the delete:
 * say so up front. Bets, ledger, Command Charge and scans still cascade.
 */
function deleteUser($app, adminId, userId, reason) {
  var email = "";
  $app.runInTransaction(function (txApp) {
    requireFreshAdmin(txApp, adminId);
    var u = txApp.findRecordById("users", userId);
    if (u.id === adminId) throw new BadRequestError("You cannot delete your own account");
    if (u.get("role") === "admin" && !u.get("disabled") && activeAdminCount(txApp) <= 1) {
      throw new BadRequestError("Cannot delete the last active admin");
    }
    if (
      txApp.countRecords("admin_audit_logs", $dbx.hashExp({ admin: u.id })) > 0 ||
      txApp.countRecords("coaching_commands", $dbx.hashExp({ user: u.id })) > 0
    ) {
      throw new BadRequestError("User has audit or coaching history; disable the account instead");
    }
    email = u.get("email");
    var tr = txApp.findRecordsByFilter(
      "proball_teams",
      "manager = {:u}",
      "",
      1,
      0,
      { u: u.id },
    );
    if (tr && tr.length) {
      tr[0].set("manager", "");
      txApp.save(tr[0]);
    }
    txApp.delete(u);
  });
  audit($app, adminId, "user_delete", "users", userId, { email: email }, null, reason, true);
  return { ok: true };
}

/**
 * Admin password reset — never logs password; invalidates sessions via tokenKey.
 */
function resetUserPassword($app, adminId, userId, password, opts) {
  opts = opts || {};
  if (!password || String(password).length < 8) {
    throw new BadRequestError("Password must be at least 8 characters");
  }
  if (!opts.reason) throw new BadRequestError("Reason required");
  var u = $app.findRecordById("users", userId);
  u.set("password", password);
  u.set("passwordConfirm", password);
  if (opts.mustChange) u.set("must_change_password", true);
  else u.set("must_change_password", false);
  // Invalidate existing auth tokens (fail closed — review F3)
  rotateTokenKey(u);
  $app.save(u);
  audit(
    $app,
    adminId,
    "password_reset",
    "users",
    userId,
    null,
    { must_change_password: !!opts.mustChange },
    opts.reason,
    true,
  );
  // Do not return password
  return { ok: true, must_change_password: !!opts.mustChange };
}

function adjustCredits($app, adminId, userId, mode, amount, reason) {
  amount = parseInt(amount, 10);
  if (!amount || amount < 0) throw new BadRequestError("Invalid amount");
  if (!reason) throw new BadRequestError("Reason required");
  var before = 0;
  var after = 0;
  $app.runInTransaction(function (txApp) {
    var u = txApp.findRecordById("users", userId);
    before = u.get("credits") || 0;
    if (mode === "set") after = amount;
    else if (mode === "add") after = before + amount;
    else if (mode === "remove") after = before - amount;
    else throw new BadRequestError("mode must be set|add|remove");
    if (after < 0) throw new BadRequestError("Balance cannot be negative");
    // Same balance+ledger write as betting (balance_after, unique key); a ledger
    // failure rolls the adjustment back instead of leaving an unledgered balance.
    if (!betMod.credit(txApp, userId, after - before, "admin_adjust", "Admin: " + reason, "admin_cred:" + userId + ":" + Date.now() + ":" + uniq())) {
      throw new Error("Duplicate admin adjustment key");
    }
  });
  audit(
    $app,
    adminId,
    "credits_adjust",
    "users",
    userId,
    { credits: before },
    { credits: after },
    reason,
    true,
  );
  return { ok: true, before: before, after: after };
}

function adjustTreasury($app, adminId, teamId, mode, amount, reason) {
  amount = parseInt(amount, 10);
  if (!amount || amount < 0) throw new BadRequestError("Invalid amount");
  if (!reason) throw new BadRequestError("Reason required");
  var before = 0;
  var after = 0;
  $app.runInTransaction(function (txApp) {
    var t = txApp.findRecordById("proball_teams", teamId);
    before = t.get("treasury") != null ? t.get("treasury") : BALANCE.startingTreasury;
    if (mode === "set") after = amount;
    else if (mode === "add") after = before + amount;
    else if (mode === "remove") after = before - amount;
    else throw new BadRequestError("mode must be set|add|remove");
    if (after < 0) throw new BadRequestError("Treasury cannot be negative");
    // Same treasury+ledger write as rewards and purchases; a ledger failure rolls
    // the adjustment back instead of leaving an unledgered treasury change.
    mgmtMod.adjustTreasury(txApp, t, after - before, "admin_adjust", "Admin: " + reason, {
      idempotency_key: "admin_tre:" + teamId + ":" + Date.now() + ":" + uniq(),
    });
  });
  audit(
    $app,
    adminId,
    "treasury_adjust",
    "proball_teams",
    teamId,
    { treasury: before },
    { treasury: after },
    reason,
    true,
  );
  return { ok: true, before: before, after: after };
}

/** Assigns an existing, enabled user; releasing is releaseTeam only (review B19). */
function assignTeam($app, adminId, teamId, userId, reason) {
  if (typeof userId !== "string" || !userId.trim()) {
    throw new BadRequestError("User ID required");
  }
  $app.runInTransaction(function (txApp) {
    var team = txApp.findRecordById("proball_teams", teamId);
    var users = txApp.findRecordsByFilter("users", "id = {:id}", "", 1, 0, { id: userId });
    if (!users || !users.length) throw new BadRequestError("User not found");
    if (users[0].get("disabled")) throw new BadRequestError("Cannot assign a disabled user");
    var other = txApp.findRecordsByFilter(
      "proball_teams",
      "manager = {:u}",
      "",
      1,
      0,
      { u: userId },
    );
    if (other && other.length && other[0].id !== teamId) {
      throw new BadRequestError("User already manages a team");
    }
    if (team.get("manager") && team.get("manager") !== userId) {
      throw new BadRequestError("Team already has a manager — release first");
    }
    // A new manager starts in manual mode, as on claim; re-assigning keeps it
    if (!team.get("manager")) team.set("manager_mode", "manual");
    team.set("manager", userId);
    txApp.save(team);
  });
  audit($app, adminId, "team_assign", "proball_teams", teamId, null, { manager: userId }, reason, true);
  return { ok: true };
}

function releaseTeam($app, adminId, teamId, reason) {
  $app.runInTransaction(function (txApp) {
    var team = txApp.findRecordById("proball_teams", teamId);
    team.set("manager", "");
    txApp.save(team);
  });
  audit($app, adminId, "team_release", "proball_teams", teamId, null, { manager: null }, reason, true);
  return { ok: true };
}

function resetTeamOps($app, adminId, teamId, mode, reason) {
  var team = $app.findRecordById("proball_teams", teamId);
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "",
    20,
    0,
    { t: teamId },
  );
  var before = { treasury: team.get("treasury"), batteries: team.get("battery_count") };

  if (mode === "energy" || mode === "full") {
    for (var i = 0; i < players.length; i++) {
      players[i].set("energy", 100);
      players[i].set("energy_updated_at", toPbDate(new Date()));
      $app.save(players[i]);
    }
  }
  if (mode === "condition" || mode === "full") {
    for (var c = 0; c < players.length; c++) {
      players[c].set("condition", 100);
      $app.save(players[c]);
    }
  }
  if (mode === "lineup" || mode === "full") {
    // leave as-is structure; re-mark first 5 starters via default is hard — set balanced intensity
    for (var p = 0; p < players.length; p++) {
      players[p].set("intensity", "balanced");
      $app.save(players[p]);
    }
  }
  if (mode === "treasury" || mode === "full") {
    team.set("treasury", BALANCE.startingTreasury);
  }
  if (mode === "batteries" || mode === "full") {
    team.set("battery_count", 2);
  }
  if (mode === "overclock" || mode === "full") {
    team.set("overclock_ready", false);
    team.set("overclock_cost_pending", false);
    team.set("overclock_fixture", "");
  }
  $app.save(team);
  audit(
    $app,
    adminId,
    "team_reset_" + mode,
    "proball_teams",
    teamId,
    before,
    { treasury: team.get("treasury"), batteries: team.get("battery_count") },
    reason,
    true,
  );
  return { ok: true };
}

function patchWorldSettings($app, adminId, body, reason) {
  var world = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0)[0];
  var before = {
    pace: world.get("pace"),
    retention_days: world.get("retention_days"),
    round_interval_ms: world.get("round_interval_ms"),
    tournament_interval_ms: world.get("tournament_interval_ms"),
    between_round_minutes: world.get("between_round_minutes"),
    match_minute_real_seconds: world.get("match_minute_real_seconds"),
    match_minute_real_ms: world.get("match_minute_real_ms"),
    ai_progression_enabled: world.get("ai_progression_enabled"),
    progression_paused: world.get("progression_paused"),
  };
  if (body.pace) world.set("pace", body.pace);
  if (body.retention_days != null) {
    var d = parseInt(body.retention_days, 10);
    // 0 = never
    if ([0, 7, 30, 90].indexOf(d) < 0) throw new BadRequestError("retention_days 0|7|30|90");
    world.set("retention_days", d);
  }
  if (body.between_round_minutes != null) {
    var mins = parseInt(body.between_round_minutes, 10);
    if (isNaN(mins) || mins < 1 || mins > 1440) {
      throw new BadRequestError("between_round_minutes must be 1–1440");
    }
    world.set("between_round_minutes", mins);
    world.set("round_interval_ms", mins * 60 * 1000);
  }
  if (body.match_minute_real_seconds != null) {
    var sec = parseInt(body.match_minute_real_seconds, 10);
    if (isNaN(sec) || sec < 1 || sec > 60) {
      throw new BadRequestError("match_minute_real_seconds must be 1–60");
    }
    world.set("match_minute_real_seconds", sec);
    world.set("match_minute_real_ms", sec * 1000);
  }
  if (body.round_interval_ms != null && body.between_round_minutes == null) {
    var rms = parseInt(body.round_interval_ms, 10);
    if (isNaN(rms) || rms < 60000) throw new BadRequestError("round_interval_ms min 60000");
    world.set("round_interval_ms", rms);
    world.set("between_round_minutes", Math.max(1, Math.round(rms / 60000)));
  }
  if (body.tournament_interval_ms != null)
    world.set("tournament_interval_ms", parseInt(body.tournament_interval_ms, 10));
  if (body.championship_gap_minutes != null || body.fixtures_window_minutes != null) {
    var gap = parseInt(body.championship_gap_minutes != null ? body.championship_gap_minutes : world.get("championship_gap_minutes") || 10, 10);
    var win = parseInt(body.fixtures_window_minutes != null ? body.fixtures_window_minutes : world.get("fixtures_window_minutes") || 5, 10);
    if (isNaN(gap) || gap < 1 || gap > 1440) throw new BadRequestError("championship_gap_minutes must be 1–1440");
    if (isNaN(win) || win < 1 || win > 1440) throw new BadRequestError("fixtures_window_minutes must be 1–1440");
    if (win > gap) throw new BadRequestError("The fixture window cannot be longer than the gap between championships");
    world.set("championship_gap_minutes", gap);
    world.set("fixtures_window_minutes", win);
  }
  if (body.ai_progression_enabled != null)
    world.set("ai_progression_enabled", !!body.ai_progression_enabled);
  if (body.progression_paused != null)
    world.set("progression_paused", !!body.progression_paused);
  $app.save(world);
  // Do not echo secrets; body may contain only settings
  var safeBody = {};
  for (var k in body) {
    if (Object.prototype.hasOwnProperty.call(body, k) && k.indexOf("password") < 0) {
      safeBody[k] = body[k];
    }
  }
  audit($app, adminId, "world_settings", "world", world.id, before, safeBody, reason, true);
  return {
    ok: true,
    between_round_minutes: world.get("between_round_minutes"),
    round_interval_ms: world.get("round_interval_ms"),
    match_minute_real_seconds: world.get("match_minute_real_seconds"),
    match_minute_real_ms: world.get("match_minute_real_ms"),
    championship_gap_minutes: world.get("championship_gap_minutes"),
    fixtures_window_minutes: world.get("fixtures_window_minutes"),
    applies_to: "unstarted_matches",
    note: "Live matches keep their kick-off speed; new breaks use the new values.",
  };
}

function listAudit($app, filters) {
  filters = filters || {};
  var rows = $app.findRecordsByFilter(
    "admin_audit_logs",
    "id != ''",
    "-created",
    100,
    0,
  );
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (filters.action && r.get("action") !== filters.action) continue;
    out.push({
      id: r.id,
      admin: r.get("admin"),
      action: r.get("action"),
      target_type: r.get("target_type"),
      target_id: r.get("target_id"),
      meta: r.get("meta"),
      created: r.get("created"),
    });
  }
  return out;
}

if (typeof module !== "undefined") {
  module.exports = {
    requireAdmin: requireAdmin,
    overview: overview,
    listUsers: listUsers,
    createUser: createUser,
    setUserDisabled: setUserDisabled,
    deleteUser: deleteUser,
    resetUserPassword: resetUserPassword,
    adjustCredits: adjustCredits,
    adjustTreasury: adjustTreasury,
    assignTeam: assignTeam,
    releaseTeam: releaseTeam,
    resetTeamOps: resetTeamOps,
    patchWorldSettings: patchWorldSettings,
    listAudit: listAudit,
    audit: audit,
  };
}
