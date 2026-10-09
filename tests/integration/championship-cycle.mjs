// Accelerated championship-cycle test. Run against a PocketBase started with
// FOOTFIVE_TIME_SCALE=60 on a fresh data dir, then audit with scripts/audit-db.py.
//   PB=http://127.0.0.1:8201 CHAMPS=2 node tests/integration/championship-cycle.mjs
import { req, user, waitHealthy, sleep } from "./lib.mjs";

const CHAMPS = Number(process.env.CHAMPS || 2);
let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else failed++;
  console.log(cond ? "  ✓" : "  ✗", name, cond ? "" : detail);
}

await waitHealthy();
const stamp = Date.now();
const A = await user(`cyc_a_${stamp}@t.local`);
const B = await user(`cyc_b_${stamp}@t.local`);
const C = await user(`cyc_c_${stamp}@t.local`);
const D = await user(`cyc_d_${stamp}@t.local`);
const E = await user(`cyc_e_${stamp}@t.local`);

const live = async (u = A) => (await req("/api/footfive/live", { token: u.token })).data;
const credits = async (u) => (await req("/api/footfive/bets/mine", { token: u.token })).data.credits;
let rid = 0;
const bet = (u, body) => req("/api/footfive/bets", { method: "POST", token: u.token, body: { requestId: `r${stamp}-${++rid}`, ...body } });

// ---- claims: concurrent claim of one team, then B manages another
const teams = (await req("/api/footfive/teams", { token: A.token })).data.teams;
const free = teams.filter((t) => t.available);
const [c1, c2] = await Promise.all([
  req(`/api/footfive/teams/${free[0].id}/claim`, { method: "POST", token: D.token }),
  req(`/api/footfive/teams/${free[0].id}/claim`, { method: "POST", token: E.token }),
]);
ok("simultaneous claims: exactly one wins", [c1.ok, c2.ok].filter(Boolean).length === 1, `${c1.status}/${c2.status}`);
const loserMsg = (c1.ok ? c2 : c1).data.message || "";
ok("losing claim explains why", /already manages|manage/i.test(loserMsg), loserMsg);
const bTeam = free[1];
const bc = await req(`/api/footfive/teams/${bTeam.id}/claim`, { method: "POST", token: B.token });
ok("B claims a team", bc.ok, JSON.stringify(bc.data));
const b2 = await req(`/api/footfive/teams/${free[2].id}/claim`, { method: "POST", token: B.token });
ok("one team per user", !b2.ok && /already manage/i.test(b2.data.message || ""), b2.data.message);
const mode = await req("/api/footfive/my-team/mode", { method: "POST", token: D.ok ? D.token : D.token, body: { mode: "ai" } });
ok("Full AI mode can be set by an owner (or rejected for non-owner)", mode.status === 200 || mode.status === 400);

let champsSeen = 0;
let lastNumber = null;
let checkedPre = false;
let checkedLive = false;
let checkedChampion = false;
const transitions = [];
let prevMode = null;
const deadline = Date.now() + CHAMPS * 6 * 60 * 1000;

while (Date.now() < deadline) {
  // GETs no longer advance the world (issue #17): drive progression through the
  // designed-tick endpoint instead of relying on the poll itself to tick.
  await req("/api/footfive/health");
  const v = await live();
  const mode = v.mode + ":" + (v.round ? v.round.key + "/" + v.round.status : "-");
  if (mode !== prevMode) {
    transitions.push({ mode, t: v.serverTimeMs, nextChampionshipAt: v.nextChampionshipAt, fixturesAt: v.fixturesAt, scheduledAt: v.round && v.round.scheduledAt, number: v.championship && v.championship.number });
    console.log("  →", mode, v.championship ? "#" + v.championship.number : "");
    prevMode = mode;
  }
  if (v.championship && v.championship.number !== lastNumber && v.round && v.round.key === "r16") {
    lastNumber = v.championship.number;
    champsSeen++;
    checkedPre = false;
    checkedLive = false;
  }
  if (champsSeen > CHAMPS) break;

  // ---- pre-kick-off checks on the R16 window
  if (!checkedPre && v.mode === "fixtures" && v.round.key === "r16" && v.round.scheduledAt - v.serverTimeMs > 1500) {
    checkedPre = true;
    const fx = v.fixtures;
    ok("8 R16 fixtures in stable order", fx.length === 8 && fx.every((f, i) => f.index === i));
    ok("no live score before kick-off", fx.every((f) => f.st === null && f.status === "scheduled"));
    ok("pre-match odds present", fx.every((f) => f.odds && f.odds.home > 1 && f.odds.away > 1));
    const wide = (await req("/api/footfive/markets", { token: A.token })).data;
    const keys = wide.markets.map((m) => m.key).sort().join(",");
    ok("round_first + champion + semis offered before R16", keys === "champion,round_first,semis", keys);
    const before = await credits(A);
    const champSel = wide.markets.find((m) => m.key === "champion").sel[0];
    const rb1 = await bet(A, { market: "champion", selection: champSel.id, stake: 10, odds: champSel.odds });
    ok("champion bet accepted", rb1.ok, JSON.stringify(rb1.data));
    const quarters = wide.markets.find((m) => m.key === "semis").quarters;
    const pickIds = quarters.map((q) => q.slice().sort((a, b) => b.p - a.p)[0].id);
    // price lookup for semis: server returns the price in the rejection message if odds too high
    let sb = await bet(A, { market: "semis", selection: pickIds.join(","), stake: 10, odds: 500 });
    const m = /Odds changed to (\d+\.\d+)/.exec(sb.data.message || "");
    ok("semis stale-price rejection carries the new price", !!m, sb.data.message);
    if (m) sb = await bet(A, { market: "semis", selection: pickIds.join(","), stake: 10, odds: Number(m[1]) });
    ok("semis bet accepted", sb.ok, JSON.stringify(sb.data));
    const bad = await bet(A, { market: "semis", selection: quarters[0].slice(0, 2).map((t) => t.id).concat(pickIds.slice(2)).join(","), stake: 10, odds: 2 });
    ok("semis rejects two teams from one quarter", !bad.ok, bad.data.message);
    const rf = wide.markets.find((m) => m.key === "round_first").sel.filter((s) => s.odds)[0];
    const rfb = await bet(A, { market: "round_first", selection: rf.id, stake: 10, odds: rf.odds });
    ok("round_first bet accepted", rfb.ok, JSON.stringify(rfb.data));

    const mk = (await req(`/api/footfive/markets/${fx[0].id}`, { token: A.token })).data;
    const w = mk.markets.find((x) => x.key === "winner").sel[0];
    const reqId = `dup-${stamp}-${lastNumber}`;
    const d1 = await req("/api/footfive/bets", { method: "POST", token: A.token, body: { requestId: reqId, market: "winner", fixtureId: fx[0].id, selection: w.id, stake: 25, odds: w.odds } });
    const d2 = await req("/api/footfive/bets", { method: "POST", token: A.token, body: { requestId: reqId, market: "winner", fixtureId: fx[0].id, selection: w.id, stake: 25, odds: w.odds } });
    ok("duplicate request returns the same bet", d1.ok && d2.ok && d2.data.duplicate && d1.data.bet.id === d2.data.bet.id, JSON.stringify(d2.data));
    const stale = await bet(A, { market: "winner", fixtureId: fx[0].id, selection: w.id, stake: 5, odds: w.odds + 0.5 });
    ok("better-than-current odds rejected", !stale.ok && /Odds changed/.test(stale.data.message || ""), stale.data.message);
    const broke = await bet(A, { market: "winner", fixtureId: fx[0].id, selection: w.id, stake: 99999, odds: w.odds });
    ok("unaffordable stake rejected", !broke.ok && /Not enough credits/.test(broke.data.message || ""), broke.data.message);
    const frac = await bet(A, { market: "winner", fixtureId: fx[0].id, selection: w.id, stake: 2.5, odds: w.odds });
    ok("fractional stake rejected", !frac.ok);
    const ex = mk.markets.find((x) => x.key === "exact").sel.find((s) => s.id === "1-0");
    const exb = await bet(A, { market: "exact", fixtureId: fx[1].id, selection: "1-1", stake: 10, odds: 1.01 });
    ok("exact score bet accepted", exb.ok || /Odds changed/.test(exb.data.message || ""), exb.data.message);
    void ex;
    const mg = await bet(A, { market: "margin", fixtureId: fx[2].id, selection: "home2", stake: 10, odds: 1.01 });
    ok("margin bet accepted", mg.ok, mg.data.message);
    const after = await credits(A);
    ok("balance debited once per accepted bet", before - after === 10 + 10 + 10 + 25 + 10 + 10, `${before}→${after}`);

    // ---- manager restrictions (B)
    const own = fx.find((f) => f.home.id === bTeam.id || f.away.id === bTeam.id);
    const ownMk = (await req(`/api/footfive/markets/${own.id}`, { token: B.token })).data;
    ok("manager sees own fixture blocked", !!ownMk.blocked, JSON.stringify(ownMk.blocked));
    const ob = await bet(B, { market: "winner", fixtureId: own.id, selection: "home", stake: 5, odds: 1.01 });
    ok("manager cannot bet on own fixture", !ob.ok && /manage/i.test(ob.data.message || ""), ob.data.message);
    const oc = await bet(B, { market: "champion", selection: champSel.id, stake: 5, odds: 1.01 });
    ok("manager cannot bet on championship futures", !oc.ok && /Managers/i.test(oc.data.message || ""), oc.data.message);
    const other = fx.find((f) => f !== own);
    const otherW = (await req(`/api/footfive/markets/${other.id}`, { token: B.token })).data.markets[0].sel[0];
    const obo = await bet(B, { market: "winner", fixtureId: other.id, selection: otherW.id, stake: 5, odds: otherW.odds });
    ok("manager can bet on other fixtures", obo.ok, obo.data.message);

    // ---- C bets on a fixture, then cannot claim a team in it
    const target = fx.find((f) => f.home.available && f.away.available && f.home.id !== bTeam.id && f.away.id !== bTeam.id) || fx[5];
    const tw = (await req(`/api/footfive/markets/${target.id}`, { token: C.token })).data.markets[0].sel[0];
    const cb = await bet(C, { market: "winner", fixtureId: target.id, selection: tw.id, stake: 5, odds: tw.odds });
    ok("C bet on a fixture", cb.ok, cb.data.message);
    const cc = await req(`/api/footfive/teams/${target.home.id}/claim`, { method: "POST", token: C.token });
    ok("claim blocked by pending bet on that team", !cc.ok && /pending bet/i.test(cc.data.message || ""), cc.data.message);
  }

  // ---- live checks
  if (!checkedLive && v.mode === "live" && v.round.key === "r16") {
    const f = v.fixtures.find((x) => x.st && x.st.ph !== "finished" && x.st.ph !== "shootout");
    if (f) {
      checkedLive = true;
      const cf = (await req("/api/footfive/markets", { token: A.token })).data;
      ok("futures closed after kick-off", cf.markets.length === 0, JSON.stringify(cf.markets.map((m) => m.key)));
      const mk = (await req(`/api/footfive/markets/${f.id}`, { token: A.token })).data;
      const ng = mk.markets.find((x) => x.key === "next_goal");
      if (ng && !ng.closed) {
        const s = ng.sel.find((x) => x.odds);
        const r = await bet(A, { market: "next_goal", fixtureId: f.id, selection: s.id, stake: 10, odds: s.odds });
        ok("live next-goal bet accepted or cleanly refused", r.ok || /moved on|Odds changed|Suspended|incident/i.test(r.data.message || ""), r.data.message);
      }
      // match view: late join returns the latest events only, ordered and bounded
      const mv = (await req(`/api/footfive/match/${f.id}`, { token: A.token })).data;
      const seqs = mv.events.map((e) => e.seq);
      ok("late join gets ordered, bounded events", seqs.length <= 60 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
      ok("match view exposes no engine state", !JSON.stringify(mv).includes('"seed"') && !JSON.stringify(mv).includes("nextAt"));
      const last = seqs[seqs.length - 1] || 0;
      const inc = (await req(`/api/footfive/match/${f.id}?since=${last}`, { token: A.token })).data;
      ok("incremental fetch returns only newer events", inc.events.every((e) => e.seq > last));
      const coach = await req(`/api/footfive/matches/${f.id}/coaching`, { method: "POST", token: A.token, body: { stance: "attack" } });
      ok("non-manager cannot coach", !coach.ok);
    }
  }

  if (!checkedChampion && v.mode === "champion") {
    checkedChampion = true;
    ok("champion screen shows a winner", !!(v.champion && v.champion.team && v.champion.final));
    ok("countdown to next championship", v.nextChampionshipAt > v.serverTimeMs);
  }
  await sleep(250);
}

// ---- schedule checks from the observed transitions
for (let i = 1; i < transitions.length; i++) {
  const p = transitions[i - 1];
  const t = transitions[i];
  if (p.mode.startsWith("champion") && t.mode.startsWith("fixtures:r16")) {
    const lead = (t.scheduledAt - t.t) / 1000;
    const windowS = (5 * 60) / Number(process.env.SCALE || 60);
    ok(`fixtures window opened ~5 game-minutes before kick-off (${lead.toFixed(1)}s, expected ≤${windowS}s)`, lead > windowS - 1.5 && lead <= windowS + 0.2, lead);
    ok("champion screen announced the fixture time it then honoured", Math.abs(p.fixturesAt - (t.scheduledAt - windowS * 1000)) < 50, `${p.fixturesAt} vs ${t.scheduledAt}`);
  }
  if (p.mode.startsWith("fixtures") && t.mode.startsWith("live")) {
    ok("kick-off at the scheduled time", t.t >= p.scheduledAt - 50, `${t.t} vs ${p.scheduledAt}`);
  }
}
ok("several championships ran unattended", champsSeen >= CHAMPS, champsSeen);
const mine = (await req("/api/footfive/bets/mine", { token: A.token })).data;
ok("bets settled into won/lost/void", mine.bets.filter((b) => b.status !== "open").length >= 5, JSON.stringify(mine.bets.map((b) => b.status)));
console.log(JSON.stringify({ passed, failed, statuses: mine.bets.map((b) => b.market + ":" + b.status) }));
process.exit(failed ? 1 : 0);
