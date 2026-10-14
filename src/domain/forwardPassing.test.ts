/**
 * FF-69: a backward midfield pass reads as a constructive lay-off, then a forward release to a different teammate,
 * instead of a raw retreat. Client-only: the engine's event, its endpoints and metadata are untouched, ordinary
 * forward passes keep their paths, and the drawn ball has a real owner at every touch — including after a long dwell.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sceneFor, short, type Actor, type Pt, type Scene } from "./scenes";
import { frameAt, smooth, type Frame, type Lineups } from "./sim";
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

/** Distance along `side`'s attacking direction (home attacks +x, away −x). */
const along = (side: Side, p: Pt) => (side === "home" ? p[0] : 100 - p[0]);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];
const first = (a: Actor) => a.path[0];
const last = (a: Actor) => a.path[a.path.length - 1];
const at = (a: Actor, t: number) => sample(a.path, t);
const mirror = ([x, y]: Pt): Pt => [100 - x, y];

// ------------------------------------------------------------------ fixtures

const NAMES = {
  home: ["Kai Home", "Ada Back", "Ben Layoff", "Cy Forward", "Di Wide"],
  away: ["Lu Away", "Mo Back", "Ned Layoff", "Oz Forward", "Pip Wide"],
} as const;
const LINEUPS: Lineups = {
  home: NAMES.home.map((name, i) => ({ name, no: i + 1, role: i ? "util" : "gk", starter: true })),
  away: NAMES.away.map((name, i) => ({ name, no: i + 1, role: i ? "util" : "gk", starter: true })),
};
const ST: MatchEvent["st"] = { sc: [0, 1], so: null, ph: "first_half", clk: { s: 1210, run: 1 }, pos: 51, x: [[1, 0, 0, 0, 2, 0, 0, 0], [2, 1, 1, 0, 1, 0, 0, 0]], d: 0, win: null, by: null };

/** A midfield pass as the engine publishes it (no chain): `p` to `p2`, `from` → `ball`. */
function pass(side: Side, from: Pt, ball: Pt, seq = 801, extra: Partial<MatchEvent> = {}): MatchEvent {
  const [, p, p2] = NAMES[side];
  return { seq, at: 120_000, t: "pass", min: 21, side, p, p2, from, ball, text: `${p} to ${p2}`, st: ST, ...extra };
}
const m = (side: Side) => (p: Pt): Pt => (side === "home" ? p : mirror(p));
/** Home cases in home coordinates (engine midfield passes land at x 25–55, y 8–56); away is the mirror. */
const BACKWARD: Array<[string, Pt, Pt]> = [
  ["square-back in the centre", [52, 30], [40, 36]],
  ["long way back down the wing", [55, 12], [27, 20]],
];
const FORWARD: Array<[string, Pt, Pt]> = [
  ["forward in the centre", [35, 30], [50, 36]],
  ["square, slightly forward", [40, 40], [41, 20]],
];
const cases = (list: Array<[string, Pt, Pt]>) =>
  (["home", "away"] as Side[]).flatMap((side) => list.map(([name, from, ball], i) => ({ name: `${side} ${name}`, side, e: pass(side, m(side)(from), m(side)(ball), 801 + i) })));
const BACK_CASES = cases(BACKWARD);
const FWD_CASES = cases(FORWARD);
const scene = (e: MatchEvent, minuteMs = 15000) => sceneFor(e, e.from as Pt, minuteMs)!;

type Team = { name: string; abbr: string; grade: string; players: Array<{ name: string; role: string; is_starter: boolean }> };
const team = (i: number): Team => {
  const t = TEAMS[i];
  return { name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const lineup = (t: Team): LineupPlayer[] => t.players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
/** Real engine events in the published scene chain (prevBall = previous scene end), with lineups: seeds 4000–4023. */
function engineMatches(n = 24) {
  const out: Array<{ events: MatchEvent[]; scenes: Array<Scene | null>; prevs: Pt[]; lineups: Lineups }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "fp" + i, seed: 4000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(1000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    let prev: Pt = [50, 32];
    const scenes: Array<Scene | null> = [];
    const prevs: Pt[] = [];
    events.forEach((e, k) => {
      prevs.push(prev);
      const s = sceneFor(e, prev, 15000, events[k + 1]);
      scenes.push(s);
      if (s) prev = end(s);
    });
    out.push({ events, scenes, prevs, lineups: { home: lineup(home), away: lineup(away) } });
  }
  return out;
}

// ------------------------------------------------------------------ drawn-pitch harness

/** Who has a drawn ring (Pitch: nominated carrier, ball on the ground, within 1.6): `side:no`, or null. */
function ringed(f: Frame): string | null {
  const p = f.players.find((q) => q.side + ":" + q.no === f.carrier);
  return p && f.lift < 0.05 && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) <= 1.6 ? f.carrier! : null;
}
/**
 * MatchPage at 16 ms ticks: `before` plays and dwells for `dwellMs` past its end (smoothed), then `s` starts from the drawn
 * ball (startBall reroute) and plays to 1 s past its end. Returns the drawn frames of `s` and the ring holders in order.
 */
function play(before: Scene | null, dwellMs: number, s: Scene, lineups: Lineups) {
  let drawn: Frame | null = null;
  let startBall: Pt | undefined;
  if (before) {
    const stop = before.ms + dwellMs;
    for (let ms = 0; ms < stop; ms += 16) drawn = smooth(drawn, frameAt(before, ms / before.ms, lineups), 16);
    drawn = smooth(drawn, frameAt(before, stop / before.ms, lineups), stop % 16 || 16);
    startBall = [...drawn!.ball];
  }
  const frames: Array<{ ms: number; f: Frame }> = [];
  const holders: string[] = [];
  for (let ms = 0; ms <= s.ms + 1000; ms += 16) {
    drawn = smooth(drawn, frameAt(s, ms / s.ms, lineups, undefined, 0, startBall), 16);
    frames.push({ ms, f: drawn });
    const h = ringed(drawn);
    if (h && holders.at(-1) !== h) holders.push(h);
  }
  return { frames, holders, startBall };
}

// ------------------------------------------------------------------ shared assertions

const keyOf = (lineups: Lineups, side: Side, name?: string) => `${side}:${lineups[side].find((p) => p.name === name)!.no}`;
/** The lay-off man: the extra, unnamed attacking actor who takes the ball in between. */
const layoffOf = (s: Scene) => s.actors.find((a) => a.id === "l");
/** The same event drawn as an ordinary pass: a build-up shares the ordinary pass branch and never gets the lay-off. */
const ordinary = (e: MatchEvent, prev: Pt = e.from as Pt) => ({ ...sceneFor({ ...e, t: "build_up" }, prev, 15000)!, type: e.t, tempo: sceneFor(e, prev, 15000)!.tempo }); // #105: tempo follows the event type

/** Lay-off then forward release, as authored and on the target frames (both sides, any lineup). */
function expectLayoff(s: Scene, e: MatchEvent, lineups: Lineups, tag: string) {
  const side = e.side as Side;
  const target = e.ball as Pt;
  // The engine's endpoints: struck from `from`, finishing exactly on `ball`, along the ground.
  expect(s.ball[0], tag).toEqual(e.from);
  expect(end(s), tag).toEqual(target);
  expect(Math.max(0, ...(s.ballHeight ?? [])), tag).toBe(0);
  // In between it is held at one lay-off point: behind the passer (still a pass back) and behind the target, so the release goes forward.
  const held = s.ball.slice(1, -1);
  expect(held.length, tag).toBeGreaterThanOrEqual(1);
  const lay = held[0];
  for (const k of held) expect(k, tag).toEqual(lay);
  expect(along(side, lay), `${tag}: lay-off behind the passer`).toBeLessThan(along(side, e.from as Pt));
  expect(along(side, target) - along(side, lay), `${tag}: release goes forward`).toBeGreaterThan(0);
  // Three different attackers: the named passer, an unnamed lay-off man on the held ball, and the named receiver who is not on it.
  const passer = s.actors.find((a) => a.id === "p")!;
  const layoff = layoffOf(s)!;
  const receiver = s.actors.find((a) => a.side === side && a.label === short(e.p2))!;
  expect(passer.label, tag).toBe(short(e.p));
  expect(layoff, tag).toBeDefined();
  expect(layoff.side, tag).toBe(side);
  expect(layoff.label, `${tag}: no invented name`).toBeUndefined();
  expect(receiver, tag).toBeDefined();
  expect(dist(first(receiver), lay), `${tag}: receiver not on the lay-off`).toBeGreaterThan(1.6);
  expect(last(receiver), tag).toEqual(target);
  for (const t of [0.4, 0.5, 0.6]) expect(dist(at(layoff, t), sample(s.ball, t)), `${tag}: lay-off man on it t=${t}`).toBeLessThanOrEqual(1.6);
  // Owners on the target frames: passer strikes, lay-off man holds, free flight, the named receiver collects — three players.
  const p = keyOf(lineups, side, e.p);
  const r = keyOf(lineups, side, e.p2);
  for (const t of [0, 0.02]) {
    const strike = frameAt(s, t, lineups);
    expect([strike.carrier, ringed(strike)], `${tag} strike t=${t}`).toEqual([p, p]);
  }
  const held1 = frameAt(s, 0.5, lineups);
  const l = held1.carrier;
  expect(l, `${tag}: a lay-off owner`).toBeTruthy();
  expect(new Set([p, l, r]).size, `${tag}: three different players`).toBe(3);
  expect(l!.startsWith(side), tag).toBe(true);
  for (const t of [0.4, 0.5, 0.6]) {
    const f = frameAt(s, t, lineups);
    expect([f.carrier, ringed(f)], `${tag} hold t=${t}`).toEqual([l, l]);
  }
  for (const t of [0.2, 0.75, 0.9]) expect(frameAt(s, t, lineups).carrier, `${tag} free flight t=${t}`).toBeNull();
  for (const t of [0.97, 1]) {
    const f = frameAt(s, t, lineups);
    expect([f.carrier, ringed(f)], `${tag} receive t=${t}`).toEqual([r, r]);
  }
  return { lay, l: l!, p, r };
}

// ------------------------------------------------------------------ tests

describe("a backward midfield pass is a lay-off, then a forward release (FF-69)", () => {
  it.each(BACK_CASES)("$name: keeps the engine's endpoints, named players and metadata", ({ e }) => {
    const s = scene(e);
    expect({ key: s.key, seq: s.seq, type: s.type, side: s.side, who: s.who, caption: s.caption, score: s.score, phase: s.phase }).toEqual({
      key: `${e.seq}`, seq: e.seq, type: "pass", side: e.side, who: e.p, caption: e.text, score: e.st.sc, phase: e.st.ph,
    });
    expect(s.flash ?? null).toBeNull();
    for (const k of ["impact", "won", "focus", "cam"] as const) expect(s[k], k).toBeUndefined();
    expect(s.actors.filter((a) => a.label).map((a) => [a.side, a.label])).toEqual([[e.side, short(e.p)], [e.side, short(e.p2)]]);
    // Two touches take longer than one pass, at every pace.
    for (const minuteMs of [15000, 8000]) expect(scene(e, minuteMs).ms).toBeGreaterThan(sceneFor({ ...e, t: "build_up" }, e.from as Pt, minuteMs)!.ms);
  });

  it.each(BACK_CASES)("$name: laid off behind the target to a third teammate, released forward to the named receiver", ({ e }) => {
    const s = scene(e);
    expect(s).not.toEqual(ordinary(e));
    expectLayoff(s, e, LINEUPS, e.side as string);
  });

  it.each(BACK_CASES)("$name: after 13 s of dwell, at 16 ms frames, the lay-off man and then the receiver are drawn on the ball", ({ side, e }) => {
    // The previous move: a forward pass that put the ball at this pass's `from`, then dwelt 13 s (bounded advance, lay-offs).
    const prevEvent = pass(side, [(e.from as Pt)[0] - (side === "home" ? 12 : -12), (e.from as Pt)[1]], e.from as Pt, e.seq - 1, { p: NAMES[side][4], p2: e.p, text: "prior pass" });
    const before = scene(prevEvent);
    const s = sceneFor(e, end(before), 15000)!;
    const authored = JSON.stringify(s);
    const { holders, frames, startBall } = play(before, 13000, s, LINEUPS);
    expect(dist(startBall!, e.from as Pt), "the dwell moved the ball off the authored start").toBeGreaterThan(3);
    const { l, r } = expectLayoff(s, e, LINEUPS, `${side} target`);
    // Drawn rings, in order: the lay-off man, then the named receiver; never a defender.
    expect(holders.every((h) => h.startsWith(side)), JSON.stringify(holders)).toBe(true);
    expect(holders.indexOf(l), JSON.stringify(holders)).toBeGreaterThanOrEqual(0);
    expect(holders.lastIndexOf(r), JSON.stringify(holders)).toBeGreaterThan(holders.indexOf(l));
    // The lay-off man's ring is drawn while he holds it (smoothing lags the 1/3 receive instant, not the hold).
    const holding = frames.filter(({ ms }) => ms >= 0.5 * s.ms && ms <= 0.6 * s.ms);
    expect(holding.length).toBeGreaterThan(0);
    for (const { ms, f } of holding) expect(ringed(f), `drawn hold at ${ms} ms`).toBe(l);
    // The reroute never touches the final key: the drawn ball comes to rest on the engine's spot, and the scene object is unchanged.
    const rest = frameAt(s, 1, LINEUPS, undefined, 0, startBall).ball;
    expect(rest[0]).toBeCloseTo((e.ball as Pt)[0], 4);
    expect(rest[1]).toBeCloseTo((e.ball as Pt)[1], 4);
    expect(JSON.stringify(s)).toBe(authored);
  });

  it.each(BACK_CASES)("$name: the next scene starts where the release finished", ({ e }) => {
    const s = scene(e);
    const nextEvent = pass(e.side as Side, e.ball as Pt, m(e.side as Side)([50, 40]), e.seq + 1, { p: e.p2, p2: NAMES[e.side as Side][3] });
    const n = sceneFor(nextEvent, end(s), 15000)!;
    expect(end(s)).toEqual(e.ball);
    expect(n.ball[0]).toEqual(e.ball);
    expect(n.ball).toEqual(scene(nextEvent).ball); // no lead-in keyframe: exactly the chain it had before
  });

  it.each(BACK_CASES)("$name: never mutates the published event", ({ e }) => {
    const before = structuredClone(e);
    const frozen = deepFreeze(structuredClone(e));
    expect(() => sceneFor(frozen, frozen.from as Pt, 15000)).not.toThrow();
    expect(() => sceneFor(frozen, [50, 32], 8000)).not.toThrow(); // lead-in from elsewhere
    const s = scene(e);
    frameAt(s, 0.5, LINEUPS, undefined, 0, [(e.from as Pt)[0] + 5, (e.from as Pt)[1] - 4]);
    expect(e).toEqual(before);
  });
});

describe("everything else keeps its existing drawing (FF-69)", () => {
  it.each(FWD_CASES)("$name: an ordinary forward pass is unchanged", ({ e }) => {
    const s = scene(e);
    expect(s).toEqual(ordinary(e));
    expect(layoffOf(s)).toBeUndefined();
  });

  it.each(["home", "away"] as Side[])("%s: a short step back is still an ordinary pass; a real pass back is not", (side) => {
    const step = pass(side, m(side)([46, 30]), m(side)([44, 33]));
    expect(scene(step)).toEqual(ordinary(step));
    const back = pass(side, m(side)([46, 30]), m(side)([30, 33]));
    expect(layoffOf(scene(back))).toBeDefined();
  });

  it.each(["home", "away"] as Side[])("%s: turnovers, keeper distribution, build-ups, through balls, crosses and dribbles keep their own drawing", (side) => {
    const back = pass(side, m(side)([52, 30]), m(side)([36, 34]));
    // A turnover is a contest for the ball (#72), not a lay-off.
    const turn = scene({ ...back, turn: 1 });
    expect(turn.won).toBeDefined();
    expect(layoffOf(turn)).toBeUndefined();
    // The keeper distributing from his own box keeps the keeper on it.
    const box = pass(side, m(side)([12, 30]), m(side)([6, 22]));
    const own = scene(box);
    expect(own.actors.some((a) => a.keeper)).toBe(true);
    expect(layoffOf(own)).toBeUndefined();
    for (const t of ["build_up", "through_ball", "cross", "dribble"]) expect(layoffOf(scene({ ...back, t })), t).toBeUndefined();
  });
});

describe("real engine passes, both sides (FF-69)", () => {
  const found = engineMatches();
  type Row = { e: MatchEvent; s: Scene; prev: Pt; before: Scene | null; lineups: Lineups };
  const backward: Row[] = [];
  const forward: Row[] = [];
  for (const { events, scenes, prevs, lineups } of found) {
    events.forEach((e, k) => {
      const s = scenes[k];
      if (e.t !== "pass" || !s || e.turn) return;
      const row = { e, s, prev: prevs[k], before: scenes[k - 1] ?? null, lineups };
      if (layoffOf(s)) backward.push(row);
      else forward.push(row);
    });
  }

  it("lays off every clearly backward open-play midfield pass, on both sides; leaves the rest as they were", () => {
    expect(backward.filter((x) => x.e.side === "home").length).toBeGreaterThanOrEqual(100);
    expect(backward.filter((x) => x.e.side === "away").length).toBeGreaterThanOrEqual(100);
    for (const { e, s, prev } of [...backward, ...forward]) {
      const back = along(e.side as Side, e.ball as Pt) - along(e.side as Side, e.from as Pt);
      if (!layoffOf(s)) {
        expect(s, `#${e.seq}`).toEqual(ordinary(e, prev));
        // Only a short step back, or the keeper's own distribution, is left as an ordinary pass.
        if (back < -6) expect(s.actors.some((a) => a.keeper), `#${e.seq} back ${back}`).toBe(true);
      } else expect(back, `#${e.seq}`).toBeLessThan(0);
    }
  });

  it("every lay-off keeps the engine's endpoints, three different players and the owner windows", () => {
    for (const { e, s, prev, lineups } of backward) {
      expect(prev, `#${e.seq}`).toEqual(e.from); // the published chain already sits on the engine's `from`
      expectLayoff(s, e, lineups, `${e.side} #${e.seq}`);
    }
  });

  it("after a real 13 s dwell of the previous scene, a sample of lay-offs on both sides is drawn lay-off man then receiver", () => {
    for (const side of ["home", "away"] as Side[]) {
      const sample12 = backward.filter((x) => x.e.side === side && x.before).slice(0, 12);
      expect(sample12).toHaveLength(12);
      for (const { e, s, before, lineups } of sample12) {
        const { holders } = play(before, 13000, s, lineups);
        const l = frameAt(s, 0.5, lineups).carrier!;
        const r = keyOf(lineups, side, e.p2);
        expect(holders.indexOf(l), `${side} #${e.seq} ${JSON.stringify(holders)}`).toBeGreaterThanOrEqual(0);
        expect(holders.lastIndexOf(r), `${side} #${e.seq} ${JSON.stringify(holders)}`).toBeGreaterThan(holders.indexOf(l));
      }
    }
  });
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}
