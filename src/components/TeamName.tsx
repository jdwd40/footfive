/**
 * Official team label: full name, abbreviation, or auto (compact contexts).
 */
import type { TeamPublic } from "../lib/pocketbase";

export type TeamNameMode = "full" | "short" | "auto";

export function teamAbbreviation(team: Pick<TeamPublic, "name" | "abbreviation" | "slug">): string {
  const ab = (team.abbreviation || "").toUpperCase().trim();
  if (ab) return ab;
  // last-resort deterministic short label (not for production teams after backfill)
  const parts = (team.name || "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1].slice(0, 2)).toUpperCase().slice(0, 3);
  }
  return (team.name || "???").slice(0, 3).toUpperCase();
}

export function resolveTeamLabel(
  team: Pick<TeamPublic, "name" | "abbreviation" | "slug">,
  mode: TeamNameMode = "full",
): string {
  if (mode === "short") return teamAbbreviation(team);
  if (mode === "auto") {
    // auto = compact by default in ticker/switcher usage
    return teamAbbreviation(team);
  }
  return team.name || teamAbbreviation(team);
}

export default function TeamName({
  team,
  mode = "full",
  className = "",
}: {
  team: Pick<TeamPublic, "name" | "abbreviation" | "slug">;
  mode?: TeamNameMode;
  className?: string;
}) {
  const label = resolveTeamLabel(team, mode);
  const full = team.name || label;
  const isAbbr = mode === "short" || mode === "auto";
  return (
    <span
      className={className}
      title={full}
      aria-label={full}
      data-team-abbr={isAbbr ? teamAbbreviation(team) : undefined}
    >
      {label}
    </span>
  );
}
