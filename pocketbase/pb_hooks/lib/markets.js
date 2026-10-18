/**
 * Betting markets — pure rules (catalogue, labels, validation, settlement).
 * Database work lives in bettingService.js; prices come from odds.js.
 *
 * Settlement rules (also shown in the UI):
 *  winner      Team to qualify — includes extra time and penalties.
 *  exact       Final football score after extra time; shootout goals excluded.
 *  next_goal   Next goal after the bet is accepted (shootouts excluded); "none" wins if no
 *              further goal is scored in normal or extra time.
 *  margin      Team wins by exactly 1, 2, or 3 on the final football score (incl. extra
 *              time, excl. shootout). A match decided on penalties has a margin of 0.
 *  round_first First team to score in the round (shootouts excluded). Refunded if the whole
 *              round has no eligible goal. Goals timed in the same millisecond: earlier fixture.
 *  champion    Championship winner. Only before the championship kicks off.
 *  semis       The four semi-finalists, any order (one team from each quarter of the draw).
 *              Only before the championship kicks off.
 */
var oddsMod;
try {
  oddsMod = require(__hooks + "/lib/odds.js");
} catch (e) {
  oddsMod = require("./odds.js");
}

var LIVE = { first_half: 1, half_time: 1, second_half: 1, et_break: 1, extra_time_1: 1, et_half_time: 1, extra_time_2: 1 };
var MIN_P = 0.002; // below this a selection is not offered
var MAX_STAKE = 100000;

var TITLES = {
  winner: "To qualify",
  exact: "Exact score (after ET)",
  next_goal: "Next goal",
  margin: "Winning margin",
  round_first: "First team to score in the round",
  champion: "Championship winner",
  semis: "Semi-finalists",
};

var RULES = {
  winner: "Team that goes through, including extra time and penalties.",
  exact: "Final football score including extra time. Shootout goals do not count.",
  next_goal: "Next goal after your bet is accepted. Shootout kicks do not count. 'No further goals' wins if nobody scores again in normal or extra time.",
  margin: "Team wins by exactly that many goals on the final football score (incl. extra time). A shootout win has a margin of 0.",
  round_first: "First goal of the whole round (shootouts excluded). Stakes are refunded if the round has no goal.",
  champion: "Wins the championship. Closes at the Round of 16 kick-off.",
  semis: "Pick one team from each quarter of the draw; all four must reach the semi-finals. Closes at the Round of 16 kick-off.",
};

function okP(p) {
  return p >= MIN_P ? oddsMod.price(p) : null;
}

/** Why a live fixture market is closed, or null when open. */
function fixtureState(fixture, st, now) {
  if (fixture.status === "finished" || (st && st.ph === "finished")) return { phase: "finished", closed: "Match finished" };
  if (fixture.status === "scheduled" || !st) {
    if (fixture.kickoffAt && now >= fixture.kickoffAt) return { phase: "kickoff", closed: "Kick-off in progress" };
    return { phase: "pre", closed: null };
  }
  if (st.ph === "shootout") return { phase: "shootout", closed: st.d ? "Penalty kick in progress" : null };
  if (LIVE[st.ph]) return { phase: "live", closed: st.d ? "Suspended — incident in progress" : null };
  return { phase: st.ph, closed: "Unavailable" };
}

/**
 * Full fixture market catalogue with current prices.
 * @param fx { id, status, kickoffAt, model: {lh, la}, home: {id, abbr, name}, away }
 * @param st latest published state (or null before kick-off)
 * @param minute public match minute (whole minutes)
 */
function fixtureMarkets(fx, st, minute, now) {
  var state = fixtureState(fx, st, now);
  var pub = st || { sc: [0, 0], ph: "pre" };
  var out = [];
  if (state.phase === "finished" || !fx.model) return { state: state, markets: out };
  var fd = oddsMod.finalDist(fx.model, pub, minute);
  var closed = state.closed;
  var H = fx.home;
  var A = fx.away;

  out.push({
    key: "winner",
    title: TITLES.winner,
    rules: RULES.winner,
    closed: closed,
    sel: [
      { id: "home", label: H.name, short: H.abbr, odds: okP(fd.qualifyHome) },
      { id: "away", label: A.name, short: A.abbr, odds: okP(1 - fd.qualifyHome) },
    ],
  });
  if (state.phase === "shootout") return { state: state, markets: out };

  var sc = pub.sc;
  var exact = [];
  for (var h = sc[0]; h <= sc[0] + 5; h++) {
    for (var a = sc[1]; a <= sc[1] + 5; a++) {
      var o = okP(fd.dist[h + "-" + a] || 0);
      if (o) exact.push({ id: h + "-" + a, label: H.abbr + " " + h + "–" + a + " " + A.abbr, short: h + "–" + a, odds: o });
    }
  }
  out.push({ key: "exact", title: TITLES.exact, rules: RULES.exact, closed: closed, sel: exact });

  var ng = oddsMod.nextGoal(fx.model, pub, minute);
  out.push({
    key: "next_goal",
    title: TITLES.next_goal,
    rules: RULES.next_goal,
    closed: closed,
    sel: [
      { id: "home", label: H.name, short: H.abbr, odds: okP(ng.home) },
      { id: "none", label: "No further goals", short: "None", odds: okP(ng.none) },
      { id: "away", label: A.name, short: A.abbr, odds: okP(ng.away) },
    ],
  });

  var margins = [];
  [
    ["home", 1],
    ["home", 2],
    ["home", 3],
    ["away", 1],
    ["away", 2],
    ["away", 3],
  ].forEach(function (m) {
    var p = 0;
    for (var k in fd.dist) {
      var s = k.split("-");
      var d = m[0] === "home" ? s[0] - s[1] : s[1] - s[0];
      if (d === m[1]) p += fd.dist[k];
    }
    var t = m[0] === "home" ? H : A;
    margins.push({ id: m[0] + m[1], label: t.name + " by exactly " + m[1], short: t.abbr + " by " + m[1], odds: okP(p) });
  });
  out.push({ key: "margin", title: TITLES.margin, rules: RULES.margin, closed: closed, sel: margins });
  return { state: state, markets: out };
}

/** Find the server price for a selection in a catalogue; null when unavailable. */
function findSelection(catalogue, market, selection) {
  for (var i = 0; i < catalogue.markets.length; i++) {
    var m = catalogue.markets[i];
    if (m.key !== market) continue;
    if (m.closed) return { closed: m.closed };
    for (var j = 0; j < m.sel.length; j++) {
      if (m.sel[j].id === selection) return m.sel[j].odds ? { odds: m.sel[j].odds, sel: m.sel[j], market: m } : { closed: "Selection unavailable" };
    }
    return { closed: "Unknown selection" };
  }
  return { closed: "Market not offered" };
}

/** Semi-finalist set: one team from each quarter. Returns sorted ids or throws a message. */
function normaliseSemis(selection, quarters) {
  var ids = String(selection || "")
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  if (ids.length !== 4) return { error: "Choose exactly four teams" };
  var seen = {};
  for (var q = 0; q < quarters.length; q++) {
    var hits = ids.filter(function (id) {
      return quarters[q].indexOf(id) >= 0;
    });
    if (hits.length !== 1) return { error: "Pick exactly one team from each quarter of the draw" };
    seen[hits[0]] = 1;
  }
  if (Object.keys(seen).length !== 4) return { error: "Choose four different teams" };
  return { ids: ids.slice().sort() };
}

/**
 * Settlement decision for a fixture market at full time.
 * @param result { sh, sa, winner: "home"|"away" }
 * @returns "won" | "lost"
 */
function settleFixtureBet(market, selection, result) {
  if (market === "winner") return selection === result.winner ? "won" : "lost";
  if (market === "exact") return selection === result.sh + "-" + result.sa ? "won" : "lost";
  if (market === "margin") {
    var side = selection.slice(0, 4);
    var n = parseInt(selection.slice(4), 10);
    var d = side === "home" ? result.sh - result.sa : result.sa - result.sh;
    return d === n ? "won" : "lost";
  }
  if (market === "next_goal") return selection === "none" ? "won" : "lost"; // reached full time with no further goal
  return "lost";
}

function validStake(stake) {
  var s = Number(stake);
  if (!isFinite(s) || Math.floor(s) !== s || s < 1) return { error: "Stake must be a whole number of credits" };
  if (s > MAX_STAKE) return { error: "Maximum stake is " + MAX_STAKE + " credits" };
  return { stake: s };
}

function payout(stake, odds) {
  return Math.floor(stake * odds + 1e-9);
}

if (typeof module !== "undefined") {
  module.exports = {
    TITLES: TITLES,
    RULES: RULES,
    MIN_P: MIN_P,
    fixtureState: fixtureState,
    fixtureMarkets: fixtureMarkets,
    findSelection: findSelection,
    normaliseSemis: normaliseSemis,
    settleFixtureBet: settleFixtureBet,
    validStake: validStake,
    payout: payout,
    okP: okP,
  };
}
