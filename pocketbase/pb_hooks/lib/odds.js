/**
 * Odds model (pure, node-testable).
 *
 * Each fixture has a kickoff model { lh, la }: expected goals per match minute for
 * each side, taken from the match engine with balanced tactics. Remaining goals are
 * Poisson(rate × minutes left); a red card multiplies the side's rate by 0.75 and the
 * opponent's by 1.15. Level after 90' adds 30' of extra time; level after that is a
 * shootout (each kick scores with probability SHOOTOUT_P). Prices carry a 6 % margin.
 * In play (#203), a near-certain selection is withdrawn: no price when the margin price
 * would be under MIN_OFFER, i.e. p > (1 - MARGIN) / MIN_OFFER ≈ 0.895. A withdrawn
 * selection has null odds and cannot be bet (bettingService: "Selection unavailable");
 * bets already placed keep their confirmed odds and settle unchanged. Pre-match prices
 * are as before, including the 1.01 floor for a lopsided pairing.
 *
 * #219: a kickoff model with game states (`r`, `k`, `at`: matchEngine.inPlayModel) is priced from the score and the minute:
 * until `at.chase` every score has the same rates, so goals there are Poisson with the summed rates; from the chase each
 * minute is walked with the rates of the score at its start (a side trailing attacks with urgency, a side leading by one
 * from `at.protect` defends, level from `at.settle` both attack), counters and rebounds already in the engine's rates. The
 * engine plays at most one attack a minute, so a walked minute has one goal at most: home with probability rate.h, away
 * with rate.a. Polled callers get the same numbers from the cached fast paths (marketProbs; see "fast paths" below). A
 * legacy model ({ lh, la } only, e.g. a match in flight at the #219 deploy) is priced as before.
 * #228: manager tables (`v` indices into `vr`) are selected from the latest published snapshot `cs`, or kickoff `model.cs`.
 * AI sides keep their score/minute policy. Stance is part of the cache key; no future manager command is read.
 */
var MARGIN = 0.06;
var MIN_ODDS = 1.01;
var MIN_OFFER = 1.05; // #203: in play, below this the outcome is all but decided: withdraw it rather than offer 1.01
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

/** `inPlay`: the match has kicked off (any phase after "pre"); only then is a near-certain selection withdrawn. */
function price(p, inPlay) {
  if (!(p > 0)) return null;
  var o = (1 - MARGIN) / p;
  if (inPlay && o < MIN_OFFER) return null;
  return Math.round(Math.min(MAX_ODDS, Math.max(MIN_ODDS, o)) * 100) / 100;
}

/** Has the match kicked off? Published state in any phase after "pre" (half-time, extra time and the shootout included). */
function inPlay(st) {
  return !!st && !!st.ph && st.ph !== "pre";
}

function zeros(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(0);
  return a;
}

/** #219: model with game states? */
function staged(model) {
  return !!(model && model.r && model.k && model.at);
}

/**
 * #228: select only stances known at this published snapshot. AI sides retain the model's score/minute policy; a manager's
 * current choice is held until another coaching row is published. Old snapshots fall back to kickoff. Old models without
 * variant tables keep their original prices (drain in-flight matches before deploying for complete #228 coverage).
 * Selected wrappers are non-enumerable runtime cache entries, never persisted or used as hidden match state.
 */
function publishedModel(model, st) {
  if (!model || !model.v) return model;
  var cs = (st && st.cs) || [];
  var valid = function (s) { return s === "balanced" || s === "attack" || s === "defend"; };
  var h = !model.ai[0] && valid(cs[0]) ? cs[0] : model.cs[0];
  var a = !model.ai[1] && valid(cs[1]) ? cs[1] : model.cs[1];
  var key = h + ":" + a;
  if (!Object.prototype.hasOwnProperty.call(model.v, key)) return model;
  if (!model.__stances) Object.defineProperty(model, "__stances", { value: {}, enumerable: false });
  if (!model.__stances[key]) model.__stances[key] = {
    lh: model.lh, la: model.la, at: model.at, k: model.k, r: model.vr[model.v[key]], csKey: key,
  };
  return model.__stances[key];
}

/**
 * #219: state `key`'s [home, away] rate at minute k, interpolated linearly between the model's sample minutes (`model.k`;
 * players tire as the match goes on). The fast paths' rate table uses the same arithmetic, inline.
 */
function rateAt(model, key, k) {
  var ks = model.k;
  var r = model.r[key];
  var n = ks.length - 1;
  if (k <= ks[0]) return [r[0], r[1]];
  if (k >= ks[n]) return [r[2 * n], r[2 * n + 1]];
  var s = 0;
  while (k > ks[s + 1]) s++;
  var t = (k - ks[s]) / (ks[s + 1] - ks[s]);
  return [r[2 * s] + t * (r[2 * s + 2] - r[2 * s]), r[2 * s + 1] + t * (r[2 * s + 3] - r[2 * s + 1])];
}

/** #219: the game state of minute k for score difference d = home − away at its start. */
function stageKey(model, k, d) {
  var at = model.at;
  if (d < 0 && k >= at.chase) return d === -1 && k >= at.protect ? "hT1" : "hT";
  if (d > 0 && k >= at.chase) return d === 1 && k >= at.protect ? "aT1" : "aT";
  if (d === 0 && k >= at.settle) return "L";
  return "n";
}

/** #219: per-minute [home, away] rates for minute k with the score difference d = home − away at its start. */
function stageRates(model, k, d) {
  return rateAt(model, stageKey(model, k, d), k);
}

/** Red-card multipliers (as rates()) for the published state. */
function redMul(st) {
  var rh = (st && st.x && st.x[0] && st.x[0][6]) || 0;
  var ra = (st && st.x && st.x[1] && st.x[1][6]) || 0;
  return { h: Math.pow(0.75, rh) * Math.pow(1.15, ra), a: Math.pow(0.75, ra) * Math.pow(1.15, rh) };
}

/** First minute still to play (engine numbering, 1-based) from the public minute, and whether play is in extra time. */
function firstMinute(ph, minute) {
  var inET = !!ET_PHASES[ph];
  return { k0: inET ? Math.max(minute, 90) + 1 : Math.max(0, minute) + 1, inET: inET };
}

/**
 * #219: the score-independent span. Before `at.chase` every score has the same rates (state `n`), so from minute k0 up to the
 * chase the goals each side adds are Poisson with the summed per-minute rates (as the pre-#219 model treated the whole match);
 * from the chase on, the remaining minutes are walked one by one. Returns the first walked minute and the two sums.
 */
function span(model, red, fm) {
  var ke = fm.inET ? fm.k0 : Math.max(fm.k0, Math.min(model.at.chase, 91));
  var lh = 0;
  var la = 0;
  for (var k = fm.k0; k < ke; k++) {
    var v = rateAt(model, "n", k);
    lh += Math.min(0.5, v[0] * red.h);
    la += Math.min(0.5, v[1] * red.a);
  }
  return { ke: ke, lh: lh, la: la };
}

/** Poisson pmf 0..n−1, and the tail P(≥ n) in slot n. */
function poisTail(lambda, n) {
  var out = [];
  var p = Math.exp(-lambda);
  var sum = 0;
  for (var k = 0; k < n; k++) {
    out.push(p);
    sum += p;
    p = (p * lambda) / (k + 1);
  }
  out.push(Math.max(0, 1 - sum));
  return out;
}

/**
 * #219 REFERENCE (the definition; the fast paths below must equal it): final-score distribution and P(home qualifies). The
 * span to the chase is Poisson (span()); then the remaining minutes are walked cell by cell, at most one goal a minute. State:
 * goals added (i, j), capped at K each (slot K holds K or more). Level after 90 plays on into extra time; level after 120 is a
 * shootout, a coin flip before it starts (as before). Used for a full distribution (scripts, tests); the app's polled paths
 * use the fast paths.
 */
function stagedDist(model, st, minute, noDist) {
  model = publishedModel(model, st);
  if (noDist) return { dist: {}, qualifyHome: fastQualify(model, st, minute) };
  var sc = (st && st.sc) || [0, 0];
  var ph = (st && st.ph) || "pre";
  var red = redMul(st);
  var fm = firstMinute(ph, minute);
  var sp = span(model, red, fm);
  var N = K + 1;
  var dist = {};
  var qualify = 0;
  var cur = zeros(N * N);
  var ph0 = poisTail(sp.lh, K);
  var pa0 = poisTail(sp.la, K);
  for (var i0 = 0; i0 < N; i0++) for (var j0 = 0; j0 < N; j0++) cur[i0 * N + j0] = ph0[i0] * pa0[j0];
  var settle = function (i, j, p) {
    var h = sc[0] + i;
    var a = sc[1] + j;
    if (h > a) qualify += p;
    else if (h === a) qualify += p * 0.5;
    if (p >= 1e-12) dist[h + "-" + a] = (dist[h + "-" + a] || 0) + p;
  };
  for (var k = sp.ke; k <= 121; k++) {
    if (k === 91 && !fm.inET) {
      for (var u = 0; u < N; u++) {
        for (var v = 0; v < N; v++) {
          var q = cur[u * N + v];
          if (q > 0 && sc[0] + u !== sc[1] + v) {
            settle(u, v, q);
            cur[u * N + v] = 0;
          }
        }
      }
    }
    if (k === 121) break;
    var nx = zeros(N * N);
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < N; j++) {
        var p = cur[i * N + j];
        if (!(p > 0)) continue;
        var base = stageRates(model, k, sc[0] + i - sc[1] - j);
        var gh = i < K ? Math.min(0.5, base[0] * red.h) : 0;
        var ga = j < K ? Math.min(0.5, base[1] * red.a) : 0;
        nx[i * N + j] += p * (1 - gh - ga);
        if (gh) nx[(i + 1) * N + j] += p * gh;
        if (ga) nx[i * N + j + 1] += p * ga;
      }
    }
    cur = nx;
  }
  for (var x = 0; x < N; x++) for (var y = 0; y < N; y++) if (cur[x * N + y] > 0) settle(x, y, cur[x * N + y]);
  return { dist: dist, qualifyHome: qualify };
}

/** #219 REFERENCE next goal: the span's first goal (Poisson), then the remaining minutes at the current score. */
function stagedNext(model, st, minute) {
  model = publishedModel(model, st);
  var ph = (st && st.ph) || "pre";
  var red = redMul(st);
  var fm = firstMinute(ph, minute);
  var sp = span(model, red, fm);
  var d = st.sc[0] - st.sc[1];
  var L = sp.lh + sp.la;
  var alive = Math.exp(-L);
  var home = L > 0 ? (sp.lh / L) * (1 - alive) : 0;
  var away = L > 0 ? (sp.la / L) * (1 - alive) : 0;
  for (var k = sp.ke; k <= 120; k++) {
    if (k === 91 && !fm.inET && d !== 0) break;
    var base = stageRates(model, k, d);
    var gh = Math.min(0.5, base[0] * red.h);
    var ga = Math.min(0.5, base[1] * red.a);
    home += alive * gh;
    away += alive * ga;
    alive *= 1 - gh - ga;
  }
  return { home: home, away: away, none: alive };
}

// ---- #219 fast paths (#219 review F2: the polled endpoints run these in PocketBase's goja VM, where every float operation
// and call is costly; a full walk took 15–37 ms there). They compute the reference's numbers with less work:
// - per model and red-card state (`ctx`, cached): the span's per-minute rates as prefix sums, a rate table for the walked
//   minutes (five score classes: behind by 2+, by 1, level, ahead by 1, by 2+), and value tables V[k][d] for P(home
//   qualifies) from the start of minute k at difference d, walked backwards once; a qualify is then a lookup, or before the
//   chase the span's difference distribution against V at the chase;
// - margins walk the score difference alone; the exact score walks only the 6 × 6 cells the market shows (goals never go
//   down, so those cells receive mass only from inside it);
// - differences beyond ±R count as decided (reaching ±9 and then losing it is below 1e-10).
// Results equal the reference within 1e-9 (reboundsCounters.test.ts asserts it on a grid of states and models).

var R = 8; // ±R: the score differences walked; beyond counts as decided (reaching 9 and then losing it is below 1e-10)
var W = 2 * R + 1;
var CACHE_MAX = 200;
var cache = { n: 0, ctx: {}, res: {} };

function cacheGet(kind, key) {
  return Object.prototype.hasOwnProperty.call(cache[kind], key) ? cache[kind][key] : undefined;
}

function cachePut(kind, key, val) {
  if (cache.n >= CACHE_MAX) {
    cache.n = 0;
    cache.ctx = {};
    cache.res = {};
  }
  cache.n++;
  cache[kind][key] = val;
  return val;
}

function modelKey(model) {
  return JSON.stringify([model.lh, model.la, model.at, model.k, model.r, model.csKey]);
}

/** Rates H[k * 5 + c], A[k * 5 + c] for the walked minutes (chase..120), and cumulative span rates cH[k], cA[k] (minutes < k). */
function buildCtx(model, red) {
  var at = model.at;
  var chase = Math.min(at.chase, 91);
  var ks = model.k;
  var last = ks.length - 1;
  var H = new Array(121 * 5);
  var A = new Array(121 * 5);
  var cH = [0, 0];
  var cA = [0, 0];
  var names = ["n", "hT", "hT1", "aT", "aT1", "L"];
  var rr = [];
  for (var q0 = 0; q0 < 6; q0++) rr.push(model.r[names[q0]]);
  var curH = [0, 0, 0, 0, 0, 0];
  var curA = [0, 0, 0, 0, 0, 0];
  var seg = 0;
  for (var k = 1; k <= 120; k++) {
    // rateAt's interpolation, inline (same arithmetic): segment `seg` and weight `t`, or an end value.
    var lo = -1;
    var t = 0;
    var end = -1;
    if (k <= ks[0]) end = 0;
    else if (k >= ks[last]) end = last;
    else {
      while (k > ks[seg + 1]) seg++;
      lo = seg;
      t = (k - ks[lo]) / (ks[lo + 1] - ks[lo]);
    }
    var nq = k < chase ? 1 : 6;
    for (var q = 0; q < nq; q++) {
      var r = rr[q];
      var vh, va;
      if (end >= 0) {
        vh = r[2 * end];
        va = r[2 * end + 1];
      } else {
        vh = r[2 * lo] + t * (r[2 * lo + 2] - r[2 * lo]);
        va = r[2 * lo + 1] + t * (r[2 * lo + 3] - r[2 * lo + 1]);
      }
      curH[q] = Math.min(0.5, vh * red.h);
      curA[q] = Math.min(0.5, va * red.a);
    }
    if (k < chase) {
      cH.push(cH[k] + curH[0]);
      cA.push(cA[k] + curA[0]);
      continue;
    }
    var b = k * 5;
    var hunt = k >= at.chase;
    var prot = k >= at.protect;
    var m0 = hunt ? 1 : 0;
    var m1 = hunt ? (prot ? 2 : 1) : 0;
    var m2 = k >= at.settle ? 5 : 0;
    var m3 = hunt ? (prot ? 4 : 3) : 0;
    var m4 = hunt ? 3 : 0;
    H[b] = curH[m0];
    A[b] = curA[m0];
    H[b + 1] = curH[m1];
    A[b + 1] = curA[m1];
    H[b + 2] = curH[m2];
    A[b + 2] = curA[m2];
    H[b + 3] = curH[m3];
    A[b + 3] = curA[m3];
    H[b + 4] = curH[m4];
    A[b + 4] = curA[m4];
  }
  return { H: H, A: A, cH: cH, cA: cA, chase: chase, V: null };
}

/** The span's sums from ctx (prefix differences; equal to span() within float rounding). */
function spanFast(cx, fm) {
  var ke = fm.inET ? fm.k0 : Math.max(fm.k0, cx.chase);
  if (ke <= fm.k0) return { ke: ke, lh: 0, la: 0 };
  return { ke: ke, lh: cx.cH[ke] - cx.cH[fm.k0], la: cx.cA[ke] - cx.cA[fm.k0] };
}

/** Value tables for P(home qualifies) from the chase on: Vr (regulation, chase..91), Ve (extra time, 91..121). */
function valueTables(cx) {
  if (cx.V) return cx.V;
  var Ve = zeros(122 * W);
  for (var d = -R; d <= R; d++) Ve[121 * W + R + d] = d > 0 ? 1 : d === 0 ? 0.5 : 0;
  for (var k2 = 120; k2 >= 91; k2--) step(Ve, k2, cx.H, cx.A);
  var Vr = zeros(92 * W);
  for (var d2 = -R; d2 <= R; d2++) Vr[91 * W + R + d2] = d2 > 0 ? 1 : d2 < 0 ? 0 : Ve[91 * W + R];
  for (var k3 = 90; k3 >= cx.chase; k3--) step(Vr, k3, cx.H, cx.A);
  cx.V = { Ve: Ve, Vr: Vr };
  return cx.V;
}

/** One backward minute of a value table: V[k][d] = (1 − h − a) V[k+1][d] + h V[k+1][d+1] + a V[k+1][d−1]. */
function step(V, k, H, A) {
  var o = k * W;
  var o1 = o + W;
  var b = k * 5;
  var h0 = H[b], a0 = A[b], s0 = 1 - h0 - a0;
  var h1 = H[b + 1], a1 = A[b + 1];
  var h2 = H[b + 2], a2 = A[b + 2];
  var h3 = H[b + 3], a3 = A[b + 3];
  var h4 = H[b + 4], a4 = A[b + 4], s4 = 1 - h4 - a4;
  // −R .. −2 (class 0); the lowest cell's "away scores" leaves the table: decided, value 0.
  V[o] = s0 * V[o1] + h0 * V[o1 + 1];
  for (var i = 1; i < R - 1; i++) V[o + i] = s0 * V[o1 + i] + h0 * V[o1 + i + 1] + a0 * V[o1 + i - 1];
  var m = R - 1;
  V[o + m] = (1 - h1 - a1) * V[o1 + m] + h1 * V[o1 + m + 1] + a1 * V[o1 + m - 1];
  V[o + R] = (1 - h2 - a2) * V[o1 + R] + h2 * V[o1 + R + 1] + a2 * V[o1 + R - 1];
  var p = R + 1;
  V[o + p] = (1 - h3 - a3) * V[o1 + p] + h3 * V[o1 + p + 1] + a3 * V[o1 + p - 1];
  for (var j = R + 2; j < W - 1; j++) V[o + j] = s4 * V[o1 + j] + h4 * V[o1 + j + 1] + a4 * V[o1 + j - 1];
  V[o + W - 1] = s4 * V[o1 + W - 1] + h4 + a4 * V[o1 + W - 2]; // beyond +R: decided, value 1
}

var SPAN_N = 18; // goals per side tabled in the span (slot SPAN_N holds the tail: 18+ goals before the chase is below 1e-8)

/** Calls f(d, p) for each span outcome: d the score difference after the span (from d0), p its probability. */
function spanEach(lh, la, d0, f) {
  var ph = poisTail(lh, SPAN_N);
  var pa = poisTail(la, SPAN_N);
  for (var i = 0; i <= SPAN_N; i++) {
    var pi = ph[i];
    if (!(pi > 0)) continue;
    for (var j = 0; j <= SPAN_N; j++) f(d0 + i - j, pi * pa[j]);
  }
}

function ctxFor(model, st) {
  var red = redMul(st);
  if (!model.__key) Object.defineProperty(model, "__key", { value: modelKey(model), enumerable: false }); // never serialised
  var key = model.__key + "|" + red.h + "|" + red.a;
  var c = cacheGet("ctx", key);
  if (c === undefined) {
    c = buildCtx(model, red);
    c.key = key;
    cachePut("ctx", key, c);
  }
  return c;
}

/** P(home qualifies): a value-table lookup, or before the chase the span's difference distribution against V at the chase. */
function fastQualify(model, st, minute) {
  var sc = (st && st.sc) || [0, 0];
  var fm = firstMinute((st && st.ph) || "pre", minute);
  var cx = ctxFor(model, st);
  var V = valueTables(cx);
  var d0 = sc[0] - sc[1];
  if (fm.inET) return d0 > R ? 1 : d0 < -R ? 0 : V.Ve[Math.min(121, fm.k0) * W + R + d0];
  if (fm.k0 > 90) return d0 > 0 ? 1 : d0 < 0 ? 0 : V.Ve[91 * W + R]; // full time in regulation
  var sp = spanFast(cx, fm);
  var base = sp.ke * W + R;
  if (sp.ke === fm.k0) return d0 > R ? 1 : d0 < -R ? 0 : V.Vr[base + d0];
  var q = 0;
  var Vr = V.Vr;
  spanEach(sp.lh, sp.la, d0, function (d, p) {
    if (d > R) q += p;
    else if (d >= -R) q += p * Vr[base + d];
  });
  return q;
}

/** The final score difference distribution (`diff[R + d]` for d within ±R; margins of 1–3 need nothing beyond). */
function fastDiff(cx, st, minute) {
  var sc = (st && st.sc) || [0, 0];
  var fm = firstMinute((st && st.ph) || "pre", minute);
  var sp = spanFast(cx, fm);
  var cur = zeros(W);
  var nx = zeros(W);
  var fin = zeros(W);
  var d0 = sc[0] - sc[1];
  if (sp.ke > fm.k0) {
    spanEach(sp.lh, sp.la, d0, function (d, p) {
      if (d >= -R && d <= R) cur[R + d] += p;
    });
  } else if (d0 >= -R && d0 <= R) cur[R + d0] = 1;
  else return fin;
  for (var k = sp.ke; k <= 120; k++) {
    if (k === 91 && !fm.inET) {
      for (var u = 0; u < W; u++) {
        if (u !== R && cur[u] > 0) {
          fin[u] += cur[u];
          cur[u] = 0;
        }
      }
      if (!(cur[R] > 0)) return fin;
    }
    var b = k * 5;
    for (var z = 0; z < W; z++) nx[z] = 0;
    for (var i = 0; i < W; i++) {
      var p = cur[i];
      if (!(p > 0)) continue;
      var c = i < R - 1 ? 0 : i === R - 1 ? 1 : i === R ? 2 : i === R + 1 ? 3 : 4;
      var h = cx.H[b + c];
      var a = cx.A[b + c];
      nx[i] += p * (1 - h - a);
      if (i + 1 < W) nx[i + 1] += p * h;
      if (i > 0) nx[i - 1] += p * a;
    }
    var tmp = cur;
    cur = nx;
    nx = tmp;
  }
  for (var x = 0; x < W; x++) fin[x] += cur[x];
  return fin;
}

/** The exact-score cells the market shows (up to `n` − 1 goals added per side), as the reference computes them. */
function fastExact(cx, st, minute, n) {
  var sc = (st && st.sc) || [0, 0];
  var fm = firstMinute((st && st.ph) || "pre", minute);
  var sp = spanFast(cx, fm);
  var cur = zeros(n * n);
  var nx = zeros(n * n);
  var dist = {};
  var d0 = sc[0] - sc[1];
  var add = function (i, j, p) {
    if (p >= 1e-12) {
      var key = sc[0] + i + "-" + (sc[1] + j);
      dist[key] = (dist[key] || 0) + p;
    }
  };
  var ph0 = poisTail(sp.lh, n);
  var pa0 = poisTail(sp.la, n);
  for (var i0 = 0; i0 < n; i0++) for (var j0 = 0; j0 < n; j0++) cur[i0 * n + j0] = ph0[i0] * pa0[j0];
  for (var k = sp.ke; k <= 121; k++) {
    if (k === 91 && !fm.inET) {
      for (var u = 0; u < n; u++) {
        for (var v = 0; v < n; v++) {
          var q = cur[u * n + v];
          if (q > 0 && d0 + u - v !== 0) {
            add(u, v, q);
            cur[u * n + v] = 0;
          }
        }
      }
    }
    if (k === 121) break;
    var b = k * 5;
    for (var z = 0; z < n * n; z++) nx[z] = 0;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var p = cur[i * n + j];
        if (!(p > 0)) continue;
        var d = d0 + i - j;
        var c = d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4;
        var h = cx.H[b + c];
        var a = cx.A[b + c];
        nx[i * n + j] += p * (1 - h - a);
        if (i + 1 < n) nx[(i + 1) * n + j] += p * h;
        if (j + 1 < n) nx[i * n + j + 1] += p * a;
      }
    }
    var tmp = cur;
    cur = nx;
    nx = tmp;
  }
  for (var x = 0; x < n; x++) for (var y = 0; y < n; y++) if (cur[x * n + y] > 0) add(x, y, cur[x * n + y]);
  return dist;
}

/** Next goal: the span's first goal (Poisson), then the reference loop on the tabled rates. */
function fastNext(model, st, minute) {
  var fm = firstMinute((st && st.ph) || "pre", minute);
  var cx = ctxFor(model, st);
  var sp = spanFast(cx, fm);
  var d = st.sc[0] - st.sc[1];
  var c = d <= -2 ? 0 : d === -1 ? 1 : d === 0 ? 2 : d === 1 ? 3 : 4;
  var L = sp.lh + sp.la;
  var alive = Math.exp(-L);
  var home = L > 0 ? (sp.lh / L) * (1 - alive) : 0;
  var away = L > 0 ? (sp.la / L) * (1 - alive) : 0;
  for (var k = sp.ke; k <= 120; k++) {
    if (k === 91 && !fm.inET && d !== 0) break;
    var gh = cx.H[k * 5 + c];
    var ga = cx.A[k * 5 + c];
    home += alive * gh;
    away += alive * ga;
    alive *= 1 - gh - ga;
  }
  return { home: home, away: away, none: alive };
}

/**
 * Every probability the fixture market catalogue prices, for markets.fixtureMarkets: P(home qualifies), the exact-score cells
 * it shows (`exact["h-a"]`, up to five goals added per side), the winning margins (`margin.home1` … `away3`) and the next
 * goal. A staged (#219) model uses the fast paths (cached per model and state); a legacy model, a shootout or a finished
 * match goes through finalDist / nextGoal exactly as before.
 */
function marketProbs(model, st, minute) {
  model = publishedModel(model, st);
  var ph = (st && st.ph) || "pre";
  if (staged(model) && ph !== "finished" && ph !== "shootout") {
    var cx = ctxFor(model, st);
    var sc = (st && st.sc) || [0, 0];
    var key = cx.key + "|" + ph + "|" + minute + "|" + sc[0] + "-" + sc[1];
    var hit = cacheGet("res", key);
    if (hit !== undefined) return hit;
    var diff = fastDiff(cx, st, minute);
    var margin = {};
    for (var n = 1; n <= 3; n++) {
      margin["home" + n] = diff[R + n];
      margin["away" + n] = diff[R - n];
    }
    var out = { qualifyHome: fastQualify(model, st, minute), exact: fastExact(cx, st, minute, 6), margin: margin, next: fastNext(model, st, minute) };
    return cachePut("res", key, out);
  }
  var fd = finalDist(model, st, minute);
  var m2 = {};
  ["home", "away"].forEach(function (side) {
    for (var n2 = 1; n2 <= 3; n2++) {
      var p = 0;
      for (var k in fd.dist) {
        var s2 = k.split("-");
        var d2 = side === "home" ? s2[0] - s2[1] : s2[1] - s2[0];
        if (d2 === n2) p += fd.dist[k];
      }
      m2[side + n2] = p;
    }
  });
  return { qualifyHome: fd.qualifyHome, exact: fd.dist, margin: m2, next: nextGoal(model, st, minute) };
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
  model = publishedModel(model, st);
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
  if (staged(model)) return stagedDist(model, st, minute, noDist);
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
  model = publishedModel(model, st);
  var ph = (st && st.ph) || "pre";
  if (ph === "finished" || ph === "shootout") return { home: 0, away: 0, none: 1 };
  if (staged(model)) return fastNext(model, st, minute);
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

/**
 * All fixture market prices from the published state.
 * Reference path (full finalDist walk, ~40 ms in goja): for scripts and tests only. Hooks and request handlers use
 * marketProbs / markets.fixtureMarkets, which are cached and equal to this within 1e-9 (#219).
 */
function fixturePrices(model, st, minute) {
  var fd = finalDist(model, st, minute);
  var ng = nextGoal(model, st, minute);
  var live = inPlay(st);
  var exact = {};
  for (var k in fd.dist) if (fd.dist[k] > 0.0005) exact[k] = price(fd.dist[k], live);
  return {
    winner: { home: price(fd.qualifyHome, live), away: price(1 - fd.qualifyHome, live) },
    exact: exact,
    next_goal: { home: price(ng.home, live), away: price(ng.away, live), none: price(ng.none, live) },
    margin: {
      home2: price(marginProb(fd.dist, "home", 2), live),
      home3: price(marginProb(fd.dist, "home", 3), live),
      away2: price(marginProb(fd.dist, "away", 2), live),
      away3: price(marginProb(fd.dist, "away", 3), live),
    },
    p: { qualifyHome: fd.qualifyHome },
  };
}

/**
 * Exact-score price for any score (scores not in the cached map are long shots).
 * Reference path (full finalDist walk): not for hot paths; see fixturePrices (#219).
 */
function exactPrice(model, st, minute, h, a) {
  var fd = finalDist(model, st, minute);
  return price(fd.dist[h + "-" + a] || 0, inPlay(st));
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
    MIN_OFFER: MIN_OFFER,
    price: price,
    inPlay: inPlay,
    finalDist: finalDist,
    nextGoal: nextGoal,
    fixturePrices: fixturePrices,
    exactPrice: exactPrice,
    pairQualify: pairQualify,
    bracket: bracket,
    roundFirst: roundFirst,
    shootoutHome: shootoutHome,
    clockMinute: clockMinute,
    stageRates: stageRates,
    marketProbs: marketProbs,
    // #219: the reference (slow, cell-by-cell) walks the fast ones must equal; tests and scripts only.
    _ref: { dist: stagedDist, next: stagedNext },
    _clearCache: function () {
      cache.n = 0;
      cache.ctx = {};
      cache.res = {};
    },
  };
}
