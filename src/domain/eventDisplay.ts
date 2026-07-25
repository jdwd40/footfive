/**
 * Central event-display config: importance, pacing, styling hooks.
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

const DEFAULT: EventDisplayConfig = {
  label: "Play",
  importance: "minor",
  holdMs: 900,
  delayMs: 0,
  className: "text-white/90",
  a11y: "Match event",
};

const TABLE: Record<string, Partial<EventDisplayConfig>> = {
  kickoff: { label: "Kickoff", importance: "medium", holdMs: 1200, className: "text-cyan" },
  goal: {
    label: "GOAL",
    importance: "major",
    holdMs: 2200,
    delayMs: 200,
    className: "text-lime",
    a11y: "Goal scored",
  },
  penalty_awarded: {
    label: "Penalty",
    importance: "major",
    holdMs: 1400,
    className: "text-amber",
    a11y: "Penalty awarded",
  },
  penalty_walkup: { label: "Penalty", importance: "major", holdMs: 1100, className: "text-amber" },
  penalty_run_up: { label: "Penalty", importance: "major", holdMs: 900, delayMs: 150, className: "text-amber" },
  penalty_scored: {
    label: "PENALTY GOAL",
    importance: "major",
    holdMs: 2200,
    className: "text-lime",
    a11y: "Penalty scored",
  },
  penalty_saved: {
    label: "SAVED",
    importance: "major",
    holdMs: 2000,
    className: "text-cyan",
    a11y: "Penalty saved",
  },
  penalty_missed: {
    label: "MISS",
    importance: "major",
    holdMs: 1800,
    className: "text-magenta",
    a11y: "Penalty missed",
  },
  yellow_card: { label: "Yellow", importance: "medium", holdMs: 1400, className: "text-amber" },
  red_card: { label: "RED", importance: "major", holdMs: 2000, className: "text-magenta", a11y: "Sending off" },
  half_time: { label: "Half-time", importance: "medium", holdMs: 1600, className: "text-cyan" },
  second_half: { label: "Second half", importance: "medium", holdMs: 1200, className: "text-cyan" },
  full_time: { label: "Full-time", importance: "major", holdMs: 1800, className: "text-cyan" },
  extra_time_start: { label: "Extra time", importance: "major", holdMs: 1600, className: "text-amber" },
  extra_time_half: { label: "ET half", importance: "medium", holdMs: 1200, className: "text-amber" },
  extra_time_end: { label: "ET end", importance: "major", holdMs: 1600, className: "text-amber" },
  shootout_start: { label: "Shootout", importance: "major", holdMs: 2000, className: "text-magenta" },
  shootout_walkup: { label: "Taker", importance: "major", holdMs: 1000, className: "text-magenta" },
  shootout_goal: {
    label: "SCORES",
    importance: "major",
    holdMs: 1600,
    className: "text-lime",
    a11y: "Shootout goal",
  },
  shootout_save: { label: "SAVED", importance: "major", holdMs: 1600, className: "text-cyan" },
  shootout_miss: { label: "MISS", importance: "major", holdMs: 1500, className: "text-magenta" },
  shootout_reaction: { label: "Reaction", importance: "medium", holdMs: 1000, className: "text-white/80" },
  shootout_end: { label: "Shootout end", importance: "major", holdMs: 2200, className: "text-lime" },
  match_end: { label: "Finished", importance: "major", holdMs: 2400, className: "text-lime" },
  save: { label: "Save", importance: "medium", holdMs: 1100, className: "text-cyan" },
  miss: { label: "Miss", importance: "medium", holdMs: 1000, className: "text-white/80" },
  block: { label: "Block", importance: "medium", holdMs: 900, className: "text-white/80" },
  corner: { label: "Corner", importance: "minor", holdMs: 700, className: "text-muted" },
  foul: { label: "Foul", importance: "minor", holdMs: 800, className: "text-muted" },
  substitution: { label: "Sub", importance: "medium", holdMs: 1300, className: "text-cyan" },
  coaching_change: { label: "Coaching", importance: "medium", holdMs: 1400, className: "text-amber" },
  midfield_play: { label: "Play", importance: "minor", holdMs: 650, className: "text-white/70" },
  build_up: { label: "Build-up", importance: "minor", holdMs: 700, className: "text-white/70" },
  kickoff_restart: { label: "Restart", importance: "minor", holdMs: 600, className: "text-muted" },
};

export function getEventDisplay(type: string): EventDisplayConfig {
  const partial = TABLE[type] || {};
  return { ...DEFAULT, ...partial, label: partial.label || type.replaceAll("_", " ") };
}

export function isScoringEvent(type: string): boolean {
  return type === "goal" || type === "penalty_scored" || type === "shootout_goal";
}

export function isPenaltyChainType(type: string): boolean {
  return type.startsWith("penalty_") || type === "penalty_awarded";
}

export function isShootoutType(type: string): boolean {
  return type.startsWith("shootout_");
}

/** Prefer shorter holds when catching up. */
export function holdForCatchUp(cfg: EventDisplayConfig, behind: number): number {
  if (behind <= 2) return cfg.holdMs;
  if (behind <= 6) return Math.min(cfg.holdMs, 500);
  if (cfg.importance === "major") return Math.min(cfg.holdMs, 700);
  return 120;
}
