import { describe, expect, it } from "vitest";
import { sceneFor, type Pt } from "./scenes";
import { frameAt, smooth, type Frame, type Lineups } from "./sim";
import type { MatchEvent, PubState, Side } from "../lib/pocketbase";

const lineups: Lineups = {
  home: Array.from({ length: 5 }, (_, i) => ({ name: `Home P${i}`, no: i + 1, role: i === 0 ? "gk" : "att", starter: true })),
  away: Array.from({ length: 5 }, (_, i) => ({ name: `Away P${i}`, no: i + 1, role: i === 0 ? "gk" : "att", starter: true })),
};
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const cases = (["home", "away"] as Side[]).flatMap((side) => [15000, 8000].map((minuteMs) => ({ side, minuteMs })));

describe("cross rerouting after an actual preceding dwell", () => {
  it.each(cases.flatMap((c) => (["frame", "smooth"] as const).map((mode) => ({ ...c, mode }))))("$mode: $side at $minuteMs ms: winger collects the rerouted ground ball before lifting it to the named arrival", ({ side, minuteMs, mode }) => {
    const name = (n: number) => `${side === "home" ? "Home" : "Away"} P${n}`;
    const pt = (x: number, y: number): Pt => [side === "home" ? x : 100 - x, y];
    const previous: MatchEvent = { seq: 700, at: 0, min: 1, t: "pass", side, p: name(3), p2: name(1),
      from: pt(50, 38), ball: pt(56, 38), text: "previous pass", st: state };
    const pass = sceneFor(previous, pt(50, 38), minuteMs)!;
    const cross: MatchEvent = { ...previous, seq: 701, t: "cross", chain: 697, p: name(1), p2: name(2),
      from: pt(56, 38), ball: pt(79, 56), text: "wide delivery" };
    const header: MatchEvent = { ...cross, seq: 702, t: "shot", header: 1, p: name(3), from: cross.ball, ball: pt(88, 29), text: "header" };
    const scene = sceneFor(cross, pt(56, 38), minuteMs, header)!;
    const authored = JSON.stringify(scene);
    const rawStart = frameAt(pass, 1 + 13000 / pass.ms, lineups).ball;
    if (mode === "frame") {
      for (const progress of [0.25, 0.375, 0.5]) {
        const frame = frameAt(scene, progress, lineups, undefined, 0, rawStart);
        const winger = frame.players.find((p) => p.side === side && p.name === cross.p2)!;
        expect(Math.hypot(winger.x - frame.ball[0], winger.y - frame.ball[1]), `winger ground contact at p=${progress}, start=${JSON.stringify(rawStart)}`).toBeLessThanOrEqual(1.6);
        expect(frame.lift).toBe(0);
      }
      const arrival = frameAt(scene, 0.8, lineups, undefined, 0, rawStart);
      const shooter = arrival.players.find((p) => p.side === side && p.name === header.p)!;
      expect(Math.hypot(shooter.x - arrival.ball[0], shooter.y - arrival.ball[1])).toBeLessThanOrEqual(1.6);
      expect(arrival.lift).toBeGreaterThan(0.5);
      const destination = frameAt(scene, 1, lineups, undefined, 0, rawStart).ball;
      expect(destination[0]).toBeCloseTo(header.ball![0], 4);
      expect(destination[1]).toBeCloseTo(header.ball![1], 4);
      expect(JSON.stringify(scene)).toBe(authored);
      return;
    }

    let drawn: Frame = frameAt(pass, 0, lineups);
    const end = pass.ms + 13000;
    for (let elapsed = 16; elapsed <= end; elapsed += 16) drawn = smooth(drawn, frameAt(pass, elapsed / pass.ms, lineups), 16);
    if (end % 16) drawn = smooth(drawn, frameAt(pass, end / pass.ms, lineups), end % 16);
    const start: Pt = [...drawn.ball];
    let minimumGroundGap = Infinity;
    let contacts = 0;
    let elevatedContacts = 0;
    let bestProgress = 0;
    for (let elapsed = 0; elapsed <= scene.ms; elapsed += 16) {
      drawn = smooth(drawn, frameAt(scene, elapsed / scene.ms, lineups, undefined, 0, start), 16);
      const winger = drawn.players.find((p) => p.side === side && p.name === cross.p2)!;
      const arrivingShooter = drawn.players.find((p) => p.side === side && p.name === header.p)!;
      if (drawn.lift > 0.5 && Math.hypot(arrivingShooter.x - drawn.ball[0], arrivingShooter.y - drawn.ball[1]) <= 1.6) elevatedContacts++;
      if (elapsed / scene.ms >= 0.25 && elapsed / scene.ms <= 0.5 && drawn.lift < 0.05) {
        const gap = Math.hypot(winger.x - drawn.ball[0], winger.y - drawn.ball[1]);
        if (gap < minimumGroundGap) {
          minimumGroundGap = gap;
          bestProgress = elapsed / scene.ms;
        }
        if (gap <= 1.6 && drawn.carrier === `${side}:${winger.no}`) contacts++;
      }
    }
    expect(minimumGroundGap, `${side}, minuteMs=${minuteMs}, sceneMs=${scene.ms}, start=${JSON.stringify(start)}, bestProgress=${bestProgress}, contacts=${contacts}: smoothed winger must collect before flight`).toBeLessThanOrEqual(1.6);
    expect(contacts).toBeGreaterThan(0);
    expect(elevatedContacts, "same named shooter meets the elevated delivery after the ground handover").toBeGreaterThan(0);
    const reroutedEnd = frameAt(scene, 1, lineups, undefined, 0, start).ball;
    expect(reroutedEnd[0]).toBeCloseTo(header.ball![0], 4);
    expect(reroutedEnd[1]).toBeCloseTo(header.ball![1], 4);
    expect(JSON.stringify(scene)).toBe(authored);
  });

  it("sprints only hot attacking cross players and preserves ordinary, opposing, referee and ball motion", () => {
    const event: MatchEvent = { seq: 710, at: 0, min: 1, t: "cross", side: "home", p: "Home P1", p2: "Home P2",
      from: [56, 38], ball: [79, 56], text: "cross", st: state };
    const scene = sceneFor(event, [56, 38], 8000)!;
    const frame = frameAt(scene, 0, lineups);
    const target: Frame = { ...frame, players: frame.players.map((p) => ({ ...p, hot: p.no === 2 })) };
    const previous: Frame = { ...target, ball: [20, 20], ref: [20, 20], players: target.players.map((p) => ({ ...p, x: p.x - 20 })) };
    const ordinary = smooth(previous, { ...target, type: "pass" }, 16);
    const cross = smooth(previous, target, 16);
    const sprinter = cross.players.find((p) => p.side === "home" && p.no === 2)!;
    const before = previous.players.find((p) => p.side === "home" && p.no === 2)!;
    const defaultPlayer = ordinary.players.find((p) => p.side === "home" && p.no === 2)!;
    expect(sprinter.x - before.x).toBeGreaterThan(defaultPlayer.x - before.x);
    expect(Math.hypot(sprinter.x - before.x, sprinter.y - before.y)).toBeLessThanOrEqual(120 * 16 / 1000 + 1e-9);
    const others = (f: Frame) => f.players.filter((p) => !(p.side === "home" && p.no === 2));
    expect(others(cross)).toEqual(others(ordinary)); // includes a hot opponent and cold attackers
    expect(cross.ref).toEqual(ordinary.ref);
    expect(cross.ball).toEqual(ordinary.ball);
  });
});
