import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sampleN, sceneFor, type Pt, type Scene } from "./scenes";
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
        const s = sceneFor(e, prev, 15000);
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

  it("every scene starts where the previous one ended: no teleports between scenes", () => {
    let n = 0;
    for (const m of matches) {
      let prev: Pt = [50, 32];
      for (const e of m) {
        const s = sceneFor(e, prev, 15000);
        if (!s) continue; // idle scenes hold the ball where it was
        expect(s.ball[0], `${e.t} #${e.seq}`).toEqual(prev);
        prev = end(s);
        n++;
      }
    }
    expect(n).toBeGreaterThan(5000);
    // Restart after a failed penalty clears to the engine's spot near the end, not the centre.
    const penRestart = all.find((e, i) => e.t === "restart" && e.ball?.[0] !== 50 && all[i - 1]?.t !== "celebration")!;
    expect(end(sceneFor(penRestart, [7, 24], 15000)!)).toEqual(penRestart.ball);
  });

  it("every result scene names its impact point, and the ball passes through it", () => {
    let n = 0;
    for (const m of matches) {
      let prev: Pt = [50, 32];
      for (const e of m) {
        const s = sceneFor(e, prev, 15000);
        if (!s) continue;
        prev = end(s);
        if (!s.flash) {
          expect(s.impact, `${e.t} #${e.seq}`).toBeUndefined();
          continue;
        }
        n++;
        const [ix, iy] = s.impact!;
        let best = Infinity;
        for (let t = 0; t <= 1.0001; t += 0.01) {
          const [x, y] = sample(s.ball, t);
          best = Math.min(best, Math.hypot(x - ix, y - iy));
        }
        expect(best, `${e.t} #${e.seq}`).toBeLessThan(0.05);
        if (s.flash === "goal" && e.t !== "celebration") expect(Math.abs(ix - (e.t === "shootout_kick" ? 100 : e.side === "home" ? 100 : 0))).toBeLessThanOrEqual(2);
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it("saved, missed, blocked and woodwork shots never cross the goal line inside the mouth", () => {
    let n = 0;
    for (const e of all) {
      if (!["save", "miss", "block", "woodwork", "penalty_saved", "penalty_missed", "penalty_woodwork"].includes(e.t)) continue;
      const s = sceneFor(e, [70, 32], 15000)!;
      expect(s).toBeTruthy();
      n++;
      // attacking side for shot results: save/block events are credited to the defending side
      const atk = e.t === "save" || e.t === "block" ? (e.side === "home" ? "away" : "home") : e.side;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const [x, y] = sample(s.ball, t);
        const behind = atk === "home" ? x > 100.5 : x < -0.5;
        if (behind) expect(inMouth(y) && sampleN(s.ballHeight, t) < 0.3).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  it("shootout kicks are taken at one end and follow the engine's outcome", () => {
    const kicks = all.filter((e) => e.t === "shootout_kick");
    expect(kicks.length).toBeGreaterThan(5);
    for (const e of kicks) {
      const s = sceneFor(e, [50, 32], 15000)!;
      const outcome = e.pen!.outcome;
      const [x, y] = end(s);
      expect(s.ball[1][0]).toBe(89); // spot at the x=100 end for both teams
      if (outcome === "goal") expect(x > 100 && inMouth(y)).toBe(true);
      else expect(x > 100 && inMouth(y) && sampleN(s.ballHeight, 1) < 0.3).toBe(false);
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

  it("a shot's snapshot never reveals its outcome: on-target counts only on the goal/save", () => {
    let shots = 0;
    for (const m of matches) {
      let prev = [[0, 0], [0, 0]];
      for (const e of m) {
        const i = e.side === "home" ? 0 : 1;
        const sot = [e.st.x[0][1], e.st.x[1][1]];
        if (e.t === "shot") {
          expect(sot, `shot #${e.seq}`).toEqual([prev[0][1], prev[1][1]]);
          shots++;
        } else if (e.t === "goal" || e.t === "penalty_goal" || e.t === "penalty_saved") expect(sot[i], `${e.t} #${e.seq}`).toBe(prev[i][1] + 1);
        else if (e.t === "save") expect(sot[1 - i], `save #${e.seq}`).toBe(prev[1 - i][1] + 1); // save is credited to the defending side
        else expect(sot, `${e.t} #${e.seq}`).toEqual([prev[0][1], prev[1][1]]);
        prev = e.st.x.map((r) => [r[0], r[1]]);
      }
    }
    expect(shots).toBeGreaterThan(100);
  });

  it("the event after a shot result or card waits resultHoldMs so the client can show it", () => {
    const hold = eng.buildTiming(1000, 1).resultHoldMs as number;
    expect(hold).toBe(1200);
    const held = new Set(["miss", "block", "woodwork", "save", "yellow_card", "red_card"]);
    let n = 0;
    for (const m of matches)
      for (let i = 0; i + 1 < m.length; i++)
        if (held.has(m[i].t)) {
          n++;
          expect(m[i + 1].at - m[i].at, `${m[i].t} → ${m[i + 1].t}`).toBeGreaterThanOrEqual(hold);
        }
    expect(n).toBeGreaterThan(50);
  });

  it("never emits corners; bounces sit on a side board; every miss bounces back in", () => {
    expect(all.filter((e) => e.t === "corner")).toHaveLength(0);
    const b = all.filter((e) => e.t === "bounce");
    expect(b.length).toBeGreaterThan(0);
    for (const e of b) {
      const hit = e.from as [number, number]; // the wall the ball came off
      expect(hit[1] === 0 || hit[1] === 64 || hit[0] === 0 || hit[0] === 100).toBe(true);
    }
    let misses = 0;
    for (const m of matches) {
      m.forEach((e, i) => {
        if (e.t !== "miss") return;
        misses++;
        expect(m[i + 1]?.t, `miss #${e.seq}`).toBe("bounce");
      });
    }
    expect(misses).toBeGreaterThan(20);
  });

  it("scene length follows the match pace; goals stay watchable", () => {
    const pass = all.find((e) => e.t === "pass")!;
    const goal = all.find((e) => e.t === "goal")!;
    expect(sceneFor(pass, [50, 32], 15000)!.ms).toBe(1500);
    expect(sceneFor(pass, [50, 32], 8000)!.ms).toBeLessThanOrEqual(900);
    expect(sceneFor(goal, [50, 32], 8000)!.ms).toBeGreaterThanOrEqual(2400);
    expect(sceneFor(goal, [50, 32], 1000)!.ms).toBe(2400); // k floors at 0.15 and goals at 2400
    expect(sceneFor(goal, [50, 32], 15000)!.ms).toBe(3800);
    const cel = all.find((e) => e.t === "celebration")!;
    expect(sceneFor(cel, [102, 32], 15000)!.ms).toBe(2600); // the GOOOAL banner's life: never under 2.6 s
    expect(sceneFor(cel, [102, 32], 1000)!.ms).toBe(2600);
  });

  it("penalties get a broadcast camera on the attacked end; the kick keeps its secret until the strike", () => {
    const kicks = all.filter((e) => e.t === "shootout_kick");
    for (const e of kicks.slice(0, 10)) {
      const s = sceneFor(e, [50, 32], 15000)!;
      expect(s.cam).toEqual([63, 16, 50, 32]);
      expect(s.flashAt).toBe(0.75);
      // Ball still on the spot and keeper still central at half-time: nothing gives the outcome away.
      expect(sample(s.ball, 0.5)).toEqual([89, 32]);
      expect(sample(s.actors.find((a) => a.keeper)!.path, 0.5)[1]).toBe(32);
      const [x] = end(s);
      if (e.pen!.outcome === "goal") expect(x).toBeGreaterThan(100);
    }
    const awayPen = all.find((e) => e.t === "penalty_awarded" && e.side === "away")!;
    expect(sceneFor(awayPen, [50, 32], 15000)!.cam).toEqual([-13, 16, 50, 32]);
    const setup = all.find((e) => e.t === "shootout_setup")!;
    const ss = sceneFor(setup, [50, 32], 15000)!;
    expect(ss.cam).toEqual([63, 16, 50, 32]);
    expect(ss.pens).toEqual([setup.st.so!.h, setup.st.so!.a]);
    const so = all.find((e) => e.t === "shootout_end")!;
    expect(sceneFor(so, [50, 32], 15000)!.cam).toEqual([63, 16, 50, 32]);
    expect(sceneFor(all.find((e) => e.t === "pass")!, [50, 32], 15000)!.cam).toBeUndefined();
  });

  it("setup scenes fill the engine's wait for the kick: taker places, walks back and settles; keeper bounces; the ref jogs in", () => {
    const setup = all.find((e) => e.t === "shootout_setup")!;
    const penSetup = all.find((e) => e.t === "penalty_setup")!;
    expect(sceneFor(setup, [50, 32], 15000)!.ms).toBe(6000); // balance.js shootoutRevealMs, whatever the pace
    expect(sceneFor(setup, [50, 32], 1000)!.ms).toBe(6000);
    expect(sceneFor(penSetup, [50, 32], 15000)!.ms).toBe(5000); // balance.js penSetupMs
    const s = sceneFor(setup, [50, 32], 15000)!;
    const at = (id: string, t: number) => sample(s.actors.find((a) => a.id === id)!.path, t);
    expect(sample(s.ball, 0.2)).toEqual([89, 32]); // ball placed by 20 % and left there
    expect(sample(s.ball, 0.9)).toEqual([89, 32]);
    expect(at("taker", 0.3)).not.toEqual(at("taker", 0.6)); // walking back
    expect(Math.hypot(...(at("taker", 0.6).map((v, i) => v - at("taker", 0.95)[i]) as [number, number]))).toBeLessThan(0.7); // settled, breathing only
    expect(Math.abs(at("taker", 0.6)[0] - 89)).toBeGreaterThan(4); // six back from the spot
    const gkY = [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => at("gk", t)[1]);
    expect(Math.max(...gkY) - Math.min(...gkY)).toBeGreaterThan(1.5); // bouncing on the line
    expect(s.actors.some((a) => a.side === "ref")).toBe(true);
    expect(at("ref", 0)).not.toEqual(at("ref", 0.5));
    expect(s.impact).toEqual([89, 32]);
  });

  it("penalty_awarded fills the engine's 5 s award wait: fouled player down, ref runs in to point, offender walks off, taker moves", () => {
    const e = all.find((e) => e.t === "penalty_awarded")!;
    const s = sceneFor(e, [50, 32], 15000)!;
    expect(s.ms).toBeGreaterThanOrEqual(5000);
    expect(sceneFor(e, [50, 32], 1000)!.ms).toBe(s.ms); // pace-independent, like the setup
    const at = (id: string, t: number) => sample(s.actors.find((a) => a.id === id)!.path, t);
    expect(s.actors.some((a) => a.side === "ref")).toBe(true);
    expect(at("ref", 0.3)).not.toEqual(at("ref", 0.55)); // runs in to point
    expect(at("fouled", 0.2)).not.toEqual(at("fouled", 0.7)); // down, then up and on the spot
    expect(Math.hypot(...(at("off", 0.85).map((v, i) => v - at("off", 0.5)[i]) as [number, number]))).toBeGreaterThan(2); // walks away
    expect(s.actors.some((a) => a.keeper)).toBe(true);
    expect(Math.hypot(...(sample(s.ball, 1).map((v, i) => v - s.impact![i]) as [number, number]))).toBeLessThan(1e-9);
  });

  it("period markers get a 3 s scene (banner life) whatever the pace; the ball stays where it was", () => {
    for (const t of ["half_time", "second_half", "end_of_normal_time", "extra_time", "et_second_half", "shootout_start"]) {
      const e = all.find((e) => e.t === t);
      if (!e) continue; // not every seed goes the distance
      const s = sceneFor(e, [20, 30], 1000)!;
      expect(s.ms, t).toBe(3000);
      expect(s.ball[0], t).toEqual([20, 30]);
      expect(s.score, t).toEqual(e.st.sc);
    }
    expect(sceneFor(all.find((e) => e.t === "half_time")!, [20, 30], 15000)!.actors).toEqual([]);
  });

  it("match_end is a 5 s scene carrying the winner (side) and how (by), for the full-time banner", () => {
    const e = all.find((e) => e.t === "match_end")!;
    const s = sceneFor(e, [20, 30], 1000)!;
    expect(s.ms).toBe(5000);
    expect(s.side).toBe(e.st.win);
    expect(s.by).toBe(e.st.by);
    expect(s.score).toEqual(e.st.sc);
    expect(s.ball).toEqual([[20, 30]]);
  });

  it("every live minute carries at least two on-pitch events", () => {
    for (const m of matches) {
      const byMin = new Map<number, number>();
      for (const e of m) if (e.ball && ["first_half", "second_half"].includes(e.st.ph)) byMin.set(e.min, (byMin.get(e.min) || 0) + 1);
      for (let min = 2; min <= 44; min++) expect(byMin.get(min) || 0, `minute ${min}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("shootout banners have what they need", () => {
  it("some seeded shootout reaches sudden death and flags a must-score kick", () => {
    const setups = events(200).flat().filter((e) => e.t === "shootout_setup");
    expect(setups.some((e) => e.kick?.sd === 1)).toBe(true);
    expect(setups.some((e) => e.kick?.must === 1)).toBe(true);
    expect(setups.some((e) => e.kick?.win === 1)).toBe(true);
  });
});
