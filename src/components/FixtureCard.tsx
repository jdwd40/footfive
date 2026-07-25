import { Link } from "react-router-dom";
import type { ScoreboardFixture } from "../lib/pocketbase";
import TeamBadge from "./TeamBadge";

function phaseLabel(f: ScoreboardFixture) {
  if (f.finished || f.status === "finished") return "Full-time";
  if (f.status === "half_time") return "Half-time";
  if (f.status === "extra_time") return `Extra time · ${f.minute}'`;
  if (f.status === "shootout") return "Penalties";
  if (f.status === "live") return `Live · ${f.minute}'`;
  if (f.status === "scheduled") {
    try {
      const t = new Date(String(f.scheduledAt).replace(" ", "T"));
      if (!isNaN(t.getTime()) && t.getTime() > Date.now()) {
        const mins = Math.ceil((t.getTime() - Date.now()) / 60000);
        return mins > 0 ? `Kickoff in ${mins}m` : "Kickoff soon";
      }
    } catch {
      /* ignore */
    }
    return "Scheduled";
  }
  return f.status;
}

function statusChip(f: ScoreboardFixture) {
  if (f.finished || f.status === "finished") return "FT";
  if (f.status === "half_time") return "HT";
  if (f.status === "extra_time") return `ET ${f.minute}'`;
  if (f.status === "shootout") return "PEN";
  if (f.status === "live") return `${f.minute}'`;
  return "SCHED";
}

export default function FixtureCard({
  fixture,
  managedTeamId,
}: {
  fixture: ScoreboardFixture;
  managedTeamId?: string | null;
}) {
  const live =
    fixture.status === "live" ||
    fixture.status === "extra_time" ||
    fixture.status === "shootout" ||
    fixture.status === "half_time";
  const showPens =
    fixture.shootoutHome > 0 ||
    fixture.shootoutAway > 0 ||
    fixture.status === "shootout" ||
    (fixture.finished && (fixture.shootoutHome > 0 || fixture.shootoutAway > 0));
  const mine =
    managedTeamId &&
    (fixture.home.id === managedTeamId || fixture.away.id === managedTeamId);

  return (
    <Link
      to={`/match/${fixture.fixtureId}`}
      className={`glass block rounded-2xl p-3 transition active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        live ? "live-pulse" : ""
      } ${mine ? "ring-1 ring-magenta/50" : ""}`}
      aria-label={`${fixture.home.name} ${fixture.scoreHome} ${fixture.away.name} ${fixture.scoreAway}, ${phaseLabel(fixture)}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-muted">
        <span className="flex items-center gap-2">
          <span>{fixture.slot}</span>
          {mine ? <span className="text-magenta">You</span> : null}
          {live ? (
            <span className="inline-flex items-center gap-1 text-lime">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-lime" />
              Live
            </span>
          ) : null}
        </span>
        <span className={live ? "text-lime" : fixture.finished ? "text-cyan" : ""}>
          {statusChip(fixture)}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <TeamBadge
            badgeKey={fixture.home.badge_key}
            color={fixture.home.primary_color}
            name={fixture.home.name}
            size={36}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">{fixture.home.name}</div>
            <div className="text-[10px] text-muted">{fixture.home.grade}</div>
          </div>
        </div>
        <div className="text-center font-display">
          <div className="text-xl tabular-nums text-white sm:text-2xl">
            {fixture.scoreHome}
            <span className="mx-1 text-muted">–</span>
            {fixture.scoreAway}
          </div>
          {showPens ? (
            <div className="text-[11px] text-amber">
              pens {fixture.shootoutHome}–{fixture.shootoutAway}
            </div>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <div className="min-w-0 text-right">
            <div className="truncate text-sm font-semibold leading-tight">{fixture.away.name}</div>
            <div className="text-[10px] text-muted">{fixture.away.grade}</div>
          </div>
          <TeamBadge
            badgeKey={fixture.away.badge_key}
            color={fixture.away.primary_color}
            name={fixture.away.name}
            size={36}
          />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-muted">{phaseLabel(fixture)}</span>
        <span className="font-semibold uppercase tracking-wide text-cyan/90">Watch →</span>
      </div>
    </Link>
  );
}
