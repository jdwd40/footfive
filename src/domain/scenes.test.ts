import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FULL_CAM, penRefSpot, sample, sampleN, sceneFor, type Cam, type Pt, type Scene } from "./scenes";
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
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Penalty camera at the x=100 end: 56 wide at the full-pitch aspect, centred on y=32, pushed left to the right-hand margin (104). */
const PEN_HOME: Cam = [48, 32 - (56 * 77) / 108 / 2, 56, (56 * 77) / 108];

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
          // the hold shifts the whole schedule: the event after next must not collapse onto the next
          if (i + 2 < m.length && m[i + 2].min === m[i + 1].min) expect(m[i + 2].at, `${m[i + 1].t} → ${m[i + 2].t}`).toBeGreaterThan(m[i + 1].at);
        }
    expect(n).toBeGreaterThan(50);
  });

  it("the first play after a kick-off / period restart waits kickoffHoldMs (announcement + walk-on)", () => {
    const hold = eng.buildTiming(1000, 1).kickoffHoldMs as number;
    expect(hold).toBe(4000);
    const starts = new Set(["kickoff", "second_half", "extra_time", "et_second_half"]);
    let n = 0;
    for (const m of matches)
      for (let i = 0; i + 1 < m.length; i++)
        if (starts.has(m[i].t)) {
          n++;
          expect(m[i + 1].at - m[i].at, `${m[i].t} → ${m[i + 1].t}`).toBeGreaterThanOrEqual(hold);
        }
    expect(n).toBeGreaterThanOrEqual(matches.length * 2);
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
      expect(s.cam).toEqual(PEN_HOME);
      expect(s.flashAt).toBe(0.75);
      // Ball still on the spot and keeper still central at half-time: nothing gives the outcome away.
      expect(sample(s.ball, 0.5)).toEqual([89, 32]);
      expect(sample(s.actors.find((a) => a.keeper)!.path, 0.5)[1]).toBe(32);
      const [x] = end(s);
      if (e.pen!.outcome === "goal") expect(x).toBeGreaterThan(100);
    }
    const awayPen = all.find((e) => e.t === "penalty_awarded" && e.side === "away")!;
    expect(sceneFor(awayPen, [50, 32], 15000)!.cam).toEqual([-4, PEN_HOME[1], 56, PEN_HOME[3]]); // mirrored, clamped to the left margin
    const setup = all.find((e) => e.t === "shootout_setup")!;
    const ss = sceneFor(setup, [50, 32], 15000)!;
    expect(ss.cam).toEqual(PEN_HOME);
    expect(ss.pens).toEqual([setup.st.so!.h, setup.st.so!.a]);
    const so = all.find((e) => e.t === "shootout_end")!;
    expect(sceneFor(so, [50, 32], 15000)!.cam).toEqual(PEN_HOME);
    expect(sceneFor(all.find((e) => e.t === "pass")!, [50, 32], 15000)!.cam).toBeUndefined();
  });

  it("every camera window keeps the full-pitch aspect ratio, so zooming never changes the SVG's height", () => {
    const ratio = FULL_CAM[2] / FULL_CAM[3];
    let n = 0;
    for (const m of matches.slice(0, 20)) {
      let prev: Pt = [50, 32];
      for (const e of m) {
        const s = sceneFor(e, prev, 15000);
        if (!s) continue;
        prev = end(s);
        if (!s.cam) continue;
        n++;
        expect(Math.abs(s.cam[2] / s.cam[3] - ratio), `${e.t} #${e.seq}`).toBeLessThan(0.01);
        expect(s.cam[2], `${e.t} #${e.seq}`).toBe(56); // the box and the goal fit
        expect(s.cam[0]).toBeGreaterThanOrEqual(FULL_CAM[0]); // inside the full-pitch margins
        expect(s.cam[0] + s.cam[2]).toBeLessThanOrEqual(FULL_CAM[0] + FULL_CAM[2]);
        expect(s.cam[1]).toBeGreaterThanOrEqual(FULL_CAM[1]);
        expect(s.cam[1] + s.cam[3]).toBeLessThanOrEqual(FULL_CAM[1] + FULL_CAM[3]);
      }
    }
    expect(n).toBeGreaterThan(20);
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
    expect(at("ref", 0)).toEqual(penRefSpot("home")); // already on his spot: smoothing walks him there, then he holds still
    expect(at("ref", 0.5)).toEqual(at("ref", 1));
    expect(s.impact).toEqual([89, 32]);
  });

  it("penalties: the referee holds one spot beside the box through setup, run-up, strike and result — never on the ball path, in the goal mouth or on the spot", () => {
    const pens = all.filter((e) => ["penalty_setup", "shootout_setup", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork", "shootout_kick", "shootout_end"].includes(e.t));
    expect(pens.length).toBeGreaterThan(30);
    for (const e of pens) {
      const s = sceneFor(e, [50, 32], 15000)!;
      const ref = s.actors.find((a) => a.side === "ref")!;
      expect(ref, `${e.t} #${e.seq}`).toBeTruthy();
      const g = e.t.startsWith("shootout") ? "home" : e.side!;
      const spot = penRefSpot(g);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) expect(sample(ref.path, t), `${e.t} #${e.seq} t=${t}`).toEqual(spot);
      const line = g === "home" ? 100 : 0;
      const penSpot = g === "home" ? 89 : 11;
      expect(Math.abs(spot[1] - 32)).toBeGreaterThanOrEqual(8); // off the spot→goal line and the mouth (y 28..36)
      expect(Math.abs(spot[0] - line)).toBeGreaterThanOrEqual(12); // not in the goal area
      expect(Math.hypot(spot[0] - penSpot, spot[1] - 32)).toBeGreaterThan(9); // clear of the spot and the run-up
      // Inside the penalty camera, so he is seen holding still rather than popping in and out.
      const [cx, cy, cw, ch] = s.cam!;
      expect(spot[0] > cx + 2 && spot[0] < cx + cw - 2 && spot[1] > cy + 2 && spot[1] < cy + ch - 2, `${e.t} in cam`).toBe(true);
      // Ball never comes within 4 of him.
      for (let t = 0; t <= 1.0001; t += 0.02) expect(Math.hypot(...(sample(s.ball, t).map((v, i) => v - spot[i]) as [number, number])), `${e.t} #${e.seq} ball`).toBeGreaterThan(4);
    }
    // The award runs him in to point to the spot, then he backs off to that same spot before the walk-up.
    const award = all.find((e) => e.t === "penalty_awarded")!;
    const a = sceneFor(award, [50, 32], 15000)!;
    const ref = a.actors.find((x) => x.side === "ref")!;
    expect(sample(ref.path, 1)).toEqual(penRefSpot(award.side!));
    expect(Math.hypot(...(sample(ref.path, 0.57).map((v, i) => v - a.impact![i]) as [number, number]))).toBeLessThan(6); // pointing at the spot
  });

  it("result badges are concrete: blocks flash BLOCKED, wide misses WIDE, high ones OVER; in-match and shootout alike", () => {
    const flashes = new Map<string, Set<string>>();
    for (const e of all) {
      const s = sceneFor(e, [70, 32], 15000);
      if (!s?.flash) continue;
      if (!flashes.has(e.t)) flashes.set(e.t, new Set());
      flashes.get(e.t)!.add(s.flash);
    }
    expect(flashes.get("block")).toEqual(new Set(["block"]));
    expect(flashes.get("miss")).toEqual(new Set(["miss", "over"]));
    expect(flashes.get("save")).toEqual(new Set(["save"]));
    expect(flashes.get("woodwork")).toEqual(new Set(["wood"]));
    const so = flashes.get("shootout_kick")!;
    expect(so.has("goal") && so.has("save") && so.has("miss")).toBe(true);
    for (const f of so) expect(["goal", "save", "miss", "over", "wood"]).toContain(f);
    for (const e of all.filter((e) => e.t === "miss")) expect(sceneFor(e, [70, 32], 15000)!.flash).toBe((e as MatchEvent & { high?: number }).high ? "over" : "miss");
  });

  it("failed attacks resolve possession on screen: the blocker ends on the loose ball, the keeper ends with a save or a woodwork rebound", () => {
    let n = 0;
    for (const e of all) {
      if (!["block", "save", "woodwork"].includes(e.t)) continue;
      const s = sceneFor(e, [70, 32], 15000)!;
      const who = e.t === "block" ? s.actors.find((a) => a.id === "b")! : s.actors.find((a) => a.keeper)!;
      const [bx, by] = end(s);
      const [px, py] = sample(who.path, 1);
      expect(Math.hypot(bx - px, by - py), `${e.t} #${e.seq}`).toBeLessThan(1.5);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });

  it("a turnover that starts deep in the other team's half is shown as a clearance collected in midfield, never an attacker standing in the keeper's hands", () => {
    let n = 0;
    let plain = 0;
    for (const m of matches) {
      let bs: string | null = "home";
      for (const e of m) {
        const s = sceneFor(e, (e.from as Pt) ?? [50, 32], 15000);
        // The engine's flag matches an independent possession trace: a side's first touch after the other side had the ball.
        if (e.t === "build_up" || (e.t === "pass" && !e.chain && m[m.indexOf(e) - 1]?.t !== "pass")) expect(!!e.turn, `${e.t} #${e.seq}`).toBe(!!bs && bs !== e.side);
        if (e.ball && e.side && !["foul", "yellow_card", "red_card", "shot", "penalty_awarded", "penalty_setup", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork", "goal", "celebration"].includes(e.t)) bs = ["miss", "woodwork"].includes(e.t) ? (e.side === "home" ? "away" : "home") : e.side;
        if (e.t === "restart") bs = e.side!;
        if (["kickoff"].includes(e.t)) bs = "home";
        if (["second_half", "extra_time", "et_second_half"].includes(e.t)) bs = null;
        if (!s || !e.turn) continue;
        const dx = (e.side === "home" ? 1 : -1) * (e.ball![0] - e.from![0]);
        const clear = s.actors.find((a) => a.id === "clear");
        if (dx >= -12) {
          expect(clear).toBeUndefined();
          plain++;
          continue;
        }
        n++;
        expect(clear, `${e.t} #${e.seq}`).toBeTruthy();
        expect(clear!.side).not.toBe(e.side);
        expect(clear!.path[0]).toEqual(e.from); // the opponent is on the ball where it was left
        const inBox = e.side === "home" ? e.from![0] >= 85 : e.from![0] <= 15;
        expect(!!clear!.keeper).toBe(inBox);
        const p = s.actors.find((a) => a.id === "p")!;
        expect(Math.hypot(...(sample(p.path, 1).map((v, i) => v - lerp(e.from!, e.ball!, 0.55)[i]) as [number, number]))).toBeLessThan(3); // the passer collects in midfield
        expect(sampleN(s.ballHeight, 0.3)).toBeGreaterThan(0.3); // the clearance is lofted
        expect(end(s)).toEqual(e.ball);
      }
    }
    expect(n).toBeGreaterThan(50);
    expect(plain).toBeGreaterThan(50);
  });

  it("the saving side's own distribution starts from the keeper's hands: his keeper launches it, never an outfielder standing on him", () => {
    let n = 0;
    for (const e of all) {
      if ((e.t !== "build_up" && e.t !== "pass") || e.turn || !e.from) continue;
      const own = e.side === "home" ? e.from[0] : 100 - e.from[0]; // distance of the ball from the passing side's own goal line
      if (own > 15) continue;
      n++;
      const s = sceneFor(e, e.from as Pt, 15000)!;
      const clear = s.actors.find((a) => a.id === "clear");
      expect(clear, `${e.t} #${e.seq}`).toBeTruthy();
      expect(clear!.side).toBe(e.side);
      expect(!!clear!.keeper).toBe(true);
      expect(clear!.path[0]).toEqual(e.from);
      for (const a of s.actors) if (a !== clear && a.side === e.side) expect(Math.hypot(a.path[0][0] - e.from[0], a.path[0][1] - e.from[1]), `${e.t} #${e.seq} ${a.id}`).toBeGreaterThan(3);
      expect(end(s)).toEqual(e.ball);
    }
    expect(n).toBeGreaterThan(50);
  });

  it("long dribbles are carried as authored by the engine (no client or engine re-routing): the carrier runs the whole progression with the ball", () => {
    // The engine's progression distances are base behaviour (pinned seed-for-seed in engine.test.ts); pace is a client
    // concern, so a long carry must still be the same player taking the ball from `from` to `ball`, not a through ball.
    const runs = all.filter((e) => e.t === "dribble");
    expect(runs.length).toBeGreaterThan(20);
    const long = runs.filter((e) => Math.hypot(e.ball![0] - e.from![0], e.ball![1] - e.from![1]) > 24);
    expect(long.length, "base engine produces carries over 24 units; this must not be converted away").toBeGreaterThan(0);
    for (const e of long) {
      expect(e.p2, `dribble #${e.seq}`).toBe(e.p);
      const s = sceneFor(e, e.from as Pt, 15000)!;
      const carrier = s.actors.find((a) => a.id === "p")!;
      expect(carrier.path[0]).toEqual(e.from);
      expect(carrier.path[carrier.path.length - 1]).toEqual(e.ball);
      expect(end(s)).toEqual(e.ball);
    }
  });

  it("a period restart kicks off from the centre: the first move of the half starts there, not where the last one died", () => {
    for (const m of matches)
      m.forEach((e, i) => {
        if (!["second_half", "extra_time", "et_second_half"].includes(e.t)) return;
        const next = m.slice(i + 1).find((x) => x.from);
        expect(next?.from, `${e.t} #${e.seq}`).toEqual([50, 32]);
      });
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

  it("period markers get a banner-life scene whatever the pace — breaks last the engine's real break; the ball stays where it was", () => {
    const life: Record<string, number> = { half_time: 30000, end_of_normal_time: 20000, et_half_time: 10000, second_half: 3000, extra_time: 3000, et_second_half: 3000, shootout_start: 10000 }; // balance.js halfTimeMs / etBreakMs / etHalfTimeMs / shootoutIntroMs
    for (const t of Object.keys(life)) {
      const e = all.find((e) => e.t === t);
      if (!e) continue; // not every seed goes the distance
      const s = sceneFor(e, [20, 30], 1000)!;
      expect(s.ms, t).toBe(life[t]);
      expect(sceneFor(e, [20, 30], 15000)!.ms, t).toBe(life[t]);
      expect(s.ball[0], t).toEqual([20, 30]);
      expect(s.score, t).toEqual(e.st.sc);
    }
    expect(sceneFor(all.find((e) => e.t === "half_time")!, [20, 30], 15000)!.actors).toEqual([]);
  });

  it("period restarts are kickoff scenes (3 s banner life): ball to the centre spot, the taker on it, both sides lined up", () => {
    for (const t of ["second_half", "extra_time", "et_second_half"]) {
      const e = all.find((e) => e.t === t);
      if (!e) continue;
      const s = sceneFor(e, [20, 30], 1000)!;
      expect(s.ms, t).toBe(3000);
      expect(end(s), t).toEqual([50, 32]);
      expect(s.actors.length, t).toBeGreaterThanOrEqual(3);
      expect(Math.hypot(...(sample(s.actors[0].path, 0.5).map((v, i) => v - [50, 32][i]) as [number, number])), t).toBeLessThan(1);
    }
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
