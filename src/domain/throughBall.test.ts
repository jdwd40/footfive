/**
 * FF-70: a through ball is drawn as a runner beating his marker onto a ball played into space ahead of him,
 * not as an ordinary short pass. Both sides, from the current published event only (no look-ahead); the engine's
 * endpoints, actors and outcome metadata are kept, and the event itself is never touched.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FULL_CAM, sample, sampleN, sceneFor, short, type Actor, type Pt, type Scene } from "./scenes";
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
const LINE_MARGIN = 3; // the runner starts this far behind his marker
const MARKER_GAP = 3; // the beaten marker ends at least this far from the ball
const LIFT_CAP = 0.3; // ground pass or a subtle lift

/** The three choreographed players: passer (`e.p`), runner (`e.p2`) and the defender marking the runner. */
function cast(s: Scene, e: MatchEvent) {
  const atk = e.side as Side;
  const passer = s.actors.find((a) => a.side === atk && a.label === short(e.p));
  const runner = s.actors.find((a) => a.side === atk && a.label === short(e.p2));
  const marker = s.actors.find((a) => a.id === "m" && a.side === other(atk));
  if (!passer || !runner || !marker) throw new Error(`#${e.seq}: through-ball scene lacks passer, runner or marker`);
  return { atk, passer, runner, marker };
}
const at = (a: Actor, t: number) => sample(a.path, t); // eased; sample() stops at t = 0.9999, so endpoints use the keys
const first = (a: Actor) => a.path[0];
const last = (a: Actor) => a.path[a.path.length - 1];
const EPS = 1e-3; // frames sample t = 1 as 0.9999

// ------------------------------------------------------------------ fixtures

const NAMES = { home: ["Kai Home", "Ada Passer", "Ben Runner", "Cy Stopper", "Di Wide"], away: ["Lu Away", "Mo Passer", "Ned Runner", "Oz Stopper", "Pip Wide"] } as const;
const LINEUPS: Lineups = {
  home: NAMES.home.map((name, i) => ({ name, no: i + 1, role: i ? (i < 3 ? "att" : "def") : "gk", starter: true })),
  away: NAMES.away.map((name, i) => ({ name, no: i + 1, role: i ? (i < 3 ? "att" : "def") : "gk", starter: true })),
};

/** A through ball as the engine publishes it (attack.js progression step) — p threads it for p2. */
function through(side: Side, from: Pt, ball: Pt, seq = 501): MatchEvent {
  const [, passer, runner] = NAMES[side];
  return {
    seq,
    at: 123_456,
    t: "through_ball",
    min: 31,
    side,
    chain: seq - 3,
    p: passer,
    p2: runner,
    from,
    ball,
    text: `${passer} threads a through ball for ${runner}`,
    st: { sc: [1, 0], so: null, ph: "second_half", clk: { s: 1810, run: 1 }, pos: 54, x: [[3, 1, 0, 0, 1, 0, 0, 0], [2, 1, 1, 0, 2, 0, 0, 0]], d: 1, win: null, by: null },
  };
}
const mirror = ([x, y]: Pt): Pt => [100 - x, y];
/** Home cases in home coordinates (engine ranges: from x ≤ 68, ball x 74–84, or 86–90 before a penalty; y 14–50); away is the mirror. */
const HOME_CASES: Array<[string, Pt, Pt]> = [
  ["central", [56, 30], [80, 34]],
  ["upper channel", [44, 20], [78, 16]],
  ["shortest (6 forward)", [68, 30], [74, 30]],
  ["long, into the box before a penalty", [40, 40], [88, 32]],
];
const CASES = (["home", "away"] as Side[]).flatMap((side) =>
  HOME_CASES.map(([name, from, ball], i) => ({ name: `${side} ${name}`, e: through(side, side === "home" ? from : mirror(from), side === "home" ? ball : mirror(ball), 501 + i)})),
);
const scene = (e: MatchEvent, minuteMs = 15000) => sceneFor(e, e.from as Pt, minuteMs)!;

type Team = { name: string; abbr: string; grade: string; players: Array<{ name: string; role: string; is_starter: boolean }> };
const team = (i: number): Team => {
  const t = TEAMS[i];
  return { name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const lineup = (t: Team): LineupPlayer[] => t.players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
/** Real engine through balls, built in the published scene chain (prevBall = the previous scene's end), with each match's lineups. */
function engineThroughBalls(n = 24) {
  const out: Array<{ e: MatchEvent; s: Scene; next: Scene | null; lineups: Lineups }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "tb" + i, seed: 2000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(1000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    let prev: Pt = [50, 32];
    let open: (typeof out)[number] | null = null;
    for (const e of events) {
      const s = sceneFor(e, prev, 15000);
      if (!s) continue;
      if (open) open.next = s;
      open = null;
      if (e.t === "through_ball") out.push((open = { e, s, next: null, lineups: { home: lineup(home), away: lineup(away) } }));
      prev = end(s);
    }
  }
  return out;
}

// ------------------------------------------------------------------ shared assertions

/** Geometry that makes it a through ball: runner behind his marker, ball played ahead of him, marker beaten and late, contact on the run. */
function expectThroughBall(s: Scene, e: MatchEvent) {
  const { atk, runner, marker } = cast(s, e);
  const spot = e.ball as Pt;
  const r0 = first(runner);
  const m0 = first(marker);
  const r1 = last(runner);
  const m1 = last(marker);
  const tag = `${atk} #${e.seq} ${JSON.stringify(e.from)}→${JSON.stringify(spot)}`;
  // Start: the runner is on his own side of the line (behind his marker) and the ball is played into space well ahead of him.
  expect(along(atk, m0) - along(atk, r0), tag).toBeGreaterThanOrEqual(LINE_MARGIN - 1e-9);
  expect(along(atk, spot) - along(atk, r0), tag).toBeGreaterThanOrEqual(6 - 1e-9);
  expect(dist(m0, spot), `${tag}: the marker already stands in the space`).toBeGreaterThan(MARKER_GAP);
  // Late: the marker's first move is the wrong way (stepping up), not towards his own goal with the runner.
  expect(along(atk, at(marker, 0.5)), tag).toBeLessThanOrEqual(along(atk, m0) + 1e-9);
  // Beaten: the runner ends goal-side of his marker, on the ball; the marker is left behind and off it.
  expect(r1, tag).toEqual(spot);
  expect(along(atk, r1) - along(atk, m1), tag).toBeGreaterThanOrEqual(MARKER_GAP - 1e-9);
  expect(dist(m1, spot), tag).toBeGreaterThan(MARKER_GAP);
  // On the run: three quarters through he is still running onto it, and the ball never waits in the space for him.
  expect(dist(at(runner, 0.75), spot), `${tag}: runner already waiting on the spot`).toBeGreaterThanOrEqual(1);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    if (dist(sample(s.ball, t), spot) < 1) expect(dist(at(runner, t), spot), `${tag} t=${t.toFixed(2)}`).toBeLessThan(1.6);
  }
  // Ground pass or a subtle lift, landing at his feet.
  expect(Math.max(...(s.ballHeight ?? [0])), tag).toBeLessThanOrEqual(LIFT_CAP);
  expect(sampleN(s.ballHeight, 1), tag).toBeLessThan(0.05);
}

/** Drawn contact as Pitch renders the carrier ring: nominated carrier, ball on the ground and within 1.6 of him. */
function contact(f: Frame) {
  const p = f.players.find((q) => q.side + ":" + q.no === f.carrier);
  return p && f.lift < 0.05 && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) <= 1.6 ? p : null;
}

// ------------------------------------------------------------------ tests

describe("through balls are a runner beating his marker into space (FF-70)", () => {
  it.each(CASES)("$name: keeps the engine's endpoints, named players and outcome metadata", ({ e }) => {
    const s = scene(e);
    const { passer } = cast(s, e);
    expect(s.type).toBe("through_ball");
    expect(s.ball[0]).toEqual(e.from);
    expect(end(s)).toEqual(e.ball);
    expect({ key: s.key, seq: s.seq, side: s.side, who: s.who, caption: s.caption, score: s.score, phase: s.phase }).toEqual({
      key: `${e.seq}`, seq: e.seq, side: e.side, who: e.p, caption: e.text, score: e.st.sc, phase: e.st.ph,
    });
    // A through ball is not a result or a contest: no badge, impact, WON IT cue, focus or camera move.
    expect(s.flash ?? null).toBeNull();
    for (const k of ["impact", "won", "focus"] as const) expect(s[k], k).toBeUndefined();
    expect(s.cam === undefined || s.cam[2] < FULL_CAM[2], "cam: final-third zoom (#81) or full pitch").toBe(true);
    // Same pace as the pass it replaces, at a broadcast and at the live minute.
    for (const ms of [15000, 8000]) expect(scene(e, ms).ms).toBe(sceneFor({ ...e, t: "pass" }, e.from as Pt, ms)!.ms);
    // The passer strikes it from where the engine put the ball.
    expect(dist(first(passer), e.from as Pt)).toBeLessThanOrEqual(1.6);
  });

  it.each(CASES)("$name: is not drawn as an ordinary pass of the same ball", ({ e }) => {
    const tb = scene(e);
    const pass = scene({ ...e, t: "pass" });
    const t = cast(tb, e);
    const p = cast(pass, e);
    // Same ball, same passer: only the runner and his marker tell the two apart.
    expect(tb.ball).toEqual(pass.ball);
    expect(t.passer.path).toEqual(p.passer.path);
    expect(t.runner.path).not.toEqual(p.runner.path);
    expect(t.marker.path).not.toEqual(p.marker.path);
    // The ordinary pass stays a short pass: receiver 4 short of the ball, his marker ending goal-side of him.
    const spot = e.ball as Pt;
    expect(along(t.atk, spot) - along(t.atk, first(p.runner))).toBeCloseTo(4, 6);
    expect(along(t.atk, last(p.marker))).toBeGreaterThan(along(t.atk, spot));
    // The through-ball runner covers more ground onto the ball than a pass receiver does.
    const run = (a: Actor) => along(t.atk, last(a)) - along(t.atk, first(a));
    expect(run(t.runner)).toBeGreaterThanOrEqual(run(p.runner) + 2 - 1e-9);
  });

  it.each(CASES)("$name: the runner starts behind his marker, beats him and meets the ball on the run", ({ e }) => {
    expectThroughBall(scene(e), e);
  });

  it.each(CASES)("$name: on the drawn pitch the passer strikes it and the runner, past his marker, collects it", ({ e }) => {
    const s = scene(e);
    const { atk } = cast(s, e);
    const key = (name?: string) => `${atk}:${LINEUPS[atk].find((p) => p.name === name)!.no}`;
    const strike = frameAt(s, 0.04, LINEUPS);
    expect(strike.carrier).toBe(key(e.p));
    expect(contact(strike)).toBeTruthy();
    // Free flight: nobody on the ball while it travels into the space.
    for (const t of [0.3, 0.5, 0.7, 0.9]) expect(frameAt(s, t, LINEUPS).carrier, `t=${t}`).toBeNull();
    for (const t of [0.97, 1]) {
      const f = frameAt(s, t, LINEUPS);
      expect(f.carrier, `t=${t}`).toBe(key(e.p2));
      expect(contact(f), `t=${t}`).toBeTruthy();
    }
    // Reduced motion and replays draw the final frame: the runner is on the ball, and the real defender bound to the marker is behind him.
    const last = frameAt(s, 1, LINEUPS);
    const runner = last.players.find((q) => q.side + ":" + q.no === key(e.p2))!;
    const marker = last.players.filter((q) => q.side === other(atk) && q.hot);
    expect(marker).toHaveLength(1);
    expect(along(atk, [runner.x, runner.y]) - along(atk, [marker[0].x, marker[0].y])).toBeGreaterThanOrEqual(MARKER_GAP - EPS);
  });

  it.each(CASES)("$name: never mutates the published event", ({ e }) => {
    const before = structuredClone(e);
    const frozen = deepFreeze(structuredClone(e));
    expect(() => sceneFor(frozen, frozen.from as Pt, 15000)).not.toThrow();
    expect(() => sceneFor(frozen, [50, 32], 8000)).not.toThrow(); // lead-in from elsewhere
    const s = sceneFor(e, e.from as Pt, 15000)!;
    frameAt(s, 0.5, LINEUPS);
    frameAt(s, 1, LINEUPS);
    expect(e).toEqual(before);
  });
});

describe("real engine through balls, both sides (FF-70)", () => {
  const found = engineThroughBalls();

  it("covers enough home and away through balls, including ones that set up a penalty", () => {
    expect(found.filter((x) => x.e.side === "home").length).toBeGreaterThanOrEqual(20);
    expect(found.filter((x) => x.e.side === "away").length).toBeGreaterThanOrEqual(20);
    expect(found.some((x) => x.next?.type === "penalty_awarded")).toBe(true);
  });

  it("every one is a beaten-marker run onto a ball played ahead, ending on the engine's spot where the next scene starts", () => {
    for (const { e, s, next } of found) {
      expect(s.type).toBe("through_ball");
      expect(s.ball[0]).toEqual(e.from); // the published chain already sits on the engine's `from`
      expectThroughBall(s, e);
      if (next) expect(next.ball[0], `after #${e.seq}`).toEqual(e.ball);
    }
  });

  it("every one is drawn with contact at the strike and at the reception, by the named players", () => {
    for (const { e, s, lineups } of found) {
      const atk = e.side as Side;
      const no = (name?: string) => `${atk}:${lineups[atk].find((p) => p.name === name)!.no}`;
      const strike = frameAt(s, 0.04, lineups);
      expect(strike.carrier, `#${e.seq}`).toBe(no(e.p));
      expect(contact(strike), `#${e.seq}`).toBeTruthy();
      const f = frameAt(s, 1, lineups);
      expect(f.carrier, `#${e.seq}`).toBe(no(e.p2));
      expect(contact(f), `#${e.seq}`).toBeTruthy();
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
