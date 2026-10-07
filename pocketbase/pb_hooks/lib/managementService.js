/**
 * Squad management, team treasury, Command Charge, shop.
 */
var balMod, effMod, tourneyMod;
try {
  balMod = require(__hooks + "/lib/balance.js");
  effMod = require(__hooks + "/lib/effectiveStats.js");
  tourneyMod = require(__hooks + "/lib/tournament.js");
} catch (e) {
  balMod = require("./balance.js");
  effMod = require("./effectiveStats.js");
  tourneyMod = require("./tournament.js");
}

var BALANCE = balMod.BALANCE;
var getTiming = balMod.getTiming;
var upgradeCost = balMod.upgradeCost;
var repairCost = balMod.repairCost;
var effectivePlayerStats = effMod.effectivePlayerStats;
var effectiveTeamStrength = effMod.effectiveTeamStrength;
var materialiseEnergy = effMod.materialiseEnergy;
var materialiseCommandCharge = effMod.materialiseCommandCharge;
var clamp = effMod.clamp;
var defaultStarters = tourneyMod.defaultStarters;

function toPbDate(d) {
  var x = d instanceof Date ? d : new Date(d);
  return x.toISOString().replace("T", " ").replace("Z", "") + "Z";
}

function parsePbDate(v) {
  if (v == null || v === "") return NaN;
  if (Object.prototype.toString.call(v) === "[object Date]") return v.getTime();
  var s = String(v).trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  return new Date(s).getTime();
}

function requireManagerTeam($app, userId) {
  var rows = $app.findRecordsByFilter(
    "proball_teams",
    "manager = {:u}",
    "",
    1,
    0,
    { u: userId },
  );
  if (!rows || !rows.length) throw new ForbiddenError("You do not manage a team");
  return rows[0];
}

/**
 * Management is always open. Live matches use the lineup frozen at their kick-off,
 * so squad changes, repairs and upgrades take effect from the team's next kick-off.
 */

/** Message describing when a change takes effect for this team. */
function effectNote($app, teamId) {
  try {
    var live = $app.findRecordsByFilter(
      "shared_fixtures",
      'status = "live" && (home_team = {:t} || away_team = {:t})',
      "",
      1,
      0,
      { t: teamId },
    );
    if (live && live.length) return "Saved — applies from your next kick-off (the current match keeps its starting setup).";
  } catch (_) {}
  return "Saved — applies from your next kick-off.";
}

function writeTeamLedger($app, teamId, amount, type, description, balanceAfter, meta) {
  meta = meta || {};
  var key = meta.idempotency_key;
  if (!key) key = teamId + ":" + type + ":" + Date.now() + ":" + Math.random();
  try {
    var existing = $app.findRecordsByFilter(
      "team_finance_ledger",
      "idempotency_key = {:k}",
      "",
      1,
      0,
      { k: key },
    );
    if (existing && existing.length) return existing[0];
  } catch (_) {}

  var col = $app.findCollectionByNameOrId("team_finance_ledger");
  var rec = new Record(col);
  rec.set("team", teamId);
  rec.set("amount", amount);
  rec.set("type", type);
  rec.set("description", description || type);
  rec.set("balance_after", balanceAfter);
  rec.set("tournament_id", meta.tournament_id || "");
  rec.set("fixture_id", meta.fixture_id || "");
  rec.set("player_id", meta.player_id || "");
  rec.set("idempotency_key", key);
  $app.save(rec);
  return rec;
}

function adjustTreasury($app, team, delta, type, description, meta) {
  var bal = team.get("treasury");
  if (bal == null || bal === "") bal = BALANCE.startingTreasury;
  bal = parseInt(bal, 10) || 0;
  var next = bal + delta;
  if (next < 0) throw new BadRequestError("Insufficient team treasury");
  team.set("treasury", next);
  $app.save(team);
  writeTeamLedger($app, team.id, delta, type, description, next, meta);
  return next;
}

function getPace($app) {
  try {
    var rows = $app.findRecordsByFilter("world", "key = 'main'", "", 1, 0);
    if (rows && rows.length) return rows[0].get("pace") || "dev";
  } catch (_) {}
  return "dev";
}

function materialisePlayerEnergy($app, playerRec, pace) {
  var timing = getTiming(pace || getPace($app));
  var now = Date.now();
  var last = parsePbDate(playerRec.get("energy_updated_at"));
  var stored = playerRec.get("energy");
  if (stored == null) stored = 100;
  var energy = materialiseEnergy(stored, last, now, timing.energyRegenPerHour);
  if (energy !== stored || isNaN(last)) {
    playerRec.set("energy", Math.round(energy));
    playerRec.set("energy_updated_at", toPbDate(now));
    $app.save(playerRec);
  }
  return Math.round(energy);
}

function ensureCommandCharge($app, userId) {
  var rows = $app.findRecordsByFilter(
    "command_charge",
    "user = {:u}",
    "",
    1,
    0,
    { u: userId },
  );
  if (rows && rows.length) return rows[0];
  var col = $app.findCollectionByNameOrId("command_charge");
  var rec = new Record(col);
  rec.set("user", userId);
  rec.set("points", BALANCE.commandChargeMax);
  rec.set("last_regen_at", toPbDate(Date.now()));
  $app.save(rec);
  return rec;
}

function getCommandChargeState($app, userId) {
  var rec = ensureCommandCharge($app, userId);
  var timing = getTiming(getPace($app));
  var now = Date.now();
  var last = parsePbDate(rec.get("last_regen_at"));
  var mat = materialiseCommandCharge(
    rec.get("points"),
    last,
    now,
    timing.commandChargeRegenMs,
    BALANCE.commandChargeMax,
  );
  if (mat.points !== rec.get("points")) {
    rec.set("points", mat.points);
    rec.set("last_regen_at", toPbDate(mat.lastAt));
    $app.save(rec);
  }
  var nextIn = 0;
  if (mat.points < BALANCE.commandChargeMax) {
    var elapsed = now - mat.lastAt;
    nextIn = Math.max(0, timing.commandChargeRegenMs - (elapsed % timing.commandChargeRegenMs));
  }
  return {
    points: mat.points,
    max: BALANCE.commandChargeMax,
    nextPointInMs: nextIn,
    lastRegenAt: rec.get("last_regen_at"),
  };
}

function spendCommandCharge($app, userId, cost) {
  var rec = ensureCommandCharge($app, userId);
  var timing = getTiming(getPace($app));
  var now = Date.now();
  var last = parsePbDate(rec.get("last_regen_at"));
  var mat = materialiseCommandCharge(
    rec.get("points"),
    last,
    now,
    timing.commandChargeRegenMs,
    BALANCE.commandChargeMax,
  );
  if (mat.points < cost) throw new BadRequestError("Insufficient Command Charge");
  rec.set("points", mat.points - cost);
  rec.set("last_regen_at", toPbDate(mat.lastAt));
  $app.save(rec);
  return rec.get("points");
}

function playerPublic($app, p, coachingStance, overclock) {
  var energy = materialisePlayerEnergy($app, p);
  var condition = p.get("condition");
  if (condition == null) condition = 100;
  var snap = {
    id: p.id,
    name: p.get("name"),
    role: p.get("role"),
    attack: p.get("attack"),
    defence: p.get("defence"),
    energy: energy,
    condition: condition,
    intensity: p.get("intensity") || "balanced",
    is_starter: !!p.get("is_starter"),
    sort_order: p.get("sort_order") || 0,
  };
  var eff = effectivePlayerStats(snap, {
    coachingStance: coachingStance || "balanced",
    overclock: !!overclock,
  });
  snap.effective_attack = eff.attack;
  snap.effective_defence = eff.defence;
  snap.upgrade_cost = { attack: upgradeCost(snap.attack), defence: upgradeCost(snap.defence) };
  return snap;
}

function getSquad($app, userId) {
  var team = requireManagerTeam($app, userId);
  var pace = getPace($app);
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "sort_order",
    20,
    0,
    { t: team.id },
  );
  var overclock = !!team.get("overclock_ready");
  var list = [];
  var energySum = 0;
  var condSum = 0;
  for (var i = 0; i < players.length; i++) {
    var pub = playerPublic($app, players[i], "balanced", overclock);
    list.push(pub);
    energySum += pub.energy;
    condSum += pub.condition;
  }
  var n = Math.max(list.length, 1);
  var treasury = team.get("treasury");
  if (treasury == null) treasury = BALANCE.startingTreasury;

  return {
    team: {
      id: team.id,
      name: team.get("name"),
      abbreviation: team.get("abbreviation") || "",
      grade: team.get("grade"),
      treasury: treasury,
      battery_count: team.get("battery_count") || 0,
      overclock_ready: overclock,
      eliminated: !!team.get("eliminated"),
      primary_color: team.get("primary_color"),
      secondary_color: team.get("secondary_color"),
      badge_key: team.get("badge_key"),
      mode: team.get("manager_mode") || "manual",
      default_stance: team.get("default_stance") || "balanced",
    },
    players: list,
    averages: {
      energy: Math.round(energySum / n),
      condition: Math.round(condSum / n),
    },
    managementOpen: true,
    effectNote: effectNote($app, team.id),
    batteryCost: BALANCE.batteryCost,
    repairCostPerPoint: BALANCE.repairCostPerPoint,
    aiRules: AI_RULES,
  };
}

var AI_RULES = [
  "Picks the five fittest players (always one goalkeeper) for each kick-off.",
  "Uses a battery on any starter below 40% energy, and buys one when the treasury is above " + (BALANCE.batteryCost + 500) + ".",
  "Repairs the most worn player (below 55% condition) when affordable.",
  "Switches to Attack when behind late on and Defend when protecting a one-goal lead.",
  "Never touches your personal betting credits and never upgrades players.",
];

/** Set manager mode: "manual" (My settings) or "ai" (Full AI). Saved setup is untouched. */
function setMode($app, userId, mode) {
  if (mode !== "manual" && mode !== "ai") throw new BadRequestError("Mode must be manual or ai");
  var team = requireManagerTeam($app, userId);
  team.set("manager_mode", mode);
  $app.save(team);
  return { ok: true, mode: mode, note: effectNote($app, team.id) };
}

/** Default stance for kick-off in My settings mode. */
function setDefaultStance($app, userId, stance) {
  if (["defend", "balanced", "attack"].indexOf(stance) < 0) throw new BadRequestError("Invalid stance");
  var team = requireManagerTeam($app, userId);
  team.set("default_stance", stance);
  $app.save(team);
  return { ok: true, stance: stance, note: effectNote($app, team.id) };
}

/** Five fittest (one goalkeeper) without mutating the saved lineup. */
function aiLineup(players) {
  var list = (players || []).map(function (p) {
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      attack: p.attack,
      defence: p.defence,
      energy: p.energy,
      condition: p.condition,
      intensity: "balanced",
      is_starter: false,
      sort_order: p.sort_order,
    };
  });
  function fit(p) {
    return ((p.attack + p.defence) / 2) * (0.35 + 0.65 * (p.energy / 100)) * (0.3 + 0.7 * (p.condition / 100));
  }
  var gks = list.filter(function (p) {
    return p.role === "gk";
  });
  gks.sort(function (a, b) {
    return fit(b) - fit(a);
  });
  var field = list.filter(function (p) {
    return p !== gks[0];
  });
  field.sort(function (a, b) {
    return fit(b) - fit(a);
  });
  if (gks[0]) gks[0].is_starter = true;
  for (var i = 0; i < field.length && i < (gks[0] ? 4 : 5); i++) field[i].is_starter = true;
  return list;
}

/** Persist per-player wear from a finished match (delta, so between-match repairs are kept). */
function applyWearDelta($app, players) {
  for (var i = 0; i < (players || []).length; i++) {
    var sp = players[i];
    if (!sp.id || !sp.is_starter) continue;
    try {
      var p = $app.findRecordById("proball_players", sp.id);
      materialisePlayerEnergy($app, p);
      var dE = Math.round((sp.e0 != null ? sp.e0 : 100) - sp.energy);
      var dC = Math.round((sp.c0 != null ? sp.c0 : 100) - sp.condition);
      p.set("energy", clamp((p.get("energy") || 0) - dE, 0, 100));
      p.set("condition", clamp((p.get("condition") || 0) - dC - (sp.sentOff ? BALANCE.conditionOnRed : 0), 0, 100));
      p.set("energy_updated_at", toPbDate(Date.now()));
      $app.save(p);
    } catch (_) {}
  }
}

function setLineup($app, userId, starterIds, subIds) {
  var team = requireManagerTeam($app, userId);
  if (!starterIds || starterIds.length !== 5) {
    throw new BadRequestError("Exactly 5 starters required");
  }
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "sort_order",
    20,
    0,
    { t: team.id },
  );
  var byId = {};
  for (var i = 0; i < players.length; i++) byId[players[i].id] = players[i];
  var hasGk = false;
  for (var s = 0; s < starterIds.length; s++) {
    var pl = byId[starterIds[s]];
    if (!pl) throw new BadRequestError("Invalid starter id");
    if (pl.get("role") === "gk") hasGk = true;
  }
  if (!hasGk) throw new BadRequestError("Starting five must include a goalkeeper");

  // Subs: remaining or explicit
  var subList = subIds && subIds.length ? subIds : [];
  for (var p = 0; p < players.length; p++) {
    var rec = players[p];
    var isSt = starterIds.indexOf(rec.id) >= 0;
    rec.set("is_starter", isSt);
    if (!isSt && subList.length < 2 && subList.indexOf(rec.id) < 0) {
      subList.push(rec.id);
    }
    // sort_order: starters 0-4, subs 5-6
    var order = isSt ? starterIds.indexOf(rec.id) : 5 + Math.max(0, subList.indexOf(rec.id));
    rec.set("sort_order", order);
    $app.save(rec);
  }
  return { ok: true };
}

function setIntensity($app, userId, playerId, intensity) {
  if (["passive", "balanced", "aggressive"].indexOf(intensity) < 0) {
    throw new BadRequestError("Invalid intensity");
  }
  var team = requireManagerTeam($app, userId);
  var player = $app.findRecordById("proball_players", playerId);
  if (player.get("team") !== team.id) throw new ForbiddenError("Not your player");
  player.set("intensity", intensity);
  $app.save(player);
  return { ok: true, intensity: intensity };
}

function upgradePlayer($app, userId, playerId, attribute) {
  if (attribute !== "attack" && attribute !== "defence") {
    throw new BadRequestError("attribute must be attack or defence");
  }
  var team = requireManagerTeam($app, userId);
  var player = $app.findRecordById("proball_players", playerId);
  if (player.get("team") !== team.id) throw new ForbiddenError("Not your player");

  var current = player.get(attribute) || 50;
  if (current >= BALANCE.attrMax) throw new BadRequestError("Attribute already maxed");
  var cost = upgradeCost(current);
  var key = "upgrade:" + playerId + ":" + attribute + ":" + current;

  $app.runInTransaction(function (txApp) {
    var t = txApp.findRecordById("proball_teams", team.id);
    var p = txApp.findRecordById("proball_players", playerId);
    var cur = p.get(attribute) || 50;
    if (cur >= BALANCE.attrMax) throw new BadRequestError("Attribute already maxed");
    var c = upgradeCost(cur);
    var treasury = t.get("treasury");
    if (treasury == null) treasury = BALANCE.startingTreasury;
    if (treasury < c) throw new BadRequestError("Insufficient team treasury");
    t.set("treasury", treasury - c);
    p.set(attribute, cur + 1);
    txApp.save(t);
    txApp.save(p);
    writeTeamLedger(txApp, t.id, -c, "upgrade", attribute + " +1 for " + p.get("name"), treasury - c, {
      idempotency_key: key,
      player_id: playerId,
    });
  });

  return { ok: true, attribute: attribute, cost: cost, newValue: current + 1 };
}

function buyBattery($app, userId, count) {
  count = parseInt(count, 10) || 1;
  if (count < 1 || count > 10) throw new BadRequestError("Invalid count");
  var team = requireManagerTeam($app, userId);
  var cost = BALANCE.batteryCost * count;
  var key = "buybat:" + team.id + ":" + Date.now();

  $app.runInTransaction(function (txApp) {
    var t = txApp.findRecordById("proball_teams", team.id);
    var treasury = t.get("treasury") != null ? t.get("treasury") : BALANCE.startingTreasury;
    if (treasury < cost) throw new BadRequestError("Insufficient team treasury");
    t.set("treasury", treasury - cost);
    t.set("battery_count", (t.get("battery_count") || 0) + count);
    txApp.save(t);
    writeTeamLedger(txApp, t.id, -cost, "battery_buy", "Bought " + count + " battery(ies)", treasury - cost, {
      idempotency_key: key,
    });
  });
  return { ok: true, cost: cost, count: count };
}

function useBattery($app, userId, playerId) {
  var team = requireManagerTeam($app, userId);
  var player = $app.findRecordById("proball_players", playerId);
  if (player.get("team") !== team.id) throw new ForbiddenError("Not your player");

  $app.runInTransaction(function (txApp) {
    var t = txApp.findRecordById("proball_teams", team.id);
    var p = txApp.findRecordById("proball_players", playerId);
    var bats = t.get("battery_count") || 0;
    if (bats < 1) throw new BadRequestError("No batteries in inventory");
    materialisePlayerEnergy(txApp, p);
    var energy = p.get("energy") || 0;
    if (energy >= 100) throw new BadRequestError("Energy already full");
    p.set("energy", clamp(energy + BALANCE.batteryRestore, 0, 100));
    p.set("energy_updated_at", toPbDate(Date.now()));
    t.set("battery_count", bats - 1);
    txApp.save(p);
    txApp.save(t);
  });
  return { ok: true, restored: BALANCE.batteryRestore };
}

function repairPlayer($app, userId, playerId, points) {
  points = parseInt(points, 10);
  if (!points || points < 1) throw new BadRequestError("Invalid repair points");
  var presets = [10, 25, 50, 100];
  if (presets.indexOf(points) < 0 && points !== 100) {
    // allow any 1-100
    if (points > 100) points = 100;
  }
  var team = requireManagerTeam($app, userId);
  var player = $app.findRecordById("proball_players", playerId);
  if (player.get("team") !== team.id) throw new ForbiddenError("Not your player");
  var cost = repairCost(points);

  $app.runInTransaction(function (txApp) {
    var t = txApp.findRecordById("proball_teams", team.id);
    var p = txApp.findRecordById("proball_players", playerId);
    var cond = p.get("condition");
    if (cond == null) cond = 100;
    var need = Math.min(points, 100 - cond);
    if (need <= 0) throw new BadRequestError("Condition already full");
    var c = repairCost(need);
    var treasury = t.get("treasury") != null ? t.get("treasury") : BALANCE.startingTreasury;
    if (treasury < c) throw new BadRequestError("Insufficient team treasury");
    t.set("treasury", treasury - c);
    p.set("condition", cond + need);
    txApp.save(t);
    txApp.save(p);
    writeTeamLedger(txApp, t.id, -c, "repair", "Repair +" + need + " for " + p.get("name"), treasury - c, {
      idempotency_key: "repair:" + playerId + ":" + Date.now(),
      player_id: playerId,
    });
  });
  return { ok: true, points: points, cost: cost };
}

function commandChargeSpend($app, userId, action, playerId, fixtureId) {
  var team = requireManagerTeam($app, userId);
  var costs = BALANCE.commandChargeCosts;
  if (!costs[action]) throw new BadRequestError("Unknown action");
  var cost = costs[action];

  if (action === "rapid_charge" || action === "field_repair") {
    if (!playerId) throw new BadRequestError("playerId required");
    var player = $app.findRecordById("proball_players", playerId);
    if (player.get("team") !== team.id) throw new ForbiddenError("Not your player");
  }

  spendCommandCharge($app, userId, cost);

  if (action === "rapid_charge") {
    materialisePlayerEnergy($app, player);
    var e = player.get("energy") || 0;
    player.set("energy", clamp(e + BALANCE.rapidChargeEnergy, 0, 100));
    player.set("energy_updated_at", toPbDate(Date.now()));
    $app.save(player);
    return { ok: true, action: action, energy: player.get("energy") };
  }

  if (action === "field_repair") {
    var c = player.get("condition");
    if (c == null) c = 100;
    player.set("condition", clamp(c + BALANCE.fieldRepairCondition, 0, 100));
    $app.save(player);
    return { ok: true, action: action, condition: player.get("condition") };
  }

  if (action === "tactical_scan") {
    // Find next opponent fixture
    var fxId = fixtureId;
    if (!fxId) {
      var next = findNextManagedFixture($app, team.id);
      if (!next) throw new BadRequestError("No upcoming fixture to scan");
      fxId = next.id;
    }
    var fx = $app.findRecordById("shared_fixtures", fxId);
    var oppId =
      fx.get("home_team") === team.id ? fx.get("away_team") : fx.get("home_team");
    if (oppId !== fx.get("home_team") && oppId !== fx.get("away_team")) {
      throw new BadRequestError("Fixture does not involve your team");
    }
    if (fx.get("home_team") !== team.id && fx.get("away_team") !== team.id) {
      throw new BadRequestError("Fixture does not involve your team");
    }
    var report = buildTacticalScan($app, oppId);
    var col = $app.findCollectionByNameOrId("tactical_scans");
    var scan = new Record(col);
    scan.set("user", userId);
    scan.set("team", team.id);
    scan.set("fixture_id", fxId);
    scan.set("report_json", report);
    scan.set("consumed", false);
    $app.save(scan);
    return { ok: true, action: action, report: report, fixtureId: fxId };
  }

  if (action === "overclock") {
    // Apply energy cost to starters + flag
    var players = $app.findRecordsByFilter(
      "proball_players",
      "team = {:t} && is_starter = true",
      "",
      10,
      0,
      { t: team.id },
    );
    for (var i = 0; i < players.length; i++) {
      materialisePlayerEnergy($app, players[i]);
      var en = players[i].get("energy") || 0;
      players[i].set("energy", clamp(en - BALANCE.overclockEnergyCost, 0, 100));
      players[i].set("energy_updated_at", toPbDate(Date.now()));
      $app.save(players[i]);
    }
    team.set("overclock_ready", true);
    team.set("overclock_fixture", "");
    $app.save(team);
    return { ok: true, action: action, bonus: BALANCE.overclockBonus };
  }

  throw new BadRequestError("Unknown action");
}

function findNextManagedFixture($app, teamId) {
  var rows = $app.findRecordsByFilter(
    "shared_fixtures",
    'status = "scheduled" && (home_team = {:t} || away_team = {:t})',
    "scheduled_at",
    1,
    0,
    { t: teamId },
  );
  return rows && rows.length ? rows[0] : null;
}

function buildTacticalScan($app, oppTeamId) {
  var team = $app.findRecordById("proball_teams", oppTeamId);
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "sort_order",
    20,
    0,
    { t: oppTeamId },
  );
  var list = [];
  var eMin = 100;
  var eMax = 0;
  var cMin = 100;
  var cMax = 0;
  for (var i = 0; i < players.length; i++) {
    if (!players[i].get("is_starter")) continue;
    var e = materialisePlayerEnergy($app, players[i]);
    var c = players[i].get("condition");
    if (c == null) c = 100;
    list.push({
      attack: players[i].get("attack"),
      defence: players[i].get("defence"),
      role: players[i].get("role"),
      energy: e,
      condition: c,
      intensity: players[i].get("intensity") || "balanced",
      is_starter: true,
    });
    eMin = Math.min(eMin, e);
    eMax = Math.max(eMax, e);
    cMin = Math.min(cMin, c);
    cMax = Math.max(cMax, c);
  }
  var str = effectiveTeamStrength(list, { grade: team.get("grade"), coachingStance: "balanced" });
  return {
    teamName: team.get("name"),
    grade: team.get("grade"),
    approxAttack: Math.round(str.attack),
    approxDefence: Math.round(str.defence),
    energyRange: [eMin, eMax],
    conditionRange: [cMin, cMax],
    confidence: "medium",
  };
}

function teamFinances($app, userId, limit) {
  var team = requireManagerTeam($app, userId);
  limit = limit || 30;
  var rows = $app.findRecordsByFilter(
    "team_finance_ledger",
    "team = {:t}",
    "-created",
    limit,
    0,
    { t: team.id },
  );
  var list = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    list.push({
      id: r.id,
      amount: r.get("amount"),
      type: r.get("type"),
      description: r.get("description"),
      balance_after: r.get("balance_after"),
      created: r.get("created"),
    });
  }
  return {
    treasury: team.get("treasury") != null ? team.get("treasury") : BALANCE.startingTreasury,
    entries: list,
  };
}

/**
 * Load players for match freeze with materialised energy + overclock.
 */
function loadTeamSnapshot($app, teamId) {
  var team = $app.findRecordById("proball_teams", teamId);
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "sort_order",
    20,
    0,
    { t: teamId },
  );
  var list = [];
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    var energy = materialisePlayerEnergy($app, p);
    var condition = p.get("condition");
    if (condition == null) condition = 100;
    list.push({
      id: p.id,
      name: p.get("name"),
      role: p.get("role"),
      attack: p.get("attack"),
      defence: p.get("defence"),
      energy: energy,
      condition: condition,
      intensity: p.get("intensity") || "balanced",
      is_starter: !!p.get("is_starter"),
      sort_order: p.get("sort_order") || i,
    });
  }
  var starters = list.filter(function (x) {
    return x.is_starter;
  });
  if (starters.length < 5) list = defaultStarters(list);

  var overclock = !!team.get("overclock_ready");
  // Consume overclock into snapshot; clear ready flag after freeze by caller
  return {
    id: team.id,
    name: team.get("name"),
    grade: team.get("grade"),
    players: list,
    overclock: overclock,
    treasury: team.get("treasury"),
  };
}

/**
 * Pay a reward once per settlement key. Errors propagate: callers run inside the
 * fixture/round settlement transaction, which must roll back and retry rather than
 * commit a half-paid reward (treasury moved, ledger or settlement row missing).
 */
function settleMatchReward($app, teamId, amount, type, description, meta) {
  if (!amount || amount <= 0) return;
  var key = meta.idempotency_key;
  var existing = $app.findRecordsByFilter(
    "reward_settlements",
    "settlement_key = {:k}",
    "",
    1,
    0,
    { k: key },
  );
  if (existing && existing.length) return;

  var team = $app.findRecordById("proball_teams", teamId);
  adjustTreasury($app, team, amount, type, description, meta);
  var col = $app.findCollectionByNameOrId("reward_settlements");
  var rec = new Record(col);
  rec.set("settlement_key", key);
  rec.set("kind", type);
  rec.set("team", teamId);
  $app.save(rec);
}

function gradeStrength(grade) {
  return BALANCE.gradeStrength[grade] || 60;
}

/**
 * Reward winner/loser after a fixture settles.
 */
function rewardFixture($app, fixture, matchState, tournamentId, roundKey) {
  var homeId = fixture.get("home_team");
  var awayId = fixture.get("away_team");
  var winnerId = matchState.get("winner_team");
  var loserId = winnerId === homeId ? awayId : homeId;
  var hs = matchState.get("score_home") || 0;
  var as_ = matchState.get("score_away") || 0;
  var homeTeam = $app.findRecordById("proball_teams", homeId);
  var awayTeam = $app.findRecordById("proball_teams", awayId);
  var fxId = fixture.id;

  function pay(teamId, amount, type, desc, suffix) {
    settleMatchReward($app, teamId, amount, type, desc, {
      idempotency_key: "rew:" + fxId + ":" + teamId + ":" + suffix,
      tournament_id: tournamentId || "",
      fixture_id: fxId,
    });
  }

  // Goals
  if (hs > 0) {
    pay(homeId, hs * BALANCE.rewards.goalBonus, "goal_bonus", hs + " goals scored", "goals_h");
  }
  if (as_ > 0) {
    pay(awayId, as_ * BALANCE.rewards.goalBonus, "goal_bonus", as_ + " goals scored", "goals_a");
  }

  if (winnerId) {
    var winTeam = winnerId === homeId ? homeTeam : awayTeam;
    var loseTeam = winnerId === homeId ? awayTeam : homeTeam;
    var base = BALANCE.rewards.winBase;
    var diff = gradeStrength(loseTeam.get("grade")) - gradeStrength(winTeam.get("grade"));
    var upset = Math.max(0, diff) * BALANCE.rewards.winPerGradeDiff;
    pay(winnerId, base + upset, "match_win", "Match win reward", "win");
    var prog = BALANCE.rewards.progress[roundKey] || 0;
    if (prog) pay(winnerId, prog, "progress", "Progress (" + roundKey + ")", "prog");
  }
}

function rewardElimination($app, teamId, roundKey, tournamentId) {
  var amount = BALANCE.rewards.consolation[roundKey] || 150;
  settleMatchReward($app, teamId, amount, "consolation", "Elimination consolation", {
    idempotency_key: "consolation:" + tournamentId + ":" + teamId + ":" + roundKey,
    tournament_id: tournamentId,
  });
  // Full energy restore, keep condition
  var players = $app.findRecordsByFilter(
    "proball_players",
    "team = {:t}",
    "",
    20,
    0,
    { t: teamId },
  );
  for (var i = 0; i < players.length; i++) {
    players[i].set("energy", 100);
    players[i].set("energy_updated_at", toPbDate(Date.now()));
    $app.save(players[i]);
  }
}

function rewardChampion($app, teamId, tournamentId) {
  settleMatchReward($app, teamId, BALANCE.rewards.champion, "champion", "Proball champion", {
    idempotency_key: "champ:" + tournamentId + ":" + teamId,
    tournament_id: tournamentId,
  });
  settleMatchReward($app, teamId, BALANCE.rewards.finalist, "finalist", "Final appearance", {
    idempotency_key: "finalist:" + tournamentId + ":" + teamId,
    tournament_id: tournamentId,
  });
}

/**
 * AI treasury maintenance before a kick-off — unmanaged teams and Full AI teams only.
 * Visible rules (AI_RULES): battery for tired starters, buy a battery when rich,
 * repair the most worn player. Never changes the saved lineup (the AI picks its five
 * at kick-off via aiLineup) and never touches personal betting credits.
 */
function aiMaintainTeam($app, team) {
  if (team.get("manager") && team.get("manager_mode") !== "ai") return;
  var players = $app.findRecordsByFilter("proball_players", "team = {:t}", "sort_order", 20, 0, { t: team.id });
  for (var i = 0; i < players.length; i++) materialisePlayerEnergy($app, players[i]);
  var treasury = team.get("treasury");
  if (treasury == null) treasury = BALANCE.startingTreasury;
  var stamp = Date.now();

  var worst = null;
  var worstCond = 100;
  for (var p = 0; p < players.length; p++) {
    var c = players[p].get("condition");
    if (c == null) c = 100;
    if (c < worstCond) {
      worstCond = c;
      worst = players[p];
    }
  }
  if (worst && worstCond < 55) {
    var need = Math.min(30, 100 - worstCond);
    var cost = repairCost(need);
    if (treasury >= cost) {
      treasury -= cost;
      worst.set("condition", worstCond + need);
      $app.save(worst);
      team.set("treasury", treasury);
      $app.save(team);
      writeTeamLedger($app, team.id, -cost, "ai_repair", "AI repair +" + need + " for " + worst.get("name"), treasury, {
        idempotency_key: "ai_repair:" + team.id + ":" + worst.id + ":" + stamp,
        player_id: worst.id,
      });
    }
  }

  var bats = team.get("battery_count") || 0;
  var fittest = aiLineup(
    players.map(function (r) {
      return { id: r.id, name: r.get("name"), role: r.get("role"), attack: r.get("attack"), defence: r.get("defence"), energy: r.get("energy"), condition: r.get("condition") };
    }),
  );
  for (var b = 0; b < players.length && bats > 0; b++) {
    var starter = fittest.filter(function (x) {
      return x.id === players[b].id;
    })[0];
    if (!starter || !starter.is_starter) continue;
    var en = players[b].get("energy") || 0;
    if (en >= 40) continue;
    players[b].set("energy", clamp(en + BALANCE.batteryRestore, 0, 100));
    players[b].set("energy_updated_at", toPbDate(stamp));
    $app.save(players[b]);
    bats -= 1;
  }
  if (bats < 1 && treasury >= BALANCE.batteryCost + 500) {
    bats = 1;
    treasury -= BALANCE.batteryCost;
    writeTeamLedger($app, team.id, -BALANCE.batteryCost, "ai_battery", "AI bought a battery", treasury, {
      idempotency_key: "ai_bat:" + team.id + ":" + stamp,
    });
  }
  team.set("battery_count", bats);
  team.set("treasury", treasury);
  $app.save(team);
}

if (typeof module !== "undefined") {
  module.exports = {
    getSquad: getSquad,
    setLineup: setLineup,
    setIntensity: setIntensity,
    setMode: setMode,
    setDefaultStance: setDefaultStance,
    aiLineup: aiLineup,
    applyWearDelta: applyWearDelta,
    effectNote: effectNote,
    upgradePlayer: upgradePlayer,
    buyBattery: buyBattery,
    useBattery: useBattery,
    repairPlayer: repairPlayer,
    commandChargeSpend: commandChargeSpend,
    getCommandChargeState: getCommandChargeState,
    teamFinances: teamFinances,
    loadTeamSnapshot: loadTeamSnapshot,
    rewardFixture: rewardFixture,
    rewardElimination: rewardElimination,
    rewardChampion: rewardChampion,
    adjustTreasury: adjustTreasury,
    aiMaintainTeam: aiMaintainTeam,
    materialisePlayerEnergy: materialisePlayerEnergy,
    requireManagerTeam: requireManagerTeam,
    upgradeCost: upgradeCost,
    BALANCE: BALANCE,
  };
}
