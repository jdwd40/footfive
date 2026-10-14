/** #102-#107: fluid open play — team shape, off-ball movement, touch variety, tempo, no pauses, cross → shot continuity. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sceneFor, touchStyle, type Pt } from "./scenes";
import { frameAt, smooth, type Lineups } from "./sim";
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";

const squad = (tag: string): LineupPlayer[] => ["gk", "df", "df", "fw", "fw"].map((role, i) => ({ name: `${tag} P${i}`, no: i + 1, role, starter: true }));
const lineups: Lineups = { home: squad("Home"), away: squad("Away") };
const ev = (seq: number, t: string, side: Side, from: Pt, ball: Pt, extra: Partial<MatchEvent> = {}): MatchEvent =>
  ({ seq, at: seq * 1000, t, min: 10, side, p: (side === "home" ? "Home" : "Away") + " P3", p2: (side === "home" ? "Home" : "Away") + " P4", from, ball, text: t, st: {} as MatchEvent["st"], ...extra }) as MatchEvent;
const own = (side: Side, x: number) => (side === "home" ? x : 100 - x);
const meanX = (f: ReturnType<typeof frameAt>, side: Side) => {
  const q = f.players.filter((p) => p.side === side && !p.gk && !p.hot);
  return q.reduce((a, p) => a + own(side, p.x), 0) / q.length;
};

describe("#102 team in possession carries the shape up the field", () => {
  for (const side of ["home", "away"] as Side[]) {
    it(`${side}: off-ball teammates advance as the ball progresses`, () => {
      const deep = sceneFor(ev(10, "pass", side, [own(side, 25), 30], [own(side, 35), 34]), [own(side, 25), 30], 15000)!;
      const high = sceneFor(ev(11, "pass", side, [own(side, 60), 30], [own(side, 72), 34]), [own(side, 60), 30], 15000)!;
      const a = meanX(frameAt(deep, 0.9, lineups), side);
      const b = meanX(frameAt(high, 0.9, lineups), side);
      expect(b - a).toBeGreaterThan(15);
      // forwards are ahead of the ball in an attack
      const f = frameAt(high, 0.9, lineups);
      const fw = f.players.filter((p) => p.side === side && p.no >= 4 && !p.hot);
      for (const p of fw) expect(own(side, p.x)).toBeGreaterThan(own(side, f.ball[0]) - 2);
    });
  }
});

describe("#103 off-the-ball players move into sensible positions", () => {
  for (const side of ["home", "away"] as Side[]) {
    const def: Side = side === "home" ? "away" : "home";
    it(`${side} attacking: defenders track goal-side, attackers find space away from the ball`, () => {
      for (const bx of [40, 55, 70]) {
        for (const by of [12, 32, 52]) {
          const s = sceneFor(ev(20, "pass", side, [own(side, bx - 8), by], [own(side, bx), by]), [own(side, bx - 8), by], 15000)!;
          const f = frameAt(s, 0.999, lineups);
          const ball = f.ball;
          for (const p of f.players.filter((q) => q.side === def && (q.no === 2 || q.no === 3) && !q.hot)) expect(own(def, p.x)).toBeLessThan(own(def, ball[0]));
          for (const p of f.players.filter((q) => q.side === side && !q.gk && !q.hot)) expect(Math.abs(p.y - ball[1])).toBeGreaterThanOrEqual(5);
        }
      }
    });
  }
  it("positions respond to the ball and to which team has it", () => {
    const a = frameAt(sceneFor(ev(30, "pass", "home", [45, 20], [50, 20]), [45, 20], 15000)!, 0.999, lineups);
    const b = frameAt(sceneFor(ev(31, "pass", "away", [55, 20], [50, 20]), [55, 20], 15000)!, 0.999, lineups);
    const c = frameAt(sceneFor(ev(32, "pass", "home", [45, 44], [50, 44]), [45, 44], 15000)!, 0.999, lineups);
    const pos = (f: typeof a) => f.players.filter((p) => !p.gk && !p.hot).map((p) => p.side + p.no + ":" + p.x.toFixed(1) + "," + p.y.toFixed(1)).join();
    expect(pos(a)).not.toEqual(pos(b));
    expect(pos(a)).not.toEqual(pos(c));
  });
});

describe("#104 mix of carrying, holding and passing", () => {
  it("is deterministic by seq and mixes all three", () => {
    const styles = Array.from({ length: 60 }, (_, i) => touchStyle(i + 1));
    expect(styles).toEqual(Array.from({ length: 60 }, (_, i) => touchStyle(i + 1)));
    for (const k of ["quick", "carry", "hold"]) expect(styles.filter((x) => x === k).length).toBeGreaterThan(8);
  });
  it("keeps the engine's endpoints and the passer on the ball until the release", () => {
    for (let seq = 1; seq <= 40; seq++) {
      const side: Side = seq % 2 ? "home" : "away";
      const from: Pt = [own(side, 40), 30];
      const to: Pt = [own(side, 52), 36];
      const s = sceneFor(ev(seq, "pass", side, from, to), from, 15000)!;
      expect(s.ball[0]).toEqual(from);
      expect(s.ball[s.ball.length - 1]).toEqual(to);
      expect(s.touch).toBe(touchStyle(seq));
      if (s.touch !== "quick") {
        const p = s.actors.find((a) => a.id === "p")!;
        for (const t of [0, 0.2, 0.4, 0.5]) expect(Math.hypot(...(sample(p.path, t).map((v, i) => v - sample(s.ball, t)[i]) as [number, number]))).toBeLessThan(2);
      }
    }
  });
});

describe("#105 fast and slow phases of play", () => {
  it("counters and quick balls are fast, patient build-up slow; scene lengths unchanged", () => {
    const tk = sceneFor(ev(40, "tackle", "home", [50, 30], [52, 30]), [50, 30], 15000)!;
    const bu = sceneFor(ev(41, "build_up", "home", [30, 30], [36, 30]), [30, 30], 15000)!;
    expect(tk.tempo).toBe("fast");
    expect(bu.tempo).toBe("slow");
    expect(bu.ms).toBe(1500);
    const tempos = new Set(Array.from({ length: 30 }, (_, i) => sceneFor(ev(50 + i, "pass", "home", [40, 30], [52, 36]), [40, 30], 15000)!.tempo));
    expect(tempos.size).toBeGreaterThan(1);
  });
  it("players move further per frame in a fast phase than in a slow one", () => {
    const s = sceneFor(ev(42, "pass", "home", [30, 30], [60, 40]), [30, 30], 15000)!;
    const f0 = frameAt(s, 0, lineups);
    const f1 = frameAt(s, 0.6, lineups);
    const step = (tempo: "fast" | "slow") => {
      const n = smooth({ ...f0, tempo }, { ...f1, tempo }, 16);
      return n.players.reduce((a, p, i) => a + Math.hypot(p.x - f0.players[i].x, p.y - f0.players[i].y), 0);
    };
    expect(step("fast")).toBeGreaterThan(step("slow") * 1.5);
  });
});

describe("#106 long balls, runs and fluid motion", () => {
  const speed = (path: Pt[], t: number, dt = 0.002) => Math.hypot(...(sample(path, t + dt).map((v, i) => (v - sample(path, t)[i]) / dt) as [number, number]));
  it("never stalls through a moving keyframe: no pause frames before a pass, shot or run", () => {
    const path: Pt[] = [[10, 10], [20, 10], [30, 10]];
    expect(speed(path, 0.5)).toBeGreaterThan(10);
    for (let seq = 1; seq <= 30; seq++) {
      const s = sceneFor(ev(seq, "pass", "home", [30, 30], [44, 34]), [30, 30], 15000)!;
      for (let t = 0.3; t <= 0.7; t += 0.02) expect(speed(s.ball, t), `#${seq} t=${t.toFixed(2)}`).toBeGreaterThan(1);
    }
    // a real hold still holds
    expect(speed([[0, 0], [5, 0], [5, 0], [9, 0]], 0.5)).toBe(0);
  });
  it("a long forward pass is a lifted long ball the receiver chases from deep", () => {
    let seq = 1;
    while (touchStyle(seq) !== "quick") seq++;
    const s = sceneFor(ev(seq, "pass", "away", [80, 30], [45, 30]), [80, 30], 15000)!;
    expect(Math.max(...s.ballHeight!)).toBeGreaterThan(0.5);
    const r = s.actors.find((a) => a.id === "r")!;
    expect(r.path[0][0] - 45).toBeGreaterThanOrEqual(10);
    expect(s.ball[s.ball.length - 1]).toEqual([45, 30]);
  });
  it("idle drift is slow: no on-the-spot wobble between frames", () => {
    const s = sceneFor(ev(60, "corner_kick", "home", [50, 32], [50, 32]), [50, 32], 15000) ?? { key: "60", seq: 60, type: "x", ms: 0, ball: [[50, 32]] as Pt[], actors: [], caption: "" };
    for (let now = 1000; now < 9000; now += 16) {
      const a = frameAt(s, 1, lineups, undefined, now);
      const b = frameAt(s, 1, lineups, undefined, now + 16);
      expect(b.ball).toEqual(a.ball);
      a.players.forEach((p, i) => expect(Math.hypot(p.x - b.players[i].x, p.y - b.players[i].y)).toBeLessThan(0.02));
    }
  });
});

describe("#107 a runner who meets a cross heads it at once", () => {
  const require = createRequire(import.meta.url);
  const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
  const eng = lib("matchEngine.js");
  const { TEAMS } = lib("teams.js");
  const { defaultStarters } = lib("tournament.js");
  const team = (i: number) => { const t = TEAMS[i]; return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) }; };
  it("cross → header → result: the ball never stands still in the box and never doubles back", () => {
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const st = eng.createMatch({ fixtureId: "f" + i, seed: 2000 + i, kickoffAt: 0, home: team(i % 16), away: team((i * 5 + 1) % 16), timing: eng.buildTiming(15000, 1) });
      const evs: MatchEvent[] = eng.advanceTo(st, 1e12);
      let prev: Pt = [50, 32];
      for (let j = 0; j < evs.length; j++) {
        const e = evs[j];
        const s = sceneFor(e, prev, 15000, evs[j + 1]);
        if (!s) continue;
        if (e.t === "shot" && e.header && evs[j - 1]?.t === "cross") {
          n++;
          const box = e.ball as Pt;
          expect(s.ball[0]).toEqual(box);
          const gx = e.side === "home" ? 100 : 0;
          const toGoal = (p: Pt) => Math.abs(gx - p[0]);
          // Moving from the first frame up to the result event (published 1200 ms in, ≈ 0.92 of the scene).
          for (let t = 0; t <= 0.9; t += 0.05) expect(toGoal(sample(s.ball, t + 0.02)), `#${e.seq} t=${t.toFixed(2)}`).toBeLessThan(toGoal(sample(s.ball, t)));
          const r = sceneFor(evs[j + 1], s.ball[s.ball.length - 1], 15000, evs[j + 2])!;
          expect(r.ball[0]).toEqual(s.ball[s.ball.length - 1]); // the result carries on from where the header left it
          expect(toGoal(r.ball[1]), `${evs[j + 1].t} ${JSON.stringify(r.ball)} from ${JSON.stringify(evs[j + 1].from)} box ${JSON.stringify(box)}`).toBeLessThanOrEqual(toGoal(r.ball[0]) + 1e-9);
        }
        prev = s.ball[s.ball.length - 1];
      }
    }
    expect(n).toBeGreaterThan(5);
  });
});
