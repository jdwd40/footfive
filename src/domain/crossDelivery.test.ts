/**
 * FF-71: a cross is a wide delivery with a separate runner attacking the box. The feeder (`p`) plays it out to the
 * winger (`p2`), who stays wide and crosses; when the next published event is that move's header, the player who
 * heads it is the one who arrives to meet the ball. Without it, an unnamed runner attacks a stable box point.
 * Look-ahead only ever reads the next published event; the scene's metadata stays the cross's own.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sampleN, sceneFor, short, type Actor, type Pt, type Scene } from "./scenes";
import { frameAt, type Frame, type Lineups } from "./sim";
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

/** Distance along `side`'s attacking direction (home attacks +x, away −x). */
const along = (side: Side, p: Pt) => (side === "home" ? p[0] : 100 - p[0]);
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const other = (side: Side): Side => (side === "home" ? "away" : "home");
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];
const first = (a: Actor) => a.path[0];
const last = (a: Actor) => a.path[a.path.length - 1];
const at = (a: Actor, t: number) => sample(a.path, t);
const mirror = ([x, y]: Pt): Pt => [100 - x, y];

// ------------------------------------------------------------------ fixtures

const NAMES = {
  home: { gk: "Kai Home", feeder: "Vic Steel", winger: "Kip Nexus", shooter: "Rex Chrome", spare: "Di Spare" },
  away: { gk: "Lu Away", feeder: "Pat Breaux", winger: "Olly Arc", shooter: "Rob Babin", spare: "Pip Spare" },
} as const;
const LINEUPS: Lineups = {
  home: Object.values(NAMES.home).map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
  away: Object.values(NAMES.away).map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
};
const snap = (sh: number): MatchEvent["st"] => ({ sc: [1, 1], so: null, ph: "second_half", clk: { s: 3910, run: 1 }, pos: 48, x: [[sh, 1, 0, 0, 1, 0, 0, 0], [2, 1, 1, 0, 2, 0, 0, 0]], d: 1, win: null, by: null });

/** A cross as the engine publishes it: the feeder goes wide to the winger, who crosses from `ball` (wide). */
function cross(side: Side, from: Pt, ball: Pt, seq = 701, p: string = NAMES[side].feeder): MatchEvent {
  const p2 = NAMES[side].winger;
  return { seq, at: 400_000, t: "cross", min: 66, side, chain: seq - 4, p, p2, from, ball, text: `${p} goes wide to ${p2}, who crosses`, st: snap(4) };
}
/** The move's header, published next: a different player meets it at `ball` in the box (from = the cross point). */
function header(c: MatchEvent, ball: Pt, p: string = NAMES[c.side as Side].shooter): MatchEvent {
  return { seq: c.seq + 1, at: c.at + 880, t: "shot", min: c.min, side: c.side, chain: c.chain, p, from: c.ball, ball, header: 1, long: 0, text: `${p} rises to meet it!`, st: snap(5) } as MatchEvent;
}
type Case = { name: string; c: MatchEvent; n: MatchEvent };
/** Home cases in home coordinates (engine ranges: cross point x 74–84, y 5–11 or 53–59; header x 84–90, y 24–40); away mirrored. */
const HOME_CASES: Array<[string, Pt, Pt, Pt]> = [
  ["bottom wing, near-post header", [56, 38], [79, 56], [88, 29]],
  ["top wing, far-post header", [50, 24], [82, 8], [86, 39]],
];
const CASES: Case[] = (["home", "away"] as Side[]).flatMap((side) =>
  HOME_CASES.map(([name, from, ball, head], i) => {
    const m = (p: Pt): Pt => (side === "home" ? p : mirror(p));
    const c = cross(side, m(from), m(ball), 701 + 10 * i);
    return { name: `${side} ${name}`, c, n: header(c, m(head)) };
  }),
);
/** The engine often has the feeder himself arrive for the header (39 of 87 crosses over seeds 3000–3023). */
const FEEDER_HEADS: Case[] = (["home", "away"] as Side[]).map((side) => {
  const m = (p: Pt): Pt => (side === "home" ? p : mirror(p));
  const c = cross(side, m([56, 38]), m([79, 56]), 731);
  return { name: `${side} feeder heads it`, c, n: header(c, m([88, 29]), c.p) };
});

type Team = { name: string; abbr: string; grade: string; players: Array<{ name: string; role: string; is_starter: boolean }> };
const team = (i: number): Team => {
  const t = TEAMS[i];
  return { name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const lineup = (t: Team): LineupPlayer[] => t.players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
/** Real engine crosses with their published next event and lineups (one reproduction set: seeds 3000–3023). */
function engineCrosses(n = 24) {
  const out: Array<{ c: MatchEvent; n: MatchEvent; prev: Pt; lineups: Lineups }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "cx" + i, seed: 3000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(1000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    let prev: Pt = [50, 32];
    events.forEach((e, k) => {
      if (e.t === "cross") out.push({ c: e, n: events[k + 1], prev, lineups: { home: lineup(home), away: lineup(away) } });
      const s = sceneFor(e, prev, 15000, events[k + 1]);
      if (s) prev = end(s);
    });
  }
  return out;
}

// ------------------------------------------------------------------ contract helpers

const GOAL_X = (side: Side) => (side === "home" ? 100 : 0);
/** Without the move's header: an unnamed runner attacks the far post from the cross side, 13 out from the goal line. */
const fallback = (c: MatchEvent): Pt => [GOAL_X(c.side as Side) + (c.side === "home" ? -13 : 13), (c.ball as Pt)[1] < 32 ? 36 : 28];
const scene = (c: MatchEvent, n?: MatchEvent, minuteMs = 15000) => sceneFor(c, c.from as Pt, minuteMs, n)!;
const labelled = (s: Scene, side: Side, name?: string) => s.actors.filter((a) => a.side === side && a.label !== undefined && a.label === short(name));
const one = (s: Scene, side: Side, name?: string) => {
  const list = labelled(s, side, name);
  expect(list, `${side} ${name}`).toHaveLength(1);
  return list[0];
};
/** The runner attacking the box: the `h` actor, or the feeder himself when he heads it. */
const runnerOf = (s: Scene, c: MatchEvent, n?: MatchEvent) =>
  n && short(n.p) === short(c.p) ? one(s, c.side as Side, c.p) : s.actors.find((a) => a.id === "h" && a.side === c.side)!;
/** Player key (`side:no`) of a named player in a lineup. */
const keyOf = (lineups: Lineups, side: Side, name?: string) => `${side}:${lineups[side].find((p) => p.name === name)!.no}`;
const onBall = (f: Frame, key: string) => {
  const p = f.players.find((q) => q.side + ":" + q.no === key);
  return !!p && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) <= 1.6;
};

/** The delivery as FF-71 draws it, for a cross `c` with its accepted header `n` (or none). */
function expectDelivery(s: Scene, c: MatchEvent, n: MatchEvent | undefined, lineups: Lineups, tag: string) {
  const side = c.side as Side;
  const B: Pt = n ? (n.ball as Pt) : fallback(c);
  const wing = c.ball as Pt;
  // The ball goes to the winger on the ground, sits with him while he shapes to cross, then is delivered into the box at head height.
  expect(s.ball[0], tag).toEqual(c.from);
  expect(s.ball.slice(1, 3), tag).toEqual([wing, wing]);
  expect(end(s), tag).toEqual(B);
  for (const t of [0, 0.25, 0.4, 0.5]) expect(sampleN(s.ballHeight, t), `${tag} lift t=${t}`).toBe(0);
  expect(Math.max(...[0.55, 0.6, 0.625, 0.65, 0.7].map((t) => sampleN(s.ballHeight, t))), tag).toBeGreaterThanOrEqual(0.9 - 1e-9);
  for (const t of [0.75, 0.9, 1]) expect(sampleN(s.ballHeight, t), `${tag} head height t=${t}`).toBeCloseTo(0.6, 6);
  // The winger receives and delivers from the touchline: always on the cross point's line, never drifting into the box.
  const winger = one(s, side, c.p2);
  for (const [x, y] of winger.path) {
    expect(y, tag).toBe(wing[1]);
    expect(along(side, [x, y]) - along(side, wing), tag).toBeLessThanOrEqual(1 + 1e-9);
  }
  expect(at(winger, 0.25), tag).toEqual(wing);
  expect(at(winger, 0.5), tag).toEqual(wing);
  // A separate runner comes from the far side of the goal's centre line, 11 short, and meets the ball where it drops.
  const runner = runnerOf(s, c, n);
  expect(runner.label === undefined || runner.label !== winger.label, tag).toBe(true);
  expect(last(runner), tag).toEqual(B);
  expect(dist(at(runner, 0.75), B), `${tag}: runner meets it at 0.75`).toBeLessThan(1e-6);
  expect(dist(at(runner, 0.5), B), `${tag}: runner already waiting`).toBeGreaterThanOrEqual(3);
  if (runner.id === "h") {
    expect(along(side, B) - along(side, first(runner)), tag).toBeCloseTo(11, 6);
    const across = (first(runner)[1] - 32) * (B[1] - 32); // starts across the goal's centre line from where he meets it
    if (B[1] === 32) expect(first(runner)[1], tag).toBe(32);
    else expect(across, tag).toBeLessThan(0);
  }
  // On the drawn pitch: feeder on it at the start, winger while he receives and crosses, the runner from the moment it drops.
  const atk = lineups[side];
  const key = (name?: string) => keyOf(lineups, side, name);
  const f0 = frameAt(s, 0, lineups);
  expect(f0.carrier, tag).toBe(key(c.p));
  expect(onBall(f0, key(c.p)), tag).toBe(true);
  for (const t of [0.25, 0.375, 0.5]) {
    const f = frameAt(s, t, lineups);
    expect(f.carrier, `${tag} t=${t}`).toBe(key(c.p2));
    expect(onBall(f, key(c.p2)), `${tag} t=${t}`).toBe(true);
  }
  const head = n && atk.some((p) => p.name === n.p) ? key(n.p) : null;
  for (const t of [0.75, 0.9, 1]) {
    const f = frameAt(s, t, lineups);
    if (head) {
      expect(f.carrier, `${tag} t=${t}`).toBe(head);
      expect(onBall(f, head), `${tag} t=${t}`).toBe(true);
    } else {
      expect(f.carrier && onBall(f, f.carrier), `${tag} t=${t}: unnamed runner on it`).toBe(true);
    }
  }
}

// ------------------------------------------------------------------ tests

describe("crosses are a wide delivery with a separate runner attacking the box (FF-71)", () => {
  it.each([...CASES, ...FEEDER_HEADS])("$name: the scene's metadata is the cross's own, whatever the look-ahead says", ({ c, n }) => {
    // A next event that carries a different (future) score and text: none of it may surface in the cross scene.
    const leaky = { ...n, st: { ...n.st, sc: [2, 1] as [number, number], d: 1 as const }, text: "GOAL! leaked" };
    for (const s of [scene(c), scene(c, n), scene(c, leaky)]) {
      expect({ key: s.key, seq: s.seq, type: s.type, side: s.side, who: s.who, caption: s.caption, score: s.score, phase: s.phase }).toEqual({
        key: `${c.seq}`, seq: c.seq, type: "cross", side: c.side, who: c.p, caption: c.text, score: c.st.sc, phase: c.st.ph,
      });
      expect(s.flash ?? null).toBeNull();
      for (const k of ["impact", "won", "focus", "cam"] as const) expect(s[k], k).toBeUndefined();
      expect(s.ms).toBe(2000);
    }
    expect(scene(c, n, 8000).ms).toBe(Math.round(2000 * (8000 / 15000)));
  });

  it.each(CASES)("$name: the winger receives wide and crosses; the header-taker arrives to meet it", ({ c, n }) => {
    const s = scene(c, n);
    expectDelivery(s, c, n, LINEUPS, c.side as string);
    const runner = one(s, c.side as Side, n.p);
    expect(runner.id).toBe("h");
    expect(runner.label).not.toBe(short(c.p));
    expect(runner.label).not.toBe(short(c.p2));
  });

  it.each(FEEDER_HEADS)("$name: he plays it wide and makes the run himself — one actor, drawn throughout", ({ c, n }) => {
    const s = scene(c, n);
    const side = c.side as Side;
    expect(s.actors.some((a) => a.id === "h")).toBe(false);
    const feeder = one(s, side, c.p); // never two actors with his name (only one would be drawn)
    expect(dist(first(feeder), c.from as Pt)).toBeLessThanOrEqual(1.6);
    expect(last(feeder)).toEqual(n.ball);
    expectDelivery(s, c, n, LINEUPS, `${side} feeder`);
    for (const t of [0, 0.3, 0.6, 1]) {
      const f = frameAt(s, t, LINEUPS);
      expect(f.players.filter((p) => p.side + ":" + p.no === keyOf(LINEUPS, side, c.p) && p.hot), `t=${t}`).toHaveLength(1);
    }
  });

  it.each([...CASES, ...FEEDER_HEADS])("$name: the header scene carries on from the same player on the same spot", ({ c, n }) => {
    const s = scene(c, n);
    const shot = sceneFor(n, end(s), 15000)!;
    expect(shot.ball[0]).toEqual(n.ball); // no lead-in: the cross already dropped it there
    expect(shot.ballHeight?.[0]).toBeCloseTo(sampleN(s.ballHeight, 1), 6); // still at head height
    const shooter = shot.actors.find((a) => a.id === "s")!;
    expect(shooter.label).toBe(short(n.p));
    expect(first(shooter)).toEqual(last(runnerOf(s, c, n)));
    const key = keyOf(LINEUPS, c.side as Side, n.p);
    const pos = (f: Frame) => f.players.find((p) => p.side + ":" + p.no === key)!;
    const a = pos(frameAt(s, 1, LINEUPS));
    const b = pos(frameAt(shot, 0, LINEUPS));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.01);
  });

  it.each(CASES)("$name: without its header an unnamed runner attacks the far post — no invented name, same every time", ({ c }) => {
    const s = scene(c);
    expectDelivery(s, c, undefined, LINEUPS, `${c.side} fallback`);
    expect(end(s)).toEqual(fallback(c));
    const h = s.actors.find((a) => a.id === "h")!;
    expect(h.label).toBeUndefined();
    expect(new Set(s.actors.flatMap((a) => (a.label ? [a.label] : [])))).toEqual(new Set([short(c.p), short(c.p2)]));
    expect(scene(c)).toEqual(s);
  });

  it.each(CASES)("$name: look-ahead takes only this move's header — anything else is ignored", ({ c, n }) => {
    const none = scene(c);
    const wrong: Array<[string, MatchEvent]> = [
      ["not a shot", { ...n, t: "pass" }],
      ["not a header", { ...n, header: 0 }],
      ["other side", { ...n, side: other(c.side as Side) }],
      ["other move", { ...n, chain: (c.chain ?? 0) + 1 }],
      ["not the next event", { ...n, seq: c.seq + 2 }],
      ["no contact point", { ...n, ball: undefined }],
    ];
    for (const [why, x] of wrong) expect(scene(c, x), why).toEqual(none);
    expect(scene(c, n)).not.toEqual(none);
  });

  it.each(CASES)("$name: a header published late changes only the delivery: the frame up to the cross is identical", ({ c, n }) => {
    const before = scene(c);
    const after = scene(c, n);
    expect(after.ball.slice(0, 3)).toEqual(before.ball.slice(0, 3));
    expect(after.ballHeight).toEqual(before.ballHeight);
    for (const id of ["p", "r", "m"]) expect(after.actors.find((a) => a.id === id)!.path, id).toEqual(before.actors.find((a) => a.id === id)!.path);
    expect(after.ms).toBe(before.ms);
    const side = c.side as Side;
    for (const t of [0, 0.2, 0.4, 0.5]) {
      const [fa, fb] = [frameAt(after, t, LINEUPS), frameAt(before, t, LINEUPS)];
      expect(fa.ball, `t=${t}`).toEqual(fb.ball);
      expect(fa.carrier, `t=${t}`).toBe(fb.carrier);
      for (const name of [c.p, c.p2]) {
        const k = keyOf(LINEUPS, side, name);
        const [pa, pb] = [fa, fb].map((f) => f.players.find((p) => p.side + ":" + p.no === k)!);
        expect([pa.x, pa.y], `${name} t=${t}`).toEqual([pb.x, pb.y]);
      }
    }
  });

  it.each(CASES)("$name: once delivered the ball holds at head height — no dwell lay-offs with it in the air", ({ c, n }) => {
    const s = scene(c, n);
    const done = frameAt(s, 1, LINEUPS);
    for (const ms of [500, 2000, 5000]) {
      const f = frameAt(s, 1 + ms / s.ms, LINEUPS);
      expect(f.ball, `+${ms}ms`).toEqual(done.ball);
      expect(f.lift, `+${ms}ms`).toBeCloseTo(0.6, 6);
    }
  });

  it.each([...CASES, ...FEEDER_HEADS])("$name: never mutates the cross or its header", ({ c, n }) => {
    const [c0, n0] = [structuredClone(c), structuredClone(n)];
    const [cf, nf] = [deepFreeze(structuredClone(c)), deepFreeze(structuredClone(n))];
    expect(() => sceneFor(cf, cf.from as Pt, 15000, nf)).not.toThrow();
    expect(() => sceneFor(cf, [50, 32], 8000, nf)).not.toThrow(); // lead-in from elsewhere
    expect(() => sceneFor(nf, nf.ball as Pt, 15000, undefined)).not.toThrow();
    const s = sceneFor(c, c.from as Pt, 15000, n)!;
    frameAt(s, 0.6, LINEUPS);
    frameAt(sceneFor(n, end(s), 15000)!, 0.5, LINEUPS);
    expect([c, n]).toEqual([c0, n0]);
  });
});

describe("real engine crosses, both sides (FF-71)", () => {
  const found = engineCrosses();

  it("covers both sides, and the feeder-heads-it case, with every header accepted as look-ahead", () => {
    expect(found.filter((x) => x.c.side === "home").length).toBeGreaterThanOrEqual(20);
    expect(found.filter((x) => x.c.side === "away").length).toBeGreaterThanOrEqual(20);
    expect(found.filter((x) => x.n.p === x.c.p).length).toBeGreaterThanOrEqual(10);
    for (const { c, n } of found) {
      expect(n, `#${c.seq}`).toMatchObject({ t: "shot", header: 1, side: c.side, chain: c.chain, seq: c.seq + 1 });
      expect(n.p, `#${c.seq}: header by the winger`).not.toBe(c.p2);
      // Look-ahead identity is by short name: two different players never share one here.
      if (n.p !== c.p) expect(short(n.p), `#${c.seq}`).not.toBe(short(c.p));
      expect(scene(c, n)).not.toEqual(scene(c));
    }
  });

  it("every one: winger wide, the named header-taker meets the ball, and the header scene carries on with him", () => {
    for (const { c, n, prev, lineups } of found) {
      const tag = `${c.side} #${c.seq}`;
      expect(prev, tag).toEqual(c.from); // the published chain already sits on the engine's `from`
      const s = sceneFor(c, prev, 15000, n)!;
      expectDelivery(s, c, n, lineups, tag);
      expect(Math.abs((c.ball as Pt)[1] - 32), `${tag}: a wide cross`).toBeGreaterThanOrEqual(18);
      const shot = sceneFor(n, end(s), 15000)!;
      expect(shot.ball[0], tag).toEqual(n.ball);
      expect(first(shot.actors.find((a) => a.id === "s")!), tag).toEqual(last(runnerOf(s, c, n)));
    }
  });

  it("every one without its header (not yet published): an unnamed runner, only the cross's own players named", () => {
    for (const { c, prev, lineups } of found) {
      const s = sceneFor(c, prev, 15000)!;
      expectDelivery(s, c, undefined, lineups, `${c.side} #${c.seq} fallback`);
      expect(s.actors.find((a) => a.id === "h")?.label).toBeUndefined();
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
