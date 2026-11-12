// Engine calibration: goals/90, ET and shootout rates, upset rate, shots, shot gaps, odds model, event sanity.
// Usage: node scripts/engine-calibrate.mjs [matches=2000]
// longestShotGap: per match, the longest gap in match minutes between consecutive real shots (open-play shots and
// penalties, normal time), averaged. modelGoals90 is the odds model (goalRates, built as worldService.pairModel does)
// over the same fixtures; modelVsSim compares it with the simulated goals/90.
// finalThirdEntries: real progressions (through ball, dribble, cross) a match; finalThirdStops: those that end in a tackle,
// clearance or keeper claim instead of a shot (#218). longestChanceGap: as longestShotGap, counting progressions as chances too.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const eng = require("../pocketbase/pb_hooks/lib/matchEngine.js");
const { TEAMS } = require("../pocketbase/pb_hooks/lib/teams.js");
const { defaultStarters } = require("../pocketbase/pb_hooks/lib/tournament.js");

const N = Number(process.argv[2] || 2000);
const team = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true });
let goals = 0, et = 0, so = 0, fav = 0, favN = 0, pens = 0, reds = 0, shots = 0, sot = 0, sdeath = 0, gapSum = 0, model90 = 0, entries = 0, stops = 0, chanceGapSum = 0;
const gaps = [];
/** Longest gap (match minutes) between consecutive real shots in normal time. */
const PROGRESSION = new Set(["through_ball", "dribble", "cross"]);
const longestShotGap = (ev, chances = false) => {
  const ts = ev.filter((e) => !e.cos && (e.t === "shot" || e.t === "penalty_setup" || (chances && PROGRESSION.has(e.t))) && e.min <= 90).map((e) => e.st.clk.s / 60);
  let g = 0;
  for (let i = 1; i < ts.length; i++) g = Math.max(g, ts[i] - ts[i - 1]);
  return g;
};
const scores = {};
for (let i = 0; i < N; i++) {
  const a = TEAMS[i % 16], b = TEAMS[(i * 7 + 3) % 16];
  if (a === b) continue;
  const st = eng.createMatch({ fixtureId: "c" + i, seed: eng.hashSeed("cal" + i), kickoffAt: 0, timing: eng.buildTiming(15000, 1), home: team(a), away: team(b) });
  const ev = eng.advanceTo(st, Infinity);
  const g90 = ev.filter((e) => (e.t === "goal" || e.t === "penalty_goal") && e.min <= 90).length;
  goals += g90;
  const gap = longestShotGap(ev);
  gapSum += gap;
  gaps.push(gap);
  chanceGapSum += longestShotGap(ev, true);
  entries += ev.filter((e) => PROGRESSION.has(e.t)).length;
  stops += ev.filter((e) => e.stop).length;
  const r = eng.goalRates(eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: team(a), away: team(b) }));
  model90 += 90 * (Math.round(r.home * 1e6) / 1e6 + Math.round(r.away * 1e6) / 1e6);
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
  goalsPer90: +(goals / N).toFixed(2),
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
  topScores: Object.entries(scores).sort((x, y) => y[1] - x[1]).slice(0, 8),
}, null, 1));
