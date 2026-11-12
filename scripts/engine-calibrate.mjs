// Engine calibration: goals/90, ET and shootout rates, upset rate, shots, shot gaps, odds model, event sanity.
// Usage: node scripts/engine-calibrate.mjs [matches=2000] [--pairs all] [--prefix cal]
// Default: TEAMS[i%16] v TEAMS[(7i+3)%16] (16 distinct pairings) at an explicit 15 s snapshot. `--pairs all` reproduces the
// balance acceptance runs instead: all 240 ordered pairings with equal weight (use a multiple of 240, e.g. 4800), at the 6 s
// production pace (cosmetic tries need spare time in a minute, so the pace matters for them). Match i is seeded hashSeed(prefix + i).
// longestShotGap: per match, the longest gap in match minutes between consecutive real shots (open-play shots and
// penalties, normal time), averaged. modelGoals90 is the odds model (goalRates, built as worldService.pairModel does)
// over the same fixtures; modelVsSim compares it with the simulated goals/90.
// finalThirdEntries: real progressions (through ball, dribble, cross) a match; finalThirdStops: those that end in a tackle,
// clearance or keeper claim instead of a shot (#218). longestChanceGap: as longestShotGap, counting progressions and cosmetic
// chances (a cosmetic try's shot row) as chances too.
// #219: counterAttacks (chains whose build-up carries `ctr`), reboundShots (shot rows with `reb`, the second shot in a chain),
// trailing (normal time: the side behind at the start of a minute, its real shots per minute it had the ball, before and
// from 70'; "inclCos" adds its cosmetic tries, the issue's definition; possession = side of the minute's first build-up or
// pass, as the harness), and stagedGoals90: the in-play odds model's expected normal-time goals from kick-off, walking the
// game states (odds.stageRates) — compare it with goalsPer90, as modelGoals90 (kickoff rates only) was before.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const eng = require("../pocketbase/pb_hooks/lib/matchEngine.js");
const { TEAMS } = require("../pocketbase/pb_hooks/lib/teams.js");
const { defaultStarters } = require("../pocketbase/pb_hooks/lib/tournament.js");
const odds = require("../pocketbase/pb_hooks/lib/odds.js");

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const N = Number(args.find((a, i) => /^\d+$/.test(a) && !String(args[i - 1]).startsWith("--")) || 2000);
const PAIRS = flag("pairs", "calibrate");
const PREFIX = flag("prefix", "cal");
if (PAIRS !== "all" && PAIRS !== "calibrate") throw new Error("--pairs must be all or calibrate");
const MINUTE_MS = PAIRS === "all" ? 6000 : 15000;
/** Fixture i's teams: the 16-pairing default, or all 240 ordered pairings (a = i%16, b = a + 1 + floor(i/16)%15, mod 16). */
const pairing = (i) => (PAIRS === "all" ? [TEAMS[i % 16], TEAMS[(i % 16 + 1 + (Math.floor(i / 16) % 15)) % 16]] : [TEAMS[i % 16], TEAMS[(i * 7 + 3) % 16]]);
const team = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true });
let counters = 0, rebounds = 0, staged90 = 0;
const trail = { pre: { mins: 0, shots: 0, cos: 0 }, late: { mins: 0, shots: 0, cos: 0 } };
/** Expected normal-time goals from kick-off under the staged in-play model (score difference walked minute by minute). */
const stagedGoals = (m) => {
  if (!m.r) return 90 * (m.lh + m.la);
  let dist = new Map([[0, 1]]);
  let g = 0;
  for (let k = 1; k <= 90; k++) {
    const nx = new Map();
    for (const [d, p] of dist) {
      const [h, a] = odds.stageRates(m, k, d);
      g += p * (h + a);
      nx.set(d, (nx.get(d) || 0) + p * (1 - h - a));
      nx.set(d + 1, (nx.get(d + 1) || 0) + p * h);
      nx.set(d - 1, (nx.get(d - 1) || 0) + p * a);
    }
    dist = nx;
  }
  return g;
};
let goals = 0, et = 0, so = 0, fav = 0, favN = 0, pens = 0, reds = 0, shots = 0, sot = 0, sdeath = 0, gapSum = 0, model90 = 0, entries = 0, stops = 0, chanceGapSum = 0, goalsAll = 0;
const gaps = [];
/** Longest gap (match minutes) between consecutive real shots in normal time. */
const PROGRESSION = new Set(["through_ball", "dribble", "cross"]);
const longestShotGap = (ev, chances = false) => {
  const real = (e) => !e.cos && (e.t === "shot" || e.t === "penalty_setup" || (chances && PROGRESSION.has(e.t)));
  const ts = ev.filter((e) => (real(e) || (chances && e.cos && e.t === "shot")) && e.min <= 90).map((e) => e.st.clk.s / 60);
  let g = 0;
  for (let i = 1; i < ts.length; i++) g = Math.max(g, ts[i] - ts[i - 1]);
  return g;
};
const scores = {};
for (let i = 0; i < N; i++) {
  const [a, b] = pairing(i);
  if (a === b) continue;
  const st = eng.createMatch({ fixtureId: "c" + i, seed: eng.hashSeed(PREFIX + i), kickoffAt: 0, timing: eng.buildTiming(MINUTE_MS, 1), home: team(a), away: team(b) });
  const ev = eng.advanceTo(st, Infinity);
  const g90 = ev.filter((e) => (e.t === "goal" || e.t === "penalty_goal") && e.min <= 90).length;
  goals += g90;
  goalsAll += ev.filter((e) => e.t === "goal" || e.t === "penalty_goal").length; // incl. extra time, never the shootout
  const gap = longestShotGap(ev);
  gapSum += gap;
  gaps.push(gap);
  chanceGapSum += longestShotGap(ev, true);
  entries += ev.filter((e) => PROGRESSION.has(e.t)).length;
  stops += ev.filter((e) => e.stop).length;
  const pm = eng.inPlayModel(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(a), away: team(b) })); // worldService.pairModel
  model90 += 90 * (pm.lh + pm.la);
  staged90 += stagedGoals(pm);
  counters += ev.filter((e) => e.t === "build_up" && e.ctr).length;
  rebounds += ev.filter((e) => e.t === "shot" && e.reb).length;
  {
    const real = ev.filter((e) => !e.cos);
    const byMin = new Map();
    for (const e of ev) {
      if (!byMin.has(e.min)) byMin.set(e.min, []);
      byMin.get(e.min).push(e);
    }
    let sc = [0, 0], j = 0;
    for (let m = 1; m <= 90; m++) {
      while (j < real.length && real[j].min < m) sc = real[j++].st.sc;
      if (sc[0] === sc[1]) continue;
      const side = sc[0] < sc[1] ? "home" : "away";
      const inMin = byMin.get(m) || [];
      const first = inMin.find((e) => !e.cos && (e.t === "build_up" || e.t === "pass"));
      if (!first || first.side !== side) continue;
      const b = m >= 70 ? trail.late : trail.pre;
      b.mins++;
      b.shots += inMin.filter((e) => !e.cos && e.side === side && (e.t === "shot" || e.t === "penalty_setup")).length;
      b.cos += inMin.filter((e) => e.cos && e.side === side && e.t === "shot").length;
    }
  }
  if (st.by !== "normal") et++;
  if (st.by === "pens") { so++; if (st.so.th > 5) sdeath++; }
  pens += ev.filter((e) => e.t === "penalty_awarded").length;
  reds += ev.filter((e) => e.t === "red_card").length;
  shots += st.stats.home.sh + st.stats.away.sh;
  sot += st.stats.home.sot + st.stats.away.sot;
  const k = Math.min(st.score[0], 6) + "-" + Math.min(st.score[1], 6);
  scores[k] = (scores[k] || 0) + 1;
  const ga = TEAMS.indexOf(a), gb = TEAMS.indexOf(b);
  if (Math.abs(ga - gb) >= 5) { favN++; if ((ga < gb) === (st.winner === "home")) fav++; }
}
console.log(JSON.stringify({
  matches: N,
  pairs: PAIRS,
  prefix: PREFIX,
  minuteMs: MINUTE_MS,
  goalsPer90: +(goals / N).toFixed(2),
  goalsPerMatch: +(goalsAll / N).toFixed(2),
  extraTime: +(et / N).toFixed(3),
  shootouts: +(so / N).toFixed(3),
  suddenDeathShare: +(sdeath / Math.max(so, 1)).toFixed(2),
  favouriteWins: +(fav / Math.max(favN, 1)).toFixed(2),
  pensPerMatch: +(pens / N).toFixed(2),
  redsPerMatch: +(reds / N).toFixed(2),
  shotsPerMatch: +(shots / N).toFixed(1),
  sotPerMatch: +(sot / N).toFixed(1),
  longestShotGap: +(gapSum / N).toFixed(2),
  longestShotGapP90: +gaps.sort((x, y) => x - y)[Math.floor(0.9 * (gaps.length - 1))].toFixed(1),
  longestChanceGap: +(chanceGapSum / N).toFixed(2),
  finalThirdEntries: +(entries / N).toFixed(2),
  finalThirdStops: +(stops / N).toFixed(2),
  modelGoals90: +(model90 / N).toFixed(3),
  modelVsSim: +(model90 / Math.max(goals, 1) - 1).toFixed(3),
  stagedGoals90: +(staged90 / N).toFixed(3),
  stagedVsSim: +(staged90 / Math.max(goals, 1) - 1).toFixed(3),
  counterAttacks: +(counters / N).toFixed(2),
  reboundShots: +(rebounds / N).toFixed(2),
  trailingShotsPerPossessionMin: {
    before70: +(trail.pre.shots / trail.pre.mins).toFixed(3),
    from70: +(trail.late.shots / trail.late.mins).toFixed(3),
    before70InclCos: +((trail.pre.shots + trail.pre.cos) / trail.pre.mins).toFixed(3),
    from70InclCos: +((trail.late.shots + trail.late.cos) / trail.late.mins).toFixed(3),
  },
  topScores: Object.entries(scores).sort((x, y) => y[1] - x[1]).slice(0, 8),
}, null, 1));
