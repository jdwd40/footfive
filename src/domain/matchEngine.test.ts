import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  goalMessageBeforeOrWithScore,
  shootoutDoesNotChangeNormalScore,
  visibleScoreFromEvents,
} from "./reconstruct";

const require = createRequire(import.meta.url);
const engine = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/matchEngine.js"),
) as {
  createMatchState: (opts: Record<string, unknown>) => Record<string, unknown>;
  advanceSegment: (
    state: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => { newEvents: unknown[]; finished: boolean; state: Record<string, unknown> };
  simulateMatch: (opts: Record<string, unknown>) => {
    events: Array<{
      type: string;
      scoreHome: number;
      scoreAway: number;
      shootoutHome: number;
      shootoutAway: number;
      message: string;
      offsetMs: number;
      seq: number;
    }>;
    scoreHome: number;
    scoreAway: number;
    winnerSide: string;
    wentExtraTime: boolean;
    wentShootout: boolean;
    durationMs: number;
  };
  reconstructVisible: (
    events: unknown[],
    elapsed: number,
    opts?: { sinceSeq?: number },
  ) => {
    scoreHome: number;
    scoreAway: number;
    finished: boolean;
    events: unknown[];
    lastSeq: number;
  };
  coachingMod: (s: string) => { attack: number; defence: number };
};

const sampleTeam = (name: string, grade: string, atk: number, def: number) => ({
  name,
  grade,
  players: [
    { name: `${name} Att`, role: "att", attack: atk, defence: 30, is_starter: true },
    { name: `${name} Mid1`, role: "mid", attack: atk - 5, defence: 50, is_starter: true },
    { name: `${name} Mid2`, role: "mid", attack: atk - 8, defence: 55, is_starter: true },
    { name: `${name} Def`, role: "def", attack: 30, defence: def, is_starter: true },
    { name: `${name} Gk`, role: "gk", attack: 15, defence: def + 5, is_starter: true },
    { name: `${name} Sub1`, role: "att", attack: atk - 10, defence: 30, is_starter: false },
    { name: `${name} Sub2`, role: "def", attack: 28, defence: def - 5, is_starter: false },
  ],
});

describe("incremental match engine", () => {
  it("does not finalise at kickoff", () => {
    const state = engine.createMatchState({
      home: sampleTeam("Alpha", "A", 80, 70),
      away: sampleTeam("Beta", "B", 70, 65),
      seed: 42,
      pace: "test",
    });
    expect(state.finalised).toBe(false);
    expect(state.events).toEqual([]);
    const r = engine.advanceSegment(state, {});
    expect(r.state.finalised).toBe(false);
    expect((r.state.events as unknown[]).length).toBeGreaterThan(0);
    expect(r.state.simMinute as number).toBeLessThan(90);
  });

  it("segment reprocess with same state advances cursor", () => {
    let state = engine.createMatchState({
      home: sampleTeam("Alpha", "A", 80, 70),
      away: sampleTeam("Beta", "B", 70, 65),
      seed: 99,
      pace: "test",
    });
    const a = engine.advanceSegment(state, {});
    state = a.state;
    const seq1 = state.seq as number;
    const b = engine.advanceSegment(state, {});
    expect((b.state.seq as number) >= seq1).toBe(true);
  });

  it("full simulateMatch still reaches match_end", () => {
    const res = engine.simulateMatch({
      home: sampleTeam("Alpha", "A", 80, 70),
      away: sampleTeam("Beta", "B", 70, 65),
      seed: "full-1",
      pace: "test",
    });
    expect(res.events[0].type).toBe("kickoff");
    expect(res.events[res.events.length - 1].type).toBe("match_end");
    expect(res.winnerSide).toMatch(/home|away/);
  });

  it("coaching modifiers differ by stance", () => {
    const d = engine.coachingMod("defend");
    const a = engine.coachingMod("attack");
    const b = engine.coachingMod("balanced");
    expect(d.defence).toBeGreaterThan(b.defence);
    expect(a.attack).toBeGreaterThan(b.attack);
    expect(d.attack).toBeLessThan(b.attack);
  });

  it("does not leak future events in reconstruct", () => {
    const res = engine.simulateMatch({
      home: sampleTeam("Alpha", "A", 80, 70),
      away: sampleTeam("Beta", "B", 70, 65),
      seed: "recon-1",
      pace: "test",
    });
    const mid = Math.floor(res.durationMs / 2);
    const vis = engine.reconstructVisible(res.events, mid);
    expect(vis.finished).toBe(false);
    for (const e of vis.events as { offsetMs: number }[]) {
      expect(e.offsetMs).toBeLessThanOrEqual(mid);
    }
  });
});

describe("score reconstruction rules", () => {
  it("goal messages accompany score events", () => {
    const events = [
      {
        type: "goal",
        scoreHome: 1,
        scoreAway: 0,
        shootoutHome: 0,
        shootoutAway: 0,
        message: "P. Blue scores!",
        offsetMs: 1000,
        seq: 1,
      },
    ];
    expect(goalMessageBeforeOrWithScore(events)).toBe(true);
    expect(visibleScoreFromEvents(events, 1000).scoreHome).toBe(1);
  });

  it("shootout goals keep normal score separate", () => {
    expect(
      shootoutDoesNotChangeNormalScore({ h: 1, a: 1 }, { h: 1, a: 1, sh: 1, sa: 0 }),
    ).toBe(true);
  });
});

describe("authoritative shootout kicks", () => {
  it("records per-kick state with team, outcome, decisive flags", () => {
    // Force shootout via equal low-scoring path: many seeds; sample until SO
    let found: {
      events: Array<{ type: string; meta?: Record<string, unknown> }>;
      scoreHome: number;
      scoreAway: number;
      wentShootout: boolean;
    } | null = null;
    for (let seed = 1; seed < 80 && !found; seed++) {
      const res = engine.simulateMatch({
        home: sampleTeam("Alpha", "A", 55, 80),
        away: sampleTeam("Beta", "B", 55, 80),
        seed: `so-${seed}`,
        pace: "test",
      });
      if (res.wentShootout) found = res;
    }
    expect(found).toBeTruthy();
    if (!found) return;

    // Normal score frozen at full-time values during SO
    expect(found.scoreHome).toBe(found.scoreAway);

    const soEvents = found.events.filter((e) =>
      String(e.type).startsWith("shootout_"),
    );
    expect(soEvents.length).toBeGreaterThan(0);

    // Walk incremental state for kick array
    // Force into shootout by simulating full match
    const full = engine.simulateMatch({
      home: sampleTeam("Alpha", "A", 55, 80),
      away: sampleTeam("Beta", "B", 55, 80),
      seed: "so-state-check",
      pace: "test",
    });
    // Use full result events for meta presence
    const goalKick = full.events.find(
      (e) => e.type === "shootout_goal" || e.type === "shootout_miss" || e.type === "shootout_save",
    ) as { meta?: Record<string, unknown> } | undefined;
    if (full.wentShootout && goalKick?.meta) {
      expect(goalKick.meta.kickIndex).toBeDefined();
      expect(goalKick.meta.team === "home" || goalKick.meta.team === "away").toBe(true);
      expect(goalKick.meta.outcome).toMatch(/goal|save|miss/);
      expect(typeof goalKick.meta.decisive).toBe("boolean");
    }

    // If any SO match in sample, at least one kick has decisive true on last
    if (found.wentShootout) {
      const resultEvents = found.events.filter(
        (e) =>
          e.type === "shootout_goal" ||
          e.type === "shootout_miss" ||
          e.type === "shootout_save",
      ) as Array<{ meta?: { decisive?: boolean; kickNumber?: number } }>;
      const decisive = resultEvents.filter((e) => e.meta?.decisive);
      expect(decisive.length).toBeGreaterThanOrEqual(1);
      // Early finish or SD still has kick numbers
      for (const e of resultEvents) {
        expect((e.meta?.kickNumber || 0) >= 1).toBe(true);
      }
    }
  });

  it("keeps normal score unchanged through shootout in reconstruct", () => {
    let soMatch: ReturnType<typeof engine.simulateMatch> | null = null;
    for (let seed = 1; seed < 100 && !soMatch; seed++) {
      const res = engine.simulateMatch({
        home: sampleTeam("Alpha", "A", 50, 85),
        away: sampleTeam("Beta", "B", 50, 85),
        seed: `recon-so-${seed}`,
        pace: "test",
      });
      if (res.wentShootout) soMatch = res;
    }
    if (!soMatch) return;
    const ft = soMatch.events.find((e) => e.type === "full_time" || e.type === "extra_time_end");
    const end = soMatch.events[soMatch.events.length - 1];
    expect(end.scoreHome).toBe(soMatch.scoreHome);
    expect(end.scoreAway).toBe(soMatch.scoreAway);
    if (ft) {
      expect(end.scoreHome).toBe(ft.scoreHome);
      expect(end.scoreAway).toBe(ft.scoreAway);
    }
  });
});

describe("tournament draw", () => {
  it("pairs 16 teams into 8 fixtures", () => {
    const tourney = require(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/tournament.js"),
    ) as {
      drawRoundOf16: (ids: string[], seed: number) => Array<{ homeId: string; awayId: string }>;
    };
    const ids = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const fixtures = tourney.drawRoundOf16(ids, 42);
    expect(fixtures).toHaveLength(8);
    const used = new Set<string>();
    for (const f of fixtures) {
      expect(used.has(f.homeId)).toBe(false);
      used.add(f.homeId);
      used.add(f.awayId);
    }
    expect(used.size).toBe(16);
  });
});
