/**
 * #206: the automatic goal replay. After a goal the engine holds play for the celebration and the restart; the replay of the move
 * is fitted into that natural pause and never moves the live clock: it is a pure function of the pitch playhead (`clock`), drawn
 * instead of the live celebration frame while the playhead is still on that celebration. The next event being due (the playhead
 * leaving the celebration) ends it at once, and the caller skips it altogether while a late batch is being fast-forwarded.
 * Presentation only: nothing here reads or changes an outcome.
 */
import type { MatchEvent } from "../lib/pocketbase";
import type { Scene } from "./scenes";

/** Replay length budget (ms of pitch time), roughly the move's last five seconds. */
export const REPLAY_MS = 5000;
/** The replay starts this long after the celebration event: the GOOOAL screen and the corner celebration come first. */
export const REPLAY_DELAY_MS = 600;
/** Its move ends at least this long before the next event, when that event is already known. */
export const REPLAY_GUARD_MS = 250;
/** Less room than this and the replay is skipped rather than squeezed. */
export const REPLAY_MIN_MS = 1500;
/** Its last frame holds at most this long (until the next event is due, which cuts it), so the live banner never flashes back in between. */
export const REPLAY_HOLD_MS = 1500;
/** The strike itself is shown slowed down (scene progress per ms relative to live). */
export const REPLAY_SLOW = 0.6;
const GOALS = new Set(["goal", "penalty_goal"]);

export type ReplayPart = { scene: Scene; p0: number; p1: number; rate: number; off: number /* ms into the replay */; dur: number };
export type GoalReplay = { goalSeq: number; celSeq: number; startAt: number; endAt: number; total: number; caption: string; parts: ReplayPart[] };

/**
 * The replay for the celebration at `events[i]`, or null (not a celebration straight after a goal, nothing to show, or no room).
 * The parts are the goal's chain, latest first: the strike (slowed, up to the ball in the net) and as many of the preceding
 * chain scenes as fit the budget, the earliest one entered part-way if needed.
 */
export function planGoalReplay(events: MatchEvent[], scenes: Map<number, Scene>, i: number): GoalReplay | null {
  const cel = events[i];
  const goal = events[i - 1];
  if (!cel || cel.t !== "celebration" || !goal || !GOALS.has(goal.t)) return null;
  const goalScene = scenes.get(goal.seq);
  if (!goalScene || !(goalScene.ms > 0)) return null;
  const startAt = cel.at + REPLAY_DELAY_MS;
  const next = events[i + 1];
  const room = next ? next.at - REPLAY_GUARD_MS - startAt : Infinity;
  const total = Math.min(REPLAY_MS, room);
  if (!(total >= REPLAY_MIN_MS)) return null;
  // The strike: from the shot (or the run-up) to just after the ball is in, slowed.
  const g1 = Math.min(1, Math.max(0.55, (goalScene.flashAt ?? 0.62) + 0.2));
  const gDur = Math.min(total, (g1 * goalScene.ms) / REPLAY_SLOW);
  const rev: Omit<ReplayPart, "off">[] = [{ scene: goalScene, p0: g1 - (gDur * REPLAY_SLOW) / goalScene.ms, p1: g1, rate: REPLAY_SLOW, dur: gDur }];
  let left = total - gDur;
  if (goal.chain != null) {
    for (let j = i - 2; j >= 0 && left > 50; j--) {
      const e = events[j];
      if (e.chain !== goal.chain) {
        if (e.cos) continue; // a cosmetic row inside the move is not part of it, but does not end it
        break;
      }
      const s = scenes.get(e.seq);
      if (!s || !(s.ms > 0)) continue;
      const dur = Math.min(left, s.ms);
      rev.push({ scene: s, p0: 1 - dur / s.ms, p1: 1, rate: 1, dur });
      left -= dur;
    }
  }
  let off = 0;
  const parts = rev.reverse().map((p) => {
    const part = { ...p, off };
    off += p.dur;
    return part;
  });
  const end = startAt + off + REPLAY_HOLD_MS;
  // The last frame holds up to the next event itself (the playhead leaving the celebration ends it): the big screen never flashes back.
  return { goalSeq: goal.seq, celSeq: cel.seq, startAt, endAt: next ? Math.min(end, next.at) : end, total: off, caption: goalScene.caption, parts };
}

/** The replay's scene and progress at pitch time `clock`, or null outside its window. Past its last part the last frame holds. */
export function replayAt(plan: GoalReplay, clock: number): { scene: Scene; p: number } | null {
  const t = clock - plan.startAt;
  if (t < 0 || clock >= plan.endAt) return null;
  const part = plan.parts.find((q) => t < q.off + q.dur) ?? plan.parts[plan.parts.length - 1];
  if (!part) return null;
  const p = Math.min(part.p1, part.p0 + ((t - part.off) * part.rate) / part.scene.ms);
  return { scene: part.scene, p };
}

/** A visit's automatic replays, by celebration seq: the plan once it has started (null: none fits) and those skipped by catch-up. */
export type ReplayMemo = { plans: Map<number, GoalReplay | null>; skipped: Set<number> };
/** The pitch clock is fast-forwarding a late batch (MatchPage's advanceClock) when it is further than this behind its target. */
export const CATCHUP_SLACK_MS = 250;

/**
 * The automatic replay to draw at pitch time `clock` (the live playhead, never moved by this), or null. `target` is where that
 * clock is heading (now − LAG_MS): behind it, a late batch is being fast-forwarded and this goal's replay is skipped for good.
 * It is planned once, as it starts (so it never re-times mid-play), with whatever next event is known by then.
 */
export function autoReplay(memo: ReplayMemo, events: MatchEvent[], scenes: Map<number, Scene>, cur: MatchEvent | null, clock: number, target: number) {
  if (!cur || cur.t !== "celebration") return null;
  const seq = cur.seq;
  if (target - clock > CATCHUP_SLACK_MS) memo.skipped.add(seq);
  if (memo.skipped.has(seq)) return null;
  let plan = memo.plans.get(seq);
  if (plan === undefined && clock >= cur.at + REPLAY_DELAY_MS) {
    plan = planGoalReplay(events, scenes, events.indexOf(cur));
    memo.plans.set(seq, plan);
  }
  const at = plan ? replayAt(plan, clock) : null;
  return plan && at ? { plan, ...at } : null;
}

/** Has this celebration's replay started (it may be over)? The big goal screen and its cheer then never come back for that goal. */
export function replayStarted(memo: ReplayMemo, cur: MatchEvent | null, clock: number) {
  const plan = cur && cur.t === "celebration" ? memo.plans.get(cur.seq) : undefined;
  return !!plan && clock >= plan.startAt;
}
