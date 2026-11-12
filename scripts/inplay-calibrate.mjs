// In-play odds calibration (#219): do the prices the app shows during a match match what then happens?
// Usage: node scripts/inplay-calibrate.mjs [matches=4800] [--prefix cal[,alt,zz]] [--minutes 60,75,85] [--root DIR] [--legacy] [--json] [--manager-policy ai-mirror|always-attack|defend-then-attack] [--manager-side home|away|both]
// (a comma-separated --prefix pools that many sets of `matches`, e.g. 3 × 4,800 = 14,400 matches; about 2 minutes per 4,800)
//
// Fixtures are engine-calibrate's `--pairs all` set: match i is seeded hashSeed(prefix + i), the 240 ordered pairings of the
// 16 teams have equal weight (use a multiple of 240), AI teams, the 6 s production pace. Each match is played to the end, and
// at each snapshot minute M the script takes the published state the app would price at that moment:
// - the last event published when the public clock reaches M:00 (clock from odds.clockMinute, exactly as fixture cards and
//   bettingService read it), priced at minute floor(clock) = M;
// - if markets are suspended then (st.d: an attack, shot or penalty in progress), the first later event that reopens them,
//   at its own clock minute. That is the first price a bettor could take. Matches already over are skipped.
// Prices come from the real code path: markets.fixtureMarkets with the kickoff model worldService.pairModel builds
// (matchEngine.inPlayModel; a tree without it gets the legacy { lh, la } goalRates model). Every offered price is checked
// exactly against odds.marketProbs and okP; a catalogue mismatch aborts. Probabilities are also compared independently with
// odds.finalDist / odds.nextGoal at a 1e-7 absolute target. Reference violations are reported and cause exit 1 after finishing
// the fixed sample. ROI always uses actual offered prices. `--legacy` prices the same matches with the constant-rate model
// ({ lh, la } only): what a match in flight at the #219 deploy gets. `--root` runs another tree (e.g. the #218 head).
//
// Buckets: snapshot minute × score state from the leader's side (level, lead by 1, lead by 2+). For each market selection
// the table compares the mean model probability with the observed frequency (pp = percentage points; se = binomial standard
// error of the observed share). Markets: winner (to qualify), next goal, winning margin (exactly 1/2/3), exact score (grouped
// by goals still to come: +0-0, +1-0, ...). "ROI" is the bettor's mean return per unit staked at the offered odds (null when
// withdrawn), with the 6% margin a calibrated model returns about −6%.
// Extra cell groups: "fav view" (the pre-match favourite leads / is level / trails); "strength" (#219 review F1: the pre-match
// underdog's chance to qualify <15%, 15–25%, 25–50%, × its score state: winner and next goal); "pre-match" (the winner price
// before kick-off by the underdog's chance, <15% … 45–50%, checked against the offered catalogue too). The summary also gives
// the underdog's pre-match ROI for the <15% class and the in-play strength cells' worst ROI.
// #228 manager scenarios hold the published stance until the next policy command. Policies are not passed to odds:
// ai-mirror uses the score at the start of each minute (70/78/100 thresholds), always-attack starts balanced and commands
// Attack for minute 1, defend-then-attack starts Defend and commands Attack for minute 1. --manager-side defaults to home;
// both exercises two managers simultaneously. Commands use the engine's queueStance boundary; they do not alter engine rules.
// ROI SE uses whole-match clusters; exact (offered) cells retain every offered score (+goals from the leader's side).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotAtMinute, openPublishedSnapshot } from "./lib/published-snapshot.mjs";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const N = Number(args.find((a, i) => /^\d+$/.test(a) && !String(args[i - 1]).startsWith("--")) || 4800);
const PREFIXES = flag("prefix", "cal").split(",");
const MINUTES = flag("minutes", "60,75,85").split(",").map(Number);
const ROOT = path.resolve(flag("root", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const LEGACY = args.includes("--legacy");
const JSON_OUT = args.includes("--json");
const MANAGER_POLICY = flag("manager-policy", null);
const MANAGER_SIDE = flag("manager-side", "home");
if (MANAGER_POLICY && !["ai-mirror", "always-attack", "defend-then-attack"].includes(MANAGER_POLICY)) throw new Error("Unknown --manager-policy");
if (!["home", "away", "both"].includes(MANAGER_SIDE)) throw new Error("--manager-side must be home, away or both");
const managerSides = !MANAGER_POLICY ? [] : MANAGER_SIDE === "both" ? ["home", "away"] : [MANAGER_SIDE];
const require = createRequire(path.join(ROOT, "package.json"));
const lib = (f) => require(path.join(ROOT, "pocketbase/pb_hooks/lib", f));
const eng = lib("matchEngine.js");
const odds = lib("odds.js");
const mkt = lib("markets.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const MINUTE_MS = 6000;
const pairing = (i) => [TEAMS[i % 16], TEAMS[(i % 16 + 1 + (Math.floor(i / 16) % 15)) % 16]];
const team = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true });
/** worldService.pairModel: the kickoff model_json. */
const pairModel = (h, a) => {
  const st = eng.createMatch({ fixtureId: "m", seed: 1, kickoffAt: 0, home: h, away: a });
  if (eng.inPlayModel && !LEGACY) return eng.inPlayModel(st);
  const r = eng.goalRates(st);
  return { lh: Math.round(r.home * 1e6) / 1e6, la: Math.round(r.away * 1e6) / 1e6 };
};
const modelCache = new Map();
const GOALS = new Set(["goal", "penalty_goal"]);
function play(st) {
  if (!MANAGER_POLICY) return eng.advanceTo(st, Infinity);
  const ev = [];
  let steps = 0;
  while (st.phase !== "finished") {
    if (++steps > 1000) throw new Error("Manager scenario failed to finish");
    for (const side of managerSides) {
      const mine = st.score[side === "home" ? 0 : 1], theirs = st.score[side === "home" ? 1 : 0];
      const minute = st.minute + 1;
      const stance = MANAGER_POLICY !== "ai-mirror" ? "attack"
        : minute >= 70 && mine < theirs ? "attack"
          : minute >= 100 && mine === theirs ? "attack"
            : minute >= 78 && mine === theirs + 1 ? "defend" : "balanced";
      if (st.teams[side].stance !== stance) eng.queueStance(st, side, stance);
    }
    ev.push(...eng.advanceTo(st, st.nextAt));
  }
  return ev;
}

// Shared-timestamp rows are canonicalized to the final published sequence before pricing, as lastPublished does.
const snapshotAt = (ev, minute) => snapshotAtMinute(ev, minute, odds.clockMinute, MINUTE_MS);

const buckets = new Map(); // key -> probability sums and offered payout sums
let matchReturns; // one cluster per simulated match, including multiple selections in an exact-score cell
const add = (key, p, hit, o) => {
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = { n: 0, p: 0, hit: 0, ret: 0, retN: 0, clusterNN: 0, clusterRR: 0, clusterNR: 0 }));
  b.n++;
  b.p += p;
  b.hit += hit ? 1 : 0;
  if (o) {
    b.retN++;
    const payout = hit ? o : 0;
    b.ret += payout;
    const r = matchReturns.get(key) || { n: 0, ret: 0 };
    r.n++;
    r.ret += payout;
    matchReturns.set(key, r);
  }
};
let snaps = 0, skippedSuspended = 0, skippedOver = 0, priceChecks = 0, roundingBoundary = 0, maxReferenceProbabilityDelta = 0, maxReferenceRelativeDelta = 0, maxOfferedReferenceRelativeDelta = 0, zeroReferencePositiveFastCount = 0;
const referenceViolations = [];
let referenceViolationCount = 0;
const favNext = new Map(); // minute -> { n, ret } for "next goal: the pre-match favourite"
const favNextFrom70 = { n: 0, ret: 0 };

for (const PREFIX of PREFIXES) for (let i = 0; i < N; i++) {
  const [a, b] = pairing(i);
  matchReturns = new Map();
  const H = team(a), A = team(b);
  for (const side of managerSides) {
    const t = side === "home" ? H : A;
    t.ai = false;
    t.stance = MANAGER_POLICY === "defend-then-attack" ? "defend" : "balanced";
  }
  const modelKey = a.slug + ":" + b.slug;
  if (!modelCache.has(modelKey)) modelCache.set(modelKey, pairModel(H, A));
  const model = modelCache.get(modelKey);
  const st = eng.createMatch({ fixtureId: "c" + i, seed: eng.hashSeed(PREFIX + i), kickoffAt: 0, timing: eng.buildTiming(MINUTE_MS, 1), home: H, away: A });
  const ev = play(st).filter((e) => !e.cos); // cosmetic rows carry the last real snapshot: nothing to price
  const final = { sh: st.score[0], sa: st.score[1], winner: st.winner };
  const q0 = odds.pairQualify(model);
  const fav = q0 >= 0.5 ? "home" : "away";
  const dogQ = Math.min(q0, 1 - q0); // the pre-match underdog's chance to qualify
  const strength = dogQ < 0.15 ? "dog<15%" : dogQ < 0.25 ? "dog 15-25%" : "dog 25-50%";
  const fx = { id: "c" + i, status: "live", kickoffAt: 0, model, home: { id: "h", abbr: H.abbr, name: H.name }, away: { id: "a", abbr: A.abbr, name: A.name } };
  const sample = (M, t0, record) => {
    const pub = openPublishedSnapshot(ev, t0);
    if (!pub) return null;
    const { i: idx, t } = pub;
    const e = ev[idx];
    if (e.st.ph === "finished" || e.st.ph === "shootout") return null;
    if (pub.moved) skippedSuspended++;
    const minute = Math.floor(odds.clockMinute(e.st.clk, e.at, t, MINUTE_MS));
    const cat = mkt.fixtureMarkets(fx, e.st, minute, t);
    if (cat.state.closed) throw new Error(`match ${i} at ${M}': markets closed (${cat.state.closed})`);
    const fd = odds.finalDist(model, e.st, minute);
    const ng = odds.nextGoal(model, e.st, minute);
    const fast = odds.marketProbs(model, e.st, minute);
    const ngNext = ev.find((x, k) => k > idx && GOALS.has(x.t));
    const nextSide = ngNext ? ngNext.side : "none";
    const sc = e.st.sc;
    const d = sc[0] - sc[1];
    const lead = d === 0 ? "level" : Math.abs(d) === 1 ? "lead1" : "lead2+";
    // Selections from the leader's side ("home" when level).
    const L = d < 0 ? "away" : "home";
    const T = L === "home" ? "away" : "home";
    const role = (side) => (side === "none" ? "none" : d === 0 ? side : side === L ? "leader" : "trailer");
    const sel = (key, id) => {
      const m = cat.markets.find((x) => x.key === key);
      const s = m && m.sel.find((x) => x.id === id);
      return s ? s.odds : null;
    };
    // Verify the actual catalogue exactly against its fast-path probability first. Compare that probability with the
    // independent reference walk separately against a 1e-7 absolute target. Extreme-score R=8 tail violations are
    // reported and cause a nonzero exit after the full sample. ROI always uses actual offered odds.
    const check = (o, p, fastP, label = "selection") => {
      priceChecks++;
      if (o !== mkt.okP(fastP, true)) throw new Error(`match ${i} at ${M}' ${label}: catalogue/fast price mismatch`);
      const delta = Math.abs(fastP - p);
      maxReferenceProbabilityDelta = Math.max(maxReferenceProbabilityDelta, delta);
      const relativeDelta = p > 0 ? delta / p : null;
      if (relativeDelta !== null) {
        maxReferenceRelativeDelta = Math.max(maxReferenceRelativeDelta, relativeDelta);
        if (o) maxOfferedReferenceRelativeDelta = Math.max(maxOfferedReferenceRelativeDelta, relativeDelta);
      } else if (fastP > 0) zeroReferencePositiveFastCount++;
      if (delta > 1e-7) {
        referenceViolationCount++;
        if (referenceViolations.length < 20) referenceViolations.push({ prefix: PREFIX, match: i, snapshot: M, minute, selection: label, delta, referenceProbability: p, fastProbability: fastP, relativeDelta, offered: o, sc: e.st.sc, cs: e.st.cs });
      }
      if (o !== mkt.okP(p, true)) roundingBoundary++;
    };
    const q = { home: fd.qualifyHome, away: 1 - fd.qualifyHome };
    const B = `${M}' ${lead}`;
    for (const side of ["home", "away"]) {
      check(sel("winner", side), q[side], side === "home" ? fast.qualifyHome : 1 - fast.qualifyHome, "winner " + side);
      add(`${B}|winner|${role(side)}`, q[side], final.winner === side, sel("winner", side));
    }
    for (const id of ["home", "away", "none"]) {
      check(sel("next_goal", id), ng[id], fast.next[id], "next_goal " + id);
      add(`${B}|next_goal|${role(id)}`, ng[id], nextSide === id, sel("next_goal", id));
    }
    const margin = (side, n) => Object.entries(fd.dist).reduce((s, [k, p]) => {
      const [x, y] = k.split("-").map(Number);
      return s + ((side === "home" ? x - y : y - x) === n ? p : 0);
    }, 0);
    for (const side of [L, T]) {
      for (const n of [1, 2, 3]) {
        const p = margin(side, n);
        check(sel("margin", side + n), p, fast.margin[side + n], "margin " + side + n);
        const won = (side === "home" ? final.sh - final.sa : final.sa - final.sh) === n;
        add(`${B}|margin|${role(side)} by ${n}`, p, won, sel("margin", side + n));
      }
    }
    // Exact score, grouped by goals still to come (from the leader's side): +0-0, +1-0, +0-1, +1-1, +2-0, +0-2, other.
    const gotL = (L === "home" ? final.sh - sc[0] : final.sa - sc[1]);
    const gotT = (L === "home" ? final.sa - sc[1] : final.sh - sc[0]);
    const groups = {};
    for (const [k, p] of Object.entries(fd.dist)) {
      const [x, y] = k.split("-").map(Number);
      const gl = L === "home" ? x - sc[0] : y - sc[1];
      const gt = L === "home" ? y - sc[1] : x - sc[0];
      const g = gl + gt <= 2 ? `+${gl}-${gt}` : "other";
      groups[g] = (groups[g] || 0) + p;
    }
    for (const s of cat.markets.find((m) => m.key === "exact").sel) {
      const p = fd.dist[s.id] || 0;
      check(s.odds, p, fast.exact[s.id] || 0, "exact " + s.id);
      if (MANAGER_POLICY) {
        const [x, y] = s.id.split("-").map(Number);
        const gl = L === "home" ? x - sc[0] : y - sc[1];
        const gt = L === "home" ? y - sc[1] : x - sc[0];
        add(`${B}|exact (offered)|+${gl}-${gt}`, p, final.sh === x && final.sa === y, s.odds);
      }
    }
    const gotGroup = gotL + gotT <= 2 ? `+${gotL}-${gotT}` : "other";
    for (const g of ["+0-0", "+1-0", "+0-1", "+1-1", "+2-0", "+0-2", "other"]) add(`${B}|exact|${g}`, groups[g] || 0, gotGroup === g, null);
    // The same markets from the pre-match favourite's side (fav = higher pairQualify), by its score state.
    const fd2 = fav === "home" ? d : -d;
    const FB = `${M}' fav ${fd2 > 0 ? "leads" : fd2 < 0 ? "trails" : "level"}`;
    const dog = fav === "home" ? "away" : "home";
    add(`${FB}|winner (fav view)|favourite`, q[fav], final.winner === fav, sel("winner", fav));
    add(`${FB}|next_goal (fav view)|favourite`, ng[fav], nextSide === fav, sel("next_goal", fav));
    add(`${FB}|next_goal (fav view)|underdog`, ng[dog], nextSide === dog, sel("next_goal", dog));
    // #219 review F1: the same by strength, the pre-match underdog's chance to qualify (<15%, 15–25%, 25–50%), and its score state.
    const SB = `${M}' ${strength}, dog ${fd2 < 0 ? "leads" : fd2 > 0 ? "trails" : "level"}`;
    add(`${SB}|winner (strength)|underdog`, q[dog], final.winner === dog, sel("winner", dog));
    add(`${SB}|next_goal (strength)|underdog`, ng[dog], nextSide === dog, sel("next_goal", dog));
    add(`${SB}|next_goal (strength)|favourite`, ng[fav], nextSide === fav, sel("next_goal", fav));
    snaps++;
    if (record) {
      const o = sel("next_goal", fav);
      if (o) record(o, nextSide === fav);
    }
    return true;
  };
  // Pre-match: the catalogue a bettor sees before kick-off, priced and checked as in play; the underdog by its chance to qualify.
  {
    const pre = mkt.fixtureMarkets({ ...fx, status: "scheduled", kickoffAt: 1 }, null, 0, 0);
    const fd0 = odds.finalDist(model, { sc: [0, 0], ph: "pre" }, 0);
    const dog0 = fav === "home" ? "away" : "home";
    const pq = { home: fd0.qualifyHome, away: 1 - fd0.qualifyHome };
    const o = (side) => pre.markets.find((m) => m.key === "winner").sel.find((x) => x.id === side).odds;
    for (const side of ["home", "away"]) {
      priceChecks++;
      if (o(side) !== mkt.okP(pq[side], false) && o(side) !== mkt.okP(pq[side] + 1e-9, false) && o(side) !== mkt.okP(pq[side] - 1e-9, false)) throw new Error(`match ${i} pre-match: offered ${o(side)}, model ${mkt.okP(pq[side], false)}`);
    }
    const qb = dogQ < 0.15 ? "<15%" : dogQ < 0.25 ? "15-25%" : dogQ < 0.35 ? "25-35%" : dogQ < 0.45 ? "35-45%" : "45-50%";
    add(`0' pre-match, dog ${qb}|winner (pre-match)|underdog`, pq[dog0], final.winner === dog0, o(dog0));
    add(`0' pre-match, dog ${qb}|winner (pre-match)|favourite`, pq[fav], final.winner === fav, o(fav));
  }
  for (const M of MINUTES) {
    const s = snapshotAt(ev, M);
    if (!s || ev[s.i].st.ph === "finished") {
      skippedOver++;
      continue;
    }
    sample(M, s.t, (o, won) => {
      const r = favNext.get(M) || { n: 0, ret: 0 };
      r.n++;
      r.ret += won ? o : 0;
      favNext.set(M, r);
    });
  }
  // Fable's #217 finding: "next goal: favourite" after 70' — every minute 70..89, the price at M:00.
  for (let M = 70; M < 90; M++) {
    const s = snapshotAt(ev, M);
    if (!s || ev[s.i].st.ph === "finished") continue;
    const pub = openPublishedSnapshot(ev, s.t);
    if (!pub || ev[pub.i].st.ph === "finished" || ev[pub.i].st.ph === "shootout") continue;
    const { i: k, t } = pub;
    const e = ev[k];
    const minute = Math.floor(odds.clockMinute(e.st.clk, e.at, t, MINUTE_MS));
    const o = mkt.okP(odds.nextGoal(model, e.st, minute)[fav], true); // the next-goal price fixtureMarkets offers (checked above)
    if (!o) continue;
    const g = ev.find((x, j) => j > k && GOALS.has(x.t));
    favNextFrom70.n++;
    favNextFrom70.ret += g && g.side === fav ? o : 0;
  }
  for (const [key, r] of matchReturns) {
    const b = buckets.get(key);
    b.clusterNN += r.n * r.n;
    b.clusterRR += r.ret * r.ret;
    b.clusterNR += r.n * r.ret;
  }
  if ((i + 1) % 2400 === 0) process.stderr.write(`${MANAGER_POLICY || "AI"}/${MANAGER_SIDE} ${PREFIX}: ${i + 1}/${N}\n`);
}

const rows = [...buckets.entries()].map(([key, b]) => {
  const [bucket, market, selection] = key.split("|");
  const model = b.p / b.n;
  const obs = b.hit / b.n;
  const se = Math.sqrt(Math.max(obs * (1 - obs), 1e-4) / b.n);
  const payoutMean = b.retN ? b.ret / b.retN : null;
  const clusters = N * PREFIXES.length;
  const roiSe = payoutMean === null ? null : Math.sqrt(Math.max(0,
    (b.clusterRR - 2 * payoutMean * b.clusterNR + payoutMean * payoutMean * b.clusterNN) * clusters / Math.max(1, clusters - 1))) / b.retN;
  return { bucket, market, selection, n: b.n, model: +(100 * model).toFixed(1), observed: +(100 * obs).toFixed(1), diffPp: +(100 * (model - obs)).toFixed(1), sePp: +(100 * se).toFixed(1), roi: b.retN ? +(b.ret / b.retN - 1).toFixed(3) : null, offered: b.retN, roiClusterSe: roiSe === null ? null : +roiSe.toFixed(5) };
});
const MIN_N = 200;
const judged = rows.filter((r) => r.n >= MIN_N);
const worst = judged.reduce((w, r) => (Math.abs(r.diffPp) > Math.abs(w.diffPp) ? r : w), { diffPp: 0 });
const outside = judged.filter((r) => Math.abs(r.diffPp) > 3);
const summary = {
  root: ROOT,
  model: eng.inPlayModel && !LEGACY ? "staged (inPlayModel)" : "legacy constant rate",
  matches: N * PREFIXES.length,
  prefix: PREFIXES.join(","),
  managerPolicy: MANAGER_POLICY,
  managerSides,
  roiUncertainty: "whole-match cluster standard error (fractional ROI)",
  snapshots: snaps,
  snapshotsMovedPastSuspension: skippedSuspended,
  snapshotsAfterTheEnd: skippedOver,
  priceChecks,
  priceChecksOnARoundingBoundary: roundingBoundary,
  maxReferenceProbabilityDelta,
  maxReferenceRelativeDelta,
  maxOfferedReferenceRelativeDelta,
  zeroReferencePositiveFastCount,
  relativeDeltaDefinition: "absolute delta / nonzero reference probability; offered maximum excludes withdrawn selections",
  referenceProbabilityTolerance: 1e-7,
  referenceViolationCount,
  firstReferenceViolations: referenceViolations,
  cellsJudged: judged.length,
  minCell: MIN_N,
  cellsOutside3pp: outside.length,
  positiveOfferedCells: rows.filter((r) => r.roi > 0).map((r) => ({ bucket: r.bucket, market: r.market, selection: r.selection, offered: r.offered, roi: r.roi, roiClusterSe: r.roiClusterSe })),
  worst: worst.bucket ? `${worst.bucket} ${worst.market} ${worst.selection}: model ${worst.model}% vs ${worst.observed}% (n ${worst.n}, se ${worst.sePp})` : null,
  nextGoalFavourite: Object.fromEntries([...favNext.entries()].map(([m, r]) => [m + "'", { n: r.n, roi: +(r.ret / r.n - 1).toFixed(3) }])),
  nextGoalFavouriteFrom70: { n: favNextFrom70.n, roi: +(favNextFrom70.ret / Math.max(1, favNextFrom70.n) - 1).toFixed(3) },
  preMatchUnderdog: Object.fromEntries(rows.filter((r) => r.market === "winner (pre-match)" && r.selection === "underdog").map((r) => [r.bucket.replace("0' pre-match, ", ""), { n: r.n, model: r.model, observed: r.observed, roi: r.roi }])),
};
if (JSON_OUT) console.log(JSON.stringify({ summary, rows }, null, 1));
else {
  console.log(JSON.stringify(summary, null, 1));
  console.log("\n| Minute, score | Market | Selection | n | Model % | Observed % | Diff pp | SE pp | ROI | ROI SE pp |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.bucket} | ${r.market} | ${r.selection} | ${r.n} | ${r.model} | ${r.observed} | ${r.diffPp > 0 ? "+" : ""}${r.diffPp}${r.n >= MIN_N && Math.abs(r.diffPp) > 3 ? " **" : ""} | ${r.sePp} | ${r.roi === null ? "" : (r.roi * 100).toFixed(1) + "%"} | ${r.roiClusterSe === null ? "" : (r.roiClusterSe * 100).toFixed(2)} |`);
}

// Finish the fixed sample before failing the reference gate, so numerical limitations do not hide ROI evidence.
if (referenceViolationCount) process.exitCode = 1;
