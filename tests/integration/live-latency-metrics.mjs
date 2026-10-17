/**
 * Pure analysis for tests/integration/live-latency.mjs (unit-tested in
 * tests/ci/live-latency-metrics.test.ts).
 *
 * Why not "newest event age"? The engine simulates a whole match minute per step and
 * persists its events ahead of time with future `at` stamps; GET /match publishes an
 * event once `at <= now`. The age of the newest published event therefore includes the
 * engine's own spacing between events, which is up to ~7 s in normal open play
 * (pass→pass, pass→build_up) and 9 s+ around goals, cards and breaks. A perfectly
 * timely server shows a sawtooth that legitimately exceeds 5 s, so that metric flakes
 * whenever the 15 s window contains one long natural gap.
 *
 * What we measure instead is what a real regression changes: how LATE a due event is.
 *  - deliveryLateMs: for an event first seen at poll i (i ≥ 1), the previous poll at
 *    server time P(i-1) did not return it. If its `at` was already ≤ P(i-1), it was
 *    provably withheld for at least P(i-1) − at. This is a lower bound free of poll
 *    granularity: a natural gap never produces it, a stalled or batched feed always does
 *    (60 s cron batches → ~59 s). Events already visible on the first poll are the
 *    pre-window backlog (warm-up) and are not counted.
 *  - overdueMs: at each poll, how far the engine's own schedule (match_states
 *    next_segment_due_at) is in the past, i.e. the next step is due but no tick has run.
 *    This catches a stall that lasts to the end of the window, when no late event ever
 *    gets delivered for deliveryLateMs to see.
 */

/**
 * @param {Array<{serverTimeMs:number, events:Array<{seq:number, at:number}>, finished?:boolean, overdueMs?:number|null}>} polls
 * @param {{limitMs:number}} opts
 */
export function analysePolls(polls, { limitMs }) {
  const seen = new Set();
  const ages = [];
  const late = []; // { seq, at, lateMs, upperMs }
  const overdue = [];
  for (let i = 0; i < polls.length; i++) {
    const p = polls[i];
    const evs = p.events || [];
    if (!p.finished) {
      const newest = evs.reduce((m, e) => Math.max(m, e.at || 0), 0);
      if (newest) ages.push(p.serverTimeMs - newest);
      if (typeof p.overdueMs === "number") overdue.push(Math.max(0, p.overdueMs));
    }
    for (const e of evs) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      if (i === 0) continue; // warm-up backlog published before the window opened
      const prev = polls[i - 1].serverTimeMs;
      late.push({ seq: e.seq, at: e.at, lateMs: Math.max(0, prev - e.at), upperMs: p.serverTimeMs - e.at });
    }
  }
  const maxLate = late.reduce((m, x) => Math.max(m, x.lateMs), 0);
  const maxOverdue = overdue.reduce((m, x) => Math.max(m, x), 0);
  return {
    ages,
    maxAge: ages.length ? Math.max(...ages) : 0,
    delivered: late.length,
    late,
    maxLate,
    overdue,
    maxOverdue,
    deliveryOk: maxLate <= limitMs,
    scheduleOk: maxOverdue <= limitMs,
  };
}
