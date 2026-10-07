/**
 * Betting — fictional credits only. All validation, pricing and settlement on the server.
 *
 * - Integer credits; every balance change writes a credit_ledger row with a unique
 *   idempotency key, inside the same transaction as the balance change.
 * - A bet locks the server price at acceptance. If the price the user confirmed is
 *   better than the current price, or the public match state moved since the price
 *   was computed, the bet is rejected with the new price (never silently worse).
 * - Repeating a request id returns the original bet (double-clicks, retries).
 */
var wsMod, oddsMod, mkt, balMod, eng;
function ws() {
  if (!wsMod) {
    try {
      wsMod = require(__hooks + "/lib/worldService.js");
    } catch (e) {
      wsMod = require("./worldService.js");
    }
  }
  return wsMod;
}
try {
  oddsMod = require(__hooks + "/lib/odds.js");
  mkt = require(__hooks + "/lib/markets.js");
  balMod = require(__hooks + "/lib/balance.js");
  eng = require(__hooks + "/lib/matchEngine.js");
} catch (e) {
  oddsMod = require("./odds.js");
  mkt = require("./markets.js");
  balMod = require("./balance.js");
  eng = require("./matchEngine.js");
}
var BALANCE = balMod.BALANCE;
var FIXTURE_MARKETS = ["winner", "exact", "next_goal", "margin"];
var WIDE_MARKETS = ["round_first", "champion", "semis"];

function one($app, col, filter, sort, params) {
  var rows = $app.findRecordsByFilter(col, filter, sort || "", 1, 0, params || {});
  return rows && rows.length ? rows[0] : null;
}

function all($app, col, filter, sort, params, limit) {
  return $app.findRecordsByFilter(col, filter, sort || "", limit || 500, 0, params || {}) || [];
}

function pbDate(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
}

/** Apply a credit delta with a ledger row. Returns false if the key was already used. */
function credit(tx, userId, delta, type, description, key) {
  if (key && one(tx, "credit_ledger", "idempotency_key = {:k}", "", { k: key })) return false;
  var u = tx.findRecordById("users", userId);
  var bal = (parseInt(u.get("credits"), 10) || 0) + delta;
  if (bal < 0) throw new BadRequestError("Not enough credits");
  u.set("credits", bal);
  tx.save(u);
  var led = new Record(tx.findCollectionByNameOrId("credit_ledger"));
  led.set("user", userId);
  led.set("type", type);
  led.set("amount", delta);
  led.set("description", String(description).slice(0, 200));
  led.set("idempotency_key", key || "");
  led.set("balance_after", bal);
  tx.save(led);
  return true;
}

// ------------------------------------------------------------------ restrictions

function restriction(managedTeam, market, fixture) {
  if (!managedTeam) return null;
  if (WIDE_MARKETS.indexOf(market) >= 0) return "Managers can't bet on championship-wide markets while managing " + managedTeam.get("name") + ".";
  if (fixture && (fixture.get("home_team") === managedTeam.id || fixture.get("away_team") === managedTeam.id)) {
    return "You manage " + managedTeam.get("name") + ", so you can't bet on its matches.";
  }
  return null;
}

/** Message if claiming teamId would conflict with the user's pending bets. */
function claimConflict(tx, userId, teamId) {
  var open = all(tx, "shared_bets", 'user = {:u} && status = "open"', "", { u: userId }, 200);
  for (var i = 0; i < open.length; i++) {
    var b = open[i];
    var market = b.get("market") || "winner";
    if (WIDE_MARKETS.indexOf(market) >= 0) {
      return "You have a pending " + mkt.TITLES[market].toLowerCase() + " bet. Claim a team after it settles.";
    }
    if (b.get("fixture")) {
      var fx = tx.findRecordById("shared_fixtures", b.get("fixture"));
      if (fx.get("home_team") === teamId || fx.get("away_team") === teamId) {
        return "You have a pending bet on a match involving this team. Claim it after the bet settles.";
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ catalogues

function fixtureCtx($app, fx, now) {
  var W = ws();
  if (W.drawHidden($app, $app.findRecordById("shared_rounds", fx.get("round")), now)) {
    throw new Error("Betting opens when the fixtures are announced.");
  }
  var teams = W.teamMap($app);
  var T = W.timing(W.ensureWorld($app));
  var card = W.fixtureCard($app, fx, teams, now, T);
  var minute = card.st ? Math.floor(oddsMod.clockMinute(card.st.clk, card.at, now, card.minuteMs)) : 0;
  var cat = mkt.fixtureMarkets(
    {
      id: fx.id,
      status: fx.get("status"),
      kickoffAt: card.kickoffAt,
      model: W.modelOf(fx),
      home: { id: card.home.id, abbr: card.home.abbreviation, name: card.home.name },
      away: { id: card.away.id, abbr: card.away.abbreviation, name: card.away.name },
    },
    card.st,
    minute,
    now,
  );
  return { card: card, cat: cat, seq: card.seq || 0 };
}

/** Markets for one fixture, with the user's restriction applied. */
function fixtureMarkets($app, userId, fixtureId) {
  var now = Date.now();
  var fx = $app.findRecordById("shared_fixtures", fixtureId);
  var c = fixtureCtx($app, fx, now);
  var managed = ws().getManagerTeam($app, userId);
  var blocked = restriction(managed, "winner", fx);
  return { serverTimeMs: now, fixtureId: fixtureId, seq: c.seq, state: c.cat.state, blocked: blocked, markets: c.cat.markets };
}

/** Round-wide and championship markets currently open. */
function wideMarkets($app, userId) {
  var W = ws();
  var now = Date.now();
  var t = W.activeTournament($app);
  var managed = W.getManagerTeam($app, userId);
  var blocked = managed ? restriction(managed, "champion", null) : null;
  var out = { serverTimeMs: now, blocked: blocked, markets: [] };
  if (!t) return out;
  var round = W.currentRound($app, t.id);
  if (!round || W.drawHidden($app, round, now)) return out;
  var teams = W.teamMap($app);
  var scheduledAt = W.parsePbDate(round.get("scheduled_at"));
  var preRound = round.get("status") === "scheduled" && now < scheduledAt;
  if (!preRound) return out;
  var fixtures = W.fixturesOf($app, round.id);
  var models = fixtures.map(function (f) {
    var m = W.modelOf(f) || { lh: 0.012, la: 0.012 };
    return { home: f.get("home_team"), away: f.get("away_team"), lh: m.lh, la: m.la };
  });
  var pf = oddsMod.roundFirst(models);
  var sel = [];
  fixtures.forEach(function (f) {
    [f.get("home_team"), f.get("away_team")].forEach(function (id) {
      var tm = W.teamPublic(teams[id]);
      sel.push({ id: id, label: tm.name, short: tm.abbreviation, odds: mkt.okP(pf[id]) });
    });
  });
  out.markets.push({ key: "round_first", title: mkt.TITLES.round_first + " (" + round.get("label") + ")", rules: mkt.RULES.round_first, closesAt: scheduledAt, sel: sel });

  if (round.get("round_key") === "r16") {
    var odds = W.readJson(t, "odds_json", null);
    if (odds && odds.champion) {
      var champ = [];
      for (var id in odds.champion) {
        var tm = W.teamPublic(teams[id]);
        champ.push({ id: id, label: tm.name, short: tm.abbreviation, odds: mkt.okP(odds.champion[id]) });
      }
      champ.sort(function (a, b) {
        return (a.odds || 999) - (b.odds || 999);
      });
      out.markets.push({ key: "champion", title: mkt.TITLES.champion, rules: mkt.RULES.champion, closesAt: scheduledAt, sel: champ });
      out.markets.push({
        key: "semis",
        title: mkt.TITLES.semis,
        rules: mkt.RULES.semis,
        closesAt: scheduledAt,
        quarters: odds.quarters.map(function (q) {
          return q.map(function (id) {
            var tm = W.teamPublic(teams[id]);
            return { id: id, label: tm.name, short: tm.abbreviation, p: odds.reachSF[id] };
          });
        }),
      });
    }
  }
  return out;
}

function semisPrice(odds, ids) {
  var p = 1;
  ids.forEach(function (id) {
    p *= odds.reachSF[id] || 0;
  });
  return mkt.okP(p);
}

// ------------------------------------------------------------------ placement

/**
 * body: { market, fixtureId?, selection, stake, odds, requestId }
 */
function placeBet($app, userId, body) {
  var W = ws();
  var market = String(body.market || "");
  var selection = String(body.selection || "");
  var requestId = String(body.requestId || "").slice(0, 64);
  if (!requestId) throw new BadRequestError("Missing request id");
  var key = "bet:" + userId + ":" + requestId;
  var prior = one($app, "shared_bets", "idempotency_key = {:k}", "", { k: key });
  if (prior) return { bet: betPublic($app, prior), duplicate: true };

  var vs = mkt.validStake(body.stake);
  if (vs.error) throw new BadRequestError(vs.error);
  var stake = vs.stake;
  var confirmed = Number(body.odds);
  if (!(confirmed >= 1.01)) throw new BadRequestError("Missing confirmed odds");

  W.tick($app, Date.now()); // resolve everything due before pricing
  var now = Date.now();
  var managed = W.getManagerTeam($app, userId);
  var priced = null;

  if (FIXTURE_MARKETS.indexOf(market) >= 0) {
    var fx = $app.findRecordById("shared_fixtures", String(body.fixtureId || ""));
    var why = restriction(managed, market, fx);
    if (why) throw new BadRequestError(why);
    var c = fixtureCtx($app, fx, now);
    var found = mkt.findSelection(c.cat, market, selection);
    if (found.closed) throw new BadRequestError(found.closed);
    var m = found.market;
    priced = {
      odds: found.odds,
      fixture: fx,
      seq: c.seq,
      label: c.card.home.abbreviation + " v " + c.card.away.abbreviation + " · " + m.title + ": " + found.sel.label,
    };
  } else if (WIDE_MARKETS.indexOf(market) >= 0) {
    var why2 = restriction(managed, market, null);
    if (why2) throw new BadRequestError(why2);
    var wide = wideMarkets($app, userId);
    var wm = wide.markets.filter(function (x) {
      return x.key === market;
    })[0];
    if (!wm) throw new BadRequestError(market === "round_first" ? "This market closes at kick-off" : "Championship markets close when the Round of 16 kicks off");
    var t = W.activeTournament($app);
    var round = W.currentRound($app, t.id);
    if (market === "semis") {
      var odds = W.readJson(t, "odds_json", null);
      var norm = mkt.normaliseSemis(selection, odds.quarters);
      if (norm.error) throw new BadRequestError(norm.error);
      selection = norm.ids.join(",");
      var teams = W.teamMap($app);
      priced = {
        odds: semisPrice(odds, norm.ids),
        round: round,
        tournament: t,
        label:
          "Semi-finalists: " +
          norm.ids
            .map(function (id) {
              return W.teamPublic(teams[id]).abbreviation;
            })
            .join(", "),
      };
    } else {
      var s = wm.sel.filter(function (x) {
        return x.id === selection;
      })[0];
      if (!s || !s.odds) throw new BadRequestError("Selection unavailable");
      priced = { odds: s.odds, round: round, tournament: t, label: wm.title + ": " + s.label };
    }
    if (!priced.odds) throw new BadRequestError("Selection unavailable");
  } else {
    throw new BadRequestError("Unknown market");
  }

  if (priced.odds + 1e-9 < confirmed) {
    var err = new BadRequestError("Odds changed to " + priced.odds.toFixed(2) + ". Review and confirm again.");
    throw err;
  }

  var bet = null;
  $app.runInTransaction(function (tx) {
    if (one(tx, "shared_bets", "idempotency_key = {:k}", "", { k: key })) {
      bet = one(tx, "shared_bets", "idempotency_key = {:k}", "", { k: key });
      return;
    }
    var placedAt = Date.now();
    if (priced.fixture) {
      // Nothing may have been published since we priced the market.
      var cur = W.lastPublished(tx, priced.fixture.id, placedAt);
      if ((cur ? cur.seq : 0) !== priced.seq) throw new BadRequestError("Match moved on — prices updated. Review and confirm again.");
      var kick = W.parsePbDate(priced.fixture.get("scheduled_at"));
      if (priced.fixture.get("status") === "scheduled" && placedAt >= kick) throw new BadRequestError("Kick-off in progress — try again in a moment.");
    } else {
      var r = tx.findRecordById("shared_rounds", priced.round.id);
      if (r.get("status") !== "scheduled" || placedAt >= W.parsePbDate(r.get("scheduled_at"))) throw new BadRequestError("This market has closed");
    }
    if (ws().getManagerTeam(tx, userId)) {
      var again = restriction(ws().getManagerTeam(tx, userId), market, priced.fixture || null);
      if (again) throw new BadRequestError(again);
    }
    var rec = new Record(tx.findCollectionByNameOrId("shared_bets"));
    rec.set("user", userId);
    if (priced.fixture) {
      rec.set("fixture", priced.fixture.id);
      rec.set("round", priced.fixture.get("round"));
      rec.set("tournament", priced.fixture.get("tournament"));
    } else {
      rec.set("round", priced.round.id);
      rec.set("tournament", priced.tournament.id);
    }
    if (market === "winner" && priced.fixture) {
      rec.set("selection_team", selection === "home" ? priced.fixture.get("home_team") : priced.fixture.get("away_team"));
    }
    if ((market === "champion" || market === "round_first") && selection) rec.set("selection_team", selection);
    rec.set("market", market);
    rec.set("selection", selection);
    rec.set("label", priced.label + " @ " + priced.odds.toFixed(2));
    rec.set("stake", stake);
    rec.set("odds", priced.odds);
    rec.set("status", "open");
    rec.set("settled", false);
    rec.set("placed_ms", placedAt);
    rec.set("idempotency_key", key);
    tx.save(rec);
    credit(tx, userId, -stake, "bet_stake", "Stake: " + priced.label, rec.id + ":stake");
    bet = rec;
  });
  return { bet: betPublic($app, bet), duplicate: false };
}

// ------------------------------------------------------------------ settlement

function settle(tx, betId, outcome, note) {
  var b = tx.findRecordById("shared_bets", betId);
  if (b.get("status") !== "open" && b.get("status") !== "locked") return false;
  var stake = b.get("stake") || 0;
  var pay = 0;
  if (outcome === "won") pay = mkt.payout(stake, b.get("odds") || 1);
  if (outcome === "void") pay = stake;
  if (pay > 0) credit(tx, b.get("user"), pay, outcome === "won" ? "bet_win" : "bet_refund", (outcome === "won" ? "Won: " : "Refund: ") + (b.get("label") || b.id), b.id + ":settle");
  b.set("status", outcome);
  b.set("settled", true);
  b.set("payout", pay);
  b.set("settled_at", pbDate(Date.now()));
  b.set("settlement_key", b.id + ":settle");
  if (note) b.set("result_note", String(note).slice(0, 200));
  tx.save(b);
  return true;
}

var BET_PAGE = 500;

/**
 * Every unsettled bet matching `filter`, read in id-ordered pages. Settlement must
 * never stop at a page boundary: a fixture is finalised once, so a capped read
 * would strand the remaining bets forever. Keyset paging (id > last) stays correct
 * while the caller settles rows out of the open set.
 */
function openBets(tx, filter, params) {
  var out = [];
  var last = "";
  for (;;) {
    var q = { last: last };
    for (var k in params || {}) q[k] = params[k];
    var page = all(tx, "shared_bets", '(status = "open" || status = "locked") && id > {:last} && (' + filter + ")", "id", q, BET_PAGE);
    out = out.concat(page);
    if (page.length < BET_PAGE) return out;
    last = page[page.length - 1].id;
  }
}

/** Fixture markets at the (public) final whistle. */
function settleFixtureBets(tx, fx, r, now) {
  var note = "Final " + r.sh + "–" + r.sa + (r.by === "pens" ? " (pens " + r.soh + "–" + r.soa + ")" : r.by === "aet" ? " AET" : "");
  var n = 0;
  openBets(tx, "fixture = {:f}", { f: fx.id }).forEach(function (b) {
    var market = b.get("market");
    var sel = b.get("selection");
    if (!market) {
      // pre-overhaul bet: team to win
      market = "winner";
      sel = b.get("selection_team") === fx.get("home_team") ? "home" : "away";
    }
    if (market === "next_goal") {
      var g = goalsAfter(tx, fx.id, b.get("placed_ms") || 0, Infinity)[0];
      if (g) {
        var side = ws().readJson(g, "data", {}).side;
        if (settle(tx, b.id, sel === side ? "won" : "lost", "Next goal: " + side)) n++;
        return;
      }
    }
    if (settle(tx, b.id, mkt.settleFixtureBet(market, sel, r), note)) n++;
  });
  return n;
}

/**
 * Fixture bets still open on a fixture whose progression already ran. Pre-v2 rounds
 * settled bets after their completion transaction, at most 200 per fixture, and never
 * retried; v2 settles them inside finaliseFixture. Settles each such fixture in its
 * own transaction (idempotent per bet) and never pre-empts finaliseFixture.
 *
 * Only fixtures whose progression already ran are read, keyset-paged by fixture id,
 * so neither a not-yet-progressed fixture nor a failing one can hide later fixtures.
 * A failing fixture rolls back alone and is reported in `errors`; the rest proceed.
 * At most STRANDED_FIXTURES fixtures per sweep.
 */
var STRANDED_FIXTURES = 100;
function settleStrandedBets($app, now) {
  var W = ws();
  var out = { fixtures: 0, settled: 0, failed: 0, errors: [] };
  var last = "";
  while (out.fixtures < STRANDED_FIXTURES) {
    var rows = all(
      $app,
      "shared_bets",
      '(status = "open" || status = "locked") && fixture > {:last} && fixture.status = "finished" && fixture.match_states_via_fixture.progression_settled ?= true',
      "fixture",
      { last: last },
      BET_PAGE,
    );
    if (!rows.length) break;
    for (var i = 0; i < rows.length && out.fixtures < STRANDED_FIXTURES; i++) {
      var fxId = rows[i].get("fixture");
      if (fxId === last) continue;
      last = fxId;
      out.fixtures++;
      var n = 0;
      try {
        $app.runInTransaction(function (tx) {
          var fx = tx.findRecordById("shared_fixtures", fxId);
          var ms = one(tx, "match_states", "fixture = {:f}", "", { f: fxId });
          if (!ms || !ms.get("progression_settled")) return;
          var r = W.resultOf(ms, fx);
          if (!r) return;
          n = settleFixtureBets(tx, fx, r, now || Date.now());
        });
        out.settled += n;
      } catch (err) {
        out.failed++;
        out.errors.push(fxId + ": " + String(err).slice(0, 200));
      }
    }
    if (rows.length < BET_PAGE) break;
  }
  return out;
}

function goalsAfter($app, fixtureId, from, now) {
  return all(
    $app,
    "match_events",
    'fixture = {:f} && at > {:a} && at <= {:n} && (type = "goal" || type = "penalty_goal")',
    "at,seq",
    { f: fixtureId, a: from, n: isFinite(now) ? now : 9e15 },
    50,
  );
}

/** Next-goal bets resolve as soon as the next goal is public. */
function settleNextGoal($app, fixtureId, now) {
  var bets = openBets($app, 'fixture = {:f} && market = "next_goal"', { f: fixtureId });
  bets.forEach(function (b) {
    var g = goalsAfter($app, fixtureId, b.get("placed_ms") || 0, now)[0];
    if (!g) return;
    var side = ws().readJson(g, "data", {}).side;
    $app.runInTransaction(function (tx) {
      settle(tx, b.id, b.get("selection") === side ? "won" : "lost", "Next goal: " + (ws().readJson(g, "data", {}).text || side));
    });
  });
}

/** First goal of the round (published); refund when the round ends goalless. */
function settleRoundFirst($app, round, fixtures, roundComplete, now) {
  var bets = openBets($app, 'round = {:r} && market = "round_first"', { r: round.id });
  if (!bets.length) return;
  var first = one($app, "match_events", 'round = {:r} && at <= {:n} && (type = "goal" || type = "penalty_goal")', "at,seq", { r: round.id, n: now || Date.now() });
  var winnerTeam = null;
  var note = "";
  if (first) {
    var d = ws().readJson(first, "data", {});
    var fx = fixtures.filter(function (f) {
      return f.id === first.get("fixture");
    })[0];
    if (!fx) return;
    winnerTeam = d.side === "home" ? fx.get("home_team") : fx.get("away_team");
    note = "First goal: " + (d.tick || d.text);
  } else if (!roundComplete) return;
  bets.forEach(function (b) {
    var run = function (tx) {
      if (!winnerTeam) settle(tx, b.id, "void", "No goal in the round — stake refunded");
      else settle(tx, b.id, b.get("selection") === winnerTeam ? "won" : "lost", note);
    };
    if ($app.runInTransaction) $app.runInTransaction(run);
    else run($app);
  });
}

function settleSemis(tx, t, qfFixtures) {
  var winners = qfFixtures.map(function (f) {
    return f.get("winner_team");
  });
  openBets(tx, 'tournament = {:t} && market = "semis"', { t: t.id }).forEach(function (b) {
    var ids = String(b.get("selection")).split(",");
    var ok = ids.every(function (id) {
      return winners.indexOf(id) >= 0;
    });
    settle(tx, b.id, ok ? "won" : "lost", "Semi-finalists decided");
  });
}

function settleChampion(tx, t, champId) {
  openBets(tx, 'tournament = {:t} && market = "champion"', { t: t.id }).forEach(function (b) {
    settle(tx, b.id, b.get("selection") === champId ? "won" : "lost", "Champion decided");
  });
}

// ------------------------------------------------------------------ wallet & history

function betPublic($app, b) {
  var stake = b.get("stake") || 0;
  var odds = b.get("odds") || 1;
  var status = b.get("status");
  if (status === "locked") status = "open";
  return {
    id: b.id,
    market: b.get("market") || "winner",
    title: mkt.TITLES[b.get("market") || "winner"] || "Bet",
    label: b.get("label") || "Match winner",
    selection: b.get("selection") || b.get("selection_team"),
    fixtureId: b.get("fixture") || null,
    stake: stake,
    odds: odds,
    potential: mkt.payout(stake, odds),
    status: status,
    payout: b.get("payout") || (status === "won" ? mkt.payout(stake, odds) : 0),
    note: b.get("result_note") || "",
    placedAt: b.get("placed_ms") || null,
    created: b.get("created"),
    settledAt: b.get("settled_at") || null,
  };
}

function myBets($app, userId) {
  var rows = all($app, "shared_bets", "user = {:u}", "-created", { u: userId }, 100);
  var u = $app.findRecordById("users", userId);
  var list = rows.map(function (b) {
    return betPublic($app, b);
  });
  var staked = 0;
  var returned = 0;
  list.forEach(function (b) {
    if (b.status === "open") return;
    staked += b.stake;
    returned += b.payout;
  });
  return { credits: u.get("credits") || 0, bets: list, settledStaked: staked, settledReturned: returned, net: returned - staked, topUp: topUpState(u) };
}

function topUpState(u) {
  var last = ws().parsePbDate(u.get("last_topup_at"));
  var next = isNaN(last) ? 0 : last + BALANCE.topUpCooldownMs;
  var credits = u.get("credits") || 0;
  return {
    amount: BALANCE.topUpAmount,
    floor: BALANCE.topUpFloor,
    available: credits < BALANCE.topUpFloor && Date.now() >= next,
    nextAt: next || null,
    rule: "Test credits: when your balance is below " + BALANCE.topUpFloor + ", claim " + BALANCE.topUpAmount + " free credits (once per hour). No cash value.",
  };
}

function topUp($app, userId) {
  var res = null;
  $app.runInTransaction(function (tx) {
    var u = tx.findRecordById("users", userId);
    var s = topUpState(u);
    if (!s.available) {
      throw new BadRequestError((u.get("credits") || 0) >= BALANCE.topUpFloor ? "Top-up is available when your balance is below " + BALANCE.topUpFloor : "Next top-up available later");
    }
    var hour = Math.floor(Date.now() / BALANCE.topUpCooldownMs);
    credit(tx, userId, BALANCE.topUpAmount, "topup", "Test credits top-up", "topup:" + userId + ":" + hour);
    u = tx.findRecordById("users", userId);
    u.set("last_topup_at", pbDate(Date.now()));
    tx.save(u);
    res = { ok: true, credits: u.get("credits") };
  });
  return res;
}

if (typeof module !== "undefined") {
  module.exports = {
    placeBet: placeBet,
    fixtureMarkets: fixtureMarkets,
    wideMarkets: wideMarkets,
    myBets: myBets,
    topUp: topUp,
    claimConflict: claimConflict,
    settleFixtureBets: settleFixtureBets,
    settleStrandedBets: settleStrandedBets,
    settleNextGoal: settleNextGoal,
    settleRoundFirst: settleRoundFirst,
    settleSemis: settleSemis,
    settleChampion: settleChampion,
    credit: credit,
  };
}
