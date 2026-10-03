/**
 * Tournament draw, bracket progression, round helpers.
 */
var BRACKET = {
  r16: [
    { slot: "R16_1", feeds: "QF1", pos: "home" },
    { slot: "R16_2", feeds: "QF1", pos: "away" },
    { slot: "R16_3", feeds: "QF2", pos: "home" },
    { slot: "R16_4", feeds: "QF2", pos: "away" },
    { slot: "R16_5", feeds: "QF3", pos: "home" },
    { slot: "R16_6", feeds: "QF3", pos: "away" },
    { slot: "R16_7", feeds: "QF4", pos: "home" },
    { slot: "R16_8", feeds: "QF4", pos: "away" },
  ],
  qf: [
    { slot: "QF1", feeds: "SF1", pos: "home" },
    { slot: "QF2", feeds: "SF1", pos: "away" },
    { slot: "QF3", feeds: "SF2", pos: "home" },
    { slot: "QF4", feeds: "SF2", pos: "away" },
  ],
  sf: [
    { slot: "SF1", feeds: "FINAL", pos: "home" },
    { slot: "SF2", feeds: "FINAL", pos: "away" },
  ],
  final: [{ slot: "FINAL", feeds: null, pos: null }],
};

var ROUND_ORDER = ["r16", "qf", "sf", "final"];
var ROUND_LABELS = {
  r16: "Round of 16",
  qf: "Quarter-finals",
  sf: "Semi-finals",
  final: "Final",
};

function shuffle(arr, rng) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random R16 draw: 8 fixtures from 16 team ids.
 * @returns {Array<{slot,homeId,awayId,feeds,pos}>}
 */
function drawRoundOf16(teamIds, seed) {
  var rng = mulberry32(typeof seed === "number" ? seed : Date.now());
  var shuffled = shuffle(teamIds, rng);
  var slots = BRACKET.r16;
  var fixtures = [];
  for (var i = 0; i < 8; i++) {
    fixtures.push({
      slot: slots[i * 1 ? slots[i].slot : slots[i].slot],
      homeId: shuffled[i * 2],
      awayId: shuffled[i * 2 + 1],
      feedsInto: slots[i].feeds,
      feedsPosition: slots[i].pos,
      bracketIndex: i,
    });
  }
  // fix slot assignment
  fixtures = [];
  for (var j = 0; j < 8; j++) {
    fixtures.push({
      slot: slots[j].slot,
      homeId: shuffled[j * 2],
      awayId: shuffled[j * 2 + 1],
      feedsInto: slots[j].feeds,
      feedsPosition: slots[j].pos,
      bracketIndex: j,
    });
  }
  return fixtures;
}

function nextRoundKey(current) {
  var idx = ROUND_ORDER.indexOf(current);
  if (idx < 0 || idx >= ROUND_ORDER.length - 1) return null;
  return ROUND_ORDER[idx + 1];
}

/**
 * Build next-round fixtures from winners map: { R16_1: teamId, ... }
 */
function buildNextRoundFixtures(currentRoundKey, winnersBySlot) {
  var nextKey = nextRoundKey(currentRoundKey);
  if (!nextKey) return [];
  var slots = BRACKET[nextKey];
  var prevSlots = BRACKET[currentRoundKey];
  var feedMap = {}; // QF1 -> { home: id, away: id }
  for (var i = 0; i < prevSlots.length; i++) {
    var ps = prevSlots[i];
    if (!ps.feeds) continue;
    if (!feedMap[ps.feeds]) feedMap[ps.feeds] = {};
    feedMap[ps.feeds][ps.pos] = winnersBySlot[ps.slot];
  }
  var fixtures = [];
  for (var j = 0; j < slots.length; j++) {
    var s = slots[j];
    var pair = feedMap[s.slot] || {};
    fixtures.push({
      slot: s.slot,
      homeId: pair.home || null,
      awayId: pair.away || null,
      feedsInto: s.feeds,
      feedsPosition: s.pos,
      bracketIndex: j,
    });
  }
  return fixtures;
}

function copyPlayer(p) {
  if (!p) return null;
  // Avoid Object.assign on goja/host objects — copy known fields explicitly.
  return {
    id: p.id || "",
    name: p.name || "",
    role: p.role || "util",
    attack: p.attack != null ? p.attack : 50,
    defence: p.defence != null ? p.defence : 50,
    energy: p.energy != null ? p.energy : 100,
    condition: p.condition != null ? p.condition : 100,
    intensity: p.intensity || "balanced",
    is_starter: !!p.is_starter,
  };
}

function defaultStarters(players) {
  // first 5 are starters, last 2 subs — ensure one gk in starters
  var list = [];
  if (players && typeof players.length === "number") {
    for (var i = 0; i < players.length; i++) {
      var cp = copyPlayer(players[i]);
      if (cp && cp.name) list.push(cp);
    }
  }
  var gk = null;
  var outfield = [];
  for (var j = 0; j < list.length; j++) {
    if (list[j].role === "gk" && !gk) gk = list[j];
    else outfield.push(list[j]);
  }
  if (!gk && list.length) {
    gk = copyPlayer(list[list.length - 1]);
    gk.role = "gk";
  }
  var starters = [];
  if (gk) {
    gk.is_starter = true;
    gk.intensity = gk.intensity || "balanced";
    starters.push(gk);
  }
  var o = 0;
  for (; o < outfield.length && starters.length < 5; o++) {
    outfield[o].is_starter = true;
    outfield[o].intensity = outfield[o].intensity || "balanced";
    starters.push(outfield[o]);
  }
  var subs = [];
  for (; o < outfield.length; o++) {
    outfield[o].is_starter = false;
    outfield[o].intensity = outfield[o].intensity || "balanced";
    subs.push(outfield[o]);
  }
  return starters.concat(subs);
}

if (typeof module !== "undefined") {
  module.exports = {
    BRACKET: BRACKET,
    ROUND_ORDER: ROUND_ORDER,
    ROUND_LABELS: ROUND_LABELS,
    drawRoundOf16: drawRoundOf16,
    nextRoundKey: nextRoundKey,
    buildNextRoundFixtures: buildNextRoundFixtures,
    defaultStarters: defaultStarters,
    shuffle: shuffle,
    mulberry32: mulberry32,
  };
}
