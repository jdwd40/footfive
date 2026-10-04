import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sceneFor, short, type Pt, type Scene } from "./scenes";
import { frameAt, playhead, reveal, sentOffAt, settle, smooth, type Frame } from "./sim";
import type { LineupPlayer, MatchEvent } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type EnginePlayer = { name: string; role: string; is_starter: boolean };
function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) as EnginePlayer[] };
}
function lineup(players: EnginePlayer[]): LineupPlayer[] {
  return players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
}

/** Ten full simulated matches with their frozen lineups. */
function matches(n = 10) {
  const out: Array<{ events: MatchEvent[]; lineups: { home: LineupPlayer[]; away: LineupPlayer[] } }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "f" + i, seed: 1000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(1000, 1) });
    out.push({ events: eng.advanceTo(st, 1e12), lineups: { home: lineup(home.players), away: lineup(away.players) } });
  }
  return out;
}

const idle = (e: MatchEvent, ball: Pt): Scene => ({ key: `${e.seq}`, seq: e.seq, type: e.t, ms: 0, ball: [ball], actors: [], caption: e.text });

describe("frameAt", () => {
  const ms = matches();
  const TS = [0, 0.5, 1];

  it("every frame has exactly 10 players, one keeper per side; inside the pitch except on the tunnel walk at a break or restart", () => {
    const tunnel = new Set(["kickoff", "second_half", "extra_time", "et_second_half", "half_time", "end_of_normal_time", "et_half_time", "match_end"]);
    for (const m of ms) {
      let prev: Pt = [50, 32];
      for (const e of m.events) {
        const s = sceneFor(e, prev, 15000) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        for (const t of TS) {
          const f = frameAt(s, t, m.lineups);
          const bad = tunnel.has(e.t) ? [] : f.players.filter((p) => p.x < 0 || p.x > 100 || p.y < 0 || p.y > 64);
          const gks = [f.players.filter((p) => p.side === "home" && p.gk).length, f.players.filter((p) => p.side === "away" && p.gk).length];
          const home = f.players.filter((p) => p.side === "home").length;
          if (f.players.length !== 10 || bad.length || gks[0] !== 1 || gks[1] !== 1 || home !== 5) {
            expect.fail(`${e.t} #${e.seq} t=${t}: ${f.players.length} players, ${bad.length} off-pitch, gks ${gks}, home ${home}`);
          }
        }
      }
    }
  });

  it("the scorer in a goal scene is the hot player riding the actor path", () => {
    let n = 0;
    for (const m of ms) {
      let prev: Pt = [50, 32];
      for (const e of m.events) {
        const s = sceneFor(e, prev, 15000) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        if (e.t !== "goal") continue;
        const scorer = s.actors.find((a) => a.id === "s")!;
        for (const t of TS) {
          const f = frameAt(s, t, m.lineups);
          const hot = f.players.find((p) => p.side === e.side && short(p.name) === scorer.label);
          expect(hot, `${e.text}`).toBeTruthy();
          expect(hot!.hot).toBe(true);
          const [x, y] = sample(scorer.path, t);
          expect(Math.hypot(hot!.x - x, hot!.y - y)).toBeLessThan(2);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it("an unlabelled actor stays bound to the same player for the scene's whole life", () => {
    const m = ms[0];
    // Tackle whose unlabelled winner sweeps from the home left-back's spot to the right-forward's: nearest-at-t would swap players.
    const s: Scene = { key: "bind-1", seq: 9001, type: "tackle", ms: 1600, ball: [[20, 20], [42, 40]], actors: [{ id: "win", side: "home", path: [[20, 20], [30, 30], [42, 40]] }], caption: "" };
    const who = (t: number) => {
      const hot = frameAt(s, t, m.lineups).players.filter((p) => p.hot);
      expect(hot).toHaveLength(1);
      return hot[0].side + ":" + hot[0].no;
    };
    const k0 = who(0);
    expect(who(0.5)).toBe(k0);
    expect(who(1)).toBe(k0);
    // Same path, fresh key: nearest at t=0 is the player formation-nearest to [20,20] (the left-back).
    expect(frameAt({ ...s, key: "bind-2" }, 1, m.lineups).players.find((p) => p.hot)!.no).toBe(frameAt({ ...s, key: "bind-3" }, 0, m.lineups).players.find((p) => p.hot)!.no);
    // A different scene with the same key (same seq, other fixture) binds on its own.
    const other: Scene = { ...s, actors: [{ id: "x", side: "away", path: [[80, 44]] }] };
    expect(frameAt(other, 0.5, m.lineups).players.filter((p) => p.hot).map((p) => p.side)).toEqual(["away"]);
  });

  it("goal: scorer ends at the corner with two teammates, defenders back off to the centre; restart resets everyone", () => {
    let n = 0;
    for (const m of ms) {
      let prev: Pt = [50, 32];
      const evs = m.events;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        const s = sceneFor(e, prev, 15000) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        if (e.t !== "goal") continue;
        n++;
        const f = frameAt(s, 1, m.lineups);
        const def = e.side === "home" ? "away" : "home";
        const cornerX = e.side === "home" ? 100 : 0;
        const hot = f.players.filter((p) => p.hot && p.side === e.side);
        expect(hot, `${e.text}`).toHaveLength(3);
        for (const p of hot) {
          expect(Math.abs(p.x - cornerX)).toBeLessThan(14);
          expect(Math.min(Math.abs(p.y - 5), Math.abs(p.y - 59))).toBeLessThan(6);
        }
        // Defenders stand where they would with the ball on the centre spot (the restart layout).
        const centre = frameAt(idle({ ...e, t: "restart" }, [50, 32]), 1, m.lineups);
        for (const p of f.players.filter((q) => q.side === def && !q.hot)) {
          const c = centre.players.find((q) => q.side === p.side && q.no === p.no)!;
          expect([p.x, p.y]).toEqual([c.x, c.y]);
        }
        // Celebration keeps the huddle; the restarting side walks the ball from the net to the centre.
        const cel = sceneFor(evs[i + 1], prev, 15000)!;
        expect(cel.type).toBe("celebration");
        const huddle = frameAt(cel, 0.5, m.lineups).players.filter((p) => p.hot);
        expect(huddle).toHaveLength(3);
        expect(Math.max(...huddle.map((p) => Math.hypot(p.x - huddle[0].x, p.y - huddle[0].y)))).toBeLessThan(8);
        const rs = sceneFor(evs[i + 2], cel.ball[cel.ball.length - 1], 15000)!;
        expect(rs.type).toBe("restart");
        expect(rs.actors.map((a) => a.side)).toEqual([def]);
        expect(rs.ball[0]).toEqual(cel.ball[cel.ball.length - 1]);
        expect(rs.ball[rs.ball.length - 1]).toEqual([50, 32]);
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it("penalty setup: the other eight line the edge of the D, alternating sides", () => {
    const m = ms.find((x) => x.events.some((e) => e.t === "shootout_setup"))!;
    const e = m.events.find((e) => e.t === "shootout_setup")!;
    const s = sceneFor(e, [50, 32], 15000)!;
    const f = frameAt(s, 0.5, m.lineups);
    const arc = f.players.filter((p) => !p.hot).sort((a, b) => a.y - b.y);
    expect(arc).toHaveLength(8);
    for (const p of arc) expect(Math.abs(p.x - 80)).toBeLessThan(8);
    for (let i = 1; i < arc.length; i++) expect(arc[i].side).not.toBe(arc[i - 1].side);
    expect(f.cam).toEqual([48, 32 - (56 * 77) / 108 / 2, 56, (56 * 77) / 108]);
    expect(frameAt(idle(e, [50, 32]), 0, m.lineups).cam).toEqual([-4, -3, 108, 77]);
  });

  it("breathes once the scene is over: players and ball drift a little with time, never when mid-scene", () => {
    const m = ms[0];
    const s = sceneFor(m.events[5], [50, 32], 15000) ?? idle(m.events[5], [50, 32]);
    const a = frameAt(s, 1, m.lineups, undefined, 0);
    const b = frameAt(s, 1, m.lineups, undefined, 628); // sin(π/2)
    const moved = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(moved({ x: a.ball[0], y: a.ball[1] }, { x: b.ball[0], y: b.ball[1] })).toBeGreaterThan(0.2);
    a.players.forEach((p, i) => {
      const d = moved(p, b.players[i]);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(0.6);
    });
    const c = frameAt(s, 0.5, m.lineups, undefined, 0);
    const e = frameAt(s, 0.5, m.lineups, undefined, 628);
    expect(e.players.map((p) => [p.x, p.y])).toEqual(c.players.map((p) => [p.x, p.y]));
  });

  it("dwells after a routine scene: the ball carrier jogs on with a teammate in tow; result scenes hold", () => {
    const m = ms[0];
    const pass = m.events.find((e) => e.t === "pass")!;
    const s = sceneFor(pass, [50, 32], 15000)!;
    const end = frameAt(s, 1, m.lineups);
    const later = frameAt(s, 1 + 2000 / s.ms, m.lineups);
    const d = Math.hypot(later.ball[0] - end.ball[0], later.ball[1] - end.ball[1]);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(10);
    expect(Math.sign(later.ball[0] - end.ball[0])).toBe(pass.side === "home" ? 1 : -1);
    // Carrier on the ball, a teammate within reach behind him; ball never leaves the pitch.
    const carrier = later.players.filter((p) => p.side === pass.side && Math.hypot(p.x - later.ball[0], p.y - later.ball[1]) < 1.5);
    expect(carrier).toHaveLength(1);
    expect(later.players.some((p) => p.side === pass.side && p !== carrier[0] && Math.hypot(p.x - later.ball[0], p.y - later.ball[1]) < 7)).toBe(true);
    // A long gap: still jogging (never a wall-hug), turning 12 short of EITHER goal line, so possession never retreats to his own line.
    const far = frameAt(s, 1 + 60000 / s.ms, m.lineups);
    const farther = frameAt(s, 1 + 61000 / s.ms, m.lineups);
    expect(Math.hypot(farther.ball[0] - far.ball[0], farther.ball[1] - far.ball[1])).toBeGreaterThan(1);
    const xs: number[] = [];
    for (let sec = 2; sec <= 90; sec += 2) {
      const f = frameAt(s, 1 + (sec * 1000) / s.ms, m.lineups);
      xs.push(f.ball[0]);
      expect(f.ball[0]).toBeGreaterThanOrEqual(Math.min(12, end.ball[0]));
      expect(f.ball[0]).toBeLessThanOrEqual(Math.max(88, end.ball[0]));
      expect(f.players.filter((p) => p.side === pass.side && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) < 1.5)).toHaveLength(1);
    }
    expect(Math.min(...xs)).toBeLessThan(20); // 90 s at 3 u/s covers the pitch: he reached both turning lines
    expect(Math.max(...xs)).toBeGreaterThan(80);
    // A goal keeps its final frame (plus breathing only).
    const goal = m.events.find((e) => e.t === "goal")!;
    const g = sceneFor(goal, [80, 30], 15000)!;
    expect(frameAt(g, 1 + 2000 / g.ms, m.lineups).ball).toEqual(frameAt(g, 1, m.lineups).ball);
  });

  it("the next scene starts from the dwell endpoint, not its authored first keyframe", () => {
    const m = ms[0];
    const i = m.events.findIndex((e, k) => e.t === "pass" && !!sceneFor(m.events[k + 1], [50, 32], 15000));
    const pass = m.events[i];
    const s = sceneFor(pass, [50, 32], 15000)!;
    const dwellEnd = frameAt(s, 1 + 3000 / s.ms, m.lineups).ball;
    const next = sceneFor(m.events[i + 1], s.ball[s.ball.length - 1], 15000)!;
    expect(dwellEnd).not.toEqual(next.ball[0]);
    const f = frameAt(next, 0, m.lineups, undefined, 0, dwellEnd);
    expect(f.ball).toEqual(dwellEnd);
    // The destination is untouched: the authored end (and the shared scene object) stands.
    const a = frameAt(next, 1, m.lineups, undefined, 0, dwellEnd).ball;
    const b = frameAt(next, 1, m.lineups).ball;
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
    expect(frameAt(next, 0, m.lineups).ball).toEqual(next.ball[0]);
  });

  it("a scene started off its authored path heads straight for its destination, never back via the old path", () => {
    const m = ms[0];
    // Straight pass 30→60 along y=32; the previous dwell carried the ball on to x=50, past the authored start.
    const s: Scene = { key: "off-1", seq: 9002, type: "pass", ms: 1500, ball: [[30, 32], [45, 32], [60, 32]], actors: [{ id: "p", side: "home", path: [[29, 32], [30, 32], [33, 32]] }], caption: "" };
    const start: Pt = [50, 32];
    expect(frameAt(s, 0, m.lineups, undefined, 0, start).ball).toEqual(start);
    expect(frameAt(s, 1, m.lineups, undefined, 0, start).ball[0]).toBeCloseTo(60, 2);
    let last = start[0];
    for (let t = 0.05; t <= 1; t += 0.05) {
      const x = frameAt(s, t, m.lineups, undefined, 0, start).ball[0];
      expect(x, `t=${t}`).toBeGreaterThanOrEqual(last);
      last = x;
    }
    // The carrier starts on the moved ball and his path blends back onto the authored one too.
    const p0 = frameAt(s, 0, m.lineups, undefined, 0, start).players.find((p) => p.hot)!;
    expect(Math.hypot(p0.x - start[0], p0.y - start[1])).toBeLessThan(1.5);
    // Clamping respects keyframes authored off the pitch (a goal's net): an outward offset never pushes past them.
    const g: Scene = { ...s, key: "off-2", type: "goal", flash: "goal", ball: [[80, 32], [100, 32], [102, 32], [102, 32], [102, 32]], actors: [], impact: [102, 32] };
    for (let t = 0; t <= 1; t += 0.05) expect(frameAt(g, t, m.lineups, undefined, 0, [90, 34]).ball[0]).toBeLessThanOrEqual(102);
    expect(frameAt(g, 1, m.lineups, undefined, 0, [90, 34]).ball[0]).toBeCloseTo(102, 3);
  });

  it("a result badge lingers 2.5 s into the next routine scene: SAVED!, WOODWORK, shootout reveals — not match goals (banner) or cards (own text)", () => {
    const m = ms[0];
    const save = m.events.find((e) => e.t === "save")!;
    const sv = sceneFor(save, [70, 30], 15000)!;
    const pass: Scene = { key: "l-1", seq: save.seq + 1, type: "pass", ms: 1500, ball: [sv.ball[sv.ball.length - 1], [50, 32], [60, 32]], actors: [], caption: "" };
    const at = (elapsed: number, prev?: Scene) => frameAt(pass, elapsed / pass.ms, m.lineups, undefined, 0, undefined, prev).flash;
    // Its own scene never drops it, however late the next event lands.
    expect(frameAt(sv, 1 + 2000 / sv.ms, m.lineups).flash).toBe("save");
    expect(at(0, sv)).toBe("save");
    expect(at(2400, sv)).toBe("save"); // past the 1.5 s pass's own end: the window is real ms, not scene progress
    expect(at(2500, sv)).toBeNull();
    expect(at(0)).toBeNull();
    expect(at(0, { ...sv, flash: "wood" })).toBe("wood");
    expect(at(0, { ...sv, type: "shootout_kick", flash: "goal" })).toBe("goal");
    expect(at(0, { ...sv, type: "celebration", flash: "goal" })).toBeNull();
    expect(at(0, { ...sv, type: "red_card", flash: "card" })).toBeNull();
    // A scene with its own result never borrows one.
    expect(frameAt(sv, 0, m.lineups, undefined, 0, undefined, { ...sv, flash: "wood" }).flash).toBe("save");
  });

  it("the referee rides his actor path as Frame.ref; without one he trails ten behind the ball on the far side", () => {
    const m = ms[0];
    const foul = m.events.find((e) => e.t === "foul")!;
    const s = sceneFor(foul, [50, 32], 15000)!;
    const refPath = s.actors.find((a) => a.side === "ref")!.path;
    expect(frameAt(s, 0, m.lineups).ref).toEqual(sample(refPath, 0));
    expect(frameAt(s, 1, m.lineups).ref).toEqual(sample(refPath, 1));
    expect(frameAt(s, 0.5, m.lineups).players).toHaveLength(10); // never drawn as a player
    const pass: Scene = { key: "p", seq: 2, type: "pass", ms: 1200, ball: [[40, 20], [60, 20]], actors: [], caption: "", side: "home" };
    const f = frameAt(pass, 0.5, m.lineups);
    expect(f.ref[0]).toBeCloseTo(f.ball[0] - 10, 5);
    expect(f.ref[1]).toBeCloseTo(f.ball[1] + 14, 5);
    const away = frameAt({ ...pass, side: "away", ball: [[60, 50], [40, 50]] }, 0.5, m.lineups);
    expect(away.ref[0]).toBeCloseTo(away.ball[0] + 10, 5);
    expect(away.ref[1]).toBeCloseTo(away.ball[1] - 14, 5);
    const edge = frameAt({ ...pass, ball: [[3, 3], [3, 3]] }, 0.5, m.lineups).ref;
    expect(edge[0]).toBeGreaterThanOrEqual(0);
    expect(edge[1]).toBeLessThanOrEqual(64);
  });

  it("skips sent-off players and survives missing lineups", () => {
    const m = ms[0];
    const e = m.events[5];
    const s = sceneFor(e, [50, 32], 15000) ?? idle(e, [50, 32]);
    const off = m.lineups.home.filter((p) => p.starter && p.role !== "gk")[0];
    const f = frameAt(s, 0.5, m.lineups, new Set(["home:" + off.name]));
    expect(f.players).toHaveLength(9);
    expect(f.players.some((p) => p.name === off.name)).toBe(false);
    expect(frameAt(s, 0.5, null).players).toHaveLength(0);
  });

  it("teams (and the ref) walk off to the tunnel over a break's first 6 s and stay off; they walk on over a restart's first 4 s", () => {
    const m = ms[0];
    const at = (type: string, elapsed: number) => {
      const e = { ...(m.events.find((e) => e.t === type) ?? m.events.find((e) => e.t === "kickoff")!), t: type }; // not every seed goes to extra time
      const s = sceneFor(e, [30, 20], 15000)!;
      return frameAt(s, elapsed / s.ms, m.lineups, undefined, 1000);
    };
    const ys = (f: Frame) => [...f.players.map((p) => p.y), f.ref[1]];
    for (const type of ["half_time", "end_of_normal_time", "et_half_time", "match_end"]) {
      const a = ys(at(type, 0));
      expect(a.every((y) => y <= 64), type).toBe(true);
      expect(ys(at(type, 3000)).every((y, i) => y > a[i] && y < 70), type).toBe(true); // on the way
      expect(ys(at(type, 6000)).every((y) => y > 64), type).toBe(true);
      expect(ys(at(type, 90000)).every((y) => y > 64), type).toBe(true); // full time: still off while finished
    }
    for (const type of ["kickoff", "second_half", "extra_time", "et_second_half"]) {
      expect(ys(at(type, 0)).every((y) => y > 64), type).toBe(true);
      expect(ys(at(type, 4000)).every((y) => y <= 64), type).toBe(true);
      expect(at(type, 4000).players).toHaveLength(10);
    }
    expect(at("kickoff", 0).players.every((p) => Math.abs(p.x - 50) < 1e-6)).toBe(true); // tunnel at [50, 70]
    // Restarts and routine play are untouched.
    expect(ys(at("restart", 0)).every((y) => y <= 64)).toBe(true);
    expect(ys(at("pass", 0)).every((y) => y <= 64)).toBe(true);
  });

  it("shootout intro (10 s): everyone to the centre circle, a huddle at half-way, then the keepers to the shootout end and the rest to the halfway line; camera full then penalty", () => {
    const m = ms.find((x) => x.events.some((e) => e.t === "shootout_start")) ?? ms[0];
    const e = { ...(m.events.find((e) => e.t === "shootout_start") ?? m.events.find((e) => e.t === "kickoff")!), t: "shootout_start", side: "away" as const };
    const s = sceneFor(e, [30, 20], 1000)!;
    expect(s.ms).toBe(10000);
    const at = (p: number) => frameAt(s, p, m.lineups, undefined, 1000);
    const start = at(0);
    expect(start.players.filter((p) => p.gk).every((p) => p.x < 10 || p.x > 90)).toBe(true); // keepers start on their own lines
    expect(start.cam).toEqual([-4, -3, 108, 77]);
    const mid = at(0.5);
    expect(mid.players).toHaveLength(10);
    for (const p of mid.players) expect(Math.hypot(p.x - 50, p.y - 32)).toBeLessThan(10);
    expect(mid.cam).toEqual([-4, -3, 108, 77]);
    const end = at(1);
    for (const p of end.players.filter((p) => p.gk)) expect(p.x).toBeGreaterThanOrEqual(90);
    expect(end.players.find((p) => p.gk && p.side === "home")!.y).toBeCloseTo(32, 3); // away kick first: the home keeper takes the line
    for (const p of end.players.filter((p) => !p.gk)) expect(Math.abs(p.x - 50)).toBeLessThan(4);
    expect(end.cam).not.toEqual([-4, -3, 108, 77]);
    expect(end.ref).toEqual([89, 32]);
    expect(at(1.5).players.map((p) => [p.x, p.y])).toEqual(end.players.map((p) => [p.x, p.y])); // holds while the setup is awaited
  });
});

describe("smooth", () => {
  const at = (x: number): Frame => ({ ball: [x, 32], lift: 0, players: [{ side: "home", name: "A", no: 7, gk: false, x, y: 32, hot: false }], ref: [x, 20], caption: "", flash: null, type: "pass", seq: 1, p: 0, ms: 1500, cam: [-4, -3, 108, 77] });
  it("players chase a jumped target instead of snapping, and settle on it", () => {
    let s = smooth(null, at(10), 16);
    expect(s.players[0].x).toBe(10); // first frame: nothing to chase from
    s = smooth(s, at(60), 16);
    expect(s.players[0].x - 10).toBeGreaterThan(0);
    expect(s.players[0].x - 10).toBeLessThan(2);
    // 60 units/s cap needs ≥ 833 ms for a 50-unit jump: 40 frames at 50 ms.
    for (let i = 0; i < 40; i++) s = smooth(s, at(60), 50);
    expect(Math.abs(s.players[0].x - 60)).toBeLessThan(0.5);
  });
  it("the ball is uncapped and new players take their target directly", () => {
    const s = smooth(at(10), { ...at(60), players: [{ side: "away", name: "B", no: 3, gk: false, x: 90, y: 10, hot: false }] }, 100);
    expect(s.ball[0]).toBeGreaterThan(40);
    expect(s.players[0]).toMatchObject({ no: 3, x: 90, y: 10 });
  });
  it("the camera glides", () => {
    const s = smooth({ ...at(10), cam: [-4, -3, 108, 77] }, { ...at(10), cam: [63, 16, 50, 32] }, 100);
    expect(s.cam[0]).toBeGreaterThan(-4);
    expect(s.cam[0]).toBeLessThan(20);
  });
  it("the referee jogs after his target — eased over 350 ms, never faster than 40 u/s — so entering or leaving a scene is a run, not a pop", () => {
    const s = smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [60, 10] }, 100);
    expect(s.ref[0]).toBeGreaterThan(12);
    expect(s.ref[0]).toBeLessThanOrEqual(14); // 40 u/s cap: 4 per 100 ms
    const tick = smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [60, 10] }, 16);
    expect(Math.hypot(tick.ref[0] - 10, tick.ref[1] - 10)).toBeLessThan(2);
  });
  it("a tick after a long gap (suspended tab) snaps to the target instead of chasing from stale positions", () => {
    expect(smooth(at(10), at(60), 1500)).toEqual(at(60));
    expect(smooth(at(10), at(60), 1000).players[0].x).toBeLessThan(60); // up to a second: still a (fast) chase
  });
});

describe("reveal", () => {
  const goal: Scene = { key: "g", seq: 5, type: "goal", ms: 3800, ball: [[80, 30], [100, 32], [102, 32], [102, 32], [102, 32]], actors: [], caption: "", flash: "goal", impact: [102, 32] };
  it("waits for the flash moment and for the displayed ball to reach the impact point, then latches", () => {
    expect(reveal(goal, 0.8, [92, 32], false)).toEqual({ reached: false, revealed: false }); // ball still short of the net
    expect(reveal(goal, 0.3, [102, 32], false)).toEqual({ reached: true, revealed: false }); // in the net, but the scene says not yet
    expect(reveal(goal, 0.8, [101, 31], false)).toEqual({ reached: true, revealed: true });
    expect(reveal(goal, 0.9, [60, 20], true)).toEqual({ reached: true, revealed: true }); // once reached, stays revealed
    expect(reveal({ ...goal, flashAt: 0.75 }, 0.7, [102, 32], true).revealed).toBe(false);
  });
  it("scenes without a result have nothing to hide", () => {
    expect(reveal({ ...goal, flash: null, impact: undefined }, 0, [10, 10], false).revealed).toBe(true);
  });
  it("a late join that first draws the ball past the impact counts as reached; a finished scene with the ball still short does not", () => {
    expect(reveal(goal, 0.8, [104, 33], false)).toEqual({ reached: true, revealed: true }); // beyond the net along the shot
    expect(reveal(goal, 0.8, [95, 40], false).reached).toBe(false); // short of it, off to the side: still travelling
    expect(reveal(goal, 1, [82, 32], false)).toEqual({ reached: false, revealed: false }); // late result event, drawn ball 20 short: the shot is still on its way
  });
  it("settle puts the drawn ball on the impact once the scene is over, so reveal follows next tick; never once reached", () => {
    const f: Frame = { ball: [82, 32], lift: 0, players: [], ref: [70, 20], caption: "", flash: "goal", type: "goal", seq: 5, p: 1, ms: 3800, cam: [-4, -3, 108, 77] };
    const s = settle(goal, 1, f, false);
    expect(s.ball).toEqual([102, 32]);
    expect(s.ref).toEqual([70, 20]); // only the ball snaps
    expect(reveal(goal, 1, s.ball, false)).toEqual({ reached: true, revealed: true });
    expect(settle(goal, 0.9, f, false).ball).toEqual([82, 32]); // still playing: chase as usual
    expect(settle(goal, 1, f, true).ball).toEqual([82, 32]); // already arrived: the ball is on its way out, leave it
    expect(settle({ ...goal, impact: undefined }, 1, f, false).ball).toEqual([82, 32]);
  });
});

describe("sentOffAt", () => {
  const ev = (seq: number, t: string, side?: "home" | "away", p?: string) => ({ seq, at: seq * 1000, t, min: 1, side, p, text: "", st: {} as MatchEvent["st"] }) as MatchEvent;
  const evs = [ev(1, "pass"), ev(2, "red_card", "home", "Ann"), ev(3, "pass"), ev(4, "red_card", "away", "Bo")];
  it("lists the players sent off by events up to seq (inclusive)", () => {
    expect(sentOffAt(evs, 1)).toEqual(new Set());
    expect(sentOffAt(evs, 2)).toEqual(new Set(["home:Ann"]));
    expect(sentOffAt(evs, 3)).toEqual(new Set(["home:Ann"]));
    expect(sentOffAt(evs, 99)).toEqual(new Set(["home:Ann", "away:Bo"]));
  });
});

describe("playhead", () => {
  const ev = (seq: number, at: number) => ({ seq, at, t: "pass", min: 1, text: `e${seq}`, st: {} as MatchEvent["st"] }) as MatchEvent;
  const evs = [ev(1, 1000), ev(2, 2000), ev(3, 2100), ev(4, 6000)];
  it("picks the last event at or before t, with its predecessor and the time elapsed since it", () => {
    expect(playhead(evs, 500)).toBeNull();
    expect(playhead(evs, 1500)).toEqual({ cur: evs[0], prev: undefined, elapsed: 500 });
    expect(playhead(evs, 2050)).toEqual({ cur: evs[1], prev: evs[0], elapsed: 50 });
    expect(playhead(evs, 99999)).toEqual({ cur: evs[3], prev: evs[2], elapsed: 93999 });
  });
  it("a later event arriving never changes progress through the current one", () => {
    const before = playhead(evs, 7250)!;
    const after = playhead([...evs, ev(5, 7300)], 7250)!;
    expect(after.cur).toBe(before.cur);
    expect(after.elapsed).toBe(1250);
    expect(before.elapsed).toBe(1250);
  });
});
