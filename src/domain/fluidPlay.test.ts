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
