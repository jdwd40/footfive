/**
 * FootFive match engine v2 — server-authoritative, incremental, deterministic.
 *
 * - The world tick calls advanceTo(state, now). Only steps whose start time has
 *   arrived are simulated; nothing beyond the current step is pre-generated.
 * - One ordered event stream per match. Every event carries the resulting public
 *   state (`st`): score, shootout, phase, clock anchor, stats, danger flag.
 *   Scoreboards, tickers, commentary, statistics and highlights all read it.
 * - A step narrates a match minute over its real duration, so some events have
 *   `at` slightly in the future. The API only publishes events with at <= now,
 *   and no event reveals the outcome of a later one (a shot never carries its
 *   result; a penalty award never carries the kick).
 * - Shootout goals live in `so` only and never touch `score`.
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
var M = BALANCE.match;
var effectiveTeamStrength = effMod.effectiveTeamStrength;

var PERIOD_END = { first_half: 45, second_half: 90, extra_time_1: 105, extra_time_2: 120 };
var OTHER = { home: "away", away: "home" };
var LIVE_PHASES = ["first_half", "second_half", "extra_time_1", "extra_time_2"];

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
  var s = String(str);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Resumable RNG: the counter is part of the persisted state. */
function rnd(st) {
  st.rc = (st.rc || 0) + 1;
  return mulberry32((st.seed + Math.imul(st.rc, 9973)) >>> 0)();
}

function pick(st, list) {
  return list[Math.floor(rnd(st) * list.length) % list.length];
}

function emptyStats() {
  return { sh: 0, sot: 0, sv: 0, co: 0, fo: 0, yc: 0, rc: 0, pen: 0 };
}

/** Wall-clock timings (ms). `scale` > 1 speeds everything up (tests only). */
function buildTiming(minuteMs, scale) {
  var k = scale && scale > 0 ? scale : 1;
  var t = { minuteMs: Math.max(50, Math.round(minuteMs / k)) };
  var keys = [
    "halfTimeMs",
    "etBreakMs",
    "etHalfTimeMs",
    "goalPauseMs",
    "penAwardMs",
    "penSetupMs",
    "penRestartMs",
    "shootoutIntroMs",
    "shootoutKickMs",
    "shootoutRevealMs",
    "endMs",
    "resultHoldMs",
    "kickoffHoldMs",
  ];
  for (var i = 0; i < keys.length; i++) t[keys[i]] = Math.max(20, Math.round(M[keys[i]] / k));
  return t;
}

function teamState(t) {
  var src = t.players || [];
  var players = [];
  var no = 2;
  for (var i = 0; i < src.length; i++) {
    var p = src[i];
    var starter = !!p.is_starter;
    players.push({
      id: p.id || "",
      name: p.name || "Player " + (i + 1),
      role: p.role || "util",
      attack: p.attack || 50,
      defence: p.defence || 50,
      energy: p.energy != null ? p.energy : 100,
      condition: p.condition != null ? p.condition : 100,
      e0: p.energy != null ? p.energy : 100,
      c0: p.condition != null ? p.condition : 100,
      intensity: p.intensity || "balanced",
      is_starter: starter,
      sentOff: false,
      no: p.role === "gk" && starter ? 1 : no++,
    });
  }
  return {
    id: t.id || "",
    name: t.name || "Team",
    abbr: t.abbr || String(t.name || "TEA").slice(0, 3).toUpperCase(),
    grade: t.grade || "C",
    stance: t.stance || "balanced",
    ai: !!t.ai,
    oc: !!t.oc,
    players: players,
  };
}

/**
 * @param o { fixtureId, seed, kickoffAt, timing, home, away }
 *   home/away: { id, name, abbr, grade, players[], stance, ai, oc }
 */
function createMatch(o) {
  return {
    v: 2,
    fx: o.fixtureId || "",
    seed: o.seed >>> 0 || 1,
    rc: 0,
    seq: 0,
    timing: o.timing || buildTiming(15000, 1),
    teams: { home: teamState(o.home), away: teamState(o.away) },
    phase: "pre",
    minute: 0,
    nextAt: o.kickoffAt,
    score: [0, 0],
    so: null,
    stats: { home: emptyStats(), away: emptyStats() },
    possMin: [0, 0],
    ball: [50, 32],
    counter: null,
    pending: {},
    danger: false,
    winner: null,
    by: null,
    finishedAt: null,
  };
}

// ---------------------------------------------------------------- strength

function active(st, side) {
  return st.teams[side].players.filter(function (p) {
    return p.is_starter && !p.sentOff;
  });
}

function strength(st, side) {
  var t = st.teams[side];
  var list = active(st, side);
  var eff = effectiveTeamStrength(list, {
    grade: t.grade,
    coachingStance: t.stance,
    overclock: t.oc,
  });
  var numbers = Math.pow(Math.max(list.length, 1) / 5, 0.8);
  return { atk: eff.attack * numbers, def: eff.defence * numbers };
}

/** Attacking edge of `side` (about 0 for evenly matched teams). */
function edge(st, side) {
  return strength(st, side).atk - strength(st, OTHER[side]).def + M.edgeOffset;
}

function keeper(st, side) {
  var list = active(st, side);
  for (var i = 0; i < list.length; i++) if (list[i].role === "gk") return list[i];
  return list[list.length - 1] || st.teams[side].players[0];
}

function weightedPick(st, list, weightFn) {
  var total = 0;
  for (var i = 0; i < list.length; i++) total += weightFn(list[i]);
  var r = rnd(st) * total;
  for (var j = 0; j < list.length; j++) {
    r -= weightFn(list[j]);
    if (r <= 0) return list[j];
  }
  return list[list.length - 1];
}

function outfield(st, side, exclude) {
  var list = active(st, side).filter(function (p) {
    return p.role !== "gk" && (!exclude || p.name !== exclude.name);
  });
  return list.length ? list : active(st, side);
}

function attacker(st, side, exclude) {
  return weightedPick(st, outfield(st, side, exclude), function (p) {
    return (p.attack || 50) + 10;
  });
}

function defender(st, side) {
  return weightedPick(st, outfield(st, side), function (p) {
    return (p.defence || 50) + 10;
  });
}

/** Per-minute probabilities for an attacking side. */
function chanceModel(st, side) {
  var e = edge(st, side);
  return {
    e: e,
    pSeq: clamp(M.seqBase * Math.exp(M.seqK * e), 0.08, 0.6),
    pShot: clamp(M.shotBase * Math.exp(M.shotK * e), 0.2, 0.85),
    pOn: clamp(M.onTargetBase * Math.exp(M.onTargetK * e), 0.25, 0.75),
    pPen: clamp(M.penBase + M.penK * Math.max(0, e), 0, 0.05),
  };
}

function saveChance(st, shooter, defSide) {
  var gk = keeper(st, defSide);
  return clamp(M.saveBase + ((gk.defence || 60) - (shooter.attack || 60)) * M.saveK, 0.3, 0.8);
}

function homePossession(st) {
  var h = strength(st, "home");
  var a = strength(st, "away");
  var p = 0.5 + ((h.atk + h.def) / 2 - (a.atk + a.def) / 2) * M.possK;
  if (st.counter === "home") p += 0.15;
  if (st.counter === "away") p -= 0.15;
  return clamp(p, 0.25, 0.75);
}

/** Expected goals per match minute for each side — the odds model uses this. */
function goalRates(st) {
  var out = {};
  var saved = st.counter;
  st.counter = null;
  var ph = homePossession(st);
  st.counter = saved;
  ["home", "away"].forEach(function (side) {
    var c = chanceModel(st, side);
    var save = saveChance(st, { attack: 72 }, OTHER[side]);
    var poss = side === "home" ? ph : 1 - ph;
    out[side] =
      poss *
      c.pSeq *
      ((1 - c.pPen) * c.pShot * (1 - M.blockRate) * c.pOn * (1 - save) + c.pPen * M.penScore);
  });
  return out;
}

// ---------------------------------------------------------------- emission

function statArr(s) {
  return [s.sh, s.sot, s.sv, s.co, s.fo, s.yc, s.rc, s.pen];
}

function snapshot(st, clk) {
  var tot = st.possMin[0] + st.possMin[1];
  var pos = tot ? Math.round((st.possMin[0] / tot) * 100) : 50;
  var so = null;
  if (st.so) {
    so = {
      h: st.so.h,
      a: st.so.a,
      th: st.so.th,
      ta: st.so.ta,
      first: st.so.first,
      next: st.so.done ? null : st.so.next,
      sd: st.so.th >= 5 && st.so.ta >= 5 && !st.so.done,
      k: st.so.kicks.map(function (k) {
        return [k.side === "home" ? 0 : 1, k.outcome, k.taker];
      }),
    };
  }
  return {
    sc: [st.score[0], st.score[1]],
    so: so,
    ph: st.phase,
    clk: clk,
    pos: pos,
    x: [statArr(st.stats.home), statArr(st.stats.away)],
    d: st.danger ? 1 : 0,
    win: st.winner,
    by: st.by,
  };
}

function emit(st, out, t, type, ev) {
  st.seq += 1;
  var e = ev || {};
  e.seq = st.seq;
  // Publication order must equal sequence order.
  e.at = Math.max(Math.round(t), st.lastAt || 0);
  st.lastAt = e.at;
  e.t = type;
  if (e.min == null) e.min = st.minute;
  e.st = snapshot(st, e.clk === undefined ? null : e.clk);
  delete e.clk;
  out.push(e);
  return e;
}

function abbr(st, side) {
  return st.teams[side].abbr;
}

function tname(st, side) {
  return st.teams[side].name;
}

function scoreline(st) {
  return abbr(st, "home") + " " + st.score[0] + "–" + st.score[1] + " " + abbr(st, "away");
}

function vs(st) {
  return abbr(st, "home") + " v " + abbr(st, "away");
}

/** Pitch is 100 x 64. Home attacks towards x = 100, away towards x = 0. */
function px(side, x) {
  return side === "home" ? x : 100 - x;
}

function pos(side, x, y) {
  return [Math.round(px(side, x)), Math.round(y)];
}

// ---------------------------------------------------------------- minute

function applyStance(st, out, t, s, side, stance, by) {
  var team = st.teams[side];
  if (team.stance === stance) return;
  team.stance = stance;
  emit(st, out, t, "coaching", {
    side: side,
    stance: stance,
    by: by,
    min: Math.floor(s / 60) + 1, // the minute it takes effect
    text:
      stance === "attack"
        ? tname(st, side) + " push forward — Attack"
        : stance === "defend"
          ? tname(st, side) + " drop deeper — Defend"
          : tname(st, side) + " settle back to Balanced",
    clk: { s: s, run: 1 },
  });
}

function aiStance(st, side) {
  var mine = st.score[side === "home" ? 0 : 1];
  var theirs = st.score[side === "home" ? 1 : 0];
  var m = st.minute + 1; // called before the minute starts
  if (m >= 70 && mine < theirs) return "attack";
  if (m >= 100 && mine === theirs) return "attack";
  if (m >= 78 && mine === theirs + 1) return "defend";
  return "balanced";
}

function wear(st) {
  ["home", "away"].forEach(function (side) {
    var list = active(st, side);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var im = BALANCE.intensity[p.intensity] || BALANCE.intensity.balanced;
      p.energy = clamp(p.energy - BALANCE.energyDrainPerMinute * (im.energyUse || 1), 0, 100);
      p.condition = clamp(p.condition - BALANCE.conditionWearPerMinute * (im.condition || 1), 0, 100);
    }
  });
}

/** Minute context: absolute time and clock for a fraction of the minute. */
function Ctx(st) {
  this.t0 = st.nextAt;
  this.m = st.minute + 1;
  this.s0 = (this.m - 1) * 60;
  this.dur = st.timing.minuteMs;
  this.pause = 0;
}
Ctx.prototype.at = function (f) {
  return this.t0 + Math.round(f * this.dur) + this.pause;
};
Ctx.prototype.s = function (f) {
  return this.s0 + Math.min(59, Math.floor(f * 60));
};
Ctx.prototype.clk = function (f) {
  return { s: this.s(f), run: 1 };
};

function playMinute(st, out) {
  var ctx = new Ctx(st);
  ["home", "away"].forEach(function (side) {
    var team = st.teams[side];
    if (team.ai) applyStance(st, out, ctx.t0, ctx.s0, side, aiStance(st, side), "ai");
    else if (st.pending[side]) applyStance(st, out, ctx.t0, ctx.s0, side, st.pending[side], "manager");
    delete st.pending[side];
  });
  st.minute = ctx.m;

  wear(st);
  var side = rnd(st) < homePossession(st) ? "home" : "away";
  st.counter = null;
  st.possMin[side === "home" ? 0 : 1] += 1;

  var cm = BALANCE.coaching;
  var foulMul = ((cm[st.teams.home.stance] || cm.balanced).foul + (cm[st.teams.away.stance] || cm.balanced).foul) / 2;
  if (rnd(st) < M.foulRate * foulMul) foulEvent(st, out, ctx, OTHER[side]);

  var c = chanceModel(st, side);
  if (rnd(st) < c.pSeq) attack(st, out, ctx, side, c);
  else midfield(st, out, ctx, side);

  st.nextAt = ctx.t0 + ctx.dur + ctx.pause;
  if (PERIOD_END[st.phase] === ctx.m) periodEnd(st, out);
}

/** Off-ball minute: 2–3 passes, maybe lost to a tackle. Keeps the pitch alive between attacks. */
function midfield(st, out, ctx, side) {
  var f = 0.1 + rnd(st) * 0.1;
  var last = attacker(st, side);
  var n = 2 + (rnd(st) < 0.5 ? 1 : 0);
  for (var i = 0; i < n; i++) {
    var recv = attacker(st, side, last);
    var from = st.ball;
    st.ball = pos(side, 25 + rnd(st) * 30, 8 + rnd(st) * 48);
    emit(st, out, ctx.at(f), "pass", {
      side: side,
      p: last.name,
      p2: recv.name,
      from: from,
      ball: st.ball,
      text: pick(st, [last.name + " to " + recv.name, last.name + " knocks it to " + recv.name, recv.name + " takes it off " + last.name]),
      clk: ctx.clk(f),
    });
    last = recv;
    f += 0.22;
  }
  if (rnd(st) < 0.4) {
    var d = defender(st, OTHER[side]);
    var from2 = st.ball;
    st.ball = pos(OTHER[side], 30 + rnd(st) * 20, clamp(st.ball[1] + (rnd(st) - 0.5) * 16, 6, 58));
    emit(st, out, ctx.at(f), "tackle", { side: OTHER[side], p: d.name, p2: last.name, from: from2, ball: st.ball, text: d.name + " wins it back for " + abbr(st, OTHER[side]), clk: ctx.clk(f) });
    st.counter = OTHER[side];
  }
}

function foulEvent(st, out, ctx, side) {
  var offender = defender(st, side);
  var victim = attacker(st, OTHER[side]);
  st.stats[side].fo += 1;
  var f = 0.04;
  emit(st, out, ctx.at(f), "foul", {
    side: side,
    p: offender.name,
    p2: victim.name,
    ball: st.ball,
    text: "Foul by " + offender.name + " on " + victim.name,
    clk: ctx.clk(f),
  });
  var r = rnd(st);
  var card = null;
  if (r < M.straightRed) card = "red";
  else if (r < M.straightRed + M.yellowRate) {
    offender.yellows = (offender.yellows || 0) + 1;
    card = offender.yellows >= 2 ? "second_yellow" : "yellow";
  }
  if (!card) return;
  if (card === "yellow") {
    st.stats[side].yc += 1;
    emit(st, out, ctx.at(f + 0.05), "yellow_card", {
      side: side,
      p: offender.name,
      text: "Yellow card — " + offender.name + " (" + abbr(st, side) + ")",
      clk: ctx.clk(f + 0.05),
    });
    ctx.pause += st.timing.resultHoldMs; // the card is shown before play moves on
    return;
  }
  offender.sentOff = true;
  st.stats[side].rc += 1;
  emit(st, out, ctx.at(f + 0.05), "red_card", {
    side: side,
    p: offender.name,
    major: 1,
    text: (card === "red" ? "Red card! " : "Second yellow! ") + offender.name + " (" + abbr(st, side) + ") is sent off",
    tick: vs(st) + " — Red card: " + offender.name + " (" + abbr(st, side) + "), " + ctx.m + "′.",
    clk: ctx.clk(f + 0.05),
  });
  ctx.pause += st.timing.resultHoldMs;
}

/**
 * One coherent attacking sequence:
 * build-up → passes → progression (through ball / dribble / cross) → outcome.
 * The outcome is decided first so every narrated step agrees with it.
 */
function attack(st, out, ctx, side, c) {
  var def = OTHER[side];
  var outcome;
  if (rnd(st) < c.pPen) outcome = "penalty";
  else if (rnd(st) < c.pShot) {
    if (rnd(st) < M.blockRate) outcome = "block";
    else if (rnd(st) < c.pOn) outcome = "on_target";
    else outcome = rnd(st) < M.woodworkRate ? "woodwork" : "miss";
  } else outcome = rnd(st) < 0.55 ? "tackle" : "interception";

  var chain = st.seq + 1;
  var f = 0.12 + rnd(st) * 0.08;
  var STEP = 0.11;
  var passer = attacker(st, side);
  var x = st.counter === side ? 48 : 20 + rnd(st) * 18;
  var y = 12 + rnd(st) * 40;
  var ball = pos(side, x, y);
  emit(st, out, ctx.at(f), "build_up", {
    side: side,
    chain: chain,
    p: passer.name,
    from: st.ball,
    ball: ball,
    text:
      st.counter === side
        ? tname(st, side) + " break quickly through " + passer.name
        : pick(st, [tname(st, side) + " build from the back", passer.name + " collects for " + abbr(st, side), tname(st, side) + " work it forward"]),
    clk: ctx.clk(f),
  });

  var last = passer;
  var passes = 2 + Math.floor(rnd(st) * 2);
  for (var i = 0; i < passes; i++) {
    f += STEP;
    var back = i > 0 && rnd(st) < 0.4 && passer.name !== last.name;
    var recv = back ? passer : attacker(st, side, last);
    x = Math.min(x + 8 + rnd(st) * 9, 68);
    y = clamp(y + (rnd(st) - 0.5) * 28, 6, 58);
    var from = ball;
    ball = pos(side, x, y);
    emit(st, out, ctx.at(f), "pass", {
      side: side,
      chain: chain,
      p: last.name,
      p2: recv.name,
      from: from,
      ball: ball,
      text: back
        ? recv.name + " gets the return pass from " + last.name
        : pick(st, [last.name + " finds " + recv.name, last.name + " slides it to " + recv.name, last.name + " plays it into " + recv.name]),
      clk: ctx.clk(f),
    });
    last = recv;
  }

  if (outcome === "tackle" || outcome === "interception") {
    f += STEP;
    var d = defender(st, def);
    var from2 = ball;
    ball = pos(side, Math.min(x + 6 + rnd(st) * 10, 74), clamp(y + (rnd(st) - 0.5) * 16, 6, 58));
    emit(st, out, ctx.at(f), outcome, {
      side: def,
      chain: chain,
      p: d.name,
      p2: last.name,
      from: from2,
      ball: ball,
      text:
        outcome === "tackle"
          ? pick(st, [d.name + " slides in and wins it for " + abbr(st, def), d.name + " stands up " + last.name + " and takes the ball"])
          : pick(st, [d.name + " reads it and intercepts", d.name + " steps in to cut out the pass"]),
      clk: ctx.clk(f),
    });
    st.ball = ball;
    st.counter = def;
    return;
  }

  // Progression into the final third — markets suspend until the outcome is public.
  f += STEP;
  var kind = outcome === "penalty" ? pick(st, ["dribble", "through_ball"]) : pick(st, ["through_ball", "dribble", "cross", "through_ball"]);
  var runner = kind === "dribble" ? last : attacker(st, side, last);
  var from3 = ball;
  x = outcome === "penalty" ? 86 + rnd(st) * 4 : 74 + rnd(st) * 10;
  y = kind === "cross" ? (y < 32 ? 5 + rnd(st) * 6 : 53 + rnd(st) * 6) : clamp(20 + rnd(st) * 24, 14, 50);
  ball = pos(side, x, y);
  st.danger = true;
  emit(st, out, ctx.at(f), kind, {
    side: side,
    chain: chain,
    p: kind === "dribble" ? runner.name : last.name,
    p2: runner.name,
    from: from3,
    ball: ball,
    text:
      kind === "through_ball"
        ? pick(st, [last.name + " threads a through ball for " + runner.name, "Defence split — " + last.name + " releases " + runner.name])
        : kind === "dribble"
          ? pick(st, [runner.name + " drives at the " + abbr(st, def) + " defence", runner.name + " skips past a challenge"])
          : last.name + " goes wide to " + runner.name + ", who crosses",
    clk: ctx.clk(f),
  });

  if (outcome === "penalty") return penalty(st, out, ctx, side, runner, f + STEP, chain);

  var shooter = kind === "cross" ? attacker(st, side, runner) : runner;
  var shotFrom = kind === "cross" ? pos(side, 84 + rnd(st) * 6, 24 + rnd(st) * 16) : ball;
  if (outcome === "on_target") outcome = rnd(st) < saveChance(st, shooter, def) ? "save" : "goal";

  f += STEP;
  st.stats[side].sh += 1;
  var gy = 28.5 + rnd(st) * 7; // goal mouth spans y 28..36
  emit(st, out, ctx.at(f), "shot", {
    side: side,
    chain: chain,
    p: shooter.name,
    from: kind === "cross" ? ball : null,
    ball: shotFrom,
    header: kind === "cross" ? 1 : 0,
    text: kind === "cross" ? shooter.name + " rises to meet it!" : pick(st, [shooter.name + " shoots!", shooter.name + " lets fly!", shooter.name + " goes for goal"]),
    clk: ctx.clk(f),
  });

  f += 0.08;
  var gk = keeper(st, def);
  if (outcome === "goal") {
    goal(st, out, ctx, f, side, shooter, gk, chain, [px(side, 100), gy], null);
    return;
  }
  var res = { chain: chain, from: shotFrom, clk: ctx.clk(f) };
  if (outcome === "save") {
    st.stats[side].sot += 1;
    st.stats[def].sv += 1;
    res.side = def;
    res.p = gk.name;
    res.p2 = shooter.name;
    res.target = [px(side, 100), gy];
    res.ball = [px(side, 96), Math.round(gy)];
    res.text = pick(st, [gk.name + " saves from " + shooter.name, "Brilliant stop by " + gk.name + "!", gk.name + " gets down to deny " + shooter.name]);
    st.counter = rnd(st) < 0.3 ? def : null;
  } else if (outcome === "block") {
    var blocker = defender(st, def);
    res.side = def;
    res.p = blocker.name;
    res.p2 = shooter.name;
    res.ball = pos(side, Math.min(px(side, shotFrom[0]) + 5, 93), shotFrom[1]);
    res.text = blocker.name + " blocks " + shooter.name + "'s shot";
  } else if (outcome === "woodwork") {
    var bar = rnd(st) < 0.35;
    res.side = side;
    res.p = shooter.name;
    res.post = bar ? "bar" : gy < 32 ? "left" : "right";
    res.target = [px(side, 100), bar ? 32 : gy < 32 ? 28 : 36];
    res.ball = pos(side, 92, bar ? 32 : gy < 32 ? 24 : 40);
    res.text = bar ? "Off the crossbar! " + shooter.name + " so close" : shooter.name + " hits the post!";
  } else {
    // Wide or over: the commentary and the highlight use the same choice.
    var over = rnd(st) < 0.4;
    var low = rnd(st) < 0.5;
    res.side = side;
    res.p = shooter.name;
    res.high = over ? 1 : 0;
    res.target = [px(side, 100), over ? 29 + rnd(st) * 6 : low ? 22 + rnd(st) * 4 : 38 + rnd(st) * 4];
    res.ball = res.target;
    res.text = over
      ? pick(st, [shooter.name + " fires over the bar", shooter.name + " can't keep it down"])
      : pick(st, [shooter.name + " drags it wide", shooter.name + " pulls it wide of the post"]);
  }
  st.danger = false; // the outcome is public with this event, so markets reopen
  emit(st, out, ctx.at(f), outcome, res);
  ctx.pause += st.timing.resultHoldMs; // the save/miss/block is shown before play moves on (shifts the rest of the minute)
  st.ball = res.ball;
  // No corners/throw-ins in FootFive: the ball rebounds off the boards and play continues. A miss always leaves the pitch.
  if (outcome === "miss" || (outcome === "block" && rnd(st) < 0.45)) bounce(st, out, ctx, f + 0.06, def, chain);
}

/** Ball hits a board and comes back into play; `side` is the team that picks it up. */
function bounce(st, out, ctx, f, side, chain) {
  var wall = rnd(st) < 0.5 ? "side" : "end";
  var hit = wall === "side" ? [clamp(st.ball[0] + Math.round((rnd(st) - 0.5) * 20), 2, 98), rnd(st) < 0.5 ? 0 : 64] : [px(OTHER[side], 100), clamp(st.ball[1] + Math.round((rnd(st) - 0.5) * 24), 4, 60)];
  var p = defender(st, side);
  st.ball = pos(side, 20 + rnd(st) * 20, 10 + rnd(st) * 44);
  emit(st, out, ctx.at(f), "bounce", {
    side: side,
    chain: chain,
    p: p.name,
    from: hit,
    ball: st.ball,
    text: pick(st, ["Off the boards! " + p.name + " collects for " + abbr(st, side), "The ball rattles the " + wall + " board and " + p.name + " brings it back in"]),
    clk: ctx.clk(f),
  });
}

/** Goal at fraction f of the minute. The clock freezes during the celebration. */
function goal(st, out, ctx, f, side, scorer, gk, chain, target, pen) {
  var T = st.timing;
  if (side === "home") st.score[0] += 1;
  else st.score[1] += 1;
  st.stats[side].sot += 1; // on-target is counted with the result, so the shot's snapshot can't leak it
  var s = ctx.s(f);
  var t = ctx.at(f);
  st.danger = true;
  emit(st, out, t, pen ? "penalty_goal" : "goal", {
    side: side,
    chain: chain,
    p: scorer.name,
    p2: gk.name,
    target: target,
    ball: target,
    pen: pen,
    major: 1,
    text: (pen ? "PENALTY SCORED! " : "GOAL! ") + scorer.name + " scores for " + tname(st, side),
    tick: scoreline(st) + " — " + scorer.name + (pen ? " scores the penalty, " : " scores, ") + ctx.m + "′.",
    clk: { s: s, run: 0 },
  });
  emit(st, out, t + Math.round(T.goalPauseMs * 0.35), "celebration", {
    side: side,
    chain: chain,
    p: scorer.name,
    text: pick(st, [scorer.name + " wheels away to celebrate", tname(st, side) + " mob " + scorer.name, scorer.name + " salutes the travelling fans"]),
    clk: { s: s, run: 0 },
  });
  ctx.pause += T.goalPauseMs;
  st.danger = false;
  st.ball = [50, 32];
  st.counter = null;
  emit(st, out, t + T.goalPauseMs, "restart", {
    side: OTHER[side],
    ball: [50, 32],
    text: tname(st, OTHER[side]) + " restart from the centre",
    clk: { s: s, run: 1 },
  });
}

/** Penalty kick: outcome plus a visual plan (column -1..1, height 0..2, keeper dive). */
function penaltyShot(st, taker, gk, scoreRate) {
  var saveRate = clamp(M.penSave + ((gk.defence || 70) - (taker.attack || 70)) * 0.002, 0.08, 0.3);
  var r = rnd(st);
  var outcome = r < scoreRate ? "goal" : r < scoreRate + saveRate ? "save" : rnd(st) < 0.35 ? "woodwork" : "miss";
  var col = pick(st, [-1, -1, 0, 1, 1]);
  var height = rnd(st) < 0.4 ? 1 : 0;
  var dive = pick(st, [-1, 0, 1]);
  var post = null;
  if (outcome === "save") dive = col;
  if (outcome === "goal" && dive === col) {
    if (col === 0) dive = pick(st, [-1, 1]);
    else height = 1; // right way, but beaten by pace and height
  }
  if (outcome === "miss") {
    if (rnd(st) < 0.5) height = 2;
    else col = col === 0 ? pick(st, [-2, 2]) : col * 2;
  }
  if (outcome === "woodwork") {
    if (rnd(st) < 0.35) {
      post = "bar";
      height = 2;
      col = col || pick(st, [-1, 1]);
    } else {
      col = col || pick(st, [-1, 1]);
      post = col < 0 ? "left" : "right";
    }
  }
  return { outcome: outcome, col: col, height: height, dive: dive, post: post, run: pick(st, [0, 1, 2]) };
}

function penalty(st, out, ctx, side, fouled, f, chain) {
  var T = st.timing;
  var def = OTHER[side];
  var offender = defender(st, def);
  var gk = keeper(st, def);
  var taker = outfield(st, side)
    .slice()
    .sort(function (a, b) {
      return (b.attack || 0) - (a.attack || 0);
    })[0];
  st.stats[side].pen += 1;
  st.stats[def].fo += 1;
  var s = ctx.s(f);
  var spot = [px(side, 89), 32];
  st.danger = true;
  var award = emit(st, out, ctx.at(f), "penalty_awarded", {
    side: side,
    chain: chain,
    p: fouled.name,
    p2: offender.name,
    ball: spot,
    major: 1,
    text: "PENALTY to " + tname(st, side) + "! " + fouled.name + " is brought down by " + offender.name,
    tick: vs(st) + " — Penalty awarded to " + tname(st, side) + ".",
    clk: { s: s, run: 0 },
  });
  var shot = penaltyShot(st, taker, gk, M.penScore);
  var tSetup = award.at + T.penAwardMs;
  emit(st, out, tSetup, "penalty_setup", {
    side: side,
    chain: chain,
    p: taker.name,
    p2: gk.name,
    ball: spot,
    text: taker.name + " places the ball. " + gk.name + " waits on the line.",
    clk: { s: s, run: 0 },
  });
  var tKick = tSetup + T.penSetupMs;
  var plan = { col: shot.col, height: shot.height, dive: shot.dive, post: shot.post, run: shot.run, outcome: shot.outcome };
  st.stats[side].sh += 1;
  if (shot.outcome === "save") st.stats[side].sot += 1; // goal() counts its own
  if (shot.outcome === "goal") {
    // Re-anchor the minute so the goal lands at the kick time.
    ctx.pause += tKick - ctx.at(f);
    goal(st, out, ctx, f, side, taker, gk, chain, [px(side, 100), 32 + shot.col * 2.5], plan);
    return;
  }
  if (shot.outcome === "save") st.stats[def].sv += 1;
  var what = shot.outcome === "save" ? "saved" : shot.outcome === "woodwork" ? "woodwork" : "missed";
  var woodText = shot.post === "bar" ? "the bar" : "the post";
  var resEv = emit(st, out, tKick, "penalty_" + what, {
    side: side,
    chain: chain,
    p: taker.name,
    p2: gk.name,
    pen: plan,
    ball: spot,
    major: 1,
    text:
      shot.outcome === "save"
        ? gk.name + " saves " + taker.name + "'s penalty!"
        : shot.outcome === "woodwork"
          ? taker.name + " hits " + woodText + " from the spot!"
          : taker.name + " puts the penalty " + (shot.height === 2 ? "over" : "wide") + "!",
    tick:
      vs(st) +
      " — " +
      (shot.outcome === "save" ? "Penalty saved by " + gk.name + "." : shot.outcome === "woodwork" ? taker.name + " hits " + woodText + " from the spot." : taker.name + " misses the penalty."),
    clk: { s: s, run: 0 },
  });
  st.ball = [px(side, 95), 32];
  st.counter = def;
  st.danger = false;
  emit(st, out, resEv.at + T.penRestartMs, "restart", {
    side: def,
    ball: st.ball,
    text: tname(st, def) + " clear their lines",
    clk: { s: s, run: 1 },
  });
  ctx.pause += resEv.at + T.penRestartMs - ctx.at(f);
}

// ---------------------------------------------------------------- periods

function periodEnd(st, out) {
  var T = st.timing;
  var t = st.nextAt;
  var m = st.minute;
  st.danger = false;
  if (m === 45) {
    st.phase = "half_time";
    emit(st, out, t, "half_time", { text: "Half-time: " + scoreline(st), clk: { s: 2700, run: 0 } });
    st.nextAt = t + T.halfTimeMs;
  } else if (m === 90) {
    if (st.score[0] !== st.score[1]) return finish(st, out, t, "normal");
    st.phase = "et_break";
    emit(st, out, t, "end_of_normal_time", {
      major: 1,
      text: "90 minutes up: " + scoreline(st) + " — extra time to come",
      tick: scoreline(st) + " after 90 minutes — extra time.",
      clk: { s: 5400, run: 0 },
    });
    st.nextAt = t + T.etBreakMs;
  } else if (m === 105) {
    st.phase = "et_half_time";
    emit(st, out, t, "et_half_time", { text: "Extra-time half-time: " + scoreline(st), clk: { s: 6300, run: 0 } });
    st.nextAt = t + T.etHalfTimeMs;
  } else if (m === 120) {
    if (st.score[0] !== st.score[1]) return finish(st, out, t, "aet");
    st.phase = "shootout";
    var first = rnd(st) < 0.5 ? "home" : "away";
    st.so = { h: 0, a: 0, th: 0, ta: 0, first: first, next: first, kicks: [], done: false };
    emit(st, out, t, "shootout_start", {
      side: first,
      major: 1,
      text: "Penalty shootout! " + tname(st, first) + " kick first",
      tick: vs(st) + " — Penalty shootout. " + abbr(st, first) + " kick first.",
    });
    st.nextAt = t + T.shootoutIntroMs;
  }
}

function resume(st, out, type, phase, s, text) {
  st.phase = phase;
  emit(st, out, st.nextAt, type, { text: text, clk: { s: s, run: 1 } });
  st.nextAt += st.timing.kickoffHoldMs; // announcement + walk-on before the first play
}

function finish(st, out, t, by) {
  st.winner = by === "pens" ? (st.so.h > st.so.a ? "home" : "away") : st.score[0] > st.score[1] ? "home" : "away";
  st.by = by;
  st.phase = "finished";
  st.danger = false;
  var w = st.winner;
  var soTxt = st.so ? " (" + abbr(st, w) + " win " + Math.max(st.so.h, st.so.a) + "–" + Math.min(st.so.h, st.so.a) + " on penalties)" : "";
  var e = emit(st, out, t, "match_end", {
    side: w,
    major: 1,
    text: "Full-time: " + scoreline(st) + (by === "aet" ? " after extra time" : "") + soTxt + ". " + tname(st, w) + " go through.",
    tick: (by === "aet" ? "AET: " : "FT: ") + scoreline(st) + soTxt + ". " + abbr(st, w) + " go through.",
    clk: { s: st.minute * 60, run: 0 },
  });
  st.finishedAt = e.at;
  st.nextAt = Infinity;
}

// ---------------------------------------------------------------- shootout

function shootoutOrder(st, side) {
  var list = active(st, side);
  var field = list
    .filter(function (p) {
      return p.role !== "gk";
    })
    .sort(function (a, b) {
      return (b.attack || 0) - (a.attack || 0);
    });
  return field.concat(
    list.filter(function (p) {
      return p.role === "gk";
    }),
  );
}

/**
 * Winner side when decided, else null. Five kicks each, ending early when one side
 * can no longer catch up; then sudden death decided only after an equal number of kicks.
 */
function shootoutDecided(h, a, th, ta) {
  if (th <= 5 && ta <= 5) {
    if (h + (5 - th) < a) return "away";
    if (a + (5 - ta) < h) return "home";
    return null;
  }
  if (th === ta && h !== a) return h > a ? "home" : "away";
  return null;
}

function shootoutKick(st, out) {
  var T = st.timing;
  var so = st.so;
  var side = so.next;
  var def = OTHER[side];
  var taken = side === "home" ? so.th : so.ta;
  var order = shootoutOrder(st, side);
  var taker = order[taken % order.length];
  var gk = keeper(st, def);
  var no = taken + 1;
  var sudden = no > 5;
  var nh = so.th + (side === "home" ? 1 : 0);
  var na = so.ta + (side === "away" ? 1 : 0);
  var ifMiss = shootoutDecided(so.h, so.a, nh, na);
  var ifGoal = shootoutDecided(so.h + (side === "home" ? 1 : 0), so.a + (side === "away" ? 1 : 0), nh, na);
  var t0 = st.nextAt;
  st.danger = true; // shootout markets stay suspended from setup to result
  emit(st, out, t0, "shootout_setup", {
    side: side,
    p: taker.name,
    p2: gk.name,
    kick: { no: no, sd: sudden ? 1 : 0, must: ifMiss === def ? 1 : 0, win: ifGoal === side ? 1 : 0 },
    text:
      taker.name +
      " steps up for " +
      tname(st, side) +
      (ifGoal === side ? " — score and " + abbr(st, side) + " win it!" : ifMiss === def ? " — must score to stay alive" : sudden ? " — sudden death" : ""),
  });
  var shot = penaltyShot(st, taker, gk, M.shootoutScore);
  var outcome = shot.outcome;
  if (side === "home") {
    so.th += 1;
    if (outcome === "goal") so.h += 1;
  } else {
    so.ta += 1;
    if (outcome === "goal") so.a += 1;
  }
  so.kicks.push({ side: side, taker: taker.name, outcome: outcome });
  var decided = shootoutDecided(so.h, so.a, so.th, so.ta);
  so.next = def;
  if (decided) so.done = true;
  st.danger = false;
  var woodText = shot.post === "bar" ? "the bar" : "the post";
  var res = emit(st, out, t0 + T.shootoutRevealMs, "shootout_kick", {
    side: side,
    p: taker.name,
    p2: gk.name,
    pen: { col: shot.col, height: shot.height, dive: shot.dive, post: shot.post, run: shot.run, outcome: outcome },
    kick: { no: no, sd: sudden ? 1 : 0, outcome: outcome, decisive: decided ? 1 : 0 },
    major: 1,
    text:
      outcome === "goal"
        ? pick(st, [taker.name + " scores!", taker.name + " buries it!", "Cool finish from " + taker.name + "!"])
        : outcome === "save"
          ? gk.name + " saves from " + taker.name + "!"
          : outcome === "woodwork"
            ? taker.name + " hits " + woodText + "!"
            : taker.name + " misses!",
    tick:
      vs(st) +
      " pens " +
      so.h +
      "–" +
      so.a +
      " — " +
      (outcome === "goal" ? taker.name + " scores." : outcome === "save" ? gk.name + " saves from " + taker.name + "." : taker.name + " misses."),
  });
  if (!decided) {
    st.nextAt = t0 + T.shootoutKickMs;
    return;
  }
  var wl = decided === "home" ? so.h + "–" + so.a : so.a + "–" + so.h;
  var end = emit(st, out, res.at + Math.round(T.endMs * 0.6), "shootout_end", {
    side: decided,
    major: 1,
    text: tname(st, decided) + " win the shootout " + wl + "!",
    tick: abbr(st, decided) + " win the shootout " + wl + ".",
  });
  finish(st, out, end.at + T.endMs, "pens");
}

// ---------------------------------------------------------------- driver

function step(st, out) {
  switch (st.phase) {
    case "pre":
      st.phase = "first_half";
      emit(st, out, st.nextAt, "kickoff", {
        side: "home",
        ball: [50, 32],
        text: "Kick-off! " + tname(st, "home") + " v " + tname(st, "away"),
        clk: { s: 0, run: 1 },
      });
      st.nextAt += st.timing.kickoffHoldMs;
      return;
    case "half_time":
      return resume(st, out, "second_half", "second_half", 2700, "Second half under way");
    case "et_break":
      return resume(st, out, "extra_time", "extra_time_1", 5400, "Extra time under way");
    case "et_half_time":
      return resume(st, out, "et_second_half", "extra_time_2", 6300, "Second period of extra time");
    case "shootout":
      return shootoutKick(st, out);
    default:
      if (LIVE_PHASES.indexOf(st.phase) >= 0) return playMinute(st, out);
      st.nextAt = Infinity;
  }
}

/** Simulate every step whose start time is <= now. Returns the new events in order. */
function advanceTo(st, now) {
  var out = [];
  var guard = 0;
  while (st.phase !== "finished" && st.nextAt <= now && guard++ < 5000) step(st, out);
  return out;
}

/** Queue a manager stance; it applies from the next simulated minute. */
function queueStance(st, side, stance) {
  st.pending[side] = stance;
}

if (typeof module !== "undefined") {
  module.exports = {
    createMatch: createMatch,
    advanceTo: advanceTo,
    queueStance: queueStance,
    buildTiming: buildTiming,
    goalRates: goalRates,
    shootoutDecided: shootoutDecided,
    hashSeed: hashSeed,
    mulberry32: mulberry32,
    LIVE_PHASES: LIVE_PHASES,
  };
}
