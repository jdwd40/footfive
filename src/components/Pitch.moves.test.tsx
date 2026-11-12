/** #205: the move effects as drawn — a fixed set of nodes whatever happens (catch-up included), poses on the keeper, and the shot's
 * drawing identical whatever its result. */
import { createRequire } from "node:module";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import { sampleN, sceneFor, touchStyle, type Pt, type Scene } from "../domain/scenes";
import { frameAt, smooth, type Frame, type Lineups } from "../domain/sim";
import type { MatchEvent, PubState, Side, TeamPublic } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const NAMES = { home: ["Kai Home", "Ada Passer", "Ben Runner", "Cy Stopper", "Di Wide"], away: ["Lu Away", "Mo Passer", "Ned Runner", "Oz Stopper", "Pip Wide"] } as const;
const LINEUPS: Lineups = {
  home: NAMES.home.map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
  away: NAMES.away.map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
};
const ST: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 1200, run: 1 }, pos: 50, x: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], d: 0, win: null, by: null };
const ev = (t: string, side: Side, seq: number, extra: Partial<MatchEvent>): MatchEvent => ({ seq, at: seq * 1000, min: 20, t, side, text: `${t} ${seq}`, st: ST, ...extra }) as MatchEvent;
/** A seq whose plain pass is a one-touch ball (released at once). */
const QUICK = (() => {
  let s = 300;
  while (touchStyle(s) !== "quick") s++;
  return s;
})();
const fxNode = (name: string) => screen.getByTestId("move-fx").querySelector(`[data-fx="${name}"]`)!;
const shown = (name: string) => fxNode(name).getAttribute("display") !== "none";
const keeperNode = (side: Side) => [...document.querySelectorAll('[data-testid="player"]')].find((n) => n.getAttribute("data-side") === side && n.hasAttribute("data-gk"))!;

afterEach(cleanup);

describe("Pitch move effects (#205)", () => {
  it("draws a pass line, a through ball's space and sprint, and a cross arc on the same four nodes, hidden when there is no move", () => {
    const pass = sceneFor(ev("pass", "home", QUICK, { p: NAMES.home[1], p2: NAMES.home[2], from: [40, 30], ball: [56, 36] }), [40, 30], 15000)!;
    const { rerender } = render(<Pitch frame={frameAt(pass, 0.05, LINEUPS)} home={home} away={away} revealed />);
    expect(screen.getByTestId("move-fx").children).toHaveLength(4);
    expect(screen.getByTestId("move-fx").getAttribute("data-kind")).toBe("pass");
    expect(shown("line")).toBe(true);
    expect(fxNode("line").getAttribute("d")).toBe("M 40.00 30.00 L 56.00 36.00");
    expect(shown("spot") || shown("sprint") || shown("burst")).toBe(false);

    const tb = sceneFor(ev("through_ball", "away", 501, { p: NAMES.away[1], p2: NAMES.away[2], from: [60, 30], ball: [36, 22] }), [60, 30], 15000)!;
    rerender(<Pitch frame={frameAt(tb, 0.4, LINEUPS)} home={home} away={away} revealed />);
    expect(fxNode("line").getAttribute("stroke-dasharray")).toBeTruthy();
    expect(shown("spot") && shown("sprint")).toBe(true);
    expect([fxNode("spot").getAttribute("cx"), fxNode("spot").getAttribute("cy")]).toEqual(["36", "22"]);

    const cross = sceneFor(ev("cross", "home", 601, { p: NAMES.home[1], p2: NAMES.home[2], chain: 4, from: [56, 28], ball: [76, 6] }), [56, 28], 15000)!;
    rerender(<Pitch frame={frameAt(cross, 0.72, LINEUPS)} home={home} away={away} revealed />);
    expect(fxNode("line").getAttribute("d")!.split("L")).toHaveLength(9); // the traced arc

    rerender(<Pitch frame={frameAt(cross, 0.2, LINEUPS)} home={home} away={away} revealed />); // the winger still has it
    expect(["line", "spot", "sprint", "burst"].map(shown)).toEqual([false, false, false, false]);
    expect(screen.getByTestId("move-fx").children).toHaveLength(4);
  });

  it("projects every effect with the end swap", () => {
    const pass = sceneFor(ev("pass", "home", QUICK, { p: NAMES.home[1], p2: NAMES.home[2], from: [40, 30], ball: [56, 36] }), [40, 30], 15000)!;
    render(<Pitch frame={{ ...frameAt(pass, 0.05, LINEUPS), phase: "second_half" }} home={home} away={away} revealed />);
    expect(fxNode("line").getAttribute("d")).toBe("M 60.00 30.00 L 44.00 36.00");
  });

  it("lays a diving keeper out towards the ball and keeps a claiming keeper upright, arms up; nobody else is turned", () => {
    const dive = sceneFor(ev("save", "away", 801, { p: NAMES.away[0], p2: NAMES.home[2], from: [74, 30], target: [100, 35], ball: [96, 35] }), [74, 30], 15000)!;
    const { rerender } = render(<Pitch frame={frameAt(dive, 0.5, LINEUPS)} home={home} away={away} revealed={false} />);
    const k = keeperNode("away");
    expect(k.getAttribute("data-pose")).toBe("dive");
    expect(k.getAttribute("transform")).toMatch(/^translate\([-\d.]+ [-\d.]+\)$/); // his spot is the frame's; the turn is inside
    expect(k.querySelector("[data-turn]")!.getAttribute("transform")).toMatch(/^rotate\(-?\d+\.\d\) scale\(1 1\.2\)$/);
    expect(keeperNode("home").querySelector("[data-turn]")!.getAttribute("transform")).toBeNull();
    expect(document.querySelectorAll("[data-turn]")).toHaveLength(2); // one fixed group per keeper, none for outfielders
    rerender(<Pitch frame={frameAt(dive, 0, LINEUPS)} home={home} away={away} revealed={false} />);
    expect(keeperNode("away").hasAttribute("data-pose")).toBe(false);
    const claim = sceneFor(ev("save", "away", 802, { p: NAMES.away[0], p2: NAMES.home[2], from: [88, 30], target: [100, 30], ball: [96, 30] }), [88, 30], 15000)!;
    rerender(<Pitch frame={frameAt(claim, 0.6, LINEUPS)} home={home} away={away} revealed={false} />);
    expect(keeperNode("away").getAttribute("data-pose")).toBe("claim");
    expect(keeperNode("away").querySelector("[data-turn]")!.getAttribute("transform")).toBeNull();
  });

  it("shows the woodwork rattle only with the revealed result", () => {
    const w = sceneFor(ev("woodwork", "home", 901, { p: NAMES.home[1], post: "left", from: [80, 30], target: [100, 28], ball: [92, 24] }), [80, 30], 15000)!;
    const f = frameAt(w, 0.7, LINEUPS);
    expect(f.fx?.burst).toBeTruthy();
    const { rerender } = render(<Pitch frame={f} home={home} away={away} revealed={false} />);
    expect(shown("burst")).toBe(false);
    rerender(<Pitch frame={f} home={home} away={away} revealed />);
    expect(shown("burst")).toBe(true);
    expect([fxNode("burst").getAttribute("cx"), fxNode("burst").getAttribute("cy")]).toEqual(["100", "28"]);
  });

  it("draws a shot identically whatever its result", () => {
    const shot = ev("shot", "home", 11, { p: NAMES.home[2], ball: [64, 30], long: 1 });
    const html = (["goal", "save", "miss", "woodwork", "block"] as const).map((t) => {
      const result = ev(t, t === "save" || t === "block" ? "away" : "home", 12, { p: NAMES.home[2], target: [100, 35], ball: [96, 35], from: [64, 30] });
      const s = sceneFor(shot, [64, 30], 6000, result)!;
      const { container, unmount } = render(<Pitch frame={frameAt(s, 0.2, LINEUPS)} home={home} away={away} revealed />);
      const out = container.querySelector("svg")!.innerHTML;
      unmount();
      return out;
    });
    expect(new Set(html).size).toBe(1);
    expect(html[0]).toContain('data-kind="long"');
  });
});

function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
}

describe("Pitch move effects at catch-up speed (#205)", () => {
  it("never pile up: a fast-forwarded backlog keeps the same four effect nodes and a bounded drawing every tick", () => {
    const st = eng.createMatch({ fixtureId: "cu", seed: 4242, kickoffAt: 0, home: team(3), away: team(9), timing: eng.buildTiming(6000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12).slice(0, 110);
    const lineups = Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;
    const scenes: Scene[] = [];
    let prev: Pt = [50, 32];
    let lift = 0;
    events.forEach((e, i) => {
      const s = sceneFor(e, prev, 6000, events[i + 1], lift);
      if (!s || !s.ms || s.ms > 3000) return; // breaks hold for real seconds; the backlog is the play
      scenes.push(s);
      prev = s.ball[s.ball.length - 1];
      lift = sampleN(s.ballHeight, 1);
    });
    const { container, rerender } = render(<Pitch frame={null} home={home} away={away} revealed />);
    let drawn: Frame | null = null;
    const counts = new Set<number>();
    const kinds = new Set<string>();
    let ticks = 0;
    for (const s of scenes) {
      // CATCHUP_RATE 4: each 16 ms tick moves 64 ms of scene time, so effects start and end four times as often
      for (let ms = 0; ms < s.ms; ms += 64) {
        drawn = smooth(drawn, frameAt(s, ms / s.ms, lineups, undefined, 1000 + ticks * 16, drawn?.ball), 16);
        rerender(<Pitch frame={drawn} home={home} away={away} revealed />);
        const fx = screen.getByTestId("move-fx");
        expect(fx.children).toHaveLength(4);
        expect(container.querySelectorAll("[data-fx]")).toHaveLength(4);
        counts.add(container.querySelectorAll("svg *").length);
        if (fx.getAttribute("data-kind")) kinds.add(fx.getAttribute("data-kind")!);
        ticks++;
      }
    }
    expect(ticks).toBeGreaterThan(300);
    expect(kinds.size).toBeGreaterThanOrEqual(3); // the run really exercised several move kinds
    expect(Math.max(...counts)).toBeLessThan(200);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3); // only the carrier ring and name (and a banner glow) come and go
  }, 60000);
});
