/**
 * Authoritative client score reconstruction from *revealed* events only.
 * Never use API snapshot scores ahead of the reveal queue.
 */

export type ScoreableEvent = {
  seq: number;
  type: string;
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
  message?: string;
  minute?: number;
  phase?: string;
};

export type VisibleScore = {
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
  finished: boolean;
  minute: number;
  phase: string;
  lastScoringSeq: number | null;
};

const SCORING = new Set(["goal", "penalty_scored"]);
const SHOOTOUT_SCORE = new Set(["shootout_goal", "shootout_save", "shootout_miss", "shootout_end"]);

/**
 * Reconstruct visible score from events already revealed (in order).
 * - Normal goals/penalty_scored update normal score from event payload.
 * - Shootout events update shootout score only (normal score from event is FT).
 * - Non-scoring events may carry progressive scores; we still apply them only
 *   after reveal, but never invent future goals.
 */
export function scoreFromRevealedEvents(revealed: ScoreableEvent[]): VisibleScore {
  let scoreHome = 0;
  let scoreAway = 0;
  let shootoutHome = 0;
  let shootoutAway = 0;
  let finished = false;
  let minute = 0;
  let phase = "scheduled";
  let lastScoringSeq: number | null = null;

  for (const e of revealed) {
    if (e.minute != null) minute = e.minute;
    if (e.phase) phase = e.phase;

    if (SCORING.has(e.type)) {
      scoreHome = e.scoreHome;
      scoreAway = e.scoreAway;
      lastScoringSeq = e.seq;
    } else if (e.type === "shootout_goal") {
      // Only shootout tally moves; FT score may be carried on event
      shootoutHome = e.shootoutHome;
      shootoutAway = e.shootoutAway;
      if (e.scoreHome != null) scoreHome = e.scoreHome;
      if (e.scoreAway != null) scoreAway = e.scoreAway;
      lastScoringSeq = e.seq;
    } else if (SHOOTOUT_SCORE.has(e.type)) {
      shootoutHome = e.shootoutHome;
      shootoutAway = e.shootoutAway;
      if (e.scoreHome != null) scoreHome = e.scoreHome;
      if (e.scoreAway != null) scoreAway = e.scoreAway;
    } else if (e.type === "match_end") {
      finished = true;
      phase = "finished";
      scoreHome = e.scoreHome;
      scoreAway = e.scoreAway;
      shootoutHome = e.shootoutHome;
      shootoutAway = e.shootoutAway;
    } else {
      // Build-up / non-scoring: keep last known progressive score from payload
      // only if it does not jump past a scoring event we haven't "had"
      // (all revealed, so safe to mirror snapshot fields on non-scoring)
      if (e.scoreHome != null && e.scoreAway != null) {
        // Only apply if not higher than we already have from goals...
        // Actually for kickoff etc. 0-0 is fine. For post-goal midfield, mirror.
        scoreHome = e.scoreHome;
        scoreAway = e.scoreAway;
      }
      if (e.shootoutHome != null) shootoutHome = e.shootoutHome;
      if (e.shootoutAway != null) shootoutAway = e.shootoutAway;
    }
  }

  return {
    scoreHome,
    scoreAway,
    shootoutHome,
    shootoutAway,
    finished,
    minute,
    phase,
    lastScoringSeq,
  };
}

/** Ensure goal events always carry a message (for tests / validation). */
export function goalHasMessage(e: ScoreableEvent): boolean {
  if (!SCORING.has(e.type) && e.type !== "shootout_goal") return true;
  return !!(e.message && e.message.length >= 3);
}

export function shootoutDoesNotAlterNormal(
  before: { h: number; a: number },
  after: { h: number; a: number },
): boolean {
  return before.h === after.h && before.a === after.a;
}
