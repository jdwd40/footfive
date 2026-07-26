/**
 * Central event-display config: importance, pacing, styling hooks.
 * Tuned for ~15 real seconds per match minute (readable live commentary).
 */

export type EventImportance = "major" | "medium" | "minor";

export type EventDisplayConfig = {
  label: string;
  importance: EventImportance;
  /** ms hold after reveal before next event */
  holdMs: number;
  /** short delay before reveal (tension) */
  delayMs: number;
  className: string;
  a11y: string;
};

/** Defaults aligned with readable live presentation (not catch-up). */
export const EVENT_PACING = {
  minorHoldMs: 4000,
  mediumHoldMs: 6000,
  majorHoldMs: 9000,
  goalHoldMs: 11000,
  catchUpMinorMinMs: 800,
  catchUpMediumMinMs: 1500,
  catchUpMajorMinMs: 3500,
  behindThresholdForCatchUp: 4,
} as const;

const DEFAULT: EventDisplayConfig = {
  label: "Play",
  importance: "minor",
  holdMs: EVENT_PACING.minorHoldMs,
  delayMs: 0,
  className: "text-white/90",
  a11y: "Match event",
};

const TABLE: Record<string, Partial<EventDisplayConfig>> = {
  kickoff: {
    label: "Kickoff",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-cyan",
  },
  goal: {
    label: "GOAL",
    importance: "major",
    holdMs: EVENT_PACING.goalHoldMs,
    delayMs: 350,
    className: "text-lime",
    a11y: "Goal scored",
  },
  penalty_awarded: {
    label: "Penalty",
    importance: "major",
    holdMs: 9000,
    className: "text-amber",
    a11y: "Penalty awarded",
  },
  penalty_walkup: {
    label: "Penalty",
    importance: "major",
    holdMs: 7000,
    className: "text-amber",
  },
  penalty_run_up: {
    label: "Penalty",
    importance: "major",
    holdMs: 5000,
    delayMs: 400,
    className: "text-amber",
  },
  penalty_scored: {
    label: "PENALTY GOAL",
    importance: "major",
    holdMs: EVENT_PACING.goalHoldMs,
    className: "text-lime",
    a11y: "Penalty scored",
  },
  penalty_saved: {
    label: "SAVED",
    importance: "major",
    holdMs: 10000,
    className: "text-cyan",
    a11y: "Penalty saved",
  },
  penalty_missed: {
    label: "MISS",
    importance: "major",
    holdMs: 9000,
    className: "text-magenta",
    a11y: "Penalty missed",
  },
  yellow_card: {
    label: "Yellow",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-amber",
  },
  red_card: {
    label: "RED",
    importance: "major",
    holdMs: EVENT_PACING.majorHoldMs,
    className: "text-magenta",
    a11y: "Sending off",
  },
  half_time: {
    label: "Half-time",
    importance: "medium",
    holdMs: 7000,
    className: "text-cyan",
  },
  second_half: {
    label: "Second half",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-cyan",
  },
  full_time: {
    label: "Full-time",
    importance: "major",
    holdMs: EVENT_PACING.majorHoldMs,
    className: "text-cyan",
  },
  extra_time_start: {
    label: "Extra time",
    importance: "major",
    holdMs: EVENT_PACING.majorHoldMs,
    className: "text-amber",
  },
  extra_time_half: {
    label: "ET half",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-amber",
  },
  extra_time_end: {
    label: "ET end",
    importance: "major",
    holdMs: EVENT_PACING.majorHoldMs,
    className: "text-amber",
  },
  shootout_start: {
    label: "Shootout",
    importance: "major",
    holdMs: 10000,
    className: "text-magenta",
  },
  shootout_walkup: {
    label: "Taker",
    importance: "major",
    holdMs: 6500,
    className: "text-magenta",
  },
  shootout_goal: {
    label: "SCORES",
    importance: "major",
    holdMs: 9000,
    className: "text-lime",
    a11y: "Shootout goal",
  },
  shootout_save: {
    label: "SAVED",
    importance: "major",
    holdMs: 9000,
    className: "text-cyan",
  },
  shootout_miss: {
    label: "MISS",
    importance: "major",
    holdMs: 8500,
    className: "text-magenta",
  },
  shootout_reaction: {
    label: "Reaction",
    importance: "medium",
    holdMs: 5000,
    className: "text-white/80",
  },
  shootout_end: {
    label: "Shootout end",
    importance: "major",
    holdMs: EVENT_PACING.goalHoldMs,
    className: "text-lime",
  },
  match_end: {
    label: "Finished",
    importance: "major",
    holdMs: EVENT_PACING.goalHoldMs,
    className: "text-lime",
  },
  save: {
    label: "Save",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-cyan",
  },
  miss: {
    label: "Miss",
    importance: "medium",
    holdMs: 5500,
    className: "text-white/80",
  },
  block: {
    label: "Block",
    importance: "medium",
    holdMs: 5000,
    className: "text-white/80",
  },
  corner: {
    label: "Corner",
    importance: "minor",
    holdMs: EVENT_PACING.minorHoldMs,
    className: "text-muted",
  },
  foul: {
    label: "Foul",
    importance: "minor",
    holdMs: EVENT_PACING.minorHoldMs,
    className: "text-muted",
  },
  substitution: {
    label: "Sub",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-cyan",
  },
  coaching_change: {
    label: "Coaching",
    importance: "medium",
    holdMs: EVENT_PACING.mediumHoldMs,
    className: "text-amber",
  },
  midfield_play: {
    label: "Play",
    importance: "minor",
    holdMs: EVENT_PACING.minorHoldMs,
    className: "text-white/70",
  },
  build_up: {
    label: "Build-up",
    importance: "minor",
    holdMs: 4500,
    className: "text-white/70",
  },
  kickoff_restart: {
    label: "Restart",
    importance: "minor",
    holdMs: 3500,
    className: "text-muted",
  },
};

export function getEventDisplay(type: string): EventDisplayConfig {
  const partial = TABLE[type] || {};
  return { ...DEFAULT, ...partial, label: partial.label || type.replaceAll("_", " ") };
}

export function isScoringEvent(type: string): boolean {
  return type === "goal" || type === "penalty_scored" || type === "shootout_goal";
}

export function isMajorEventType(type: string): boolean {
  return getEventDisplay(type).importance === "major";
}

export function isPenaltyChainType(type: string): boolean {
  return type.startsWith("penalty_") || type === "penalty_awarded";
}

export function isShootoutType(type: string): boolean {
  return type.startsWith("shootout_");
}

/**
 * Catch-up holds: only when explicitly behind.
 * Never collapse major events to unreadable flash times.
 */
export function holdForCatchUp(
  cfg: EventDisplayConfig,
  behind: number,
  mode: "live" | "catchup" | "history" = "live",
): number {
  if (mode !== "catchup" || behind <= EVENT_PACING.behindThresholdForCatchUp) {
    return cfg.holdMs;
  }
  if (cfg.importance === "major") {
    return Math.max(EVENT_PACING.catchUpMajorMinMs, Math.min(cfg.holdMs, 5000));
  }
  if (cfg.importance === "medium") {
    return Math.max(EVENT_PACING.catchUpMediumMinMs, Math.min(cfg.holdMs, 2500));
  }
  return Math.max(EVENT_PACING.catchUpMinorMinMs, Math.min(cfg.holdMs, 1200));
}
