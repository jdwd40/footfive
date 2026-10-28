import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sceneFor, short, type Pt, type Scene } from "./scenes";
import { DWELL_ADVANCE, DWELL_LINE, FWD_LEAD, FWD_WIDTH, GAP, WON_MS, frameAt, playhead, reveal, sentOffAt, settle, shapeAt, smooth, spaceOut, type Frame, type Player } from "./sim";
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

/** Ten full simulated matches with their frozen lineups (`minuteMs`: the engine's pace, for real gaps between events). */
function matches(n = 10, minuteMs = 1000) {
  const out: Array<{ events: MatchEvent[]; lineups: { home: LineupPlayer[]; away: LineupPlayer[] } }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "f" + i, seed: 1000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(minuteMs, 1) });
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

  it("drifts once the scene is over: players ease slowly with time, the ball stays put, nothing moves mid-scene (#106)", () => {
    const m = ms[0];
    const s = sceneFor(m.events[5], [50, 32], 15000) ?? idle(m.events[5], [50, 32]);
    const a = frameAt(s, 1, m.lineups, undefined, 0);
    const b = frameAt(s, 1, m.lineups, undefined, 1571); // sin(π/2) at IDLE_TAU
    const moved = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(b.ball).toEqual(a.ball);
    a.players.forEach((p, i) => {
      const d = moved(p, b.players[i]);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(1.4);
    });
    const c = frameAt(s, 0.5, m.lineups, undefined, 0);
    const e = frameAt(s, 0.5, m.lineups, undefined, 1571);
    expect(e.players.map((p) => [p.x, p.y])).toEqual(c.players.map((p) => [p.x, p.y]));
  });

  it("dwells after a routine scene: two teammates jog on passing the ball between them, an opponent closes down; result scenes hold", () => {
    const m = ms[0];
    // A midfield pass: the whole bounded advance fits before the line.
    const pass = m.events.find((e) => e.t === "pass" && e.ball && (e.side === "home" ? e.ball[0] : 100 - e.ball[0]) <= DWELL_LINE - DWELL_ADVANCE)!;
    const s = sceneFor(pass, [50, 32], 15000)!;
    const end = frameAt(s, 1, m.lineups);
    const fwd = (f: Frame) => (pass.side === "home" ? 1 : -1) * (f.ball[0] - end.ball[0]);
    // A jog on from the scene end (4.5 u/s as it starts) that eases off: forward only, and never past the bounded advance.
    expect(fwd(frameAt(s, 1 + 1000 / s.ms, m.lineups))).toBeGreaterThan(2);
    const later = frameAt(s, 1 + 2000 / s.ms, m.lineups);
    expect(fwd(later)).toBeGreaterThan(3.5);
    expect(fwd(later)).toBeLessThan(DWELL_ADVANCE);
    // Carrier on the ball, a teammate within reach in the other lane; ball never leaves the pitch.
    const carrier = later.players.filter((p) => p.side === pass.side && Math.hypot(p.x - later.ball[0], p.y - later.ball[1]) < 1.5);
    expect(carrier).toHaveLength(1);
    expect(carrier[0].hot).toBe(true);
    expect(later.players.some((p) => p.side === pass.side && p !== carrier[0] && Math.hypot(p.x - later.ball[0], p.y - later.ball[1]) < 7)).toBe(true);
    // The nearest opponent closes down: within 1.5 s he is four in front of the ball, and he stays on it.
    const def = (f: Frame) => f.players.filter((p) => p.side !== pass.side && !p.gk).map((p) => Math.hypot(p.x - f.ball[0], p.y - f.ball[1])).sort((a, b) => a - b)[0];
    expect(def(later)).toBeLessThan(4.5);
    expect(def(frameAt(s, 1 + 7000 / s.ms, m.lineups))).toBeLessThan(4.5);
    // Every 3 s the ball is laid off to the mate: the player on the ball changes, the ball moves forward, nobody teleports.
    const who = (ms: number) => {
      const f = frameAt(s, 1 + ms / s.ms, m.lineups);
      const on = f.players.filter((p) => p.side === pass.side && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) < 1.5);
      expect(on, `${ms} ms`).toHaveLength(1);
      return on[0].no;
    };
    expect(who(2400)).not.toBe(who(3100));
    expect(who(3100)).toBe(who(5400));
    expect(who(5400)).not.toBe(who(6100));
    expect(who(6100)).toBe(who(2400));
    for (let t = 2500; t <= 3000; t += 50) {
      const a = frameAt(s, 1 + t / s.ms, m.lineups);
      const b = frameAt(s, 1 + (t + 50) / s.ms, m.lineups);
      expect(Math.hypot(a.ball[0] - b.ball[0], a.ball[1] - b.ball[1])).toBeLessThan(2); // the lay-off travels, it doesn't jump
    }
    // A long gap (stale server): the advance is spent but the lay-offs go on, past the old 6 s freeze, without drifting any further.
    const owners = new Set<number>();
    for (let sec = 2; sec <= 60; sec += 2) {
      const f = frameAt(s, 1 + (sec * 1000 + 200) / s.ms, m.lineups); // +200: never inside a lay-off's 450 ms
      expect(fwd(f)).toBeGreaterThan(-1);
      expect(fwd(f)).toBeLessThanOrEqual(DWELL_ADVANCE + 0.6);
      const on = f.players.filter((p) => p.side === pass.side && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) < 1.5);
      expect(on).toHaveLength(1);
      if (sec > 6) owners.add(on[0].no);
    }
    expect(owners.size).toBe(2);
    // A goal keeps its final frame (plus breathing only).
    const goal = m.events.find((e) => e.t === "goal")!;
    const g = sceneFor(goal, [80, 30], 15000)!;
    expect(frameAt(g, 1 + 2000 / g.ms, m.lineups).ball).toEqual(frameAt(g, 1, m.lineups).ball);
  });

  it("bounds the dwell for both sides: however late the next event, the ball is carried on at most the advance, never past x70, and keeps circulating", () => {
    const sides = new Set<string>();
    for (const m of ms) {
      for (const e of m.events.filter((x) => x.t === "pass" || x.t === "dribble" || x.t === "build_up" || x.t === "tackle").slice(0, 8)) {
        const s = sceneFor(e, [50, 32], 15000);
        if (!s || s.flash || !s.side) continue;
        sides.add(s.side);
        const att = (x: number) => (s.side === "home" ? x : 100 - x);
        const end = frameAt(s, 1, m.lineups).ball;
        const line = Math.max(DWELL_LINE, att(end[0])) + 0.6; // a lay-off's receiver is 0.6 ahead of the carrier
        let prev: Pt | null = null;
        let still = 0;
        for (let t = 0; t <= 60000; t += 250) {
          const b = frameAt(s, 1 + t / s.ms, m.lineups).ball;
          const fwd = att(b[0]) - att(end[0]);
          expect(fwd, `${e.seq} @${t}`).toBeGreaterThanOrEqual(-0.6 - 1e-3); // never carried back (1e-3: sample() stops a hair short of the last keyframe)
          expect(fwd, `${e.seq} @${t}`).toBeLessThanOrEqual(DWELL_ADVANCE + 0.6 + 1e-3); // never accumulates
          expect(att(b[0]), `${e.seq} @${t}`).toBeLessThanOrEqual(line + 1e-3); // never on into the box
          expect(Math.abs(b[1] - end[1])).toBeLessThanOrEqual(6 + 1.2 + 1e-3); // the other lane plus the weave
          still = prev && Math.hypot(b[0] - prev[0], b[1] - prev[1]) < 1e-6 ? still + 250 : 0;
          expect(still, `${e.seq} @${t}: frozen`).toBeLessThan(1000); // light circulation, not a freeze
          prev = b;
        }
      }
    }
    expect([...sides].sort()).toEqual(["away", "home"]);
  });

  it("a ball already past the line (a through ball into the final third) is laid off where it is: carried neither on into the box nor back", () => {
    const m = ms[0];
    for (const side of ["home", "away"] as const) {
      const x = side === "home" ? 80 : 20;
      const s: Scene = { key: `deep-${side}`, seq: 9100, type: "through_ball", side, ms: 1500, ball: [[100 - x, 30], [50, 30], [x, 30]], actors: [], caption: "" };
      const ys: number[] = [];
      for (let t = 0; t <= 30000; t += 100) {
        const b = frameAt(s, 1 + t / s.ms, m.lineups).ball;
        expect(Math.abs(b[0] - x), `${side} @${t}`).toBeLessThanOrEqual(0.6 + 1e-3); // sample() stops a hair short of the last keyframe
        ys.push(b[1]);
      }
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5); // still laid off across the lanes
    }
  });

  it("hands over to the next event from exactly where the dwell left the ball, with only the bounded advance to give back — for real and stale gaps", () => {
    const LIMIT = Math.hypot(DWELL_ADVANCE + 0.6, 6 + 1.2);
    const ROUTINE = new Set(["pass", "build_up", "dribble", "through_ball", "cross", "tackle", "interception"]);
    const sides = new Set<string>();
    let checked = 0;
    let longGaps = 0;
    for (const m of matches(4, 15000)) {
      let prev: Pt = [50, 32];
      const scenes = m.events.map((e) => {
        const s = sceneFor(e, prev, 15000) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        return s;
      });
      for (let k = 0; k + 1 < scenes.length; k++) {
        const s = scenes[k];
        const next = scenes[k + 1];
        if (!s.ms || s.flash || !s.side || !ROUTINE.has(s.type)) continue;
        for (const late of [0, 4000, 20000]) {
          const gap = m.events[k + 1].at - m.events[k].at + late;
          if (gap <= s.ms) continue;
          if (gap - s.ms > 6000) longGaps++;
          const left = frameAt(s, gap / s.ms, m.lineups).ball;
          const first = frameAt(next, 0, m.lineups, undefined, 0, left).ball;
          expect(Math.hypot(first[0] - left[0], first[1] - left[1])).toBeLessThan(1e-9); // no jump at the boundary itself
          const from = next.ball[0]; // where the engine has the next event start: this scene's end
          const back = (s.side === "home" ? 1 : -1) * (left[0] - from[0]);
          expect(back, `${s.seq}+${late}`).toBeLessThanOrEqual(DWELL_ADVANCE + 0.6 + 1e-3); // 1e-3: sample() stops a hair short of a scene's last keyframe
          expect(Math.hypot(left[0] - from[0], left[1] - from[1]), `${s.seq}+${late}`).toBeLessThanOrEqual(LIMIT + 1e-3);
          // A routine next scene keeps its authored destination, however the dwell left the ball (idle and break scenes hold or walk from the drawn ball by design).
          if (ROUTINE.has(next.type)) {
            const a = frameAt(next, 1, m.lineups, undefined, 0, left).ball;
            const b = frameAt(next, 1, m.lineups).ball;
            expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
          }
          sides.add(s.side);
          checked++;
        }
      }
    }
    expect([...sides].sort()).toEqual(["away", "home"]);
    expect(checked).toBeGreaterThan(500);
    expect(longGaps).toBeGreaterThan(50); // past the old 6 s cap
  });

  it("a won challenge shows who has the ball: the loser before the contest, the winner from `won` with WON IT for WON_MS into his dwell — no result gate", () => {
    const m = ms[0];
    const st = m.events[0].st;
    const out = (side: "home" | "away", k: number) => m.lineups[side].filter((p) => p.starter && p.role !== "gk")[k].name;
    const ev = (t: string, side: "home" | "away", from: Pt, ball: Pt, turn?: number): MatchEvent => ({ seq: 9300, at: 0, t, min: 1, side, p: out(side, 1), p2: t === "pass" ? out(side, 2) : t === "build_up" ? undefined : out(side === "home" ? "away" : "home", 2), from, ball, turn, text: "", st });
    const cases: Array<[string, MatchEvent]> = [
      ["home tackle", ev("tackle", "home", [50, 32], [54, 32])],
      ["away tackle", ev("tackle", "away", [50, 32], [46, 32])],
      ["away interception", ev("interception", "away", [50, 32], [46, 32])],
      ["home interception", ev("interception", "home", [50, 32], [54, 32])],
      ["home turnover pass", ev("pass", "home", [75, 32], [45, 32], 1)],
      ["away turnover pass", ev("pass", "away", [25, 32], [55, 32], 1)],
      ["home turnover off the keeper", ev("build_up", "home", [93, 30], [30, 30], 1)],
      ["away turnover off the keeper", ev("build_up", "away", [7, 34], [70, 34], 1)],
    ];
    for (const [name, e] of cases) {
      const s = sceneFor(e, e.from as Pt, 15000)!;
      const w = s.won!;
      const loser = e.side === "home" ? "away" : "home";
      const owner = (t: number) => {
        const f = frameAt(s, t, m.lineups);
        return f.players.find((p) => p.side + ":" + p.no === f.carrier && Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) <= 1.6); // the ring: carrier in contact
      };
      expect(owner(0.02)?.side, `${name}: before the contest`).toBe(loser);
      // #184: a build-up's named player is its collector — a team-mate wins it and plays it to him on the engine's spot.
      const collector = e.t === "build_up";
      if (collector) expect(owner(w + 0.02)?.side, `${name}: a team-mate has won it`).toBe(e.side);
      else expect(owner(w + 0.02)?.name, `${name}: the named winner has it`).toBe(e.p);
      expect(owner(1)?.side, `${name}: still theirs at the end`).toBe(e.side);
      if (collector) expect(owner(1)?.name, `${name}: the named collector has it at the end`).toBe(e.p);
      const at = (ms: number) => frameAt(s, w + ms / s.ms, m.lineups);
      expect(frameAt(s, w - 0.02, m.lineups).won ?? null, name).toBeNull(); // never before he has it
      expect(at(20).won, name).toBe(e.side);
      expect(at(WON_MS - 50).won, name).toBe(e.side); // into the dwell when the scene is short
      expect(at(WON_MS + 50).won ?? null, name).toBeNull();
      expect(at(WON_MS - 50).flash ?? null).toBeNull(); // a cue, not a result: nothing to reveal, nothing held
      expect(reveal(s, 0.6, frameAt(s, 0.6, m.lineups).ball, false).revealed).toBe(true);
      const end = frameAt(s, 1, m.lineups).ball;
      const later = frameAt(s, 1 + 1500 / s.ms, m.lineups).ball;
      expect(Math.hypot(later[0] - end[0], later[1] - end[1]), `${name}: the winner's dwell runs on`).toBeGreaterThan(1);
      // Reduced motion (and a replay's held last frame) keep t at 1: the cue still times off the real elapsed ms, so it stays brief.
      const held = (elapsed: number) => frameAt(s, 1, m.lineups, undefined, 0, undefined, undefined, elapsed).won ?? null;
      expect(held(w * s.ms - 20), `${name}: held, before the win`).toBeNull();
      expect(held(w * s.ms + 20), `${name}: held, just won`).toBe(e.side);
      expect(held(w * s.ms + WON_MS + 50), `${name}: held, expired`).toBeNull();
      expect(held(60000), `${name}: held through a long gap`).toBeNull();
      expect(held(s.ms + 900), `${name}: a replay's 900 ms end hold`).toBe(s.ms + 900 - w * s.ms < WON_MS ? e.side : null);
    }
  });

  it.each(["home", "away"] as const)("%s turnover after 13s of opposing dwell gives the named winner contact before the receiver at 16ms", (side) => {
    const opposing = side === "home" ? "away" : "home";
    const lineups = {
      home: Array.from({ length: 5 }, (_, i) => ({ name: `Home P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true })),
      away: Array.from({ length: 5 }, (_, i) => ({ name: `Away P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true })),
    };
    const label = (s: "home" | "away", n: number) => `${s === "home" ? "Home" : "Away"} P${n}`;
    const point = (x: number): Pt => [side === "home" ? x : 100 - x, 32];
    const previous: MatchEvent = { seq: 9400, at: 0, t: "pass", min: 1, side: opposing,
      p: label(opposing, 3), p2: label(opposing, 4), from: point(60), ball: point(75), text: "prior pass", st: ms[0].events[0].st };
    const pass = sceneFor(previous, point(60), 15000)!;
    let drawn: Frame | null = null;
    const dwellEnd = pass.ms + 13000;
    for (let elapsed = 0; elapsed < dwellEnd; elapsed += 16) {
      drawn = smooth(drawn, frameAt(pass, elapsed / pass.ms, lineups), 16);
    }
    drawn = smooth(drawn, frameAt(pass, dwellEnd / pass.ms, lineups), dwellEnd % 16);
    const startBall: Pt = [...drawn.ball];
    expect(Math.hypot(startBall[0] - point(75)[0], startBall[1] - 32)).toBeGreaterThan(6);
    const event: MatchEvent = { ...previous, seq: 9401, at: dwellEnd, side, turn: 1,
      p: label(side, 3), p2: label(side, 4), from: point(75), ball: point(45), text: "turnover" };
    const scene = sceneFor(event, point(75), 15000)!;
    const authored = JSON.stringify(scene);
    const won = frameAt(scene, scene.won!, lineups, undefined, 0, startBall);
    const named = won.players.find((p) => p.side === side && p.name === event.p)!;
    expect(Math.hypot(named.x - won.ball[0], named.y - won.ball[1]), "named winner follows the rerouted challenge contact").toBeLessThanOrEqual(1.6);
    const contacts: string[] = [];
    for (let elapsed = 0; elapsed <= scene.ms + 1000; elapsed += 16) {
      drawn = smooth(drawn, frameAt(scene, elapsed / scene.ms, lineups, undefined, 0, startBall), 16);
      const holder = drawn.players.find((p) => p.side === side && drawn!.carrier === `${side}:${p.no}` && drawn!.lift < 0.05 && Math.hypot(p.x - drawn!.ball[0], p.y - drawn!.ball[1]) <= 1.6);
      if (holder && contacts.at(-1) !== holder.name) contacts.push(holder.name);
    }
    expect(contacts[0], "the first winning-side ring belongs to the named challenge winner").toBe(event.p);
    expect(contacts).toContain(event.p2);
    const end = frameAt(scene, 1, lineups, undefined, 0, startBall).ball;
    expect(end[0]).toBeCloseTo(point(45)[0], 4);
    expect(end[1]).toBeCloseTo(point(45)[1], 4);
    expect(JSON.stringify(scene)).toBe(authored);
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
    const badgeTailMs = 2500; // same window as sim LINGER_MS; local so this file still loads where that export does not exist yet
    // Own scene keeps the chip for the same 2.5 s after it ends, then drops it. A 20 s gap must not leave SAVED up.
    expect(frameAt(sv, 1 + 2000 / sv.ms, m.lineups).flash).toBe("save");
    expect(frameAt(sv, 1 + badgeTailMs / sv.ms, m.lineups).flash).toBeNull();
    expect(frameAt(sv, 1 + 20000 / sv.ms, m.lineups).flash).toBeNull();
    // Reduced motion and a replay tail hold t at 1; elapsedMs is the clock that expires the chip.
    expect(frameAt(sv, 1, m.lineups, undefined, 0, undefined, undefined, sv.ms + 1000).flash).toBe("save");
    expect(frameAt(sv, 1, m.lineups, undefined, 0, undefined, undefined, sv.ms + 900).flash).toBe("save");
    expect(frameAt(sv, 1, m.lineups, undefined, 0, undefined, undefined, sv.ms + badgeTailMs).flash).toBeNull();
    expect(frameAt(pass, 0, m.lineups).flash).toBeNull();
    const goal: Scene = { ...sv, type: "goal", flash: "goal" };
    const card: Scene = { ...sv, type: "red_card", flash: "card" };
    const shootout: Scene = { ...sv, type: "shootout_kick", flash: "save" };
    expect(frameAt(goal, 1 + 20000 / goal.ms, m.lineups).flash).toBe("goal");
    expect(frameAt(card, 1 + 20000 / card.ms, m.lineups).flash).toBe("card");
    expect(frameAt(shootout, 1 + 20000 / shootout.ms, m.lineups).flash).toBeNull();
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

  it("the referee rides his actor path as Frame.ref; without one he trails ten behind the ball, sliding across the far half without a side flip", () => {
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
    expect(f.ref[1]).toBeCloseTo(32 + (32 - f.ball[1]) * 0.6, 5);
    const away = frameAt({ ...pass, side: "away", ball: [[60, 50], [40, 50]] }, 0.5, m.lineups);
    expect(away.ref[0]).toBeCloseTo(away.ball[0] + 10, 5);
    expect(away.ref[1]).toBeCloseTo(32 + (32 - away.ball[1]) * 0.6, 5);
    // Crossing the centre line moves him a touch, not to the other side of the pitch (the old far-side rule flipped 28 units).
    const lo = frameAt({ ...pass, ball: [[50, 31], [50, 31]] }, 0.5, m.lineups).ref;
    const hi = frameAt({ ...pass, ball: [[50, 33], [50, 33]] }, 0.5, m.lineups).ref;
    expect(Math.abs(lo[1] - hi[1])).toBeLessThan(2);
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
    for (const p of end.players.filter((p) => !p.gk)) expect(p.x - 1.7 - 3).toBeGreaterThanOrEqual(end.cam[0]); // whole circle + number inside the pen cam
    for (const p of end.players.filter((p) => !p.gk)) expect(Math.abs(p.x - 58)).toBeLessThan(4); // halfway rows
    expect(end.cam).not.toEqual([-4, -3, 108, 77]);
    expect(end.ref).toEqual([86, 19]); // beside the box, off the spot and the ball path
    expect(at(1.5).players.map((p) => [p.x, p.y])).toEqual(end.players.map((p) => [p.x, p.y])); // holds while the setup is awaited
  });

  it("a build-up's collector has the ball at its end, and the pass that follows starts with him on it — plain, own box and turnover (#184)", () => {
    let plain = 0;
    let turn = 0;
    for (const m of ms) {
      let prev: Pt = [50, 32];
      const scenes = m.events.map((e, i) => {
        const s = sceneFor(e, prev, 15000, m.events[i + 1]) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        return s;
      });
      m.events.forEach((e, i) => {
        const next = m.events[i + 1];
        if (e.t !== "build_up" || next?.t !== "pass" || next.p !== e.p) return;
        const end = frameAt(scenes[i], 1, m.lineups);
        const x = end.players.find((p) => p.side === e.side && p.name === e.p)!;
        expect(end.carrier, `build_up #${e.seq}`).toBe(x.side + ":" + x.no);
        expect(Math.hypot(x.x - end.ball[0], x.y - end.ball[1]), `build_up #${e.seq}`).toBeLessThanOrEqual(1.6);
        const start = frameAt(scenes[i + 1], 0, m.lineups, undefined, 0, end.ball);
        const y = start.players.find((p) => p.side === e.side && p.name === e.p)!;
        expect(start.carrier, `pass #${next.seq}`).toBe(y.side + ":" + y.no);
        expect(Math.hypot(y.x - start.ball[0], y.y - start.ball[1]), `pass #${next.seq}`).toBeLessThanOrEqual(1.6);
        if (e.turn) turn++;
        else plain++;
      });
    }
    expect(plain).toBeGreaterThan(30);
    expect(turn).toBeGreaterThan(30);
  });

  // #184: formation-only frames (no actors) over a grid of ball spots, so the two shapes alone meet.
  const shapeOnly = (bx: number, by: number, poss: "home" | "away" | null): Scene => ({ key: "s", seq: 9500, type: poss ? "pass" : "foul", ms: 1500, ball: [[bx, by]], actors: [], caption: "", side: poss ?? "home" });
  /** Pairs touching (kits overlap) where at least one is a formation outfielder: the only players the spacing may move. */
  const touching = (f: Frame, pinned = new Set<Player>()) => {
    const free = (p: Player) => !p.gk && !p.hot && !pinned.has(p);
    return f.players.flatMap((p, i) => f.players.slice(i + 1).filter((q) => (free(p) || free(q)) && Math.hypot(p.x - q.x, p.y - q.y) < 2.9).map((q) => `${p.side}:${p.no}/${q.side}:${q.no}`));
  };
  /** A dwell's own movers (its two lanes and the closing marker): designed contact, never spaced. The marker was the nearest
   * opponent when chosen; an actor can end up nearer, so the two nearest opponents stand in for him. */
  const ROUTINE = new Set(["pass", "build_up", "dribble", "through_ball", "tackle", "interception", "bounce", "kickoff", "restart"]);
  const dwellers = (s: Scene, t: number, f: Frame) => {
    if (t <= 1 || s.flash || !s.side || !ROUTINE.has(s.type)) return new Set<Player>();
    const byBall = (ps: Player[]) => ps.sort((p, q) => Math.hypot(p.x - f.ball[0], p.y - f.ball[1]) - Math.hypot(q.x - f.ball[0], q.y - f.ball[1]));
    return new Set([...byBall(f.players.filter((p) => p.side === s.side && !p.gk)).slice(0, 2), ...byBall(f.players.filter((p) => p.side !== s.side && !p.gk)).slice(0, 2)]);
  };

  it("formation players don't stand on anyone: never over a grid of ball spots for both shapes and none, ten players or nine after a red card; all but a rare squeeze in real matches' open play (#184)", () => {
    const m = ms[0];
    const red = new Set([`home:${m.lineups.home.filter((p) => p.starter && p.role !== "gk")[2].name}`]);
    for (let bx = 4; bx <= 96; bx += 4)
      for (let by = 4; by <= 60; by += 4)
        for (const poss of ["home", "away", null] as const)
          for (const sentOff of [undefined, red]) {
            const f = frameAt(shapeOnly(bx, by, poss), 0.5, m.lineups, sentOff);
            expect(f.players).toHaveLength(sentOff ? 9 : 10);
            const bad = touching(f);
            if (bad.length) expect.fail(`ball ${bx},${by} ${poss} ${sentOff ? 9 : 10}: ${bad.join(" ")}`);
          }
    const SKIP = new Set(["kickoff", "second_half", "extra_time", "et_second_half", "half_time", "end_of_normal_time", "et_half_time", "match_end"]);
    // Real play adds actors on their routes: a formation player squeezed between two of them may still brush one. Actors, the
    // dwell's movers and challenges are designed contact and not counted.
    let n = 0;
    let touch = 0;
    for (const mm of ms) {
      let prev: Pt = [50, 32];
      for (const e of mm.events) {
        const s = sceneFor(e, prev, 15000) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        if (s.cam || SKIP.has(s.type)) continue;
        for (const t of [0, 0.5, 1, 1 + 1200 / Math.max(1, s.ms)]) {
          const f = frameAt(s, t, mm.lineups, undefined, 1000);
          if (touching(f, dwellers(s, t, f)).length) touch++;
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(10000);
    expect(touch / n).toBeLessThan(0.002);
  });

  it("attacking forwards make the runs: a pass ahead of the ball and wide of its lane, one either side, moving smoothly with it — out of the crowd round the ball at both ends (#184)", () => {
    for (let bx = 4; bx <= 96; bx += 2)
      for (let by = 2; by <= 62; by += 2) {
        const [x3, y3] = shapeAt(3, bx, by, true);
        const [x4, y4] = shapeAt(4, bx, by, true);
        for (const x of [x3, x4]) expect(x, `ball ${bx},${by}`).toBeGreaterThanOrEqual(Math.min(94, bx + FWD_LEAD) - 1e-9);
        expect(y3, `ball ${bx},${by}`).toBeCloseTo(Math.max(4, by - FWD_WIDTH), 9);
        expect(y4, `ball ${bx},${by}`).toBeCloseTo(Math.min(60, by + FWD_WIDTH), 9);
      }
    // The ball moving across the pitch never makes a forward jump sides (the old lane rule flipped him 18 across its lane).
    for (const bx of [30, 50, 70])
      for (const i of [3, 4]) {
        let prev = shapeAt(i, bx, 2, true);
        for (let by = 2.1; by <= 62; by += 0.1) {
          const q = shapeAt(i, bx, by, true);
          expect(Math.hypot(q[0] - prev[0], q[1] - prev[1]), `forward ${i}, ball ${bx},${by.toFixed(1)}`).toBeLessThan(0.2);
          prev = q;
        }
      }
    // Drawn, through the mirror and the spacing: in midfield both stay outside 16 of the ball (≈150 px on a desktop pitch).
    for (const poss of ["home", "away"] as const)
      for (let ox = 20; ox <= 70; ox += 5)
        for (let by = 18; by <= 46; by += 4) {
          const f = frameAt(shapeOnly(poss === "home" ? ox : 100 - ox, by, poss), 0.5, ms[0].lineups);
          for (const p of f.players.filter((q) => q.side === poss).slice(3)) expect(Math.hypot(p.x - f.ball[0], p.y - f.ball[1]), `${poss} ${ox},${by} #${p.no}`).toBeGreaterThan(16);
        }
  });

  it("the spacing adds no jump of its own: along a slow ball path, no player moves further per step than the shapes themselves do (#184)", () => {
    const m = ms[0];
    const raw = (side: "home" | "away", i: number, bx: number, by: number, poss: "home" | "away"): Pt => {
      const own = (x: number) => (side === "away" ? 100 - x : x);
      const [x, y] = shapeAt(i, own(bx), by, poss === side, poss !== side);
      return [own(x), y];
    };
    for (const poss of ["home", "away"] as const) {
      let last: Frame | null = null;
      let lastRaw: Pt[] | null = null;
      for (let k = 0; k <= 1000; k++) {
        const bx = 8 + 0.084 * k;
        const by = 6 + 0.052 * k; // 0.1 units a step, corner to corner
        const f = frameAt(shapeOnly(bx, by, poss), 0.5, m.lineups);
        const r = f.players.map((p, j) => (p.gk ? ([p.x, p.y] as Pt) : raw(p.side, j % 5, bx, by, poss)));
        if (last && lastRaw) {
          const moved = Math.max(...f.players.map((p, j) => Math.hypot(p.x - last!.players[j].x, p.y - last!.players[j].y)));
          const shape = Math.max(...r.map((q, j) => Math.hypot(q[0] - lastRaw![j][0], q[1] - lastRaw![j][1])));
          expect(moved, `${poss} step ${k}`).toBeLessThanOrEqual(shape + 0.6);
        }
        last = f;
        lastRaw = r;
      }
    }
  });

  it("the ringed dwell holder keeps the ball at his feet as the drawn frame chases it (#184)", () => {
    const lineups = {
      home: Array.from({ length: 5 }, (_, i) => ({ name: `Home P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true })),
      away: Array.from({ length: 5 }, (_, i) => ({ name: `Away P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true })),
    };
    const pass: MatchEvent = { seq: 9600, at: 0, t: "pass", min: 1, side: "home", p: "Home P3", p2: "Home P4", from: [30, 30], ball: [42, 34], text: "", st: ms[0].events[0].st };
    const s = sceneFor(pass, [30, 30], 15000)!;
    let drawn: Frame | null = null;
    let worst = 0;
    let n = 0;
    for (let el = 0; el <= s.ms + 2400; el += 16) {
      const target = frameAt(s, el / s.ms, lineups, undefined, 0);
      drawn = smooth(drawn, target, 16);
      if (el < s.ms + 300 || !drawn.carrier) continue; // the dwell has settled in
      const h = drawn.players.find((p) => p.side + ":" + p.no === drawn!.carrier)!;
      worst = Math.max(worst, Math.hypot(h.x - drawn.ball[0], h.y - drawn.ball[1]));
      n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(0.9); // the dwell's own 0.8 behind the ball, not a trailing gap
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
  it("the referee walks after his target — eased over 900 ms, never faster than 14 u/s, ignoring shifts under 4 units — so he repositions rarely and never darts", () => {
    const s = smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [60, 10] }, 100);
    expect(s.ref[0]).toBeGreaterThan(11);
    expect(s.ref[0]).toBeLessThanOrEqual(11.4); // 14 u/s cap: 1.4 per 100 ms
    const tick = smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [60, 10] }, 16);
    expect(Math.hypot(tick.ref[0] - 10, tick.ref[1] - 10)).toBeLessThan(0.3);
    expect(smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [13, 12] }, 100).ref).toEqual([10, 10]); // small shift: stays put
    expect(smooth({ ...at(10), ref: [10, 10] }, { ...at(10), ref: [15, 10] }, 100).ref[0]).toBeGreaterThan(10); // beyond the deadband: walks
  });
  it("the carrier on the ball keeps the ball's pace; flights, a lifted ball and a carrier not yet on it keep the ordinary chase, capped (#184)", () => {
    const f = (x: number, ball: number, carrier: string | null, lift = 0): Frame => ({ ...at(x), ball: [ball, 32], lift, carrier });
    const step = (target: Frame) => smooth(f(0, 0, null), target, 16).players[0].x;
    const ordinary = 10 * (1 - Math.exp(-16 / 220));
    expect(step(f(10, 10.5, null))).toBeCloseTo(ordinary, 9); // a flight: nobody is nominated
    expect(step(f(10, 10.5, "home:7", 0.3))).toBeCloseTo(ordinary, 9); // in the air
    expect(step(f(10, 14, "home:7"))).toBeCloseTo(ordinary, 9); // nominated but not on it in the target
    expect(step(f(10, 10.5, "away:7"))).toBeCloseTo(ordinary, 9); // someone else's ball
    expect(smooth({ ...f(0, 0, null), ball: [8, 32] }, f(10, 10.5, "home:7"), 16).players[0].x).toBeCloseTo(ordinary, 9); // still running in to it
    expect(step(f(10, 10.5, "home:7"))).toBeCloseTo(10 * (1 - Math.exp(-16 / 90)), 9); // at his feet: the ball's own pace
    expect(smooth(f(0, 0, null), f(50, 50.5, "home:7"), 16).players[0].x).toBeLessThanOrEqual((120 * 16) / 1000 + 1e-9); // never a teleport
  });
  it("spaceOut moves only formation outfielders, straight out to GAP, in a fixed order; keepers, actors and pinned movers stay put (#184)", () => {
    const pl = (side: "home" | "away", no: number, x: number, y: number, extra: Partial<Player> = {}): Player => ({ side, name: side + no, no, gk: false, x, y, hot: false, ...extra });
    const make = () => [pl("home", 1, 4, 32, { gk: true }), pl("home", 4, 50, 30), pl("home", 5, 50, 30.5, { hot: true }), pl("away", 1, 96, 32, { gk: true }), pl("away", 4, 50.5, 30), pl("away", 5, 60, 40), pl("away", 3, 6, 32), pl("home", 2, 30, 20), pl("away", 2, 30, 20, { hot: true })];
    const run = () => {
      const ps = make();
      spaceOut(ps, new Set([ps[5]]), "away");
      return ps;
    };
    const ps = run();
    const before = make();
    for (const i of [0, 2, 3, 5, 8]) expect(ps[i]).toEqual(before[i]); // keepers, actors, the pinned marker
    for (const i of [1, 4, 6, 7]) for (const q of ps) if (q !== ps[i]) expect(Math.hypot(ps[i].x - q.x, ps[i].y - q.y)).toBeGreaterThanOrEqual(2.9); // kits never touch
    expect(ps[7].x).toBeCloseTo(30 - GAP, 1); // exactly on a player: he steps goal-side, out to GAP
    expect(ps[7].y).toBe(20);
    expect(ps[6].x).toBeCloseTo(4 + GAP, 1); // straight away from his keeper, out to GAP
    expect(ps[6].y).toBe(32);
    // Squeezed between two players in a column: what cancels out takes him goal-side, out of the squeeze, kits clear of both.
    const mid = [pl("home", 4, 39, 31), pl("away", 4, 39, 29, { hot: true }), pl("away", 5, 39, 35, { hot: true })];
    spaceOut(mid, new Set(), "home");
    expect(mid[0].x).toBeLessThan(39 - 1); // towards his own goal (home defends x=0)
    for (const q of mid.slice(1)) expect(Math.hypot(mid[0].x - q.x, mid[0].y - q.y)).toBeGreaterThanOrEqual(2.9);
    expect(run()).toEqual(ps); // deterministic
    // A formation player passing close by an actor swings round him: small, smooth steps, never a jump.
    let prev: Pt | null = null;
    for (let x = 40; x <= 60; x += 0.05) {
      const pair = [pl("home", 4, x, 33), pl("away", 4, 50, 32, { hot: true })];
      spaceOut(pair, new Set(), "home");
      if (prev) expect(Math.hypot(pair[0].x - prev[0], pair[0].y - prev[1])).toBeLessThan(0.5);
      prev = [pair[0].x, pair[0].y];
    }
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
