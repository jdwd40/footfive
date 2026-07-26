import type { ScoreboardFixture } from "../../lib/pocketbase";
import TeamName from "../TeamName";

function statusChip(f: ScoreboardFixture) {
  if (f.finished || f.status === "finished") return "FT";
  if (f.status === "shootout") return "PENS";
  if (f.status === "extra_time") return `ET ${f.minute}′`;
  if (f.status === "half_time") return "HT";
  if (f.status === "live") return `${f.minute}′`;
  if (f.status === "scheduled") return "VS";
  return f.status.slice(0, 4).toUpperCase();
}

export default function MatchSwitcher({
  fixtures,
  activeId,
  managedTeamId,
  onSelect,
}: {
  fixtures: ScoreboardFixture[];
  activeId: string;
  managedTeamId?: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label="Match switcher"
    >
      {fixtures.map((f) => {
        const active = f.fixtureId === activeId;
        const mine =
          managedTeamId &&
          (f.home.id === managedTeamId || f.away.id === managedTeamId);
        const live =
          f.status === "live" ||
          f.status === "extra_time" ||
          f.status === "shootout" ||
          f.status === "half_time";
        const pens =
          f.shootoutHome > 0 || f.shootoutAway > 0 || f.status === "shootout";
        return (
          <button
            key={f.fixtureId}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`${f.home.name} ${f.scoreHome} to ${f.away.name} ${f.scoreAway}, ${statusChip(f)}`}
            onClick={() => onSelect(f.fixtureId)}
            className={`min-w-[7.75rem] max-w-[10rem] shrink-0 rounded-xl border px-2.5 py-2 text-left transition active:scale-[0.98] ${
              active
                ? "border-cyan bg-cyan/15 ring-1 ring-cyan/40"
                : "border-white/10 bg-panel/80"
            } ${live && !active ? "live-pulse" : ""}`}
          >
            <div className="flex items-center justify-between gap-1 text-[10px] uppercase tracking-wider text-muted">
              <span>{f.slot.replace("R16_", "R").replace("QF", "Q")}</span>
              <span className={live ? "text-lime" : f.finished ? "text-cyan" : ""}>
                {statusChip(f)}
              </span>
            </div>
            <div className="mt-0.5 text-xs font-semibold tabular-nums">
              <TeamName team={f.home} mode="short" /> {f.scoreHome}–{f.scoreAway}{" "}
              <TeamName team={f.away} mode="short" />
            </div>
            {pens ? (
              <div className="text-[10px] text-amber">
                pens {f.shootoutHome}–{f.shootoutAway}
              </div>
            ) : null}
            {mine ? (
              <div className="mt-0.5 text-[10px] font-bold uppercase text-magenta">Your match</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
