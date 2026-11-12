/**
 * #205: every move has its own signature on the pitch, as pure data from the scene and frame functions; the keeper's dive or claim
 * is a result-scene pose only; and nothing drawn for a shot before its result is current can depend on that result.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEEPER_RESULTS, sample, sampleN, sceneFor, touchStyle, type Pt, type Scene } from "./scenes";
import { frameAt, smooth, type Frame, type Lineups } from "./sim";
import { BURST_MS, PASS_FADE_MS, TRACE_N, crossBend, keeperPose, moveFx } from "./moves";
import { commentaryLine } from "./commentary";
import type { MatchEvent, PubState, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const NAMES = { home: ["Kai Home", "Ada Passer", "Ben Runner", "Cy Stopper", "Di Wide"], away: ["Lu Away", "Mo Passer", "Ned Runner", "Oz Stopper", "Pip Wide"] } as const;
const LINEUPS: Lineups = {
  home: NAMES.home.map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
  away: NAMES.away.map((name, i) => ({ name, no: i + 1, role: i ? "att" : "gk", starter: true })),
};
const ST: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 1200, run: 1 }, pos: 50, x: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], d: 0, win: null, by: null };
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const mirror = (side: Side, [x, y]: Pt): Pt => [side === "home" ? x : 100 - x, y];
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];
const key = (side: Side, name: string) => `${side}:${NAMES[side].indexOf(name as never) + 1}`;
const ev = (t: string, side: Side, seq: number, extra: Partial<MatchEvent>): MatchEvent => ({ seq, at: seq * 1000, min: 20, t, side, text: `${t} ${seq}`, st: ST, ...extra }) as MatchEvent;
/** First seq from `from` whose plain pass is drawn as `touch`. */
const seqFor = (touch: string, from = 300) => {
  let s = from;
  while (touchStyle(s) !== touch) s++;
  return s;
};
/** Largest distance of any point from the chord first → last. */
function bulge(pts: Pt[]) {
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return Math.max(...pts.map(([x, y]) => Math.abs((x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])) / len));
}

describe("#205 move signatures (pure data)", () => {
  for (const side of ["home", "away"] as Side[]) {
    const [, passer, runner] = NAMES[side];

    it(`${side}: a pass draws a faint straight line from the passer to the receiver that fades within ${PASS_FADE_MS} ms`, () => {
      const seq = seqFor("quick");
      const e = ev("pass", side, seq, { p: passer, p2: runner, from: mirror(side, [40, 30]), ball: mirror(side, [54, 36]) });
      const s = sceneFor(e, e.from as Pt, 15000)!;
      expect(s.move).toBe("pass");
      const f = frameAt(s, 0.05, LINEUPS);
      expect(f.fx!.kind).toBe("pass");
      expect(f.fx!.line).toEqual([[...(e.from as Pt), 0], [...(e.ball as Pt), 0]]); // straight, on the ground, passer to receiver
      expect(f.fx!.alpha).toBeGreaterThan(0.3);
      expect(f.fx!.alpha).toBeLessThanOrEqual(0.5); // faint
      expect(f.fx!.spot ?? f.fx!.sprint ?? f.fx!.burst).toBeUndefined();
      expect(frameAt(s, PASS_FADE_MS / s.ms + 0.01, LINEUPS).fx).toBeUndefined(); // gone quickly
      // a carry's line only appears at the release, from where he lets it go
      const cs = seqFor("carry");
      const c = sceneFor({ ...e, seq: cs }, e.from as Pt, 15000)!;
      expect(frameAt(c, 0.3, LINEUPS).fx).toBeUndefined();
      expect(frameAt(c, 0.55, LINEUPS).fx!.line[0].slice(0, 2)).toEqual(c.ball[1]);
    });

    it(`${side}: a through ball is played into marked space, its line dashed out to the spot, and the runner sprints onto it`, () => {
      const e = ev("through_ball", side, 501, { p: passer, p2: runner, from: mirror(side, [48, 30]), ball: mirror(side, [70, 22]) });
      const s = sceneFor(e, e.from as Pt, 15000)!;
      expect(s.move).toBe("through");
      for (const t of [0.1, 0.5, 0.8]) {
        const fx = frameAt(s, t, LINEUPS).fx!;
        expect(fx.kind).toBe("through");
        expect(fx.spot!.at).toEqual(e.ball); // the space it is played into
        expect(fx.sprint!.key).toBe(key(side, runner)); // the named runner, sprinting...
        expect(fx.sprint!.to).toEqual(e.ball); // ...onto it
        expect(fx.line).toEqual([[...(e.from as Pt), 0], [...(e.ball as Pt), 0]]);
      }
      expect(frameAt(s, 1, LINEUPS).fx?.spot).toBeUndefined(); // collected: the marker goes
      expect(s.ms).toBeLessThan(sceneFor(ev("pass", side, seqFor("quick"), { p: passer, p2: runner, from: e.from, ball: e.ball }), e.from as Pt, 15000)!.ms); // faster than a pass
    });

    it(`${side}: a cross is a curved, lofted arc from the wing into the box, traced behind the ball, endpoints untouched`, () => {
      const e = ev("cross", side, 601, { p: passer, p2: runner, chain: 7, from: mirror(side, [56, 28]), ball: mirror(side, [76, 6]) });
      const s = sceneFor(e, e.from as Pt, 15000)!;
      expect(s.move).toBe("cross");
      expect(frameAt(s, 0.45, LINEUPS).fx).toBeUndefined(); // nothing while the winger shapes to cross
      const f = frameAt(s, 0.74, LINEUPS);
      const fx = f.fx!;
      expect(fx.kind).toBe("cross");
      expect(fx.line).toHaveLength(TRACE_N);
      expect(fx.line[0].slice(0, 2)).toEqual(e.ball); // from the wing
      expect(Math.max(...fx.line.map((p) => p[2]))).toBeGreaterThan(0.8); // lofted
      expect(bulge(fx.line.map(([x, y]) => [x, y] as Pt))).toBeGreaterThan(1.5); // curved on the ground, not a straight ball
      // the ball itself curls in mid-flight (towards the goal) and is exactly on the winger and the drop either side of it
      const [bx] = crossBend(s, 0.625);
      expect(Math.sign(bx)).toBe(side === "home" ? 1 : -1);
      expect(frameAt(s, 0.625, LINEUPS).ball).toEqual([sample(s.ball, 0.625)[0] + bx, sample(s.ball, 0.625)[1] + crossBend(s, 0.625)[1]]);
      expect(crossBend(s, 0.5)).toEqual([0, 0]);
      expect(crossBend(s, 0.75)).toEqual([0, 0]);
      expect(frameAt(s, 1, LINEUPS).ball).toEqual(sample(s.ball, 1));
    });

    it(`${side}: a long shot is a run-up then a rising strike; an ordinary shot or header has no signature`, () => {
      const shot = ev("shot", side, 701, { p: passer, ball: mirror(side, [64, 36]), long: 1 });
      const s = sceneFor(shot, shot.ball as Pt, 15000)!;
      expect(s.move).toBe("long");
      const early = frameAt(s, 0.1, LINEUPS).fx!;
      expect(early.sprint!.key).toBe(key(side, passer)); // he ran onto it
      expect(early.sprint!.to).toEqual(mirror(side, [100, 32])); // neutral: towards goal centre, never the result
      const late = frameAt(s, 0.95, LINEUPS).fx!;
      expect(late.sprint).toBeUndefined();
      expect(late.line[0].slice(0, 2)).toEqual(shot.ball);
      expect(late.line[late.line.length - 1][2]).toBeGreaterThan(late.line[0][2] + 0.3); // rising
      // the result carries the strike on: still climbing after the launch, then down to where it is decided
      const lift = sampleN(s.ballHeight, 1);
      const miss = sceneFor(ev("miss", side, 702, { p: passer, from: shot.ball, target: mirror(side, [100, 40]), ball: mirror(side, [100, 40]) }), end(s), 15000, undefined, lift)!;
      expect(miss.move).toBe("long");
      expect(Math.max(...miss.ballHeight!)).toBeGreaterThan(lift);
      expect(frameAt(miss, 0.4, LINEUPS).fx!.kind).toBe("long");
      for (const plain of [{ long: 0 }, { header: 1 }]) {
        const o = sceneFor({ ...shot, ...plain }, shot.ball as Pt, 15000)!;
        expect(o.move).toBeUndefined();
        for (const t of [0, 0.3, 0.9]) expect(frameAt(o, t, LINEUPS).fx).toBeUndefined();
      }
    });

    it(`${side}: a save is a dive towards the ball, a close-range save a claim off the line, both in the save scene only`, () => {
      const def = other(side);
      const wide = sceneFor(ev("save", def, 801, { p: NAMES[def][0], p2: passer, from: mirror(side, [74, 30]), target: mirror(side, [100, 35]), ball: mirror(side, [96, 35]) }), mirror(side, [74, 30]), 15000)!;
      expect(wide.keeper!.pose).toBe("dive");
      expect(frameAt(wide, 0, LINEUPS).keeper).toBeUndefined(); // not before he reacts
      const k = frameAt(wide, 0.5, LINEUPS).keeper!;
      expect(k).toMatchObject({ side: def, pose: "dive", k: 1 });
      expect(Math.sign(k.dir[1])).toBe(1); // towards the ball's side of the goal (y 35 > 32)...
      expect(Math.sign(k.dir[0])).toBe(def === "home" ? 1 : -1); // ...and forward, at it
      const close = sceneFor(ev("save", def, 802, { p: NAMES[def][0], p2: passer, from: mirror(side, [88, 30]), target: mirror(side, [100, 30]), ball: mirror(side, [96, 30]) }), mirror(side, [88, 30]), 15000)!;
      expect(close.keeper!.pose).toBe("claim");
      const line = mirror(side, [97, 32])[0];
      expect(Math.abs(close.impact![0] - line)).toBeGreaterThanOrEqual(3.5); // he comes off his line for it
      expect(end(close)).toEqual(close.impact); // and holds it
      expect(frameAt(close, 0.6, LINEUPS).keeper!.pose).toBe("claim");
      // a header off a cross from anywhere the engine heads it (10–16 out): the claim carries the header's launch straight on (#190)
      for (const x of [84, 86, 88, 90]) {
        const spot = mirror(side, [x, 34]);
        const header = sceneFor(ev("shot", side, 803, { p: passer, ball: spot, header: 1 }), spot, 15000)!;
        const save = sceneFor(ev("save", def, 804, { p: NAMES[def][0], p2: passer, from: spot, target: mirror(side, [100, 30]), ball: mirror(side, [96, 30]) }), end(header), 15000, undefined, sampleN(header.ballHeight, 1))!;
        expect(save.keeper!.pose, `x=${x}`).toBe("claim");
        expect(save.ball[0], `x=${x}: no lead-in back to the header point`).toEqual(end(header));
        expect(save.ball).toHaveLength(4);
        const toGoal = (p: Pt) => (side === "home" ? p[0] : -p[0]);
        expect(toGoal(save.impact!), `x=${x}`).toBeGreaterThan(toGoal(end(header)) + 1); // the ball keeps going towards him
      }
    });

    it(`${side}: woodwork rattles the frame where it hits, only from the moment it hits, and the ball comes back off it`, () => {
      for (const post of ["left", "bar"]) {
        const target = mirror(side, [100, post === "bar" ? 32 : 28]);
        const w = sceneFor(ev("woodwork", side, 901, { p: passer, post, from: mirror(side, [80, 30]), target, ball: mirror(side, [92, post === "bar" ? 32 : 24]) }), mirror(side, [80, 30]), 15000)!;
        const hit = 2 / 3; // [from, approach, post, rebound]
        expect(frameAt(w, hit - 0.05, LINEUPS).fx?.burst).toBeUndefined();
        const b = frameAt(w, hit + 0.02, LINEUPS).fx!.burst!;
        expect(b.at).toEqual(target);
        expect(frameAt(w, hit + BURST_MS / w.ms + 0.01, LINEUPS).fx?.burst).toBeUndefined();
        expect(Math.abs(end(w)[0] - target[0])).toBeGreaterThanOrEqual(8); // rebounds back into play
        if (post === "bar") expect(sampleN(w.ballHeight, hit)).toBeGreaterThan(0.9); // the bar is hit in the air
      }
    });
  }

  it("the four ball moves are told apart by their data alone", () => {
    const side: Side = "home";
    const [, passer, runner] = NAMES[side];
    const pass = sceneFor(ev("pass", side, seqFor("quick"), { p: passer, p2: runner, from: [40, 30], ball: [54, 36] }), [40, 30], 15000)!;
    const tb = sceneFor(ev("through_ball", side, 501, { p: passer, p2: runner, from: [40, 30], ball: [62, 24] }), [40, 30], 15000)!;
    const cross = sceneFor(ev("cross", side, 601, { p: passer, p2: runner, from: [56, 28], ball: [76, 6] }), [56, 28], 15000)!;
    const long = sceneFor(ev("shot", side, 701, { p: passer, ball: [64, 36], long: 1 }), [64, 36], 15000)!;
    const sig = (s: Scene, t: number) => {
      const fx = frameAt(s, t, LINEUPS).fx!;
      const pts = fx.line.map(([x, y]) => [x, y] as Pt);
      return { kind: fx.kind, spot: !!fx.spot, sprint: !!fx.sprint, curved: pts.length > 2 && bulge(pts) > 1, lofted: Math.max(...fx.line.map((p) => p[2])) > 0.3 };
    };
    const all = [sig(pass, 0.1), sig(tb, 0.5), sig(cross, 0.74), sig(long, 0.4)];
    expect(all).toEqual([
      { kind: "pass", spot: false, sprint: false, curved: false, lofted: false },
      { kind: "through", spot: true, sprint: true, curved: false, lofted: false },
      { kind: "cross", spot: false, sprint: false, curved: true, lofted: true },
      { kind: "long", spot: false, sprint: true, curved: false, lofted: true },
    ]);
  });
});

// ------------------------------------------------------------------ the shot never shows its result

/** Scenes as MatchPage builds them: chained ball and lift, each with the next already-fetched event. */
function chain(events: MatchEvent[], minuteMs: number) {
  const out: Scene[] = [];
  let prev: Pt = [50, 32];
  let lift = 0;
  events.forEach((e, i) => {
    const s = sceneFor(e, prev, minuteMs, events[i + 1], lift);
    if (!s) return;
    out.push({ ...s, caption: commentaryLine(events, i, { home: "HOM", away: "AWY" }) });
    prev = s.ball[s.ball.length - 1];
    lift = sampleN(s.ballHeight, 1);
  });
  return out;
}
const OUTCOMES = ["goal", "save", "block", "miss", "woodwork"] as const;
function attack(side: Side, kind: "ground" | "long" | "header", outcome: (typeof OUTCOMES)[number]): MatchEvent[] {
  const [, passer, runner] = NAMES[side];
  const def = other(side);
  const spot = mirror(side, kind === "long" ? [64, 30] : kind === "header" ? [86, 34] : [80, 24]);
  const lead: MatchEvent = kind === "header"
    ? ev("cross", side, 10, { p: passer, p2: runner, chain: 3, from: mirror(side, [56, 30]), ball: mirror(side, [76, 6]) })
    : ev("pass", side, 10, { p: passer, p2: runner, chain: 3, from: mirror(side, [44, 30]), ball: spot });
  const shooter = kind === "header" ? NAMES[side][3] : runner;
  const shot = ev("shot", side, 11, { p: shooter, chain: 3, ball: spot, from: kind === "header" ? lead.ball : null, header: kind === "header" ? 1 : 0, long: kind === "long" ? 1 : 0 });
  const target = mirror(side, [100, 35]);
  const res: Record<string, Partial<MatchEvent>> = {
    goal: { side, p: shooter, target, ball: target, st: { ...ST, sc: side === "home" ? [1, 0] : [0, 1] } },
    save: { side: def, p: NAMES[def][0], p2: shooter, from: spot, target, ball: mirror(side, [96, 35]) },
    block: { side: def, p: NAMES[def][3], p2: shooter, from: spot, ball: mirror(side, [spot[0] + (side === "home" ? 5 : -5), spot[1]]) },
    miss: { side, p: shooter, from: spot, target: mirror(side, [100, 40]), ball: mirror(side, [100, 40]), high: 0 } as Partial<MatchEvent>,
    woodwork: { side, p: shooter, from: spot, post: "right", target: mirror(side, [100, 36]), ball: mirror(side, [92, 40]) },
  };
  const result = ev(outcome, res[outcome].side as Side, 12, { chain: 3, text: `UNSEEN ${outcome}`, ...res[outcome] });
  const after = ev(outcome === "goal" ? "celebration" : "pass", outcome === "save" || outcome === "block" ? def : side, 13, { p: NAMES[def][1], p2: NAMES[def][2], from: mirror(side, [80, 30]), ball: mirror(side, [60, 30]) });
  return [lead, shot, result, after];
}
/** Every frame a viewer can see of the shot (and the move before it) before its result is current: the target frames over the shot's
 * life and its hold, live from a drawn start, and the smoothed frames MatchPage would draw from them. */
function preResult(events: MatchEvent[], minuteMs: number) {
  const scenes = chain(events, minuteMs);
  const lead = scenes.find((s) => s.seq === 10)!;
  const shot = scenes.find((s) => s.seq === 11)!;
  const frames: Frame[] = [];
  let drawn: Frame | null = null;
  for (let ms = 0; ms <= lead.ms + 400; ms += 16) frames.push((drawn = smooth(drawn, frameAt(lead, ms / lead.ms, LINEUPS, undefined, 5000 + ms), 16)));
  const startBall = drawn!.ball;
  const starts = Object.fromEntries(drawn!.players.map((p) => [p.side + ":" + p.no, [p.x, p.y] as Pt]));
  for (let ms = 0; ms <= shot.ms * 1.8; ms += 16) {
    const target = frameAt(shot, ms / shot.ms, LINEUPS, undefined, 9000 + ms, startBall, lead, ms, starts);
    frames.push(target, (drawn = smooth(drawn, target, 16)));
  }
  return { frames, captions: [lead.caption, shot.caption], scenes: [lead, shot] };
}

describe("#205 no reveal: a shot's frames are the same whatever its result", () => {
  const cases = (["home", "away"] as Side[]).flatMap((side) => (["ground", "long", "header"] as const).flatMap((kind) => [15000, 6000].map((minuteMs) => ({ side, kind, minuteMs }))));
  it.each(cases)("$side $kind shot at $minuteMs ms/min: every pre-result frame (fx and keeper included) is identical across goal, save, block, miss and woodwork", ({ side, kind, minuteMs }) => {
    const runs = OUTCOMES.map((o) => preResult(attack(side, kind, o), minuteMs));
    for (const r of runs.slice(1)) {
      expect(r.scenes).toEqual(runs[0].scenes);
      expect(r.captions).toEqual(runs[0].captions);
      expect(r.frames.length).toBe(runs[0].frames.length);
      r.frames.forEach((f, i) => expect(f, `frame ${i}`).toEqual(runs[0].frames[i]));
    }
    for (const f of runs[0].frames) {
      expect(f.keeper).toBeUndefined(); // no dive or claim before the result
      expect(f.fx?.burst).toBeUndefined(); // no woodwork before the result
      expect(f.flash ?? null).toBeNull();
      if (f.seq === 11 && f.fx?.sprint) expect(f.fx.sprint.to).toEqual(mirror(side, [100, 32])); // the shot aims neutrally
    }
    for (const r of runs) expect(r.captions.join(" ")).not.toContain("UNSEEN");
    // and the result scene is where they differ
    const results = OUTCOMES.map((o) => chain(attack(side, kind, o), minuteMs).find((s) => s.seq === 12)!);
    expect(new Set(results.map((s) => JSON.stringify([s.ball, s.keeper ?? null]))).size).toBe(OUTCOMES.length);
  });
});

// ------------------------------------------------------------------ keepers move only in result scenes (real engine)

function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
}

describe("#205 keeper dives and claims (real engine matches)", () => {
  it("appear only in result scenes, never in a shot, and saves get both dives and claims", () => {
    const poses = new Map<string, Set<string>>();
    let shotFrames = 0;
    for (let i = 0; i < 16; i++) {
      const st = eng.createMatch({ fixtureId: "k" + i, seed: 5000 + i, kickoffAt: 0, home: team(i % 16), away: team((i * 5 + 1) % 16), timing: eng.buildTiming(1000, 1) });
      const events: MatchEvent[] = eng.advanceTo(st, 1e12);
      const lineups = Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;
      for (const s of chain(events, 15000)) {
        if (s.keeper) expect(KEEPER_RESULTS.has(s.type), `${s.type} #${s.seq}`).toBe(true);
        for (let t = 0; t <= 1.2; t += 0.1) {
          const f = frameAt(s, t, lineups);
          if (s.type === "shot") {
            shotFrames++;
            expect(f.keeper, `shot #${s.seq}`).toBeUndefined();
          }
          if (f.keeper) {
            expect(KEEPER_RESULTS.has(s.type), `${s.type} #${s.seq}`).toBe(true);
            expect(keeperPose(s, t)).toEqual(f.keeper);
            if (!poses.has(s.type)) poses.set(s.type, new Set());
            poses.get(s.type)!.add(f.keeper.pose);
          }
        }
      }
    }
    expect(shotFrames).toBeGreaterThan(300);
    expect([...(poses.get("save") ?? [])].sort()).toEqual(["claim", "dive"]);
    expect(poses.get("goal")).toEqual(new Set(["dive"]));
  }, 60000);

  it("only result scenes carry a move effect that could give a result away (rattle), and every shot effect is built from the shot alone", () => {
    const s = sceneFor(ev("shot", "home", 5, { p: NAMES.home[1], ball: [62, 30], long: 1 }), [62, 30], 15000)!;
    for (let t = 0; t <= 1.5; t += 0.05) {
      const fx = moveFx(s, t, () => "home:2");
      expect(fx?.burst).toBeUndefined();
      expect(fx?.spot).toBeUndefined();
    }
  });
});
