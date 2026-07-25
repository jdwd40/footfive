/**
 * Incremental server-authoritative match simulation.
 * Advances in segments (~5 match minutes); never pre-generates full result at kickoff.
 */
var balMod, effMod;
try {
  balMod = require(__hooks + "/lib/balance.js");
  effMod = require(__hooks + "/lib/effectiveStats.js");
} catch (e) {
  balMod = require("./balance.js");
  effMod = require("./effectiveStats.js");
}
var BALANCE = balMod.BALANCE;
var getTiming = balMod.getTiming;
var coachingMod = balMod.coachingMod;
var effectiveTeamStrength = effMod.effectiveTeamStrength;
var clamp = effMod.clamp;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  var h = 2166136261;
  for (var i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function emptyStats() {
  return {
    possession: 50,
    shots: 0,
    shots_on_target: 0,
    saves: 0,
    misses: 0,
    blocks: 0,
    corners: 0,
    fouls: 0,
    yellow_cards: 0,
    red_cards: 0,
    penalties_awarded: 0,
    penalties_scored: 0,
    penalties_saved: 0,
    penalties_missed: 0,
    goals: 0,
  };
}

function effectiveStrength(team, players, coachingStance, overclock) {
  return effectiveTeamStrength(players, {
    grade: team.grade,
    coachingStance: coachingStance || "balanced",
    overclock: !!overclock,
  });
}

/**
 * Create initial match state (not simulated past kickoff).
 */
function createMatchState(opts) {
  var home = opts.home;
  var away = opts.away;
  var pace = opts.pace || "normal";
  var timing = getTiming(pace);
  var seed = opts.seed != null ? opts.seed : hashSeed(home.name + ":" + away.name + ":" + Date.now());
  var seedNum = typeof seed === "number" ? seed : hashSeed(String(seed));

  return {
    simVersion: 1,
    seed: seedNum,
    rngCalls: 0,
    pace: pace,
    phase: "scheduled",
    simMinute: 0, // minutes fully simulated
    clockMs: 0, // match-time offset for event offsets
    scoreHome: 0,
    scoreAway: 0,
    shootoutHome: 0,
    shootoutAway: 0,
    shootoutTakenHome: 0,
    shootoutTakenAway: 0,
    shootoutSide: "home",
    shootoutKicks: [], // authoritative per-kick history
    yellows: {},
    sentOff: {},
    stats: { home: emptyStats(), away: emptyStats() },
    homeCoaching: opts.homeCoaching || "balanced",
    awayCoaching: opts.awayCoaching || "balanced",
    homePlayers: home.players || [],
    awayPlayers: away.players || [],
    homeName: home.name,
    awayName: away.name,
    homeGrade: home.grade,
    awayGrade: away.grade,
    homeId: home.id || null,
    awayId: away.id || null,
    homeOverclock: !!opts.homeOverclock,
    awayOverclock: !!opts.awayOverclock,
    homeSubsUsed: 0,
    awaySubsUsed: 0,
    seq: 0,
    events: [],
    finalised: false,
    wentExtraTime: false,
    wentShootout: false,
    winnerSide: null,
    kickoffDone: false,
    halfTimeDone: false,
    secondHalfDone: false,
    fullTimeDone: false,
    etStarted: false,
    etHalfDone: false,
    etEndDone: false,
    shootoutStarted: false,
    segmentIndex: 0,
    timing: timing,
  };
}

function nextRng(state) {
  state.rngCalls = (state.rngCalls || 0) + 1;
  var rng = mulberry32((state.seed + state.rngCalls * 9973) >>> 0);
  return rng();
}

function pickPlayer(state, side) {
  var list = side === "home" ? state.homePlayers : state.awayPlayers;
  list = (list || []).filter(function (p) {
    return p.is_starter !== false && p.role !== "gk" && !state.sentOff[side + ":" + p.name];
  });
  if (!list.length) {
    list = (side === "home" ? state.homePlayers : state.awayPlayers) || [];
  }
  if (!list.length) return { name: "Unknown", role: "util", attack: 50, defence: 50 };
  var total = 0;
  for (var i = 0; i < list.length; i++) total += (list[i].attack || 50) + 10;
  var r = nextRng(state) * total;
  for (var j = 0; j < list.length; j++) {
    r -= (list[j].attack || 50) + 10;
    if (r <= 0) return list[j];
  }
  return list[0];
}

function gkName(state, side) {
  var list = side === "home" ? state.homePlayers : state.awayPlayers;
  for (var i = 0; i < (list || []).length; i++) {
    if (list[i].role === "gk") return list[i].name;
  }
  return "Keeper";
}

function teamName(state, side) {
  return side === "home" ? state.homeName : state.awayName;
}

function pushEvent(state, ev) {
  state.seq += 1;
  var e = {
    seq: state.seq,
    minute: ev.minute != null ? ev.minute : state.simMinute,
    phase: ev.phase || state.phase,
    offsetMs: state.clockMs + (ev.extraMs || 0),
    type: ev.type,
    team: ev.team || null,
    player: ev.player || null,
    message: ev.message,
    scoreHome: state.scoreHome,
    scoreAway: state.scoreAway,
    shootoutHome: state.shootoutHome,
    shootoutAway: state.shootoutAway,
    chainId: ev.chainId || null,
    chainStep: ev.chainStep != null ? ev.chainStep : null,
    meta: ev.meta || null,
  };
  if (ev.advanceMs) state.clockMs += ev.advanceMs;
  state.events.push(e);
  return e;
}

function maybeAutoSub(state, side, minute, phase) {
  var used = side === "home" ? state.homeSubsUsed : state.awaySubsUsed;
  if (used >= BALANCE.maxSubstitutions) return;
  var players = side === "home" ? state.homePlayers : state.awayPlayers;
  if (!players || !players.length) return;
  var starter = null;
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (!p.is_starter || p.sentOff) continue;
    if (
      (p.energy != null && p.energy <= BALANCE.autoSubEnergy) ||
      (p.condition != null && p.condition <= BALANCE.autoSubCondition)
    ) {
      starter = p;
      break;
    }
  }
  if (!starter) return;
  var sub = null;
  for (var j = 0; j < players.length; j++) {
    if (!players[j].is_starter && !players[j].sentOff && !players[j]._usedAsSub) {
      sub = players[j];
      break;
    }
  }
  if (!sub) return;
  starter.is_starter = false;
  starter._subbedOff = true;
  sub.is_starter = true;
  sub._usedAsSub = true;
  if (side === "home") state.homeSubsUsed = used + 1;
  else state.awaySubsUsed = used + 1;
  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "substitution",
    team: side,
    player: sub.name,
    message:
      teamName(state, side) +
      " substitution: " +
      sub.name +
      " replaces " +
      starter.name +
      ".",
  });
}

function applyMinuteWear(state, side) {
  var players = side === "home" ? state.homePlayers : state.awayPlayers;
  if (!players || !players.length) return;
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (!p.is_starter || p.sentOff) continue;
    var im = BALANCE.intensity[p.intensity || "balanced"] || BALANCE.intensity.balanced;
    var drain = BALANCE.energyDrainPerMinute * (im.energyUse || 1);
    p.energy = clamp((p.energy != null ? p.energy : 100) - drain, 0, 100);
    var wear = BALANCE.conditionWearPerMinute * (im.condition || 1);
    p.condition = clamp((p.condition != null ? p.condition : 100) - wear, 0, 100);
  }
}

function atkChance(state, side) {
  var hs = effectiveStrength(
    { grade: state.homeGrade },
    state.homePlayers,
    state.homeCoaching,
    state.homeOverclock,
  );
  var as_ = effectiveStrength(
    { grade: state.awayGrade },
    state.awayPlayers,
    state.awayCoaching,
    state.awayOverclock,
  );
  var s = side === "home" ? hs : as_;
  var o = side === "home" ? as_ : hs;
  var raw =
    BALANCE.baseAttackChance +
    (s.attack - o.defence) * 0.002 +
    (s.base - o.base) * BALANCE.attackPerStrength;
  var noise = (nextRng(state) - 0.5) * BALANCE.randomVariation;
  var offCount = 0;
  for (var k in state.sentOff) {
    if (state.sentOff[k] && k.indexOf(side) === 0) offCount++;
  }
  if (offCount) raw *= Math.pow(0.75, offCount);
  return clamp(raw + noise, 0.04, 0.55);
}

function handleFoul(state, minute, phase) {
  var side = nextRng(state) < 0.5 ? "home" : "away";
  var offender = pickPlayer(state, side);
  var key = side + ":" + offender.name;
  state.stats[side].fouls += 1;
  var cm = coachingMod(side === "home" ? state.homeCoaching : state.awayCoaching);
  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "foul",
    team: side,
    player: offender.name,
    message: "Foul by " + offender.name + " of " + teamName(state, side) + ".",
  });
  if (nextRng(state) < BALANCE.yellowFromFoul * cm.foul) {
    state.yellows[key] = (state.yellows[key] || 0) + 1;
    if (state.yellows[key] >= 2 && BALANCE.secondYellowAsRed) {
      state.sentOff[key] = true;
      state.stats[side].red_cards += 1;
      pushEvent(state, {
        minute: minute,
        phase: phase,
        type: "red_card",
        team: side,
        player: offender.name,
        message: "Second yellow! " + offender.name + " is sent off!",
      });
    } else {
      state.stats[side].yellow_cards += 1;
      pushEvent(state, {
        minute: minute,
        phase: phase,
        type: "yellow_card",
        team: side,
        player: offender.name,
        message: "Yellow card for " + offender.name + " of " + teamName(state, side) + ".",
      });
    }
  }
}

function handlePenalty(state, side, minute, phase) {
  var chainId = "pen-" + minute + "-" + side + "-" + state.seq;
  var taker = pickPlayer(state, side);
  var defSide = side === "home" ? "away" : "home";
  var gk = gkName(state, defSide);
  var timing = state.timing;
  state.stats[side].penalties_awarded += 1;

  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "penalty_awarded",
    team: side,
    player: taker.name,
    message: "Penalty awarded to " + teamName(state, side) + "!",
    chainId: chainId,
    chainStep: 0,
    advanceMs: timing.penaltySequenceStepMs,
  });
  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "penalty_walkup",
    team: side,
    player: taker.name,
    message: taker.name + " steps up for " + teamName(state, side) + ".",
    chainId: chainId,
    chainStep: 1,
    advanceMs: timing.penaltySequenceStepMs,
  });
  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "penalty_run_up",
    team: side,
    player: taker.name,
    message: taker.name + " runs up…",
    chainId: chainId,
    chainStep: 2,
    advanceMs: timing.penaltySequenceStepMs,
  });

  var r = nextRng(state);
  var outcome;
  if (r < BALANCE.penaltyScoreRate) outcome = "scored";
  else if (r < BALANCE.penaltyScoreRate + BALANCE.penaltySaveRate) outcome = "saved";
  else outcome = "missed";

  if (outcome === "scored") {
    if (side === "home") state.scoreHome += 1;
    else state.scoreAway += 1;
    state.stats[side].goals += 1;
    state.stats[side].penalties_scored += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "penalty_scored",
      team: side,
      player: taker.name,
      message: taker.name + " scores the penalty for " + teamName(state, side) + "!",
      chainId: chainId,
      chainStep: 3,
      advanceMs: timing.penaltySequenceStepMs,
    });
    if (minute !== 45 && minute !== 90 && minute !== 105 && minute !== 120) {
      pushEvent(state, {
        minute: minute,
        phase: phase,
        type: "kickoff_restart",
        team: defSide,
        message: teamName(state, defSide) + " restart from kickoff.",
        chainId: chainId,
        chainStep: 4,
      });
    }
  } else if (outcome === "saved") {
    state.stats[side].penalties_saved += 1;
    state.stats[defSide].saves += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "penalty_saved",
      team: side,
      player: taker.name,
      message: gk + " saves " + taker.name + "'s penalty!",
      chainId: chainId,
      chainStep: 3,
    });
  } else {
    state.stats[side].penalties_missed += 1;
    state.stats[side].misses += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "penalty_missed",
      team: side,
      player: taker.name,
      message: taker.name + " blazes the penalty over!",
      chainId: chainId,
      chainStep: 3,
    });
  }
}

function handleAttack(state, side, minute, phase) {
  var chainId = "atk-" + minute + "-" + side + "-" + state.seq;
  var attacker = pickPlayer(state, side);
  var defSide = side === "home" ? "away" : "home";
  var hs = effectiveStrength(
    { grade: state.homeGrade },
    state.homePlayers,
    state.homeCoaching,
    state.homeOverclock,
  );
  var as_ = effectiveStrength(
    { grade: state.awayGrade },
    state.awayPlayers,
    state.awayCoaching,
    state.awayOverclock,
  );
  var s = side === "home" ? hs : as_;
  var o = side === "home" ? as_ : hs;
  var step = 0;

  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "midfield_play",
    team: side,
    player: attacker.name,
    message: attacker.name + " drives forward for " + teamName(state, side) + ".",
    chainId: chainId,
    chainStep: step++,
  });

  var pressure = s.attack - o.defence;
  var penChance =
    pressure > 15 ? BALANCE.highPressurePenaltyChance : BALANCE.basePenaltyChance;
  if (nextRng(state) < penChance) {
    handlePenalty(state, side, minute, phase);
    return;
  }

  pushEvent(state, {
    minute: minute,
    phase: phase,
    type: "build_up",
    team: side,
    player: attacker.name,
    message: teamName(state, side) + " surge into the final third.",
    chainId: chainId,
    chainStep: step++,
  });

  var blockChance =
    BALANCE.defenceBlockBase + (o.defence - s.attack) * BALANCE.defencePerStrength;
  if (nextRng(state) < clamp(blockChance, 0.1, 0.55)) {
    state.stats[defSide].blocks += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "block",
      team: defSide,
      message: teamName(state, defSide) + " block the shot.",
      chainId: chainId,
      chainStep: step++,
    });
    if (nextRng(state) < 0.35) {
      state.stats[side].corners += 1;
      pushEvent(state, {
        minute: minute,
        phase: phase,
        type: "corner",
        team: side,
        message: "Corner to " + teamName(state, side) + ".",
        chainId: chainId,
        chainStep: step++,
      });
    }
    return;
  }

  state.stats[side].shots += 1;
  if (nextRng(state) >= BALANCE.shotOnTargetRate) {
    state.stats[side].misses += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "miss",
      team: side,
      player: attacker.name,
      message: attacker.name + " fires wide!",
      chainId: chainId,
      chainStep: step++,
    });
    return;
  }

  state.stats[side].shots_on_target += 1;
  if (nextRng(state) < BALANCE.saveRate) {
    var gk = gkName(state, defSide);
    state.stats[defSide].saves += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "save",
      team: defSide,
      player: gk,
      message: gk + " makes a sharp save!",
      chainId: chainId,
      chainStep: step++,
    });
    return;
  }

  if (nextRng(state) < BALANCE.goalFromOnTarget) {
    if (side === "home") state.scoreHome += 1;
    else state.scoreAway += 1;
    state.stats[side].goals += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "goal",
      team: side,
      player: attacker.name,
      message: attacker.name + " scores for " + teamName(state, side) + "!",
      chainId: chainId,
      chainStep: step++,
    });
    if (minute !== 45 && minute !== 90 && minute !== 105 && minute !== 120) {
      pushEvent(state, {
        minute: minute,
        phase: phase,
        type: "kickoff_restart",
        team: defSide,
        message: teamName(state, defSide) + " kick off again.",
        chainId: chainId,
        chainStep: step++,
      });
    }
  } else {
    state.stats[side].misses += 1;
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "miss",
      team: side,
      player: attacker.name,
      message: attacker.name + " rattles the bar!",
      chainId: chainId,
      chainStep: step++,
    });
  }
}

function simulateOneMinute(state, minute, phase) {
  applyMinuteWear(state, "home");
  applyMinuteWear(state, "away");
  maybeAutoSub(state, "home", minute, phase);
  maybeAutoSub(state, "away", minute, phase);

  var foulMul =
    coachingMod(state.homeCoaching).foul + coachingMod(state.awayCoaching).foul;
  if (nextRng(state) < BALANCE.foulChance * (foulMul / 2)) {
    handleFoul(state, minute, phase);
    // extra condition on fouler is approximate via foul handler side
  }
  if (nextRng(state) < atkChance(state, "home")) {
    handleAttack(state, "home", minute, phase);
  } else if (nextRng(state) < atkChance(state, "away")) {
    handleAttack(state, "away", minute, phase);
  } else if (nextRng(state) < 0.35) {
    var side = nextRng(state) < 0.5 ? "home" : "away";
    var p = pickPlayer(state, side);
    pushEvent(state, {
      minute: minute,
      phase: phase,
      type: "midfield_play",
      team: side,
      player: p.name,
      message: teamName(state, side) + " recycle possession in midfield.",
    });
  }
  state.clockMs += state.timing.matchMinuteRealMs;
  state.simMinute = minute;
}

function processShootoutKick(state) {
  if (!state.shootoutKicks) state.shootoutKicks = [];
  var side = state.shootoutSide;
  var taker = pickPlayer(state, side);
  var defSide = side === "home" ? "away" : "home";
  var gk = gkName(state, defSide);
  var kickIndex = state.shootoutTakenHome + state.shootoutTakenAway + 1;
  var kickNumForSide =
    (side === "home" ? state.shootoutTakenHome : state.shootoutTakenAway) + 1;
  var isSudden = kickNumForSide > BALANCE.shootoutStandardRounds;
  var chainId = "so-" + kickIndex;
  var timing = state.timing;

  // must-score / match-point heuristic before kick
  var mustScore = false;
  var matchPoint = false;
  if (state.shootoutTakenHome === state.shootoutTakenAway) {
    var rem =
      Math.max(
        BALANCE.shootoutStandardRounds -
          Math.max(state.shootoutTakenHome, state.shootoutTakenAway),
        0,
      ) - 1;
    if (rem < 0) rem = 0;
    // after this kick if they miss and other already leads...
  }
  // If other side has more remaining potential
  var otherScore = side === "home" ? state.shootoutAway : state.shootoutHome;
  var myScore = side === "home" ? state.shootoutHome : state.shootoutAway;
  var otherTaken = side === "home" ? state.shootoutTakenAway : state.shootoutTakenHome;
  var otherRem = Math.max(BALANCE.shootoutStandardRounds - otherTaken, 0);
  if (!isSudden && otherScore + otherRem < myScore + 1) {
    // already winning even if miss later — not must score
  }
  if (
    !isSudden &&
    myScore + Math.max(BALANCE.shootoutStandardRounds - kickNumForSide + 1, 0) <=
      otherScore
  ) {
    mustScore = true;
  }
  if (isSudden) {
    // sudden death: must score if other already scored this pair
    if (
      state.shootoutTakenHome !== state.shootoutTakenAway &&
      myScore <= otherScore
    ) {
      mustScore = true;
    }
  }

  pushEvent(state, {
    minute: 120,
    phase: "shootout",
    type: "shootout_walkup",
    team: side,
    player: taker.name,
    message: taker.name + " walks up for " + teamName(state, side) + ".",
    chainId: chainId,
    chainStep: 0,
    advanceMs: timing.shootoutKickSpacingMs * 0.4,
    meta: {
      kickIndex: kickIndex,
      kickNumber: kickNumForSide,
      suddenDeath: isSudden,
      mustScore: mustScore,
    },
  });

  var onT = nextRng(state) < BALANCE.shootoutOnTarget;
  var saved = onT && nextRng(state) < BALANCE.shootoutSaveRate;
  var scored = onT && !saved;
  var outcome = scored ? "goal" : saved ? "save" : "miss";

  if (side === "home") state.shootoutTakenHome += 1;
  else state.shootoutTakenAway += 1;

  if (scored) {
    if (side === "home") state.shootoutHome += 1;
    else state.shootoutAway += 1;
  }

  // Check if decisive after this kick
  var finished = false;
  if (state.shootoutTakenHome === state.shootoutTakenAway) {
    var r = state.shootoutTakenHome;
    var rem2 = Math.max(BALANCE.shootoutStandardRounds - r, 0);
    if (r >= BALANCE.shootoutStandardRounds) {
      if (state.shootoutHome !== state.shootoutAway) finished = true;
    } else if (Math.abs(state.shootoutHome - state.shootoutAway) > rem2) {
      finished = true;
    }
  } else {
    // unequal: early win possible after home took more
    var moreSide =
      state.shootoutTakenHome > state.shootoutTakenAway ? "home" : "away";
    var moreTaken =
      moreSide === "home" ? state.shootoutTakenHome : state.shootoutTakenAway;
    var lessTaken =
      moreSide === "home" ? state.shootoutTakenAway : state.shootoutTakenHome;
    var moreScore = moreSide === "home" ? state.shootoutHome : state.shootoutAway;
    var lessScore = moreSide === "home" ? state.shootoutAway : state.shootoutHome;
    var lessRem = Math.max(BALANCE.shootoutStandardRounds - lessTaken, 0);
    if (moreTaken <= BALANCE.shootoutStandardRounds && moreScore > lessScore + lessRem) {
      finished = true;
    }
  }

  var kickRec = {
    kickIndex: kickIndex,
    team: side,
    kickNumber: kickNumForSide,
    suddenDeath: isSudden,
    player: taker.name,
    keeper: gk,
    outcome: outcome,
    mustScore: mustScore,
    matchPoint: matchPoint,
    decisive: finished,
    shootoutHome: state.shootoutHome,
    shootoutAway: state.shootoutAway,
    takenHome: state.shootoutTakenHome,
    takenAway: state.shootoutTakenAway,
  };
  state.shootoutKicks.push(kickRec);

  var resultType = scored
    ? "shootout_goal"
    : saved
      ? "shootout_save"
      : "shootout_miss";
  pushEvent(state, {
    minute: 120,
    phase: "shootout",
    type: resultType,
    team: side,
    player: taker.name,
    message: scored
      ? taker.name + " scores!"
      : saved
        ? gk + " saves from " + taker.name + "!"
        : taker.name + " misses!",
    chainId: chainId,
    chainStep: 1,
    advanceMs: timing.shootoutKickSpacingMs * 0.6,
    meta: kickRec,
  });

  state.shootoutSide = side === "home" ? "away" : "home";
  return finished;
}

function finalise(state) {
  if (state.finalised) return;
  if (state.wentShootout) {
    state.winnerSide =
      state.shootoutHome > state.shootoutAway ? "home" : "away";
  } else if (state.scoreHome !== state.scoreAway) {
    state.winnerSide = state.scoreHome > state.scoreAway ? "home" : "away";
  } else {
    state.winnerSide = "home";
  }
  pushEvent(state, {
    minute: state.simMinute,
    phase: "finished",
    type: "match_end",
    team: state.winnerSide,
    message:
      teamName(state, state.winnerSide) +
      " win! Final " +
      state.homeName +
      " " +
      state.scoreHome +
      "–" +
      state.scoreAway +
      " " +
      state.awayName +
      (state.wentShootout
        ? " (" + state.shootoutHome + "–" + state.shootoutAway + " pens)"
        : "") +
      ".",
  });
  state.phase = "finished";
  state.finalised = true;
  var hAtk = effectiveStrength(
    { grade: state.homeGrade },
    state.homePlayers,
    "balanced",
    false,
  ).attack;
  var aAtk = effectiveStrength(
    { grade: state.awayGrade },
    state.awayPlayers,
    "balanced",
    false,
  ).attack;
  var totalAtk = hAtk + aAtk || 1;
  state.stats.home.possession = Math.round((hAtk / totalAtk) * 100);
  state.stats.away.possession = 100 - state.stats.home.possession;
}

/**
 * Advance one simulation segment. Applies current coaching for new minutes only.
 * @returns {{ newEvents: Array, finished: boolean, state: object }}
 */
function advanceSegment(state, opts) {
  opts = opts || {};
  if (opts.homeCoaching) state.homeCoaching = opts.homeCoaching;
  if (opts.awayCoaching) state.awayCoaching = opts.awayCoaching;

  if (state.finalised) {
    return { newEvents: [], finished: true, state: state };
  }

  var timing = state.timing || getTiming(state.pace || "normal");
  state.timing = timing;
  var segMins = timing.segmentMatchMinutes || 5;
  var startSeq = state.seq;
  var startMin = state.simMinute;

  // Kickoff
  if (!state.kickoffDone) {
    state.phase = "first_half";
    pushEvent(state, {
      minute: 0,
      phase: "first_half",
      type: "kickoff",
      team: "home",
      message: "Kickoff! " + state.homeName + " vs " + state.awayName + ".",
    });
    state.kickoffDone = true;
  }

  // Coaching visibility events at segment start if stance just applied via meta
  if (opts.coachingAnnouncement) {
    pushEvent(state, {
      minute: state.simMinute,
      phase: state.phase,
      type: "coaching_change",
      team: opts.coachingAnnouncement.team,
      message: opts.coachingAnnouncement.message,
    });
  }

  var minutesDone = 0;
  var maxMinutesThisSeg = segMins;

  function phaseForMinute(m) {
    if (m <= 45) return "first_half";
    if (m <= 90) return "second_half";
    if (m <= 105) return "extra_time_1";
    if (m <= 120) return "extra_time_2";
    return "shootout";
  }

  // Shootout mode: process limited kicks per segment
  if (state.phase === "shootout" || state.shootoutStarted) {
    state.phase = "shootout";
    if (!state.shootoutStarted) {
      pushEvent(state, {
        minute: 120,
        phase: "shootout",
        type: "shootout_start",
        message: "Penalty shootout!",
        advanceMs: timing.shootoutIntroMs,
      });
      state.shootoutStarted = true;
      state.wentShootout = true;
    }
    var kicks = 0;
    while (kicks < 2 && !state.finalised) {
      var done = processShootoutKick(state);
      kicks++;
      if (done) {
        pushEvent(state, {
          minute: 120,
          phase: "shootout",
          type: "shootout_end",
          team: state.shootoutHome > state.shootoutAway ? "home" : "away",
          message:
            teamName(
              state,
              state.shootoutHome > state.shootoutAway ? "home" : "away",
            ) +
            " win " +
            state.shootoutHome +
            "–" +
            state.shootoutAway +
            " on penalties!",
          advanceMs: timing.shootoutKickSpacingMs,
        });
        finalise(state);
        break;
      }
    }
    state.segmentIndex += 1;
    var newEventsSo = state.events.filter(function (e) {
      return e.seq > startSeq;
    });
    return { newEvents: newEventsSo, finished: state.finalised, state: state };
  }

  while (minutesDone < maxMinutesThisSeg && !state.finalised) {
    var nextMin = state.simMinute + 1;

    // Half-time transition after 45
    if (nextMin === 46 && !state.halfTimeDone) {
      state.phase = "half_time";
      pushEvent(state, {
        minute: 45,
        phase: "half_time",
        type: "half_time",
        message:
          "Half-time: " +
          state.homeName +
          " " +
          state.scoreHome +
          "–" +
          state.scoreAway +
          " " +
          state.awayName +
          ".",
        advanceMs: timing.halfTimeBreakMs,
      });
      state.halfTimeDone = true;
      pushEvent(state, {
        minute: 45,
        phase: "second_half",
        type: "second_half",
        team: "away",
        message: "Second half underway.",
      });
      state.phase = "second_half";
    }

    // Full time after 90
    if (nextMin === 91 && !state.fullTimeDone) {
      state.phase = "full_time";
      pushEvent(state, {
        minute: 90,
        phase: "full_time",
        type: "full_time",
        message:
          "Full-time: " +
          state.homeName +
          " " +
          state.scoreHome +
          "–" +
          state.scoreAway +
          " " +
          state.awayName +
          ".",
        advanceMs: timing.matchMinuteRealMs,
      });
      state.fullTimeDone = true;
      state.secondHalfDone = true;
      if (state.scoreHome !== state.scoreAway) {
        finalise(state);
        break;
      }
      // ET
      state.wentExtraTime = true;
      state.phase = "extra_time_1";
      pushEvent(state, {
        minute: 90,
        phase: "extra_time_1",
        type: "extra_time_start",
        message: "Extra time! Still level.",
        advanceMs: timing.matchMinuteRealMs,
      });
      state.etStarted = true;
    }

    // ET half
    if (nextMin === 106 && state.etStarted && !state.etHalfDone) {
      pushEvent(state, {
        minute: 105,
        phase: "extra_time_ht",
        type: "extra_time_half",
        message: "Extra-time half-time.",
        advanceMs: timing.etHalfTimeBreakMs,
      });
      state.etHalfDone = true;
      state.phase = "extra_time_2";
    }

    // End of ET
    if (nextMin === 121 && state.etStarted && !state.etEndDone) {
      pushEvent(state, {
        minute: 120,
        phase: "extra_time_end",
        type: "extra_time_end",
        message:
          "End of extra time: " +
          state.homeName +
          " " +
          state.scoreHome +
          "–" +
          state.scoreAway +
          " " +
          state.awayName +
          ".",
        advanceMs: timing.matchMinuteRealMs,
      });
      state.etEndDone = true;
      if (state.scoreHome !== state.scoreAway) {
        finalise(state);
        break;
      }
      // Enter shootout next segment
      state.phase = "shootout";
      break;
    }

    if (nextMin > 120) break;
    if (nextMin > 90 && !state.etStarted) break;

    var ph = phaseForMinute(nextMin);
    state.phase = ph;
    simulateOneMinute(state, nextMin, ph);
    minutesDone++;
  }

  state.segmentIndex += 1;
  var newEvents = state.events.filter(function (e) {
    return e.seq > startSeq;
  });
  return { newEvents: newEvents, finished: state.finalised, state: state };
}

/**
 * Reconstruct visible state from events given elapsed ms since match start.
 */
function reconstructVisible(events, elapsedMs, opts) {
  opts = opts || {};
  var list = events || [];
  var due = [];
  var scoreHome = 0;
  var scoreAway = 0;
  var shootoutHome = 0;
  var shootoutAway = 0;
  var phase = "scheduled";
  var minute = 0;
  var finished = false;
  var lastSeq = 0;
  var elapsed = typeof elapsedMs === "number" && !isNaN(elapsedMs) ? elapsedMs : 0;

  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    var off = e.offsetMs != null ? e.offsetMs : 0;
    if (off > elapsed) break;
    due.push(e);
    lastSeq = e.seq != null ? e.seq : lastSeq;
    if (e.minute != null) minute = e.minute;
    if (e.phase != null && e.phase !== "") phase = String(e.phase);
    if (e.scoreHome != null) scoreHome = e.scoreHome;
    if (e.scoreAway != null) scoreAway = e.scoreAway;
    if (e.shootoutHome != null) shootoutHome = e.shootoutHome;
    if (e.shootoutAway != null) shootoutAway = e.shootoutAway;
    if (e.type === "match_end") {
      finished = true;
      phase = "finished";
    }
  }

  if (!due.length) {
    phase = elapsed < 0 ? "scheduled" : "live";
  }

  var phaseStr = String(phase || "scheduled");
  var status = "live";
  if (finished) status = "finished";
  else if (elapsed < 0) status = "scheduled";
  else if (phaseStr === "half_time" || phaseStr === "extra_time_ht") status = "half_time";
  else if (phaseStr.indexOf("extra") === 0) status = "extra_time";
  else if (phaseStr === "shootout") status = "shootout";
  else if (phaseStr === "scheduled") status = "scheduled";
  else status = "live";

  return {
    events: due,
    eventsSince: opts.sinceSeq
      ? due.filter(function (ev) {
          return (ev.seq || 0) > opts.sinceSeq;
        })
      : due,
    scoreHome: scoreHome,
    scoreAway: scoreAway,
    shootoutHome: shootoutHome,
    shootoutAway: shootoutAway,
    phase: phaseStr,
    minute: minute,
    finished: finished,
    lastSeq: lastSeq,
    status: status,
  };
}

/** Full offline sim for tests (loops segments until done). */
function simulateMatch(opts) {
  var state = createMatchState(opts);
  var guard = 0;
  while (!state.finalised && guard < 80) {
    advanceSegment(state, {});
    guard++;
  }
  return {
    events: state.events,
    scoreHome: state.scoreHome,
    scoreAway: state.scoreAway,
    shootoutHome: state.shootoutHome,
    shootoutAway: state.shootoutAway,
    winnerSide: state.winnerSide,
    wentExtraTime: state.wentExtraTime,
    wentShootout: state.wentShootout,
    stats: state.stats,
    durationMs: state.clockMs,
    expectedFinishOffsetMs: state.clockMs,
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    createMatchState: createMatchState,
    advanceSegment: advanceSegment,
    reconstructVisible: reconstructVisible,
    simulateMatch: simulateMatch,
    effectiveStrength: effectiveStrength,
    mulberry32: mulberry32,
    hashSeed: hashSeed,
    coachingMod: coachingMod,
  };
}
