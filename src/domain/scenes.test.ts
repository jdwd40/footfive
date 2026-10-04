import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { enqueue, sample, sceneFor, type Pt, type Scene } from "./scenes";
import type { MatchEvent } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
}

/** All published events of several full simulated matches. */
function events(n = 40): MatchEvent[][] {
  const out: MatchEvent[][] = [];
  for (let i = 0; i < n; i++) {
    const st = eng.createMatch({ fixtureId: "f" + i, seed: 1000 + i, kickoffAt: 0, home: team(i % 16), away: team((i * 7 + 3) % 16), timing: eng.buildTiming(1000, 1) });
    out.push(eng.advanceTo(st, 1e12));
  }
  return out;
}

const inMouth = (y: number) => y >= 27.5 && y <= 36.5;
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];

describe("highlight scenes agree with the simulation", () => {
  const matches = events();
  const all = matches.flat();

  it("every goal scene ends with the ball in the net of the attacked goal", () => {
    let prev: Pt = [50, 32];
    let n = 0;
    for (const m of matches) {
      for (const e of m) {
        const s = sceneFor(e, prev);
        if (s) prev = end(s);
        if (!s || (e.t !== "goal" && e.t !== "penalty_goal")) continue;
        n++;
        const [x, y] = end(s);
        if (e.side === "home") expect(x).toBeGreaterThanOrEqual(100);
        else expect(x).toBeLessThanOrEqual(0);
        expect(inMouth(y)).toBe(true);
        expect(s.flash).toBe("goal");
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("saved, missed, blocked and woodwork shots never cross the goal line inside the mouth", () => {
    let n = 0;
    for (const e of all) {
      if (!["save", "miss", "block", "woodwork", "penalty_saved", "penalty_missed", "penalty_woodwork"].includes(e.t)) continue;
      const s = sceneFor(e, [70, 32])!;
      expect(s).toBeTruthy();
      n++;
      // attacking side for shot results: save/block events are credited to the defending side
      const atk = e.t === "save" || e.t === "block" ? (e.side === "home" ? "away" : "home") : e.side;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const [x, y] = sample(s.ball, t);
        const behind = atk === "home" ? x > 100.5 : x < -0.5;
        if (behind) expect(inMouth(y) && !s.ballHeight).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it("shootout kicks are taken at one end and follow the engine's outcome", () => {
    const kicks = all.filter((e) => e.t === "shootout_kick");
    expect(kicks.length).toBeGreaterThan(5);
    for (const e of kicks) {
      const s = sceneFor(e, [50, 32])!;
      const outcome = e.pen!.outcome;
      const [x, y] = end(s);
      expect(s.ball[0][0]).toBe(89); // spot at the x=100 end for both teams
      if (outcome === "goal") expect(x > 100 && inMouth(y)).toBe(true);
      else expect(x > 100 && inMouth(y) && !s.ballHeight).toBe(false);
    }
  });

  it("goal scenes are announced with the score change (same event)", () => {
    for (const m of matches) {
      let sc = [0, 0];
      for (const e of m) {
        if (e.t === "goal" || e.t === "penalty_goal") {
          const i = e.side === "home" ? 0 : 1;
          expect(e.st.sc[i]).toBe(sc[i] + 1);
          expect(e.text).toMatch(/GOAL|PENALTY SCORED/);
        } else expect(e.st.sc).toEqual(sc);
        sc = e.st.sc;
      }
    }
  });

  it("never emits corners; bounces sit on a side board", () => {
    expect(all.filter((e) => e.t === "corner")).toHaveLength(0);
    const b = all.filter((e) => e.t === "bounce");
    expect(b.length).toBeGreaterThan(0);
    for (const e of b) {
      const hit = e.from as [number, number]; // the wall the ball came off
      expect(hit[1] === 0 || hit[1] === 64 || hit[0] === 0 || hit[0] === 100).toBe(true);
    }
  });

  it("every live minute carries at least two on-pitch events", () => {
    for (const m of matches) {
      const byMin = new Map<number, number>();
      for (const e of m) if (e.ball && ["first_half", "second_half"].includes(e.st.ph)) byMin.set(e.min, (byMin.get(e.min) || 0) + 1);
      for (let min = 2; min <= 44; min++) expect(byMin.get(min) || 0, `minute ${min}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("bounded live queue", () => {
  const mk = (seq: number, important: boolean): Scene => ({ key: String(seq), seq, type: important ? "goal" : "pass", ms: 1000, ball: [[0, 0]], actors: [], caption: "", important });
  it("drops stale routine scenes before incidents (keeping the lead-in) and never grows past the cap", () => {
    let q: Scene[] = [];
    q = enqueue(q, [mk(1, false), mk(2, false), mk(3, true), mk(4, false), mk(5, false), mk(6, true)], 4);
    expect(q.map((s) => s.seq)).toEqual([3, 5, 6]);
    q = enqueue(q, [mk(7, true), mk(8, true), mk(9, true)], 4);
    expect(q.map((s) => s.seq)).toEqual([6, 7, 8, 9]);
    q = enqueue([], [mk(10, false), mk(11, false), mk(12, false), mk(13, false), mk(14, false), mk(15, false)], 4);
    expect(q.map((s) => s.seq)).toEqual([12, 13, 14, 15]);
  });
});
