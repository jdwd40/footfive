/** #206: the automatic goal replay fits the natural pause after a goal and never moves the live clock: run on real engine matches. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchEvent } from "../lib/pocketbase";
import { CATCHUP_SLACK_MS, REPLAY_DELAY_MS, REPLAY_GUARD_MS, REPLAY_MIN_MS, REPLAY_MS, autoReplay, planGoalReplay, replayAt, type ReplayMemo } from "./replay";
import { sampleN, sceneFor, type Pt, type Scene } from "./scenes";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");
const team = (i: number) => ({ id: TEAMS[i].slug, name: TEAMS[i].name, abbr: TEAMS[i].abbreviation, grade: TEAMS[i].grade, players: defaultStarters(TEAMS[i].players) });
const MINUTE_MS = 6000; // the live pace

/** Events and their scenes exactly as MatchPage chains them. */
function match(seed: number) {
  const st = eng.createMatch({ fixtureId: "r" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 7 + 3) % 16), timing: eng.buildTiming(MINUTE_MS, 1) });
  const events: MatchEvent[] = eng.advanceTo(st, 1e12);
  const scenes = new Map<number, Scene>();
  let prev: Pt = [50, 32];
  let lift = 0;
  events.forEach((e, i) => {
    const s = sceneFor(e, prev, MINUTE_MS, events[i + 1], lift);
    if (!s) return;
    scenes.set(e.seq, s);
    prev = s.ball[s.ball.length - 1];
    lift = sampleN(s.ballHeight, 1);
  });
  return { events, scenes };
}
const memo = (): ReplayMemo => ({ plans: new Map(), skipped: new Set() });

describe("automatic goal replay (#206)", () => {
  const games = [3, 11, 27].map(match);
  const celebrations = games.flatMap((g) => g.events.map((e, i) => ({ ...g, i, cel: e })).filter((x) => x.cel.t === "celebration"));

  it("plays the goal's own move inside the pause before the restart, ending on the ball in the net", () => {
    expect(celebrations.length).toBeGreaterThan(2);
    for (const { events, scenes, i, cel } of celebrations) {
      const goal = events[i - 1];
      const next = events[i + 1];
      const plan = planGoalReplay(events, scenes, i)!;
      expect(plan.startAt).toBe(cel.at + REPLAY_DELAY_MS);
      expect(plan.total).toBeGreaterThanOrEqual(REPLAY_MIN_MS);
      expect(plan.total).toBeLessThanOrEqual(REPLAY_MS);
      expect(plan.startAt + plan.total).toBeLessThanOrEqual(next.at - REPLAY_GUARD_MS); // the move is over before the next event
      expect(plan.endAt).toBeLessThanOrEqual(next.at); // and its last frame never outlives it
      // only the goal's chain, in order, and its last part is the goal itself, past the moment the ball is in
      const seqs = plan.parts.map((q) => q.scene.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      for (const q of plan.parts) expect(events.find((e) => e.seq === q.scene.seq)!.chain ?? goal.chain).toBe(goal.chain);
      const last = plan.parts.at(-1)!;
      expect(last.scene.seq).toBe(goal.seq);
      expect(last.p1).toBeGreaterThan(last.scene.flashAt ?? 0.62);
      // the replay shows its parts back to back, then holds the last frame; nothing outside its window
      expect(replayAt(plan, plan.startAt - 1)).toBeNull();
      expect(replayAt(plan, plan.startAt)!.scene).toBe(plan.parts[0].scene);
      const end = replayAt(plan, plan.endAt - 1)!;
      expect(end.scene).toBe(last.scene);
      expect(end.p).toBeCloseTo(last.p1, 2);
      expect(replayAt(plan, plan.endAt)).toBeNull();
      // Live, the restart is usually not fetched yet: the last frame then holds (the restart arriving cuts it, see below).
      const blind = planGoalReplay(events.slice(0, i + 1), scenes, i)!;
      expect(blind.total).toBe(REPLAY_MS);
      expect(replayAt(blind, blind.startAt + blind.total + 100)).toMatchObject({ scene: blind.parts.at(-1)!.scene, p: blind.parts.at(-1)!.p1 });
    }
  });

  it("is skipped when the next event is due before there is room, and cut by it when it comes early", () => {
    const { events, scenes, i, cel } = celebrations[0];
    const soon = events.map((e, j) => (j === i + 1 ? { ...e, at: cel.at + REPLAY_DELAY_MS + REPLAY_MIN_MS } : e));
    expect(planGoalReplay(soon, scenes, i)).toBeNull();
    // The playhead leaves the celebration as the next event is due: autoReplay draws nothing from that moment.
    const m = memo();
    const at = cel.at + REPLAY_DELAY_MS + 200;
    expect(autoReplay(m, events, scenes, cel, at, at)).not.toBeNull();
    expect(autoReplay(m, events, scenes, events[i + 1], at + 300, at + 300)).toBeNull();
  });

  it("is a pure function of the playhead: it reads the clock, never sets it, and each tick gives the same frame", () => {
    const { events, scenes, cel } = celebrations[1];
    const m = memo();
    const t = cel.at + REPLAY_DELAY_MS + 1234;
    const a = autoReplay(m, events, scenes, cel, t, t)!;
    const b = autoReplay(m, events, scenes, cel, t, t)!;
    expect(a.scene).toBe(b.scene);
    expect(a.p).toBe(b.p);
    expect(m.plans.size).toBe(1); // planned once, not re-timed
    // before its start: the GOOOAL screen and the celebration are left alone
    expect(autoReplay(memo(), events, scenes, cel, cel.at + REPLAY_DELAY_MS - 1, cel.at + REPLAY_DELAY_MS - 1)).toBeNull();
  });

  it("is skipped for good when any of the celebration is fast-forwarded (catch-up), even once caught up", () => {
    const { events, scenes, cel } = celebrations[2];
    const m = memo();
    const t = cel.at + REPLAY_DELAY_MS + 500;
    expect(autoReplay(m, events, scenes, cel, t - 2000, t - 2000 + CATCHUP_SLACK_MS + 1)).toBeNull(); // clock behind its target
    expect(autoReplay(m, events, scenes, cel, t, t)).toBeNull();
    expect(autoReplay(memo(), events, scenes, cel, t, t)).not.toBeNull(); // the same moment, watched live
  });

  it("only follows a goal", () => {
    const { events, scenes } = games[0];
    const i = events.findIndex((e) => e.t === "save" || e.t === "pass");
    expect(planGoalReplay(events, scenes, i)).toBeNull();
    expect(autoReplay(memo(), events, scenes, events[i], events[i].at + 2000, events[i].at + 2000)).toBeNull();
  });
});
