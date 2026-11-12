// #229: offered next-goal prices at every real published row, plus time spent suspended.
// node scripts/attack-reveal-calibrate.mjs 9600 [--root DIR] [--baseline-root DIR] [--prefix reveal]
// Each row stakes one unit on its named side (the attacking/possessing side for build-ups/passes; the winning side for a
// turnover). Rows without a side are skipped. Closed/withdrawn selections stake nothing. Results are grouped by row type,
// including 86..90 match minutes. Repeated bets in one match are correlated: SE uses whole-match clusters.
// Suspended share: wall time carrying d:1 / wall time in playable halves (breaks, pre-match and shootouts excluded).
// --baseline-root also proves every payload except st.d, and the entire final state, is identical on the same seeds.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const N = Number(args[0]) || 9600;
const ROOT = path.resolve(flag("root", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const BASE = flag("baseline-root", null);
const PREFIX = flag("prefix", "reveal");
const require = createRequire(path.join(ROOT, "package.json"));
const lib = (f) => require(path.join(ROOT, "pocketbase/pb_hooks/lib", f));
const eng = lib("matchEngine.js"), odds = lib("odds.js"), markets = lib("markets.js");
const baseEng = BASE && require(path.resolve(BASE, "pocketbase/pb_hooks/lib/matchEngine.js"));
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");
const team = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true });
const PLAY = new Set(["first_half", "second_half", "extra_time_1", "extra_time_2"]);
const GOAL = new Set(["goal", "penalty_goal"]);
const groups = new Map();
const totals = { playableMs: 0, suspendedMs: 0, baselineSuspendedMs: 0, matches: N, payloadParityMatches: 0 };
const clean = (ev) => ev.map(({ st, ...e }) => { const { d, ...s } = st; void d; return { ...e, st: s }; });
const models = new Map();
for (let n = 0; n < N; n++) {
  const hi = n % 16, ai = (hi + 1 + (Math.floor(n / 16) % 15)) % 16;
  const H = team(TEAMS[hi]), A = team(TEAMS[ai]);
  const opts = { fixtureId: "reveal" + n, seed: eng.hashSeed(PREFIX + n), kickoffAt: 0, timing: eng.buildTiming(6000, 1), home: H, away: A };
  const st = eng.createMatch(opts), ev = eng.advanceTo(st, Infinity).filter((e) => !e.cos);
  let bev;
  if (baseEng) {
    const bst = baseEng.createMatch(opts);
    bev = baseEng.advanceTo(bst, Infinity).filter((e) => !e.cos);
    assert.deepEqual(clean(ev), clean(bev), `non-danger payload drift: match ${n}`);
    assert.deepEqual(st, bst, `final state drift: match ${n}`);
    totals.payloadParityMatches++;
  }
  const mk = hi + ":" + ai;
  if (!models.has(mk)) models.set(mk, eng.inPlayModel(eng.createMatch(opts)));
  const model = models.get(mk);
  const local = new Map();
  let next = null;
  const nextSides = [];
  for (let i = ev.length - 1; i >= 0; i--) { nextSides[i] = next; if (GOAL.has(ev[i].t)) next = ev[i].side; }
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (PLAY.has(e.st.ph) && i + 1 < ev.length) {
      const dt = ev[i + 1].at - e.at;
      totals.playableMs += dt;
      if (e.st.d) totals.suspendedMs += dt;
      if (bev && bev[i].st.d) totals.baselineSuspendedMs += dt;
    }
    if (!PLAY.has(e.st.ph) || !["home", "away"].includes(e.side)) continue;
    const minute = Math.floor(odds.clockMinute(e.st.clk, e.at, e.at, 6000));
    const closed = markets.fixtureState({ status: "live" }, e.st, e.at).closed;
    const offered = closed ? null : markets.okP(odds.nextGoal(model, e.st, minute)[e.side], true);
    const ret = offered && nextSides[i] === e.side ? offered : 0;
    const keys = ["all rows", e.t];
    if (e.t === "build_up" && e.ctr) keys.push("counter build_up");
    for (const key of keys) for (const window of ["all", ...(e.min >= 86 && e.min <= 90 ? ["86-90"] : [])]) {
      const k = window + " | " + key;
      const r = local.get(k) || { rows: 0, n: 0, ret: 0 };
      r.rows++; if (offered) { r.n++; r.ret += ret; } local.set(k, r);
    }
  }
  for (const [k, r] of local) {
    const b = groups.get(k) || { rows: 0, n: 0, ret: 0, nn: 0, rr: 0, nr: 0 };
    b.rows += r.rows; b.n += r.n; b.ret += r.ret;
    b.nn += r.n * r.n; b.rr += r.ret * r.ret; b.nr += r.n * r.ret;
    groups.set(k, b);
  }
  if ((n + 1) % 2400 === 0) process.stderr.write(`played ${n + 1}/${N}\n`);
}
const rows = [...groups].map(([key, b]) => {
  const mean = b.n ? b.ret / b.n : null;
  const se = mean === null ? null : Math.sqrt(Math.max(0, (b.rr - 2 * mean * b.nr + mean * mean * b.nn) * N / (N - 1))) / b.n;
  return { key, rows: b.rows, bets: b.n, roiPct: mean === null ? null : +(100 * (mean - 1)).toFixed(2), clusterSePct: se === null ? null : +(100 * se).toFixed(2) };
}).sort((a, b) => a.key.localeCompare(b.key));
console.log(JSON.stringify({ root: ROOT, baseline: BASE, prefix: PREFIX, ...totals, suspendedPct: 100 * totals.suspendedMs / totals.playableMs, baselineSuspendedPct: BASE ? 100 * totals.baselineSuspendedMs / totals.playableMs : null, rows }, null, 2));
