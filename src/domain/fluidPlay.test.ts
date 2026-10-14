/** #102-#107: fluid open play — team shape, off-ball movement, touch variety, tempo, no pauses, cross → shot continuity. */
import { describe, expect, it } from "vitest";
import { sceneFor, type Pt } from "./scenes";
import { frameAt, type Lineups } from "./sim";
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
