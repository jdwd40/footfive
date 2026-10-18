/**
 * Single source for effective Attack/Defence used by match engine + management UI estimates.
 */
var balMod;
try {
  balMod = require(__hooks + "/lib/balance.js");
} catch (e) {
  balMod = require("./balance.js");
}
var BALANCE = balMod.BALANCE;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Multiplier for a 0-100 energy or condition: 1 when full, 1 - impact when empty. */
function fitnessFactor(value, impact) {
  return 1 - impact * (1 - value / 100);
}

/**
 * @param {object} player { attack, defence, role, energy, condition, intensity }
 * @param {object} opts { overclock, sentOff } — a coaching stance is a match tempo applied
 *   by the match engine, so it never changes a player's stats (a legacy coachingStance is ignored)
 */
function effectivePlayerStats(player, opts) {
  opts = opts || {};
  if (opts.sentOff) {
    return { attack: 0, defence: 0, energyFactor: 0, conditionFactor: 0 };
  }
  var role = player.role || "util";
  var w = BALANCE.roleWeights[role] || BALANCE.roleWeights.util;
  var intensity = player.intensity || "balanced";
  var im = BALANCE.intensity[intensity] || BALANCE.intensity.balanced;
  var energy = clamp(player.energy != null ? player.energy : 100, 0, 100);
  var condition = clamp(player.condition != null ? player.condition : 100, 0, 100);
  // Low values hurt, but never zero a player from one axis alone
  var energyFactor = fitnessFactor(energy, BALANCE.fitness.energyImpact);
  var conditionFactor = fitnessFactor(condition, BALANCE.fitness.conditionImpact);
  var overclock = opts.overclock ? BALANCE.overclockBonus : 1;

  var atk =
    (player.attack || 50) *
    w.attack *
    im.attack *
    energyFactor *
    conditionFactor *
    overclock;
  var def =
    (player.defence || 50) *
    w.defence *
    im.defence *
    energyFactor *
    conditionFactor *
    overclock;

  return {
    attack: Math.round(atk * 10) / 10,
    defence: Math.round(def * 10) / 10,
    energyFactor: energyFactor,
    conditionFactor: conditionFactor,
  };
}

/**
 * Aggregate team effective strength from starter list.
 */
function effectiveTeamStrength(players, opts) {
  opts = opts || {};
  var starters = (players || []).filter(function (p) {
    return p.is_starter !== false && !p.sentOff;
  });
  if (!starters.length) starters = players || [];
  var atk = 0;
  var def = 0;
  var n = Math.max(starters.length, 1);
  for (var i = 0; i < starters.length; i++) {
    var s = effectivePlayerStats(starters[i], {
      overclock: opts.overclock,
      sentOff: starters[i].sentOff,
    });
    atk += s.attack;
    def += s.defence;
  }
  var gradeBase = BALANCE.gradeStrength[opts.grade] || 60;
  return {
    attack: atk / n + gradeBase * 0.35,
    defence: def / n + gradeBase * 0.35,
    base: gradeBase,
  };
}

/**
 * Materialise energy from stored value + last_energy_at timestamp.
 */
function materialiseEnergy(stored, lastAtMs, nowMs, regenPerHour) {
  var e = clamp(stored != null ? stored : 100, 0, 100);
  if (!lastAtMs || !regenPerHour) return e;
  var hours = Math.max(0, (nowMs - lastAtMs) / 3600000);
  return clamp(e + hours * regenPerHour, 0, 100);
}

function materialiseCommandCharge(points, lastAtMs, nowMs, regenMs, maxPts) {
  var p = clamp(points != null ? points : maxPts, 0, maxPts);
  if (!lastAtMs || !regenMs || p >= maxPts) return { points: p, lastAt: lastAtMs || nowMs };
  var elapsed = Math.max(0, nowMs - lastAtMs);
  var gained = Math.floor(elapsed / regenMs);
  if (gained <= 0) return { points: p, lastAt: lastAtMs };
  var next = clamp(p + gained, 0, maxPts);
  var used = gained * regenMs;
  return { points: next, lastAt: lastAtMs + used };
}

if (typeof module !== "undefined") {
  module.exports = {
    effectivePlayerStats: effectivePlayerStats,
    effectiveTeamStrength: effectiveTeamStrength,
    materialiseEnergy: materialiseEnergy,
    materialiseCommandCharge: materialiseCommandCharge,
    fitnessFactor: fitnessFactor,
    clamp: clamp,
  };
}
