/**
 * #208: what fills the pitch in dead time. The break summary (half-time, end of 90 minutes, full time) and the pre-match line-up
 * walkout. Both are overlays inside the pitch box (absolutely positioned, so nothing outside moves) and mount only in a break or
 * before kick-off, so open play draws no extra nodes. Presentation only: built from data the page already holds.
 */
import { memo, useMemo, useState, type CSSProperties } from "react";
import type { LineupPlayer, Side, TeamPublic } from "../lib/pocketbase";
import { CARDS, formation, playerLine, type BreakSummary as Summary, type CardId, type Shot } from "../domain/breaks";
import { FULL_CAM } from "../domain/scenes";
import { minuteLabel } from "../lib/live";
import { Abbr } from "./Team";
import { kitsFor } from "./kits";

const STAT_ROWS: Array<[string, number]> = [
  ["Shots", 0],
  ["On target", 1],
  ["Saves", 2],
  ["Fouls", 4],
  ["Yellow cards", 5],
  ["Red cards", 6],
];
const TITLES: Record<CardId, string> = { stats: "Key stats", shots: "Shot map", goals: "Goals", players: "Top players" };
const RESULT_NAME: Record<Shot["result"], string> = { goal: "Goal", save: "Saved", miss: "Off target", block: "Blocked", woodwork: "Woodwork" };
const lastName = (n: string) => n.trim().split(/\s+/).at(-1) ?? n;

type Teams = { home: TeamPublic; away: TeamPublic };

/**
 * The summary cards on the pitch. One card at a time on a narrow pitch, two side by side on a wide one (a container query picks
 * which set of `data-n` / `data-w` cards shows). The card follows the pitch playhead (`page` / `pair`); a dot picks one by hand for
 * the rest of this break.
 */
export const BreakSummary = memo(function BreakSummary({ summary, page, pair, home, away }: { summary: Summary; page: number; pair: number } & Teams) {
  const [pick, setPick] = useState<number | null>(null);
  const n = pick ?? page;
  const w = pick != null ? Math.floor(pick / 2) : pair;
  return (
    <div className="brk flex h-full min-h-0 flex-col" data-testid="break-summary" data-kind={summary.kind}>
      <div className="brk-cards min-h-0 flex-1">
        {CARDS.map((id, i) => (
          <section key={id} className="brk-card event-enter min-h-0 min-w-0 flex-col rounded-lg bg-black/45 px-2.5 py-1.5 ring-1 ring-white/10" data-testid="break-card" data-card={id} data-n={i === n || undefined} data-w={Math.floor(i / 2) === w || undefined} aria-label={TITLES[id]}>
            <h3 className="brk-title mb-1 shrink-0 font-display font-bold uppercase tracking-widest text-cyan">{TITLES[id]}</h3>
            {id === "stats" ? <StatsCard summary={summary} home={home} away={away} /> : id === "shots" ? <ShotsCard shots={summary.shots} home={home} away={away} /> : id === "goals" ? <GoalsCard summary={summary} home={home} away={away} /> : <PlayersCard summary={summary} home={home} away={away} />}
          </section>
        ))}
      </div>
      <div className="brk-pager pointer-events-auto flex shrink-0 justify-center gap-1 pt-1" role="group" aria-label="Summary" data-testid="break-pager">
        {CARDS.map((id, i) => (
          <button key={id} type="button" className="brk-dot grid h-6 w-6 place-items-center" aria-label={`Show ${TITLES[id].toLowerCase()}`} aria-pressed={i === n} data-n={i === n || undefined} data-w={Math.floor(i / 2) === w || undefined} onClick={() => setPick(i)}>
            <span className="block h-2 w-2 rounded-full" />
          </button>
        ))}
      </div>
    </div>
  );
});

function StatsCard({ summary, home, away }: { summary: Summary } & Teams) {
  const st = summary.st;
  return (
    <div className="brk-body space-y-0.5 tabular" data-testid="break-stats">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5 font-bold">
        <span className="flex items-center gap-1">
          <Abbr team={home} />
          {st.pos}%
        </span>
        <span className="text-center font-normal text-muted">Possession</span>
        <span className="flex items-center gap-1">
          {100 - st.pos}%
          <Abbr team={away} away />
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-panel-2" aria-label={`Possession ${st.pos}% – ${100 - st.pos}%`} role="img">
        <div style={{ width: `${st.pos}%`, background: home.primary_color || "#00f0ff" }} />
        <div style={{ width: `${100 - st.pos}%`, background: "#f4f7ff" }} />
      </div>
      {STAT_ROWS.map(([label, i]) => (
        <div key={label} className="grid grid-cols-[2rem_1fr_2rem] items-center text-center" data-testid="break-stat" data-stat={label}>
          <span className="font-bold">{st.x[0][i] ?? 0}</span>
          <span className="text-muted">{label}</span>
          <span className="font-bold">{st.x[1][i] ?? 0}</span>
        </div>
      ))}
    </div>
  );
}

/** Where each attempt was struck from, on one small pitch: the home side attacks right, the away side left (as at kick-off). */
function ShotsCard({ shots, home, away }: { shots: Shot[] } & Teams) {
  const count = (s: Side) => shots.filter((x) => x.side === s);
  const on = (s: Side) => count(s).filter((x) => x.result === "goal" || x.result === "save").length;
  return (
    <div className="brk-body flex min-h-0 flex-1 flex-col" data-testid="break-shots">
      <div className="flex shrink-0 items-center justify-between gap-2 text-muted tabular">
        <span className="flex items-center gap-1">
          ← <Abbr team={away} away /> {count("away").length} ({on("away")} on target)
        </span>
        <span className="flex items-center gap-1">
          {count("home").length} ({on("home")} on target) <Abbr team={home} /> →
        </span>
      </div>
      <svg viewBox="-2 -2 104 68" preserveAspectRatio="xMidYMid meet" className="mt-1 min-h-0 w-full flex-1" role="img" aria-label={`Shot map: ${home.abbreviation} ${count("home").length} shots, ${away.abbreviation} ${count("away").length} shots`}>
        <g fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={0.5}>
          <rect x={0} y={0} width={100} height={64} fill="rgba(22,79,42,0.55)" />
          <line x1={50} y1={0} x2={50} y2={64} />
          <rect x={0} y={16} width={15} height={32} />
          <rect x={85} y={16} width={15} height={32} />
        </g>
        {shots.map((s) => {
          const col = s.side === "home" ? home.primary_color || "#00f0ff" : "#f4f7ff";
          const title = `${minuteLabel(s.min)} ${s.p} — ${RESULT_NAME[s.result]}${s.pen ? " (penalty)" : s.header ? " (header)" : ""}`;
          return (
            <g key={s.seq} transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`} data-testid="shot-dot" data-side={s.side} data-result={s.result}>
              <title>{title}</title>
              {s.result === "goal" ? (
                <circle r={2.6} fill="#b8ff3c" stroke="#0b1404" strokeWidth={0.5} />
              ) : s.result === "save" ? (
                <circle r={2} fill={col} stroke="#0b1404" strokeWidth={0.4} />
              ) : s.result === "block" ? (
                <rect x={-1.6} y={-1.6} width={3.2} height={3.2} fill="none" stroke={col} strokeWidth={0.7} />
              ) : (
                <circle r={1.8} fill="none" stroke={s.result === "woodwork" ? "#ffb020" : col} strokeWidth={0.7} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-0.5 flex shrink-0 flex-wrap justify-center gap-x-2.5 text-muted" aria-hidden>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-lime align-middle" />Goal</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-muted align-middle" />Saved</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-muted align-middle" />Off target</span>
        <span><i className="mr-1 inline-block h-2 w-2 border border-muted align-middle" />Blocked</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full border border-amber align-middle" />Woodwork</span>
      </div>
    </div>
  );
}

function GoalsCard({ summary, home, away }: { summary: Summary } & Teams) {
  const goals = summary.goals;
  if (!goals.length) return <p className="brk-body text-muted" data-testid="break-goals">No goals yet — {home.abbreviation} 0–0 {away.abbreviation}.</p>;
  const shown = goals.slice(-6);
  return (
    <ol className="brk-body space-y-0.5 tabular" data-testid="break-goals">
      {goals.length > shown.length ? <li className="text-muted">+{goals.length - shown.length} earlier</li> : null}
      {shown.map((g) => (
        <li key={g.seq} className="flex items-center gap-1.5" data-testid="break-goal">
          <span className="w-8 shrink-0 text-muted">{minuteLabel(g.min)}</span>
          <Abbr team={g.side === "home" ? home : away} away={g.side === "away"} />
          <span className="min-w-0 flex-1 truncate font-semibold">
            {g.p}
            {g.pen ? <span className="font-normal text-muted"> (pen)</span> : null}
          </span>
          <span className="shrink-0 font-bold">
            {g.score[0]}–{g.score[1]}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlayersCard({ summary, home, away }: { summary: Summary } & Teams) {
  if (!summary.top.length) return <p className="brk-body text-muted" data-testid="break-players">Nothing to pick between them yet.</p>;
  return (
    <ol className="brk-body space-y-1" data-testid="break-players">
      {summary.top.map((p, i) => (
        <li key={`${p.side}:${p.name}`} className="flex items-center gap-1.5" data-testid="break-top-player">
          <span className="w-4 shrink-0 font-bold text-cyan">{i + 1}</span>
          <Abbr team={p.side === "home" ? home : away} away={p.side === "away"} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{p.name}</span>
            <span className="block truncate text-muted">{playerLine(p)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Before kick-off: both line-ups walk out of the tunnel (off the bottom touchline, where the players come on at kick-off) to their
 * formation, one by one, then hold there with their names until the kick-off is on the pitch. Same view box as the pitch, so it
 * lines up exactly; reduced motion shows the formation without the walk.
 */
export const PreMatch = memo(function PreMatch({ lineups, home, away }: { lineups: { home: LineupPlayer[]; away: LineupPlayer[] } } & Teams) {
  const kits = useMemo(() => kitsFor(home, away), [home, away]);
  const spots = useMemo(() => {
    const h = formation(lineups.home, "home");
    const a = formation(lineups.away, "away");
    // Alternate the two teams out of the tunnel, keepers first.
    return Array.from({ length: Math.max(h.length, a.length) }, (_, i) => [h[i] && { ...h[i], side: "home" as Side }, a[i] && { ...a[i], side: "away" as Side }]).flat().filter(Boolean) as Array<ReturnType<typeof formation>[number] & { side: Side }>;
  }, [lineups]);
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="prematch">
      <svg viewBox={FULL_CAM.join(" ")} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" aria-label={`Line-ups: ${home.name} and ${away.name}`} role="img">
        {spots.map(({ p, x, y, side }, i) => {
          const kit = p.role === "gk" ? (side === "home" ? kits.homeGk : kits.awayGk) : kits[side];
          return (
            <g key={`${side}:${p.name}`} transform={`translate(${x} ${y})`} data-testid="prematch-player" data-side={side}>
              <g className="walkout" style={{ "--dx": `${(50 - x).toFixed(1)}px`, "--dy": `${(70 - y).toFixed(1)}px`, animationDelay: `${i * 140}ms` } as CSSProperties}>
                <g className="pitch-figure">
                  <circle r={2.4} fill={kit.body} stroke={kit.trim} strokeWidth={0.45} />
                  <text y={0.85} textAnchor="middle" fontWeight={800} fontSize={2.3} fill={kit.num}>
                    {p.no}
                  </text>
                  <text y={5} textAnchor="middle" fontSize={2.1} fontWeight={800} fill="#fff" stroke="rgba(0,0,0,0.8)" strokeWidth={0.5} paintOrder="stroke">
                    {lastName(p.name).toUpperCase()}
                  </text>
                </g>
              </g>
            </g>
          );
        })}
      </svg>
      <div className="absolute inset-x-0 top-[5%] flex justify-center">
        <span className="event-enter rounded-md bg-black/60 px-3 py-0.5 font-display text-xs font-bold tracking-widest text-white sm:text-sm" data-testid="prematch-title">
          LINE-UPS · {home.abbreviation} v {away.abbreviation}
        </span>
      </div>
    </div>
  );
});
