// Engine-only exposure check with the live coaching command budget, wall-clock cooldown and pending-command deduplication.
// This does not exercise the HTTP API, database transactions, authorization or tick/catch-up races.
// node scripts/manager-stance-exposure.mjs [--root DIR] [--matches 19200] [--prefix cal,alt,zz,qq]
// --matches is the TOTAL across prefixes. Each prefix must receive an equal multiple of all 240 ordered pairings.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotAtMinute, openPublishedSnapshot } from "./lib/published-snapshot.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = path.resolve(flag("root", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const total = Number(flag("matches", "19200"));
const prefixes = flag("prefix", "cal,alt,zz,qq").split(",");
assert(Number.isSafeInteger(total) && total > 0 && prefixes.every(Boolean), "valid positive --matches and nonempty --prefix required");
assert(new Set(prefixes).size === prefixes.length, "--prefix values must be unique");
assert(total % (240 * prefixes.length) === 0, "each prefix must have an equal multiple of 240 ordered pairings");
const perPrefix = total / prefixes.length;
const require = createRequire(path.join(root, "package.json"));
const lib = (name) => require(path.join(root, "pocketbase/pb_hooks/lib", name));
const engine = lib("matchEngine.js"), odds = lib("odds.js"), markets = lib("markets.js");
const { TEAMS } = lib("teams.js"), { defaultStarters } = lib("tournament.js"), { BALANCE } = lib("balance.js");
const minuteMs = 6000;
const cooldownMs = (BALANCE.liveCoachingCooldownMinutes || 3) * minuteMs; // worldService.liveCoachCooldownMs
const team = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: false, stance: "balanced" });
const models = new Map();
const goalTypes = new Set(["goal", "penalty_goal"]);
const policy = (st, side) => {
  const mine = st.score[side === "home" ? 0 : 1], theirs = st.score[side === "home" ? 1 : 0], minute = st.minute + 1;
  return minute >= 70 && mine < theirs ? "attack"
    : minute >= 100 && mine === theirs ? "attack"
      : minute >= 78 && mine === theirs + 1 ? "defend" : "balanced";
};
const result = {
  root,
  scope: "engine-only guarded policy; not HTTP/API integration",
  strategy: "both manual managers follow the AI stance policy when command budget and cooldown permit; bet next-goal favourite at the latest open published snapshot",
  timing: "6 s minutes; commands submitted at nextAt - 1 ms after already published play",
  roiUncertainty: "sample mean payout standard error; at most one wager per match in each minute/score bucket",
  matchesPerMode: total,
  prefix: prefixes.join(","),
  pairings: 240,
  limit: BALANCE.liveCoachingMax,
  cooldownMs,
  modes: {},
};

let changes = 0, maxChanges = 0, overBudget = 0, overBudgetBefore85 = 0, cooldownViolations = 0;
let bets = 0, ret = 0, retSq = 0, level85 = 0, issued = 0, budgetRejectedTargets = 0, cooldownRejectedTargets = 0;
const histogram = {}, buckets = {};
for (let i = 0; i < total; i++) {
  const prefix = prefixes[Math.floor(i / perPrefix)], cohortIndex = i % perPrefix;
  const hi = cohortIndex % 16, ai = (hi + 1 + Math.floor(cohortIndex / 16) % 15) % 16;
  const opts = { fixtureId: "c" + i, seed: engine.hashSeed(prefix + cohortIndex), kickoffAt: 0, timing: engine.buildTiming(minuteMs, 1), home: team(TEAMS[hi]), away: team(TEAMS[ai]) };
  const key = hi + ":" + ai;
  if (!models.has(key)) models.set(key, engine.inPlayModel(engine.createMatch(opts)));
  const model = models.get(key);
  const st = engine.createMatch(opts), events = [], used = { home: 0, away: 0 }, last = { home: -Infinity, away: -Infinity };
  const commandTimes = { home: [], away: [] };
  while (st.phase !== "finished") {
    const now = st.nextAt - 1; // queue only before the next unsimulated minute starts
    if (st.phase !== "shootout") for (const side of ["home", "away"]) {
      const target = policy(st, side);
      if ((st.pending[side] || st.teams[side].stance) === target) continue;
      if (used[side] >= BALANCE.liveCoachingMax) { budgetRejectedTargets++; continue; }
      if (now - last[side] < cooldownMs) { cooldownRejectedTargets++; continue; }
      assert(!st.teams[side].ai, "only manual sides may receive coaching");
      assert(engine.LIVE_PHASES.includes(st.phase) || ["half_time", "et_break", "et_half_time"].includes(st.phase), "command phase must permit live coaching");
      assert(st.lastAt <= now, "policy must not observe unpublished play");
      engine.queueStance(st, side, target);
      used[side]++;
      last[side] = now;
      commandTimes[side].push(now);
      issued++;
    }
    events.push(...engine.advanceTo(st, st.nextAt));
  }
  const real = events.filter((e) => !e.cos), counts = { home: 0, away: 0 }, early = { home: 0, away: 0 };
  for (const e of real) if (e.t === "coaching") { counts[e.side]++; if (e.min <= 85) early[e.side]++; }
  changes += counts.home + counts.away;
  const max = Math.max(counts.home, counts.away);
  maxChanges = Math.max(maxChanges, max);
  histogram[max] = (histogram[max] || 0) + 1;
  if (max > BALANCE.liveCoachingMax) overBudget++;
  if (Math.max(early.home, early.away) > BALANCE.liveCoachingMax) overBudgetBefore85++;
  // Audit the issued timeline separately from the rejection condition, rather than counting attempted targets as commands.
  const violatedCooldown = Object.values(commandTimes).some((times) => times.some((time, j) => j > 0 && time - times[j - 1] < cooldownMs));
  if (violatedCooldown) cooldownViolations++;
  assert(Math.max(used.home, used.away) <= BALANCE.liveCoachingMax, "command budget exceeded");
  assert(!violatedCooldown, "wall-clock cooldown violated");
  const favourite = odds.pairQualify(model) >= 0.5 ? "home" : "away";
  for (const snapshotMinute of [60, 75, 85]) {
    const snap = snapshotAtMinute(real, snapshotMinute, odds.clockMinute, minuteMs);
    if (!snap) continue;
    const pub = openPublishedSnapshot(real, snap.t);
    if (!pub) continue;
    const event = real[pub.i];
    if (["finished", "shootout"].includes(event.st.ph)) continue;
    const diff = (favourite === "home" ? 1 : -1) * (event.st.sc[0] - event.st.sc[1]);
    const bucket = snapshotMinute + ":" + (diff === 0 ? "level" : diff > 0 ? "favLeads" : "favTrails");
    const minute = Math.floor(odds.clockMinute(event.st.clk, event.at, pub.t, minuteMs));
    const offered = markets.okP(odds.nextGoal(model, event.st, minute)[favourite], true);
    if (!offered) continue;
    const next = real.find((e, j) => j > pub.i && goalTypes.has(e.t));
    const payout = next?.side === favourite ? offered : 0;
    const tally = buckets[bucket] ??= { bets: 0, ret: 0, retSq: 0 };
    tally.bets++; tally.ret += payout; tally.retSq += payout * payout;
    if (snapshotMinute === 85 && diff === 0) { level85++; bets++; ret += payout; retSq += payout * payout; }
  }
  if ((i + 1) % perPrefix === 0) process.stderr.write("completed " + (i + 1) + "/" + total + "\n");
}
const roi = (count, returns, squares) => {
  if (!count) return { roiPct: null, roiSePp: null };
  const mean = returns / count;
  return { roiPct: 100 * (mean - 1), roiSePp: count > 1 ? 100 * Math.sqrt(Math.max(0, (squares - count * mean * mean) / (count - 1))) / Math.sqrt(count) : null };
};
for (const tally of Object.values(buckets)) {
  Object.assign(tally, roi(tally.bets, tally.ret, tally.retSq));
  delete tally.ret;
  delete tally.retSq;
}
result.modes["cap4+cooldown"] = {
  buckets,
  issuedCommands: issued,
  appliedChanges: changes,
  meanAppliedChangesPerTeam: changes / (2 * total),
  maxAppliedChangesPerTeam: maxChanges,
  matchesOver4Changes: overBudget,
  matchesOver4ChangesBy85: overBudgetBefore85,
  matchesWithCooldownViolation: cooldownViolations,
  maxTeamChangeCountHistogram: histogram,
  budgetRejectedTargets,
  cooldownRejectedTargets,
  level85,
  bets,
  ...roi(bets, ret, retSq),
};
console.log(JSON.stringify(result, null, 2));
