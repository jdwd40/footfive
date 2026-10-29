/** FF-190: published shots launch before their result exists. Authored mirrored cases; no engine oracle. */
import { describe, expect, it } from "vitest";
import { sample, sampleN, sceneFor, type Pt, type Scene } from "./scenes";
import { frameAt, reveal, settle, smooth, type Lineups } from "./sim";
import type { MatchEvent, Side } from "../lib/pocketbase";

const lineups: Lineups = {
  home: ["Keeper H", "Shooter H", "Runner H", "Wide H", "Back H"].map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
  away: ["Keeper A", "Shooter A", "Runner A", "Wide A", "Back A"].map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
};
const mirror = (side: Side, [x, y]: Pt): Pt => [side === "home" ? x : 100 - x, y];
const distance = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const end = (s: Scene) => s.ball[s.ball.length - 1];
const kinds = ["ground", "long", "header"] as const;
const outcomes = ["goal", "save", "block", "miss", "woodwork"] as const;
function shot(side: Side, kind: typeof kinds[number]): MatchEvent {
  return { seq: 401, at: 20000, min: 20, t: "shot", side, p: lineups[side][1].name, ball: mirror(side, [80, 12]), from: mirror(side, [80, 12]), header: kind === "header" ? 1 : undefined, long: kind === "long" ? 1 : undefined, text: "Shoots", st: { sc: [0, 0], so: null, ph: "first_half", clk: { s: 1200, run: 1 }, pos: 50, x: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], d: 0, win: null, by: null } };
}
function result(s: MatchEvent, t: typeof outcomes[number]): MatchEvent {
  const defending = s.side === "home" ? "away" : "home";
  return { ...s, seq: 402, at: 21200, t, header: undefined, long: undefined, side: t === "save" || t === "block" ? defending : s.side, from: s.ball, target: mirror(s.side as Side, [100, 42]), ball: mirror(s.side as Side, [88, 24]), text: `UNSEEN ${t}`, st: { ...s.st, sc: t === "goal" ? [1, 0] : [0, 0] } };
}
const cases = (["home", "away"] as Side[]).flatMap(side => kinds.flatMap(kind => [5000, 8000].map(ms => ({ side, kind, ms }))));

describe("FF-190 shot release", () => {
  it.each(cases)("$side $kind at $ms: positive 16ms drawn release, forward flight and no shooter detour/ring", ({ side, kind, ms }) => {
    const e = shot(side, kind);
    const s = sceneFor(e, e.ball as Pt, ms)!;
    const origin = e.ball as Pt;
    const aim = mirror(side, [100, 32]);
    const progress = (p: Pt) => (p[0] - origin[0]) * (aim[0] - origin[0]) + (p[1] - origin[1]) * (aim[1] - origin[1]);
    expect(distance(end(s), origin)).toBeLessThanOrEqual((kind === "long" ? 3 : 2) + 1e-9);
    expect(progress(end(s))).toBeGreaterThan(0);
    const actor = s.actors.find(a => a.label && a.side === side)!;
    expect(actor.path[0]).toEqual(origin);
    for (const p of actor.path) expect(progress(p)).toBeGreaterThanOrEqual(-1e-9);
    let drawn = frameAt(s, 0, lineups);
    let previous = 0;
    for (let elapsed = 16; elapsed <= s.ms; elapsed += 16) {
      const p = elapsed / s.ms;
      drawn = smooth(drawn, frameAt(s, p, lineups), 16);
      expect(progress(drawn.ball), `elapsed=${elapsed}`).toBeGreaterThan(previous);
      expect(drawn.carrier ?? null).toBeNull();
      expect(drawn.flash ?? null).toBeNull();
      expect(drawn.score).toEqual([0, 0]);
      previous = progress(drawn.ball);
    }
    if (kind === "ground") expect(sampleN(s.ballHeight, 0.5)).toBe(0);
    else expect(sampleN(s.ballHeight, 0.5)).toBeGreaterThan(0.3);
    if (kind === "long") expect(sampleN(s.ballHeight, 0.5)).toBeGreaterThan(0.3);
  });

  it.each(["home", "away"] as Side[])("%s: unseen alternative outcomes cannot change any shot prefix", side => {
    for (const kind of kinds) {
      const e = Object.freeze(shot(side, kind));
      const scenes = outcomes.map(t => sceneFor(e, e.ball as Pt, 5000, result(e, t))!);
      for (const s of scenes) {
        expect(s).toEqual(scenes[0]);
        for (const p of [0, 0.04, 0.3, 0.8, 1]) expect(frameAt(s, p, lineups)).toEqual(frameAt(scenes[0], p, lineups));
        expect(s.caption).not.toContain("UNSEEN");
      }
    }
  });
});

describe("FF-190 unchanged result contacts", () => {
  it.each((["home", "away"] as Side[]).flatMap(side => outcomes.map(t => ({ side, t }))))("$side $t: off-axis continuation retains exact contact/end and reveal gate", ({ side, t }) => {
    for (const kind of kinds) {
      const e = shot(side, kind);
      const launch = sceneFor(e, e.ball as Pt, 5000)!;
      const r = result(e, t);
      const canonical = sceneFor(r, e.ball as Pt, 5000)!;
      const lift = sampleN(launch.ballHeight, 1);
      const continued = sceneFor(r, end(launch), 5000, undefined, lift)!;
      expect(continued.ball[0]).toEqual(end(launch));
      expect(continued.impact).toEqual(canonical.impact);
      expect(end(continued)).toEqual(end(canonical));
      expect(continued.ball.slice(1)).toEqual(canonical.ball.slice(1));
      // MatchPage may start from a still-lagging DRAWN position. Its first target cannot teleport back to the authored origin.
      const startBall: Pt = [end(launch)[0] + (side === "home" ? -0.1 : 0.1), end(launch)[1]];
      let drawn = frameAt(continued, 0, lineups, undefined, 0, startBall);
      expect(drawn.ball).toEqual(startBall);
      const first = smooth(drawn, frameAt(continued, 16 / continued.ms, lineups, undefined, 16, startBall), 16);
      const towards: Pt = [continued.impact![0] - startBall[0], continued.impact![1] - startBall[1]];
      expect((first.ball[0] - startBall[0]) * towards[0] + (first.ball[1] - startBall[1]) * towards[1]).toBeGreaterThan(0);
      drawn = first;
      expect(drawn.carrier ?? null).toBeNull();
      // Goal, miss and woodwork have an independently authored corner target; block remains only four units ahead.
      if (["goal", "miss", "woodwork"].includes(t)) expect(continued.impact).toEqual(mirror(side, [100, 42]));
      if (t === "block") expect(Math.abs(continued.impact![0] - (e.ball as Pt)[0])).toBe(4);
      expect(sampleN(continued.ballHeight, 0)).toBeCloseTo(lift, 8);
      const direction: Pt = [continued.impact![0] - continued.ball[0][0], continued.impact![1] - continued.ball[0][1]];
      let previous = -1;
      // First leg is before every impact, including the short block. Rebounds after contact are deliberately allowed.
      for (let p = 0; p <= 0.24; p += 0.02) {
        const b = sample(continued.ball, p);
        const progress = (b[0] - continued.ball[0][0]) * direction[0] + (b[1] - continued.ball[0][1]) * direction[1];
        expect(progress).toBeGreaterThanOrEqual(previous);
        previous = progress;
      }
      expect(reveal(continued, 0, continued.ball[0], false).revealed).toBe(false);
      expect(reveal(continued, 1, continued.impact!, true).revealed).toBe(true);
      const target = frameAt(continued, 1, lineups);
      const settled = settle(continued, 1, { ...target, ball: continued.ball[0] }, false);
      expect(settled.ball).toEqual(continued.impact);
    }
  });
});
