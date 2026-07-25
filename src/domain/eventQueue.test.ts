import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createEventQueue } from "./eventQueue";
import { scoreFromRevealedEvents, goalHasMessage } from "./scoreFromRevealed";

function ev(
  seq: number,
  type: string,
  sh: number,
  sa: number,
  psh = 0,
  psa = 0,
  msg = "msg",
) {
  return {
    seq,
    type,
    scoreHome: sh,
    scoreAway: sa,
    shootoutHome: psh,
    shootoutAway: psa,
    message: msg,
    minute: seq,
    phase: "first_half",
    offsetMs: seq * 100,
  };
}

describe("event queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates by seq", () => {
    const q = createEventQueue({ reducedMotion: true });
    q.ingest([ev(1, "kickoff", 0, 0), ev(1, "kickoff", 0, 0)]);
    vi.runAllTimers();
    const s = q.getState();
    expect(s.revealed.filter((e) => e.seq === 1)).toHaveLength(1);
    q.dispose();
  });

  it("preserves order when catching up bulk", () => {
    const q = createEventQueue({ reducedMotion: true });
    const many = Array.from({ length: 10 }, (_, i) =>
      ev(i + 1, i === 5 ? "goal" : "midfield_play", i >= 5 ? 1 : 0, 0, 0, 0, "x"),
    );
    q.ingest(many, { reset: true, catchUp: true });
    vi.runAllTimers();
    const s = q.getState();
    const seqs = s.revealed.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    q.dispose();
  });

  it("catchUpToLive flushes pending", () => {
    const q = createEventQueue({ reducedMotion: false });
    q.ingest([ev(1, "kickoff", 0, 0), ev(2, "goal", 1, 0, 0, 0, "GOAL!")]);
    expect(q.getState().pending.length).toBeGreaterThan(0);
    q.catchUpToLive();
    expect(q.getState().pending).toHaveLength(0);
    expect(q.getState().score.scoreHome).toBe(1);
    q.dispose();
  });
});

describe("score from revealed", () => {
  it("does not score until goal event revealed", () => {
    const events = [ev(1, "kickoff", 0, 0), ev(2, "build_up", 0, 0), ev(3, "goal", 1, 0, 0, 0, "Goal!")];
    expect(scoreFromRevealedEvents(events.slice(0, 2)).scoreHome).toBe(0);
    expect(scoreFromRevealedEvents(events).scoreHome).toBe(1);
  });

  it("penalty miss does not require score change", () => {
    const events = [
      ev(1, "penalty_awarded", 0, 0),
      ev(2, "penalty_missed", 0, 0, 0, 0, "Miss!"),
    ];
    const s = scoreFromRevealedEvents(events);
    expect(s.scoreHome).toBe(0);
    expect(s.scoreAway).toBe(0);
  });

  it("shootout goal updates shootout only conceptually", () => {
    const events = [
      ev(1, "full_time", 1, 1),
      ev(2, "shootout_goal", 1, 1, 1, 0, "Scores!"),
    ];
    const s = scoreFromRevealedEvents(events);
    expect(s.scoreHome).toBe(1);
    expect(s.scoreAway).toBe(1);
    expect(s.shootoutHome).toBe(1);
  });

  it("goals have messages", () => {
    expect(goalHasMessage(ev(1, "goal", 1, 0, 0, 0, "P. Blue scores!"))).toBe(true);
    expect(goalHasMessage(ev(1, "goal", 1, 0, 0, 0, ""))).toBe(false);
  });
});
