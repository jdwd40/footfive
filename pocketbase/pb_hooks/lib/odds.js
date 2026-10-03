/**
 * Odds model (pure, node-testable).
 *
 * Each fixture has a kickoff model { lh, la }: expected goals per match minute for
 * each side, taken from the match engine with balanced tactics. Remaining goals are
 * Poisson(rate × minutes left); a red card multiplies the side's rate by 0.75 and the
 * opponent's by 1.15. Level after 90' adds 30' of extra time; level after that is a
 * shootout (each kick scores with probability SHOOTOUT_P). Prices carry a 6 % margin.
 */
var MARGIN = 0.06;
var MIN_ODDS = 1.01;
var MAX_ODDS = 500;
var SHOOTOUT_P = 0.75;
var K = 12; // max extra goals considered per side

var REG_PHASES = { pre: 1, first_half: 1, half_time: 1, second_half: 1 };
var ET_PHASES = { et_break: 1, extra_time_1: 1, et_half_time: 1, extra_time_2: 1 };

function pmf(lambda) {
  var out = [];
  var p = Math.exp(-lambda);
  for (var k = 0; k <= K; k++) {
    out.push(p);
    p = (p * lambda) / (k + 1);
  }
  return out;
}

function price(p) {
  if (!(p > 0)) return null;
  var o = (1 - MARGIN) / p;
  return Math.round(Math.min(MAX_ODDS, Math.max(MIN_ODDS, o)) * 100) / 100;
}

function rates(model, st) {
  var rh = (st && st.x && st.x[0] && st.x[0][6]) || 0;
  var ra = (st && st.x && st.x[1] && st.x[1][6]) || 0;
  return {
    h: model.lh * Math.pow(0.75, rh) * Math.pow(1.15, ra),
    a: model.la * Math.pow(0.75, ra) * Math.pow(1.15, rh),
  };
}

/** Probability that home wins a shootout from the given state. */
function shootoutHome(so) {
  var memo = {};
  var p = SHOOTOUT_P;
  function decided(h, a, th, ta) {
    if (th <= 5 && ta <= 5) {
      if (h + (5 - th) < a) return 0;
      if (a + (5 - ta) < h) return 1;
      return -1;
    }
    if (th === ta && h !== a) return h > a ? 1 : 0;
    return -1;
  }
  function f(h, a, th, ta, next, depth) {
    var d = decided(h, a, th, ta);
    if (d >= 0) return d;
    if (depth > 40) return 0.5;
    var key = h + "," + a + "," + th + "," + ta + "," + next;
    if (memo[key] != null) return memo[key];
    var r;
    if (next === "home") r = p * f(h + 1, a, th + 1, ta, "away", depth + 1) + (1 - p) * f(h, a, th + 1, ta, "away", depth + 1);
    else r = p * f(h, a + 1, th, ta + 1, "home", depth + 1) + (1 - p) * f(h, a, th, ta + 1, "home", depth + 1);
    memo[key] = r;
    return r;
  }
  if (!so) return 0.5;
  return f(so.h, so.a, so.th, so.ta, so.next || "home", 0);
}

/**
 * Final football-score distribution (incl. extra time, excl. shootout).
 * @param model { lh, la } per-minute rates
 * @param st published state { sc, ph, so, x }
 * @param minute current match minute (from the public clock)
 * @param noDist skip the score distribution (qualify probability only — much cheaper)
 * @returns { dist: { "h-a": p }, qualifyHome: p }
 */
function finalDist(model, st, minute, noDist) {
  var sc = (st && st.sc) || [0, 0];
  var ph = (st && st.ph) || "pre";
  var dist = {};
  function addFinal(h, a, p) {
    if (noDist || p < 1e-12) return;
    var k = h + "-" + a;
    dist[k] = (dist[k] || 0) + p;
  }
  if (ph === "finished") {
    addFinal(sc[0], sc[1], 1);
    return { dist: dist, qualifyHome: st.win === "home" ? 1 : 0 };
  }
  if (ph === "shootout") {
    addFinal(sc[0], sc[1], 1);
    return { dist: dist, qualifyHome: shootoutHome(st.so) };
  }
  var r = rates(model, st);
  var inET = !!ET_PHASES[ph];
  var etMins = inET ? Math.max(0, 120 - Math.max(minute, 90)) : 30;
  var etH = pmf(r.h * etMins);
  var etA = pmf(r.a * etMins);
  // Extra time is independent of how the 90 minutes ended level.
  var etWin = 0;
  var etLevel = 0;
  for (var i = 0; i <= K; i++) {
    for (var j = 0; j <= K; j++) {
      var q = etH[i] * etA[j];
      if (i > j) etWin += q;
      else if (i === j) etLevel += q;
    }
  }
  var etQualify = etWin + etLevel * 0.5; // a shootout is a coin flip pre-shootout
  if (inET) {
    for (var x = 0; x <= K; x++) for (var y = 0; y <= K; y++) addFinal(sc[0] + x, sc[1] + y, etH[x] * etA[y]);
    var lead = sc[0] - sc[1];
    var qET = 0;
    for (var u = 0; u <= K; u++) {
      for (var v = 0; v <= K; v++) {
        var p2 = etH[u] * etA[v];
        if (lead + u - v > 0) qET += p2;
        else if (lead + u - v === 0) qET += p2 * 0.5;
      }
    }
    return { dist: dist, qualifyHome: qET };
  }
  var left = Math.max(0, 90 - minute);
  var gh = pmf(r.h * left);
  var ga = pmf(r.a * left);
  var qualify = 0;
  for (var a1 = 0; a1 <= K; a1++) {
    for (var b1 = 0; b1 <= K; b1++) {
      var p = gh[a1] * ga[b1];
      var h = sc[0] + a1;
      var aw = sc[1] + b1;
      if (h > aw) {
        qualify += p;
        addFinal(h, aw, p);
      } else if (h < aw) {
        addFinal(h, aw, p);
      } else {
        qualify += p * etQualify;
        if (!noDist) for (var e1 = 0; e1 <= K; e1++) for (var e2 = 0; e2 <= K; e2++) addFinal(h + e1, aw + e2, p * etH[e1] * etA[e2]);
      }
    }
  }
  return { dist: dist, qualifyHome: qualify };
}

/** Probabilities for the next goal (excl. shootouts). */
function nextGoal(model, st, minute) {
  var ph = (st && st.ph) || "pre";
  if (ph === "finished" || ph === "shootout") return { home: 0, away: 0, none: 1 };
  var r = rates(model, st);
  var L = r.h + r.a;
  var level = st.sc[0] === st.sc[1];
  var none;
  if (REG_PHASES[ph]) none = Math.exp(-L * Math.max(0, 90 - minute)) * (level ? Math.exp(-L * 30) : 1);
  else none = Math.exp(-L * Math.max(0, 120 - Math.max(minute, 90)));
  return { home: ((1 - none) * r.h) / L, away: ((1 - none) * r.a) / L, none: none };
}

function marginProb(dist, side, n) {
  var p = 0;
  for (var k in dist) {
    var parts = k.split("-");
    var d = side === "home" ? parts[0] - parts[1] : parts[1] - parts[0];
    if (d === n) p += dist[k];
  }
  return p;
}

/** All fixture market prices from the published state. */
function fixturePrices(model, st, minute) {
  var fd = finalDist(model, st, minute);
  var ng = nextGoal(model, st, minute);
  var exact = {};
  for (var k in fd.dist) if (fd.dist[k] > 0.0005) exact[k] = price(fd.dist[k]);
  return {
    winner: { home: price(fd.qualifyHome), away: price(1 - fd.qualifyHome) },
    exact: exact,
    next_goal: { home: price(ng.home), away: price(ng.away), none: price(ng.none) },
    margin: {
      home2: price(marginProb(fd.dist, "home", 2)),
      home3: price(marginProb(fd.dist, "home", 3)),
      away2: price(marginProb(fd.dist, "away", 2)),
      away3: price(marginProb(fd.dist, "away", 3)),
    },
    p: { qualifyHome: fd.qualifyHome },
  };
}

/** Exact-score price for any score (scores not in the cached map are long shots). */
function exactPrice(model, st, minute, h, a) {
  var fd = finalDist(model, st, minute);
  return price(fd.dist[h + "-" + a] || 0);
}

/** P(home qualifies) for a pre-match model. */
function pairQualify(model) {
  return finalDist(model, { sc: [0, 0], ph: "pre" }, 0, true).qualifyHome;
}

/**
 * Championship probabilities from the R16 bracket.
 * @param r16 [{ home, away }] x 8 in bracket order (team ids)
 * @param q function(i, j) -> P(i beats j)
 */
function bracket(r16, q) {
  function stage(groups, prev) {
    // groups: array of [listA, listB] team lists meeting in one slot
    var next = {};
    groups.forEach(function (g) {
      [0, 1].forEach(function (s) {
        g[s].forEach(function (t) {
          var p = 0;
          g[1 - s].forEach(function (u) {
            p += (prev[u] || 0) * q(t, u);
          });
          next[t] = (prev[t] || 0) * p;
        });
      });
    });
    return next;
  }
  var all = {};
  var slots = r16.map(function (f) {
    all[f.home] = 1;
    all[f.away] = 1;
    return [[f.home], [f.away]];
  });
  var p1 = stage(slots, all); // win R16
  var qf = [];
  for (var i = 0; i < 4; i++) qf.push([[r16[2 * i].home, r16[2 * i].away], [r16[2 * i + 1].home, r16[2 * i + 1].away]]);
  var p2 = stage(qf, p1); // win QF = reach SF
  var sf = [
    [qf[0][0].concat(qf[0][1]), qf[1][0].concat(qf[1][1])],
    [qf[2][0].concat(qf[2][1]), qf[3][0].concat(qf[3][1])],
  ];
  var p3 = stage(sf, p2); // reach final
  var fin = [[sf[0][0].concat(sf[0][1]), sf[1][0].concat(sf[1][1])]];
  var p4 = stage(fin, p3); // champion
  return {
    champion: p4,
    reachSF: p2,
    quarters: qf.map(function (g) {
      return g[0].concat(g[1]);
    }),
  };
}

/** Probability that the first goal of a round is scored by each team (refund if none). */
function roundFirst(models) {
  // models: [{ home, away, lh, la }]
  var total = 0;
  var out = {};
  models.forEach(function (m) {
    total += m.lh + m.la;
  });
  var any = 1 - Math.exp(-total * 90);
  models.forEach(function (m) {
    out[m.home] = (m.lh / total) * any;
    out[m.away] = (m.la / total) * any;
  });
  return out;
}

/** Public match minute (float) from a published clock anchor; never passes the period end. */
function clockMinute(clk, at, now, minuteMs) {
  if (!clk) return 120;
  var s = clk.s;
  if (clk.run) {
    var end = s < 2700 ? 2700 : s < 5400 ? 5400 : s < 6300 ? 6300 : 7200;
    s = Math.min(end, s + (Math.max(0, now - at) / minuteMs) * 60);
  }
  return s / 60;
}

if (typeof module !== "undefined") {
  module.exports = {
    MARGIN: MARGIN,
    price: price,
    finalDist: finalDist,
    nextGoal: nextGoal,
    fixturePrices: fixturePrices,
    exactPrice: exactPrice,
    pairQualify: pairQualify,
    bracket: bracket,
    roundFirst: roundFirst,
    shootoutHome: shootoutHome,
    clockMinute: clockMinute,
  };
}
