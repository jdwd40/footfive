import { createRequire } from "node:module";
import { cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import { sceneFor, type Pt, type Scene } from "../domain/scenes";
import { frameAt, playhead, smooth, type Frame } from "../domain/sim";
import type { MatchEvent, TeamPublic, LineupPlayer } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const eng = require("../../pocketbase/pb_hooks/lib/matchEngine.js");
const { TEAMS } = require("../../pocketbase/pb_hooks/lib/teams.js");
const { defaultStarters } = require("../../pocketbase/pb_hooks/lib/tournament.js");
const team = (i: number) => {
  const t = TEAMS[i];
  // Manual sides held at Balanced, so late Full AI tactic switches don't decide whether this
  // fixture reaches every phase.
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: false, stance: "balanced" };
};
// Seed 1024 checked against the #133 engine: these two manual Balanced sides play extra time
// and a shootout with kicks from both. The engine's seeded outcomes shift with any engine
// tuning (see the 200-seed pin in engine.test.ts); the precondition test below says so first.
const state = eng.createMatch({ seed: 1024, fixtureId: "ends", kickoffAt: 0, home: team(10), away: team(9), timing: eng.buildTiming(8000, 1) });
const events = eng.advanceTo(state, 1e13) as MatchEvent[];
const lineups = Object.fromEntries(["home", "away"].map(side => [side, state.teams[side].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as { home: LineupPlayer[]; away: LineupPlayer[] };
const home = { name: "Home", abbreviation: "HOM" } as TeamPublic;
const away = { name: "Away", abbreviation: "AWY" } as TeamPublic;

describe("Pitch event-snapshot end projection", () => {
  it("fixture plays real extra time and a shootout with kicks from both sides, with no tactic changes", () => {
    const types = new Set(events.map(e => e.t));
    for (const t of ["half_time", "end_of_normal_time", "et_half_time", "shootout_start", "shootout_end"]) expect(types, t).toContain(t);
    expect(new Set(events.filter(e => e.st.ph === "extra_time_1" || e.st.ph === "extra_time_2").map(e => e.st.ph))).toEqual(new Set(["extra_time_1", "extra_time_2"]));
    expect(new Set(events.filter(e => e.t === "shootout_kick").map(e => e.side))).toEqual(new Set(["home", "away"]));
    expect(types.has("coaching")).toBe(false);
  });

  it.each(["half_time", "end_of_normal_time", "et_half_time"])("keeps the visible ball continuous through off-centre %s to the next period", (type) => {
    const scenes = new Map<number, Scene>();
    let prev: Pt = [50, 32];
    for (const e of events) {
      const s = sceneFor(e, prev, 8000) ?? { key: String(e.seq), seq: e.seq, type: e.t, phase: e.st.ph, ms: 0, ball: [prev], actors: [], caption: e.text };
      prev = s.ball.at(-1)!;
      scenes.set(e.seq, s);
    }
    const marker = events.find(e => e.t === type)!;
    const next = events[events.indexOf(marker) + 1];
    const authored = JSON.stringify([...scenes]);
    let drawn: Frame | null = null;
    let startBall: Pt | undefined;
    let switches = 0;
    const displayX = (f: Frame) => ["second_half", "et_break", "extra_time_2", "shootout", "finished"].includes(f.phase!) ? 100 - f.ball[0] : f.ball[0];
    for (let now = marker.at - 1000; now <= next.at + 4000; now += 100) {
      const ph = playhead(events, now)!;
      const scene = scenes.get(ph.cur.seq)!;
      if (drawn?.seq !== scene.seq) startBall = drawn?.ball;
      const target = frameAt(scene, scene.ms ? ph.elapsed / scene.ms : 1, lineups, undefined, now, startBall);
      const frame = smooth(drawn, target, 100);
      if (drawn?.seq === marker.seq && frame.seq === marker.seq) {
        expect(Math.hypot(frame.ball[0] - drawn.ball[0], frame.ball[1] - drawn.ball[1]), "return during break stays continuous").toBeLessThan(2);
      }
      if (drawn && drawn.phase !== frame.phase && frame.seq === next.seq) {
        switches++;
        cleanup();
        const { container, rerender } = render(<Pitch frame={drawn} home={home} away={away} revealed />);
        const before = Number(container.querySelector('circle[stroke="#111"]')!.getAttribute("cx"));
        rerender(<Pitch frame={frame} home={home} away={away} revealed />);
        const after = Number(container.querySelector('circle[stroke="#111"]')!.getAttribute("cx"));
        const distance = Math.hypot(after - before, frame.ball[1] - drawn.ball[1]);
        console.log(`${type}: canonical ${drawn.ball} -> ${frame.ball}; SVG ${before} -> ${after}; 100ms movement ${distance}`);
        expect(distance, `${type} end switch`).toBeLessThan(1);
        expect(displayX(drawn)).toBeCloseTo(50, 2);
        expect(drawn.ball[1]).toBeCloseTo(32, 2);
      }
      drawn = frame;
    }
    expect(JSON.stringify([...scenes])).toBe(authored);
    expect(switches).toBe(1);
  });

  it("swaps every playing period, keeps each break's outgoing end and one shootout end, without mutating canonical frames or mirroring numbers", () => {
    const phases = new Set<string>();
    let prev: Pt = [50, 32];
    const tested = new Set<string>();
    for (const e of events) {
      const scene = sceneFor(e, prev, 8000);
      if (!scene) continue;
      prev = scene.ball.at(-1)!;
      const key = `${e.t}/${e.st.ph}/${e.side}`;
      if (tested.has(key)) continue;
      tested.add(key);
      // Includes walk-off/on frames, ordinary outcomes, penalties and both sides' shootout kicks.
      for (const progress of [0, 0.5, 1]) {
        cleanup();
        const f = frameAt(scene, progress, lineups);
        const original = JSON.stringify(f);
        const flip = ["second_half", "et_break", "extra_time_2", "shootout", "finished"].includes(e.st.ph);
        const x = (v: number) => flip ? 100 - v : v;
        const { container } = render(<Pitch frame={f} home={home} away={away} revealed />);
        const actors = container.querySelectorAll('[data-testid="player"]');
        f.players.forEach((p, i) => {
          expect(actors[i].getAttribute("transform"), `${e.t}/${e.st.ph}/${progress}`).toBe(`translate(${x(p.x)} ${p.y})`);
          expect(actors[i].textContent).toBe(String(p.no));
        });
        expect(container.querySelector('[data-testid="ref"]')!.getAttribute("cx")).toBe(String(x(f.ref[0])));
        expect(container.querySelector('circle[stroke="#111"]')!.getAttribute("cx")).toBe(String(x(f.ball[0])));
        expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe([flip ? 100 - f.cam[0] - f.cam[2] : f.cam[0], ...f.cam.slice(1)].join(" "));
        expect(JSON.stringify(f)).toBe(original);
        phases.add(e.st.ph);
      }
    }
    expect([...phases]).toEqual(expect.arrayContaining(["first_half", "half_time", "second_half", "et_break", "extra_time_1", "et_half_time", "extra_time_2", "shootout", "finished"]));
  });
});
