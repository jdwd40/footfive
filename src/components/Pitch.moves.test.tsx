/** #205: the move effects as drawn — a fixed set of nodes whatever happens (catch-up included), poses on the keeper, and the shot's
 * drawing identical whatever its result. */
import { createRequire } from "node:module";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pitch from "./Pitch";
import { sampleN, sceneFor, touchStyle, type Pt, type Scene } from "../domain/scenes";
import { frameAt, reveal, settle, smooth, type Frame, type Lineups } from "../domain/sim";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("lays a diving keeper out towards the ball and keeps a claiming keeper upright, arms up — only once the save is revealed", () => {
    const dive = sceneFor(ev("save", "away", 801, { p: NAMES.away[0], p2: NAMES.home[2], from: [74, 30], target: [100, 35], ball: [96, 35] }), [74, 30], 15000)!;
    const f = frameAt(dive, 0.7, LINEUPS);
    expect(f.keeper?.pose).toBe("dive"); // the frame knows the pose...
    const { rerender } = render(<Pitch frame={f} home={home} away={away} revealed={false} />);
    // ...but before the reveal the keeper is drawn as for any outcome: no pose, no turn, his usual sleeves and gloves
    expect(keeperNode("away").hasAttribute("data-pose")).toBe(false);
    expect(keeperNode("away").querySelector("[data-turn]")!.getAttribute("transform")).toBeNull();
    for (const part of ["[data-sleeves]", "[data-gloves]"]) expect(keeperNode("away").querySelector(part)!.getAttribute("d")).toBe(keeperNode("home").querySelector(part)!.getAttribute("d")); // same as the idle keeper
    rerender(<Pitch frame={f} home={home} away={away} revealed />);
    const k = keeperNode("away");
    expect(k.getAttribute("data-pose")).toBe("dive");
    expect(k.getAttribute("transform")).toMatch(/^translate\([-\d.]+ [-\d.]+\)$/); // his spot is the frame's; the turn is inside
    expect(k.querySelector("[data-turn]")!.getAttribute("transform")).toMatch(/^rotate\(-?\d+\.\d\) scale\(1 1\.2\)$/);
    expect(keeperNode("home").querySelector("[data-turn]")!.getAttribute("transform")).toBeNull();
    expect(document.querySelectorAll("[data-turn]")).toHaveLength(2); // one fixed group per keeper, none for outfielders
    rerender(<Pitch frame={frameAt(dive, 0, LINEUPS)} home={home} away={away} revealed />);
    expect(keeperNode("away").hasAttribute("data-pose")).toBe(false);
    const claim = sceneFor(ev("save", "away", 802, { p: NAMES.away[0], p2: NAMES.home[2], from: [88, 30], target: [100, 30], ball: [96, 30] }), [88, 30], 15000)!;
    rerender(<Pitch frame={frameAt(claim, 0.7, LINEUPS)} home={home} away={away} revealed={false} />);
    expect(keeperNode("away").hasAttribute("data-pose")).toBe(false);
    rerender(<Pitch frame={frameAt(claim, 0.7, LINEUPS)} home={home} away={away} revealed />);
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

// ------------------------------------------------------------------ through the real reveal gate

const OUTCOMES = ["goal", "save", "block", "miss", "woodwork"] as const;
const mirror = (side: Side, [x, y]: Pt): Pt => [side === "home" ? x : 100 - x, y];
/** A shot and each possible result, as published: the result event becomes the current scene at its `at`. */
function attack(side: Side, kind: "ground" | "long", outcome: (typeof OUTCOMES)[number], target: Pt): MatchEvent[] {
  const def: Side = side === "home" ? "away" : "home";
  const shooter = NAMES[side][2];
  const spot = mirror(side, kind === "long" ? [64, 30] : [80, 26]);
  const shot = ev("shot", side, 11, { p: shooter, chain: 3, ball: spot, long: kind === "long" ? 1 : 0 });
  const res: Record<string, Partial<MatchEvent>> = {
    goal: { side, p: shooter, target, ball: target, st: { ...ST, sc: side === "home" ? [1, 0] : [0, 1] } },
    save: { side: def, p: NAMES[def][0], p2: shooter, from: spot, target, ball: mirror(side, [96, target[1]]) },
    block: { side: def, p: NAMES[def][3], p2: shooter, from: spot, ball: mirror(side, [spot[0] + (side === "home" ? 5 : -5), spot[1]]) },
    miss: { side, p: shooter, from: spot, target: mirror(side, [100, 40]), ball: mirror(side, [100, 40]) },
    woodwork: { side, p: shooter, from: spot, post: "right", target: mirror(side, [100, 36]), ball: mirror(side, [92, 40]) },
  };
  return [shot, ev(outcome, res[outcome].side as Side, 12, { chain: 3, ...res[outcome] })];
}
/** What a viewer can tell the outcome by, besides the ball: both keepers' pose, turn, arms and gloves, and every effect node. */
function tells() {
  const k = (side: Side) => {
    const n = keeperNode(side);
    return [n.getAttribute("data-pose"), n.querySelector("[data-turn]")!.getAttribute("transform"), n.querySelector("[data-sleeves]")!.getAttribute("d"), n.querySelector("[data-gloves]")!.getAttribute("d")];
  };
  return JSON.stringify([k("home"), k("away"), screen.getByTestId("move-fx").outerHTML]);
}

describe("Pitch result scenes through the reveal gate (#205)", () => {
  it.each(["home", "away"] as Side[])("%s: a claimed save is drawn where a plain save is until revealed, then he eases off his line with the ball", (side) => {
    const def: Side = side === "home" ? "away" : "home";
    const spot = mirror(side, [88, 32]); // close and central: a claim
    const shot = sceneFor(ev("shot", side, 11, { p: NAMES[side][2], ball: spot }), spot, 6000)!;
    const res = sceneFor(ev("save", def, 12, { p: NAMES[def][0], p2: NAMES[side][2], from: spot, target: mirror(side, [100, 30]), ball: mirror(side, [96, 30]) }), shot.ball[shot.ball.length - 1], 6000, undefined, sampleN(shot.ballHeight, 1))!;
    expect(res.keeper).toMatchObject({ pose: "claim" });
    const clock = { now: 1000 };
    vi.spyOn(performance, "now").mockImplementation(() => clock.now);
    const { rerender } = render(<Pitch frame={null} home={home} away={away} revealed />);
    let drawn: Frame | null = null;
    for (let ms = 0; ms <= shot.ms; ms += 32) drawn = smooth(drawn, frameAt(shot, ms / shot.ms, LINEUPS), 32);
    const startBall = drawn!.ball;
    let reached = false;
    let before = 0;
    let offAtEnd = 0;
    const at = (n: Element) => n.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!.slice(1).map(Number);
    for (let ms = 0; ms <= res.ms * 1.3; ms += 32) {
      clock.now += 32;
      const p = ms / res.ms;
      const frame = settle(res, p, smooth(drawn, frameAt(res, p, LINEUPS, undefined, 0, startBall), 32), reached);
      const gate = reveal(res, p, frame.ball, reached);
      reached = gate.reached;
      drawn = frame;
      rerender(<Pitch frame={frame} home={home} away={away} revealed={gate.revealed} />);
      const gk = frame.players.find((q) => q.gk && q.side === def)!;
      const [tx, ty] = at(keeperNode(def));
      const ball = document.querySelector('circle[stroke="#111"]')!;
      if (!gate.revealed) {
        // exactly the frame's own spot: the save scene's path, which is a plain save's (no claim offset), and the ball where the frame has it
        expect([tx, ty]).toEqual([gk.x, gk.y]);
        expect(Number(ball.getAttribute("cx"))).toBe(frame.ball[0]);
        before++;
      } else {
        offAtEnd = (tx - gk.x) * (def === "home" ? 1 : -1);
        expect(offAtEnd).toBeGreaterThanOrEqual(0); // only ever off his line, towards the play
        expect(offAtEnd).toBeLessThanOrEqual(2.5 + 1e-9);
        if (Math.hypot(gk.x - frame.ball[0], gk.y - frame.ball[1]) <= 2.5) expect(Number(ball.getAttribute("cx")) - frame.ball[0]).toBeCloseTo(tx - gk.x, 6); // with the ball
      }
    }
    expect(before).toBeGreaterThan(5);
    expect(offAtEnd).toBeCloseTo(2.5, 6); // eased all the way out within the scene
  });

  // MatchPage's loop: target frame, smoothing, settle, then reveal() decides `revealed` (the same verdict that holds the caption and
  // feed back: `holding`/`liveRevealed`). Up to that tick the keeper and the effects must not tell one outcome from another.
  const cases = (["home", "away"] as Side[]).flatMap((side) => (["ground", "long"] as const).map((kind) => ({ side, kind })));
  it.each(cases)("$side $kind shot: keeper pose and effects are the same for every outcome until it is revealed, then the result's own", ({ side, kind }) => {
    const target = mirror(side, [100, 34.5]);
    const before = new Set<string>();
    const after = new Map<string, Set<string | null>>();
    for (const outcome of OUTCOMES) {
      const events = attack(side, kind, outcome, target);
      const shot = sceneFor(events[0], events[0].ball as Pt, 6000)!;
      const res = sceneFor(events[1], shot.ball[shot.ball.length - 1], 6000, undefined, sampleN(shot.ballHeight, 1))!;
      const { rerender, unmount } = render(<Pitch frame={null} home={home} away={away} revealed />);
      let drawn: Frame | null = null;
      for (let ms = 0; ms <= shot.ms; ms += 32) drawn = smooth(drawn, frameAt(shot, ms / shot.ms, LINEUPS), 32);
      const startBall = drawn!.ball;
      let reached = false;
      let shown = false;
      const poses = new Set<string | null>();
      for (let ms = 0; ms <= res.ms * 1.2; ms += 32) {
        const p = ms / res.ms;
        const frame = settle(res, p, smooth(drawn, frameAt(res, p, LINEUPS, undefined, 0, startBall), 32), reached);
        const gate = reveal(res, p, frame.ball, reached);
        reached = gate.reached;
        drawn = frame;
        rerender(<Pitch frame={frame} home={home} away={away} revealed={gate.revealed} />);
        if (!gate.revealed) {
          expect(shown, `${outcome}: the gate never closes again`).toBe(false);
          before.add(tells());
        } else {
          shown = true;
          poses.add(document.querySelector('[data-gk][data-pose]')?.getAttribute("data-pose") ?? null);
        }
      }
      expect(shown, `${outcome} is revealed`).toBe(true);
      after.set(outcome, poses);
      unmount();
    }
    expect([...before], "pre-reveal drawing (keepers + effects) across all outcomes").toHaveLength(1);
    expect(JSON.parse([...before][0])[0][0]).toBeNull(); // the neutral keeper: no pose
    expect(after.get("save")!.has("dive")).toBe(true); // ...and from the reveal, each result's own
    expect(after.get("goal")!.has("dive")).toBe(true);
    expect(after.get("miss")!.has("dive") || after.get("miss")!.has("claim")).toBe(false);
  });
});

function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
}

describe("Pitch move effects at catch-up speed (#205)", () => {
  it("never pile up: a fast-forwarded backlog keeps the same four effect nodes and a bounded drawing every tick", () => {
    // #218: the final-third turnovers' extra draws left seed 4242's first 100 events with no cross or long shot; 4243 has
    // through balls, crosses and a long shot.
    const st = eng.createMatch({ fixtureId: "cu", seed: 4243, kickoffAt: 0, home: team(3), away: team(9), timing: eng.buildTiming(6000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12).slice(0, 100);
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
      for (let ms = 0; ms < s.ms; ms += 128) { // sampled: every other catch-up tick
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
    expect(ticks).toBeGreaterThan(60);
    expect(kinds.size).toBeGreaterThanOrEqual(3); // the run really exercised several move kinds
    expect(Math.max(...counts)).toBeLessThan(200);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3); // only the carrier ring and name (and a banner glow) come and go
  }, 60000);
});
