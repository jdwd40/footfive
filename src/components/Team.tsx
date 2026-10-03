import type { TeamPublic } from "../lib/pocketbase";

/** Readable text colour on a team colour. */
function ink(hex: string) {
  const h = hex.replace("#", "");
  if (h.length < 6) return "#060912";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? "#060912" : "#ffffff";
}

/**
 * Kit swatch. Home = team colour; away = white with a team-colour accent (house convention).
 */
export function Kit({ team, away = false, size = 14 }: { team: Pick<TeamPublic, "primary_color" | "name">; away?: boolean; size?: number }) {
  const c = team.primary_color || "#00f0ff";
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-[4px]"
      style={{
        width: size,
        height: size,
        background: away ? "#f4f7ff" : c,
        boxShadow: away ? `inset 0 0 0 3px ${c}` : "inset 0 0 0 1px rgba(255,255,255,0.25)",
      }}
    />
  );
}

/** Abbreviation pill in team colours (compact areas, tickers). */
export function Abbr({ team, away = false }: { team: Pick<TeamPublic, "primary_color" | "abbreviation" | "name">; away?: boolean }) {
  const c = team.primary_color || "#00f0ff";
  return (
    <abbr
      title={team.name}
      className="inline-flex min-w-[2.6rem] justify-center rounded px-1 font-display text-[11px] font-bold no-underline"
      style={away ? { background: "#f4f7ff", color: "#060912", boxShadow: `inset 0 -3px 0 ${c}` } : { background: c, color: ink(c) }}
    >
      {team.abbreviation}
    </abbr>
  );
}

/** Team name with kit. Full name by default; `compact` shows the abbreviation on narrow screens. */
export function TeamLabel({
  team,
  away = false,
  align = "left",
  className = "",
  compact = false,
}: {
  team: TeamPublic;
  away?: boolean;
  align?: "left" | "right";
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${align === "right" ? "flex-row-reverse text-right" : ""} ${className}`}>
      <Kit team={team} away={away} />
      <span className={`truncate font-semibold ${compact ? "hidden sm:inline" : ""}`} title={team.name}>
        {team.name}
      </span>
      {compact ? (
        <span className="font-display text-sm font-bold sm:hidden" title={team.name}>
          {team.abbreviation}
        </span>
      ) : null}
    </span>
  );
}

export function PendingTeam({ text }: { text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-muted">
      <span aria-hidden className="inline-block h-[14px] w-[14px] shrink-0 rounded-[4px] border border-dashed border-muted/60" />
      <span className="truncate text-sm italic">{text}</span>
    </span>
  );
}
