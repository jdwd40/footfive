/**
 * Client-side helpers for score reconstruction rules (tested independently).
 */

export type ScoreEvent = {
  type: string;
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
  message: string;
  offsetMs: number;
  seq: number;
};

export function visibleScoreFromEvents(events: ScoreEvent[], elapsedMs: number) {
  let scoreHome = 0;
  let scoreAway = 0;
  let shootoutHome = 0;
  let shootoutAway = 0;
  let finished = false;
  const due: ScoreEvent[] = [];

  for (const e of events) {
    if (e.offsetMs > elapsedMs) break;
    due.push(e);
    if (e.type === "goal" || e.type === "penalty_scored") {
      scoreHome = e.scoreHome;
      scoreAway = e.scoreAway;
    } else if (
      e.type === "shootout_goal" ||
      e.type === "shootout_save" ||
      e.type === "shootout_miss" ||
      e.type === "shootout_end"
    ) {
      shootoutHome = e.shootoutHome;
      shootoutAway = e.shootoutAway;
      scoreHome = e.scoreHome;
      scoreAway = e.scoreAway;
    } else {
      scoreHome = e.scoreHome;
      scoreAway = e.scoreAway;
      shootoutHome = e.shootoutHome;
      shootoutAway = e.shootoutAway;
    }
    if (e.type === "match_end") finished = true;
  }

  return { due, scoreHome, scoreAway, shootoutHome, shootoutAway, finished };
}

export function goalMessageBeforeOrWithScore(events: ScoreEvent[]) {
  // For consecutive goal-type events, message and score share the same event.
  for (const e of events) {
    if (e.type === "goal" || e.type === "penalty_scored" || e.type === "shootout_goal") {
      if (!e.message || e.message.length < 3) return false;
    }
  }
  return true;
}

export function shootoutDoesNotChangeNormalScore(
  before: { h: number; a: number },
  afterShootoutGoal: { h: number; a: number; sh: number; sa: number },
) {
  return before.h === afterShootoutGoal.h && before.a === afterShootoutGoal.a;
}
