import { describe, expect, it } from "vitest";
import { analysePolls } from "../integration/live-latency-metrics.mjs";

const LIMIT = 5000;
type Ev = { seq: number; at: number };
type Poll = { serverTimeMs: number; events: Ev[]; finished?: boolean; overdueMs?: number | null };

/** Polls every `step` ms from t0; each poll returns the events with at <= visibleAt(at). */
function simulate(evs: Ev[], { t0, n, step = 1010, publishAt = (e: Ev) => e.at, overdue = () => 0 }: {
  t0: number;
  n: number;
  step?: number;
  publishAt?: (e: Ev) => number;
  overdue?: (t: number) => number;
}): Poll[] {
  const polls: Poll[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i * step;
    polls.push({ serverTimeMs: t, events: evs.filter((e) => publishAt(e) <= t), overdueMs: overdue(t) });
  }
  return polls;
}

describe("live-latency metrics", () => {
  it("a natural ~6.4 s engine gap (main run 38987889014) is not latency", () => {
    // Shape of the failing CI run: lag 150, 1161, …, 6215, then 806 — one open-play gap of ~6.4 s.
    const t0 = 1_000_000;
    const evs: Ev[] = [
      { seq: 1, at: t0 - 4000 },
      { seq: 2, at: t0 - 2000 },
      { seq: 3, at: t0 - 150 },
      { seq: 4, at: t0 - 150 + 6419 },
      { seq: 5, at: t0 + 8000 },
      { seq: 6, at: t0 + 9500 },
      { seq: 7, at: t0 + 11000 },
    ];
    const m = analysePolls(simulate(evs, { t0, n: 15 }), { limitMs: LIMIT });
    expect(m.maxAge).toBeGreaterThan(LIMIT); // the old metric would have failed
    expect(m.ages.filter((a: number) => a > LIMIT)).toHaveLength(2);
    expect(m.deliveryOk).toBe(true);
    expect(m.maxLate).toBe(0);
    expect(m.scheduleOk).toBe(true);
  });

  it("excludes the warm-up backlog visible on the first poll", () => {
    const t0 = 1_000_000;
    const evs: Ev[] = [{ seq: 1, at: t0 - 30_000 }, { seq: 2, at: t0 - 20_000 }, { seq: 3, at: t0 + 1500 }];
    const m = analysePolls(simulate(evs, { t0, n: 5 }), { limitMs: LIMIT });
    expect(m.delivered).toBe(1);
    expect(m.maxLate).toBe(0);
  });

  it("catches the unfixed 60 s cron batches", () => {
    const t0 = 1_000_000;
    const evs: Ev[] = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, at: t0 - 50_000 + i * 2000 }));
    // Nothing visible until the cron minute lands mid-window, then everything at once.
    const m = analysePolls(simulate(evs, { t0, n: 15, publishAt: () => t0 + 7000, overdue: (t) => t - (t0 - 50_000) }), { limitMs: LIMIT });
    expect(m.deliveryOk).toBe(false);
    expect(m.maxLate).toBeGreaterThan(30_000);
    expect(m.scheduleOk).toBe(false);
  });

  it("catches a single due event held back by a late tick", () => {
    const t0 = 1_000_000;
    const evs: Ev[] = [{ seq: 1, at: t0 - 500 }, { seq: 2, at: t0 + 2000 }, { seq: 3, at: t0 + 4000 }];
    const m = analysePolls(simulate(evs, { t0, n: 15, publishAt: (e) => (e.seq === 3 ? e.at + 7000 : e.at) }), { limitMs: LIMIT });
    expect(m.deliveryOk).toBe(false);
    expect(m.maxLate).toBeGreaterThan(LIMIT);
  });

  it("catches a tick stall that lasts to the end of the window (no late event ever delivered)", () => {
    const t0 = 1_000_000;
    const evs: Ev[] = [{ seq: 1, at: t0 - 500 }, { seq: 2, at: t0 + 1000 }];
    const m = analysePolls(simulate(evs, { t0, n: 15, overdue: (t) => t - (t0 + 2000) }), { limitMs: LIMIT });
    expect(m.deliveryOk).toBe(true);
    expect(m.scheduleOk).toBe(false);
    expect(m.maxOverdue).toBeGreaterThan(LIMIT);
  });

  it("ignores ages and overdue once the match is finished", () => {
    const m = analysePolls(
      [
        { serverTimeMs: 100_000, events: [{ seq: 1, at: 1000 }], finished: true, overdueMs: 99_000 },
        { serverTimeMs: 101_000, events: [{ seq: 1, at: 1000 }], finished: true, overdueMs: 100_000 },
      ],
      { limitMs: LIMIT },
    );
    expect(m.ages).toHaveLength(0);
    expect(m.scheduleOk).toBe(true);
  });
});
