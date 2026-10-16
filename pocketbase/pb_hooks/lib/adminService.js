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

function overview($app) {
  var users = $app.findRecordsByFilter("users", "id != ''", "", 500, 0);
  var teams = $app.findRecordsByFilter("proball_teams", "id != ''", "", 20, 0);
  var managed = 0;
  for (var i = 0; i < teams.length; i++) {
    if (teams[i].get("manager")) managed++;
  }
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
    liveFx = $app.findRecordsByFilter(
      "shared_fixtures",
      'status = "live"',
      "",
      50,
      0,
    ).length;
  } catch (_) {}
  var eventStates = 0;
  try {
    eventStates = $app.findRecordsByFilter(
      "match_states",
      "id != ''",
      "",
      500,
      0,
    ).length;
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
    users: (users || []).length,
    managedTeams: managed,
    availableTeams: 16 - managed,
    spectators: Math.max(0, (users || []).length - managed),
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

function listUsers($app, q) {
  var rows = $app.findRecordsByFilter("users", "id != ''", "-created", 200, 0);
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var u = rows[i];
    if (q) {
      var hay =
        (u.get("email") || "") +
        " " +
        (u.get("display_name") || "") +
        " " +
        u.id;
      if (hay.toLowerCase().indexOf(String(q).toLowerCase()) < 0) continue;
    }
    var team = null;
    try {
      var tr = $app.findRecordsByFilter(
        "proball_teams",
        "manager = {:u}",
        "",
        1,
        0,
        { u: u.id },
      );
      if (tr && tr.length) team = { id: tr[0].id, name: tr[0].get("name") };
    } catch (_) {}
    out.push({
      id: u.id,
      email: u.get("email"),
      display_name: u.get("display_name"),
      role: u.get("role") || "user",
      credits: u.get("credits") || 0,
      disabled: !!u.get("disabled"),
      admin_note: u.get("admin_note") || "",
      team: team,
      created: u.get("created"),
    });
  }
  return out;
}

function createUser($app, adminId, body) {
  var col = $app.findCollectionByNameOrId("users");
  var rec = new Record(col);
  rec.set("email", body.email);
  rec.set("password", body.password);
  rec.set("passwordConfirm", body.password);
  rec.set("display_name", body.display_name || body.email.split("@")[0]);
  rec.set("role", body.role === "admin" ? "admin" : "user");
  rec.set("credits", body.credits != null ? body.credits : BALANCE.startingCredits);
  rec.set("disabled", false);
  $app.save(rec);
  audit($app, adminId, "user_create", "users", rec.id, null, { email: body.email }, body.reason || "create", true);
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

function setUserDisabled($app, adminId, userId, disabled, reason) {
  var u = $app.findRecordById("users", userId);
  var before = !!u.get("disabled");
  u.set("disabled", !!disabled);
  if (disabled && !before) {
    // Revoke outstanding auth tokens: PB validates tokens against tokenKey (review B2)
    rotateTokenKey(u);
  }
  $app.save(u);
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

function deleteUser($app, adminId, userId, reason) {
  var u = $app.findRecordById("users", userId);
  var email = u.get("email");
  // release team
  try {
    var tr = $app.findRecordsByFilter(
      "proball_teams",
      "manager = {:u}",
      "",
      1,
      0,
      { u: userId },
    );
    if (tr && tr.length) {
      tr[0].set("manager", "");
      $app.save(tr[0]);
    }
  } catch (_) {}
  $app.delete(u);
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

function assignTeam($app, adminId, teamId, userId, reason) {
  $app.runInTransaction(function (txApp) {
    var team = txApp.findRecordById("proball_teams", teamId);
    if (userId) {
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
      team.set("manager", userId);
    } else {
      team.set("manager", "");
    }
    txApp.save(team);
  });
  audit(
    $app,
    adminId,
    userId ? "team_assign" : "team_release",
    "proball_teams",
    teamId,
    null,
    { manager: userId || null },
    reason,
    true,
  );
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
    resetTeamOps: resetTeamOps,
    patchWorldSettings: patchWorldSettings,
    listAudit: listAudit,
    audit: audit,
  };
}
