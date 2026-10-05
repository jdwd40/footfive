import { render, cleanup } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import { sceneFor, type Scene } from "../domain/scenes";
import { frameAt, smooth, type Frame, type Lineups } from "../domain/sim";
import type { MatchEvent, TeamPublic } from "../lib/pocketbase";
const home = { abbreviation: "HOM" } as TeamPublic, away = { abbreviation: "AWY" } as TeamPublic;
const lineups: Lineups = { home: ["Keeper", "Passer", "Receiver", "Mate", "Other"].map((name, i) => ({ name, no: i + 1, role: i ? "util" : "gk", starter: true })), away: ["Goalie", "Winner", "Defender", "Mate", "Other"].map((name, i) => ({ name, no: i + 1, role: i ? "util" : "gk", starter: true })) };
const event = (t: string, extras: Partial<MatchEvent> = {}): MatchEvent => ({ seq: 3, at: 1000, t, min: 60, text: t, side: "home", p: "Passer", p2: "Receiver", from: [30, 32], ball: [60, 32], st: { ph: "second_half" } as MatchEvent["st"], ...extras });
const draw = (f: Frame) => {
  cleanup();
  const { container } = render(<Pitch frame={f} home={home} away={away} revealed />);
  return [...container.querySelectorAll('[data-testid="player"]')].filter(n => n.querySelector("[data-ring]")).map(n => n.textContent);
};
const at = (s: Scene, t: number) => frameAt(s, t, lineups);

describe("actual carrier, never hot event actors", () => {
  it("marks the passer then receiver, none during a grounded pass; a free ball beside an unrelated actor never gives possession", () => {
    const s = sceneFor(event("pass"), [30, 32], 15000)!;
    expect(draw(at(s, 0))).toEqual(["2"]);
    expect(draw(at(s, 0.5))).toEqual([]);
    expect(draw(at(s, 1))).toEqual(["3"]);
    const free = at(s, 0.5);
    free.players[0].x = free.ball[0]; free.players[0].y = free.ball[1];
    expect(draw(free)).toEqual([]);
  });
  it("marks a dribbler only in displayed contact, not while smoothing lags behind or the ball is airborne", () => {
    const s = sceneFor(event("dribble", { p2: "Passer" }), [30, 32], 15000)!;
    const f = at(s, 0.5);
    expect(draw(f)).toEqual(["2"]);
    expect(draw({ ...f, lift: 0.5 })).toEqual([]);
    expect(draw({ ...f, ball: [80, 32] })).toEqual([]);
    const smoothed = smooth(at(s, 0), at(s, 0.7), 16);
    const p = smoothed.players.find(p => p.name === "Passer")!;
    expect(Math.hypot(p.x - smoothed.ball[0], p.y - smoothed.ball[1])).toBeGreaterThan(1.6);
    expect(draw(smoothed)).toEqual([]);
  });
  it("transfers a tackle to the winner, and a save to the keeper only after collection; keeper distribution loses its mark in flight", () => {
    const tackle = sceneFor(event("tackle", { side: "away", p: "Winner", p2: "Passer" }), [30, 32], 15000)!;
    expect(draw(at(tackle, 1))).toEqual(["2"]);
    const save = sceneFor(event("save", { side: "away", p: "Goalie", p2: "Passer", from: [70, 32], target: [100, 34], ball: [96, 34] }), [70, 32], 15000)!;
    expect(draw(at(save, 0.35))).toEqual([]);
    expect(draw(at(save, 1))).toEqual(["1"]);
    const dist = sceneFor(event("pass", { side: "away", p: "Winner", p2: "Defender", from: [96, 34], ball: [65, 32] }), [96, 34], 15000)!;
    expect(draw(at(dist, 0))).toEqual(["1"]);
    expect(draw(at(dist, 0.3))).toEqual([]);
    expect(draw(at(dist, 1))).toEqual(["3"]);
  });
  it("penalty placer has the mark only while carrying; stationary spot, run-up before contact and released shot have none", () => {
    const setup = sceneFor(event("penalty_setup"), [70, 32], 15000)!;
    expect(draw(at(setup, 0.1))).toEqual(["2"]);
    expect(draw(at(setup, 0.8))).toEqual([]);
    const kick = sceneFor(event("shootout_kick", { pen: { col: 1, height: 0, dive: -1, post: null, run: 0, outcome: "goal" } }), [89, 32], 15000)!;
    expect(draw(at(kick, 0.2))).toEqual([]);
    expect(draw(at(kick, 0.5))).toEqual(["2"]);
    expect(draw(at(kick, 0.7))).toEqual([]);
  });
  it("dwell passes have no mark in flight even though hot binding still places a player at the ball", () => {
    const s = sceneFor(event("pass"), [30, 32], 15000)!;
    expect(draw(at(s, 1 + 2400 / s.ms))).toHaveLength(1);
    expect(draw(at(s, 1 + 2750 / s.ms))).toEqual([]);
    expect(draw(at(s, 1 + 3100 / s.ms))).toHaveLength(1);
  });
});
