import { createRequire } from "node:module";
import { cleanup, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import { sceneFor, type Pt } from "../domain/scenes";
import { frameAt } from "../domain/sim";
import type { MatchEvent, TeamPublic, LineupPlayer } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const eng = require("../../pocketbase/pb_hooks/lib/matchEngine.js");
const { TEAMS } = require("../../pocketbase/pb_hooks/lib/teams.js");
const { defaultStarters } = require("../../pocketbase/pb_hooks/lib/tournament.js");
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true };
};
const state = eng.createMatch({ seed: 1018, fixtureId: "ends", kickoffAt: 0, home: team(10), away: team(9), timing: eng.buildTiming(8000, 1) });
const events = eng.advanceTo(state, 1e13) as MatchEvent[];
const lineups = Object.fromEntries(["home", "away"].map(side => [side, state.teams[side].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as { home: LineupPlayer[]; away: LineupPlayer[] };
const home = { name: "Home", abbreviation: "HOM" } as TeamPublic;
const away = { name: "Away", abbreviation: "AWY" } as TeamPublic;

describe("Pitch event-snapshot end projection", () => {
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
