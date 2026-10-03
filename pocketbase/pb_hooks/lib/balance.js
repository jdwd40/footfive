/**
 * Central balance — timing, combat, economy, Command Charge.
 * Team treasury ≠ personal betting credits.
 */
var BALANCE = {
  // Official default: 1 in-game minute = 15 real seconds (~22m30s for 90')
  matchMinuteRealMs: 15000,
  matchMinuteRealSeconds: 15,
  halfTimeBreakMs: 30000,
  etHalfTimeBreakMs: 15000,
  shootoutKickSpacingMs: 10000,
  shootoutIntroMs: 8000,
  penaltySequenceStepMs: 3500,

  // Dev/test turbo (only when pace is dev/test AND no world override)
  devMatchMinuteRealMs: 200,
  devHalfTimeBreakMs: 600,
  devEtHalfTimeBreakMs: 400,
  devShootoutKickSpacingMs: 300,
  devShootoutIntroMs: 200,
  devPenaltySequenceStepMs: 100,

  segmentMatchMinutes: 5,
  devSegmentMatchMinutes: 5,
  minMatchMinuteSeconds: 1,
  maxMatchMinuteSeconds: 60,

  roundIntervalMs: 10 * 60 * 1000,
  tournamentIntervalMs: 10 * 60 * 1000,
  devRoundIntervalMs: 25 * 1000,
  devTournamentIntervalMs: 20 * 1000,
  firstKickoffDelayMs: 15000,
  devFirstKickoffDelayMs: 4000,

  // Personal betting wallet (users.credits)
  startingCredits: 1000,

  // Team treasury (proball_teams.treasury)
  startingTreasury: 2500,

  coachingCooldownMs: 8000,
  devCoachingCooldownMs: 1500,

  // Live coaching (Defend / Balanced / Attack): limited commands per match with a
  // recharge measured in match minutes.
  liveCoachingMax: 4,
  liveCoachingCooldownMinutes: 5,

  // Dummy test credits: top up to this when below the floor, at most once per hour.
  topUpAmount: 1000,
  topUpFloor: 100,
  topUpCooldownMs: 60 * 60 * 1000,

  // Match engine v2 (per-minute model; see matchEngine.js). Tuned by
  // scripts/engine-calibrate.mjs to ~2.1 goals per 90' (the historic average).
  match: {
    edgeOffset: 18, // attack − defence is ≈ −18 for evenly matched sides
    seqBase: 0.28,
    seqK: 0.006,
    shotBase: 0.5,
    shotK: 0.004,
    onTargetBase: 0.45,
    onTargetK: 0.003,
    blockRate: 0.22,
    woodworkRate: 0.12,
    saveBase: 0.55,
    saveK: 0.004,
    possK: 0.004,
    penBase: 0.006,
    penK: 0.0002,
    penScore: 0.76,
    penSave: 0.16,
    shootoutScore: 0.75,
    foulRate: 0.1,
    yellowRate: 0.15,
    straightRed: 0.004,
    // Real-time pauses (ms) — divided by FOOTFIVE_TIME_SCALE in tests.
    halfTimeMs: 30000,
    etBreakMs: 20000,
    etHalfTimeMs: 10000,
    goalPauseMs: 9000,
    penAwardMs: 5000,
    penSetupMs: 5000,
    penRestartMs: 4000,
    shootoutIntroMs: 10000,
    shootoutKickMs: 12000,
    shootoutRevealMs: 6500,
    endMs: 6000,
  },

  baseAttackChance: 0.22,
  attackPerStrength: 0.0018,
  defenceBlockBase: 0.28,
  defencePerStrength: 0.0015,
  randomVariation: 0.18,

  shotOnTargetRate: 0.42,
  saveRate: 0.55,
  goalFromOnTarget: 0.38,

  foulChance: 0.08,
  yellowFromFoul: 0.22,
  secondYellowAsRed: true,

  basePenaltyChance: 0.012,
  highPressurePenaltyChance: 0.028,
  penaltyScoreRate: 0.72,
  penaltySaveRate: 0.18,

  shootoutOnTarget: 0.82,
  shootoutSaveRate: 0.28,
  shootoutStandardRounds: 5,

  coaching: {
    defend: { attack: 0.82, defence: 1.18, foul: 0.9 },
    balanced: { attack: 1.0, defence: 1.0, foul: 1.0 },
    attack: { attack: 1.18, defence: 0.82, foul: 1.15 },
  },

  gradeStrength: {
    "A++": 96,
    "A+": 90,
    A: 85,
    "A-": 80,
    "B+": 75,
    B: 70,
    "B-": 65,
    "C+": 60,
    C: 55,
    "C-": 50,
  },

  intensity: {
    passive: { attack: 0.85, defence: 1.05, energyUse: 0.55, foul: 0.7, condition: 0.6 },
    balanced: { attack: 1.0, defence: 1.0, energyUse: 1.0, foul: 1.0, condition: 1.0 },
    aggressive: { attack: 1.15, defence: 0.9, energyUse: 1.4, foul: 1.4, condition: 1.35 },
  },

  roleWeights: {
    gk: { attack: 0.05, defence: 1.4 },
    def: { attack: 0.35, defence: 1.2 },
    mid: { attack: 0.9, defence: 0.9 },
    att: { attack: 1.25, defence: 0.4 },
    util: { attack: 0.85, defence: 0.85 },
  },

  // Energy: points lost per match minute played as starter (× intensity.energyUse)
  energyDrainPerMinute: 0.35,
  // Natural regen: points per real hour offline (between matches)
  energyRegenPerHour: 12,
  devEnergyRegenPerHour: 120,
  batteryRestore: 40,
  batteryCost: 180,

  // Condition damage per match minute (base × intensity.condition); fouls add more
  conditionWearPerMinute: 0.08,
  conditionOnFoul: 1.5,
  conditionOnYellow: 3,
  conditionOnRed: 8,

  // Auto-sub thresholds
  autoSubEnergy: 18,
  autoSubCondition: 22,
  maxSubstitutions: 2,

  // Overclock
  overclockBonus: 1.06, // +6% effective atk/def for one fixture
  overclockEnergyCost: 8, // each starter loses this energy when applied

  // Command Charge
  commandChargeMax: 5,
  commandChargeRegenMs: 15 * 60 * 1000, // 15 min per point
  devCommandChargeRegenMs: 20 * 1000,
  commandChargeCosts: {
    rapid_charge: 1,
    field_repair: 1,
    tactical_scan: 1,
    overclock: 2,
  },
  rapidChargeEnergy: 18,
  fieldRepairCondition: 15,

  // Upgrade costs: base * growth^(level) where level = current attr
  upgradeBaseCost: 80,
  upgradeGrowth: 1.08,
  attrMax: 100,

  // Repair: cost per Condition point restored
  repairCostPerPoint: 12,

  // Team rewards (treasury)
  rewards: {
    winBase: 400,
    winPerGradeDiff: 40, // extra if opponent stronger (grade strength delta)
    goalBonus: 50,
    progress: { r16: 200, qf: 350, sf: 600, final: 1000 },
    finalist: 500,
    champion: 2000,
    consolation: { r16: 150, qf: 250, sf: 400, final: 600 },
  },

  minOdds: 1.2,
  maxOdds: 8.0,
};

/**
 * @param {string} pace
 * @param {number} [matchMinuteRealMsOverride] absolute ms per match minute (from world/fixture snapshot)
 */
function getTiming(pace, matchMinuteRealMsOverride) {
  var dev = pace === "dev" || pace === "test";
  var minuteMs =
    matchMinuteRealMsOverride != null && matchMinuteRealMsOverride > 0
      ? matchMinuteRealMsOverride
      : dev
        ? BALANCE.devMatchMinuteRealMs
        : BALANCE.matchMinuteRealMs;
  return {
    matchMinuteRealMs: minuteMs,
    halfTimeBreakMs: dev ? BALANCE.devHalfTimeBreakMs : BALANCE.halfTimeBreakMs,
    etHalfTimeBreakMs: dev ? BALANCE.devEtHalfTimeBreakMs : BALANCE.etHalfTimeBreakMs,
    shootoutKickSpacingMs: dev
      ? BALANCE.devShootoutKickSpacingMs
      : BALANCE.shootoutKickSpacingMs,
    shootoutIntroMs: dev ? BALANCE.devShootoutIntroMs : BALANCE.shootoutIntroMs,
    penaltySequenceStepMs: dev
      ? BALANCE.devPenaltySequenceStepMs
      : BALANCE.penaltySequenceStepMs,
    roundIntervalMs: dev ? BALANCE.devRoundIntervalMs : BALANCE.roundIntervalMs,
    tournamentIntervalMs: dev
      ? BALANCE.devTournamentIntervalMs
      : BALANCE.tournamentIntervalMs,
    firstKickoffDelayMs: dev ? BALANCE.devFirstKickoffDelayMs : BALANCE.firstKickoffDelayMs,
    segmentMatchMinutes: dev
      ? BALANCE.devSegmentMatchMinutes
      : BALANCE.segmentMatchMinutes,
    coachingCooldownMs: dev ? BALANCE.devCoachingCooldownMs : BALANCE.coachingCooldownMs,
    energyRegenPerHour: dev ? BALANCE.devEnergyRegenPerHour : BALANCE.energyRegenPerHour,
    commandChargeRegenMs: dev
      ? BALANCE.devCommandChargeRegenMs
      : BALANCE.commandChargeRegenMs,
  };
}

function clampMatchMinuteSeconds(sec) {
  var n = parseInt(sec, 10);
  if (isNaN(n)) return BALANCE.matchMinuteRealSeconds;
  if (n < BALANCE.minMatchMinuteSeconds) n = BALANCE.minMatchMinuteSeconds;
  if (n > BALANCE.maxMatchMinuteSeconds) n = BALANCE.maxMatchMinuteSeconds;
  return n;
}

function coachingMod(stance) {
  return BALANCE.coaching[stance] || BALANCE.coaching.balanced;
}

function upgradeCost(currentAttr) {
  var lvl = Math.max(1, Math.min(99, parseInt(currentAttr, 10) || 50));
  return Math.floor(BALANCE.upgradeBaseCost * Math.pow(BALANCE.upgradeGrowth, lvl - 40));
}

function repairCost(points) {
  var p = Math.max(1, parseInt(points, 10) || 0);
  return p * BALANCE.repairCostPerPoint;
}

if (typeof module !== "undefined") {
  module.exports = {
    BALANCE: BALANCE,
    getTiming: getTiming,
    clampMatchMinuteSeconds: clampMatchMinuteSeconds,
    coachingMod: coachingMod,
    upgradeCost: upgradeCost,
    repairCost: repairCost,
  };
}
