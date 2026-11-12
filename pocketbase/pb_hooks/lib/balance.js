/**
 * Central balance — timing, combat, economy, Command Charge.
 * Team treasury ≠ personal betting credits.
 */
var BALANCE = {
  // Official default: 1 in-game minute = 6 real seconds (9m for 90', plus holds/breaks)
  matchMinuteRealMs: 6000,
  matchMinuteRealSeconds: 6,
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
  // scripts/engine-calibrate.mjs to ~3 goals per 90' (#195 recommended tuning).
  // #217: more attacks (seqBase 0.28 -> 0.36) with lower conversion (onTargetBase 0.50 -> 0.44,
  // saveBase 0.48 -> 0.54): ~21 real shots a match, same goals (docs/balance-217.md).
  match: {
    edgeOffset: 18, // attack − defence is ≈ −18 for evenly matched sides
    seqBase: 0.36,
    seqK: 0.006,
    shotBase: 0.54,
    shotK: 0.004,
    onTargetBase: 0.44,
    onTargetK: 0.003,
    blockRate: 0.22,
    woodworkRate: 0.12,
    saveBase: 0.59,
    saveK: 0.004,
    // Occasional long-range effort: fraction of shots taken from deep (x 58–70)
    // without final-third progression; the keeper's save chance gets this bonus.
    longShotRate: 0.08,
    longShotMinX: 58,
    longShotMaxX: 70,
    longShotSaveBonus: 0.15,
    // #218: share of tackle/interception attacks that first reach the final third (a cross, through ball or dribble into
    // x 74–82) and die there to a last-ditch tackle, a clearance or a keeper claim. Outcomes are unchanged; only where they happen.
    deepTurnoverRate: 0.5,
    // #219: game state. From urgencyMinute a trailing side (any stance) attacks in more of its possession minutes and has a
    // little more of the ball; a turnover becomes a real counter-attack (a fast 1–2 pass break into the final third with a
    // better shot chance), more often against a trailing side committed forward; and a parried save or a blocked shot can
    // drop to an attacker for a second shot in the same chain. goalRates models all of it (docs/balance-219.md).
    urgencyMinute: 70, // = the AI chase minute (matchEngine AI.chase): the in-play odds model starts both together
    urgencySeq: 1.25, // × pSeq for the trailing side
    urgencyPoss: 0.04, // extra possession share for the trailing side
    counterRate: 0.07, // chance that a side which won the ball last minute (st.counter) and keeps it breaks at once
    counterRisk: 1.6, // × counterRate when the side that lost it was trailing late (committed forward)
    counterShot: 1.2, // × pShot on a counter (fewer defenders back)
    reboundSave: 0.15, // share of saves parried loose to an attacker
    reboundBlock: 0.15, // share of blocks that drop to an attacker
    reboundOn: 0.85, // × pOn for the second shot (snatched)
    reboundSaveDrop: 0.1, // the keeper is scrambling: save chance − this on the second shot
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
    resultHoldMs: 1200, // min real gap after a shot result / card so the client can show it before the next event
    kickoffHoldMs: 4000, // kick-off / restart-of-period announcement + teams walking on before the first play
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

  // A stance sets the tempo of the whole match, not player stats: both teams' tempo is added
  // to both sides' attacking edge (matchEngine). Attack opens up chances at both ends, Defend
  // closes them down at both ends; foul scales the foul rate.
  coaching: {
    defend: { tempo: -22, foul: 0.9 },
    balanced: { tempo: 0, foul: 1.0 },
    attack: { tempo: 22, foul: 1.15 },
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

  // Per-player intensity: aggressive presses harder now (more attack, a little less defence)
  // and tires faster; passive gives up attack and some defence now to save energy and
  // condition. #157: aggressive 1.25/1.0 -> 1.2/0.95 so it is a trade, not a free buff.
  intensity: {
    passive: { attack: 0.8, defence: 0.95, energyUse: 0.55, condition: 0.6 },
    balanced: { attack: 1.0, defence: 1.0, energyUse: 1.0, condition: 1.0 },
    aggressive: { attack: 1.2, defence: 0.95, energyUse: 1.4, condition: 1.35 },
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

  // Fitness: effective attack/defence scale by 1 - impact x (share of energy or condition
  // missing), so a flat tank costs a player `impact` of their output (effectiveStats.fitnessFactor).
  // The engine, scouting estimates and AI line-up choices all use this one policy.
  fitness: { energyImpact: 0.35, conditionImpact: 0.35 },

  // Overclock
  overclockBonus: 1.1, // +10% effective atk/def for one fixture (#157: was 1.12); the starters still pay the energy cost
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

  // Upgrade costs: base * growth^(level) where level = current attr (+1 per purchase)
  upgradeBaseCost: 80,
  upgradeGrowth: 1.04,
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

/** Stance settings; an unknown or missing stance plays as Balanced. */
function coachingMod(stance) {
  return Object.prototype.hasOwnProperty.call(BALANCE.coaching, stance)
    ? BALANCE.coaching[stance]
    : BALANCE.coaching.balanced;
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
