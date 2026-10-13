/**
 * Stateless SVG pitch: draws one Frame (10 players + ball). The parent ticks the playhead;
 * nothing animates in here.
 */
import type { ReactNode } from "react";
import type { TeamPublic } from "../lib/pocketbase";
import type { Frame } from "../domain/sim";
import { FULL_CAM } from "../domain/scenes";

type Props = {
  frame: Frame | null;
  home: TeamPublic;
  away: TeamPublic;
  replay?: boolean;
  revealed: boolean; // MatchPage decides when the result may show (flash moment + displayed ball at the impact point)
  hud?: ReactNode; // compact score / clock / shootout strip pinned to the pitch's top-left corner
};

const W = 100;
const H = 64;
const R = 1.45; // player radius: one size for everyone (the ring and the lime fill are the only marks)
/** Result badge per flash kind (what actually happened, never a generic "no goal"); shootout goals and cards are special-cased below. */
const BADGE: Record<string, string> = { goal: "GOAL!", save: "SAVED!", wood: "WOODWORK", miss: "WIDE", over: "OVER", block: "BLOCKED", pen: "PENALTY" };

/** Number colour from the kit fill: dark text on light kits, white on dark (relative luminance, one threshold). */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) > 150 ? "#0b1404" : "#fff";
}

export default function Pitch({ frame, home, away, replay, revealed, hud }: Props) {
  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  // Project only at the drawing boundary. Smoothing, startBall and impact/reveal all stay canonical.
  // Breaks retain the outgoing end; ET starts right, ET2 left; every shootout kick stays at the left end.
  const flip = !!frame?.phase && ["second_half", "et_break", "extra_time_2", "shootout", "finished"].includes(frame.phase);
  const x = (v: number) => flip ? W - v : v;
  const cam = frame?.cam ?? FULL_CAM;
  const viewBox = [flip ? W - cam[0] - cam[2] : cam[0], ...cam.slice(1)];
  const ball = [x(frame?.ball[0] ?? 50), frame?.ball[1] ?? 32];
  const lift = frame?.lift ?? 0;
  const flash = frame && revealed ? frame.flash : null;
  // Match goals (not shootout kicks): big banner once the ball is in (flash gate) and through the celebration.
  const goal = frame && frame.flash === "goal" && (frame.type === "celebration" || (flash && (frame.type === "goal" || frame.type === "penalty_goal"))) ? frame : null;
  // Shootout stakes, from the setup's kick flags (shootout_kick events don't carry win/must).
  const kick = frame?.kick;
  const team = frame?.side === "away" ? away : home;
  const strip = frame?.type === "shootout_setup" && kick ? `Kick ${kick.no} · ${team.abbreviation} · ${frame.who ?? ""}` : null;
  const pen =
    frame?.type === "shootout_end" && frame.side
      ? { text: `${team.name} are through!`, cls: "bg-lime text-ink text-xl sm:text-3xl" }
      : kick?.win
        ? { text: `${team.abbreviation} score this and they're through!`, cls: "bg-lime text-ink text-sm sm:text-lg" }
        : kick?.must
          ? { text: `${team.abbreviation} must score to stay in`, cls: "bg-amber text-ink text-sm sm:text-lg" }
          : frame?.type === "shootout_setup" && kick?.sd && kick.no === 6
            ? { text: "SUDDEN DEATH", cls: "bg-magenta text-white text-xl sm:text-3xl" } // first SD kick has no stakes flag; the reply kick always does
            : null;
  // Full-pitch banner: GOOOAL (team glow + confetti), FULL-TIME with the winner (lime, held: match_end is the last event), or a period marker (amber, for the scene's life — the whole break).
  const sc = frame?.score ?? [0, 0];
  const PERIOD: Record<string, string> = {
    half_time: `HALF-TIME · ${home.abbreviation} ${sc[0]}–${sc[1]} ${away.abbreviation}`,
    second_half: "SECOND HALF — KICK-OFF",
    end_of_normal_time: `FULL-TIME · ${sc[0]}–${sc[1]} · EXTRA TIME`,
    extra_time: "EXTRA TIME — KICK-OFF",
    et_half_time: `ET HALF-TIME · ${home.abbreviation} ${sc[0]}–${sc[1]} ${away.abbreviation}`,
    et_second_half: "ET SECOND HALF",
    shootout_start: "PENALTY SHOOTOUT",
  };
  const period = frame && frame.p < 1 ? PERIOD[frame.type] : undefined;
  const dim = !!period && frame!.p * frame!.ms > 4000; // after 4 s the break banner lets the pitch show through
  const ft = frame?.type === "match_end" && frame.side ? frame : null;
  const glow = goal ? (goal.side === "away" ? ac : hc) : null;
  const banner = goal
    ? { id: "goal-banner", title: "GOOOAL!", sub: goal.score ? `${home.abbreviation} ${goal.score[0]}–${goal.score[1]} ${away.abbreviation}` : "", who: goal.who, cls: "goal-pop text-white", big: true }
    : ft
      ? { id: "ft-banner", title: "FULL-TIME", sub: `${team.name} go through!`, who: ft.by === "aet" ? "after extra time" : ft.by === "pens" && ft.pens ? `on penalties ${Math.max(...ft.pens)}–${Math.min(...ft.pens)}` : "", cls: "goal-pop text-lime", big: true }
      : period
        ? { id: "period-banner", title: period, sub: "", who: "", cls: "event-enter text-amber", big: false }
        : null;

  return (
    <>
      <div className="mb-1 flex gap-3 font-display text-[10px] font-bold tracking-wider text-muted" data-testid="kit-legend">
        <span className="flex items-center gap-1">
          <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: hc }} /> {home.abbreviation}
        </span>
        <span className="flex items-center gap-1">
          <i className="inline-block h-2.5 w-2.5 rounded-full bg-[#f4f7ff]" style={{ boxShadow: `0 0 0 2px ${ac}` }} /> {away.abbreviation}
        </span>
      </div>
      {/* Keep the camera aspect stable. Responsive chrome/insets live in CSS; tiny screens retain the old cap. */}
      <div className="match-pitch relative mx-auto w-full overflow-hidden rounded-xl border border-line bg-[#0a2416]" style={{ aspectRatio: `${FULL_CAM[2]}/${FULL_CAM[3]}`, maxWidth: `max(260px, calc((100vh - var(--pitch-chrome, 360px)) * ${(FULL_CAM[2] / FULL_CAM[3]).toFixed(4)}))` }} data-testid="pitch">
        <svg viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" role="img" aria-label={frame ? frame.caption : "Pitch"}>
        <defs>
          <pattern id="stripes" width="12.5" height={H} patternUnits="userSpaceOnUse">
            <rect width="6.25" height={H} fill="#0f3a22" />
            <rect x="6.25" width="6.25" height={H} fill="#0d331e" />
          </pattern>
          <radialGradient id="glow">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill="url(#stripes)" />
        <g stroke="rgba(220,255,240,0.55)" strokeWidth="0.35" fill="none">
          <rect x={0} y={0} width={W} height={H} />
          <line x1={50} y1={0} x2={50} y2={H} />
          <circle cx={50} cy={32} r={8} />
          <rect x={0} y={16} width={15} height={32} />
          <rect x={85} y={16} width={15} height={32} />
          <rect x={0} y={25} width={5} height={14} />
          <rect x={95} y={25} width={5} height={14} />
          <circle cx={11} cy={32} r={0.4} fill="rgba(220,255,240,0.7)" />
          <circle cx={89} cy={32} r={0.4} fill="rgba(220,255,240,0.7)" />
        </g>
        {/* goals (net behind the line) */}
        <g>
          <rect x={-3} y={28} width={3} height={8} fill="rgba(255,255,255,0.1)" stroke="#fff" strokeWidth="0.45" />
          <rect x={100} y={28} width={3} height={8} fill="rgba(255,255,255,0.1)" stroke="#fff" strokeWidth="0.45" />
        </g>

        {frame?.players.map((p) => {
          const c = p.side === "home" ? hc : ac;
          const isAway = p.side === "away";
          const r = R;
          return (
            <g key={`${p.side}-${p.name}`} transform={`translate(${x(p.x)} ${p.y})`} data-testid="player">
              <ellipse cx={0} cy={r} rx={r} ry={0.6} fill="rgba(0,0,0,0.35)" />
              {frame.carrier === p.side + ":" + p.no && lift < 0.05 && Math.hypot(p.x - frame.ball[0], p.y - frame.ball[1]) <= 1.6 ? <circle r={r + 0.7} fill="none" stroke="#fff" strokeWidth={0.5} data-ring /> : null}
              <circle r={r} fill={p.gk ? "#c6ff00" : isAway ? "#f4f7ff" : c} stroke={p.gk || isAway ? c : "rgba(255,255,255,0.7)"} strokeWidth={0.3} data-kit />
              <text y={r * 0.42} textAnchor="middle" fontWeight={700} fill={textOn(p.gk ? "#c6ff00" : isAway ? "#f4f7ff" : c)} fontSize={r * 1.1}>
                {p.no}
              </text>
            </g>
          );
        })}

        {frame ? <circle cx={x(frame.ref[0])} cy={frame.ref[1]} r={R} fill="#ffd400" stroke="#000" strokeWidth={0.3} data-testid="ref" /> : null}

        {/* ball: shadow on the ground, ball lifted by height */}
        <ellipse cx={ball[0]} cy={ball[1] + 0.9} rx={0.9} ry={0.35} fill="rgba(0,0,0,0.45)" />
        <circle cx={ball[0]} cy={ball[1] - lift * 3} r={0.85 + lift * 0.35} fill="#fff" stroke="#111" strokeWidth="0.2" />

        {flash === "goal" ? <circle cx={ball[0]} cy={32} r={9} fill="url(#glow)" opacity={0.7} /> : null}
      </svg>

      {banner ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden bg-black/30 transition-opacity duration-1000" style={dim ? { opacity: 0.85 } : undefined} data-testid={banner.id}>
          {glow ? (
            <div className="confetti absolute inset-x-0 top-0 h-0" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} style={{ left: `${(i * 4.3 + 2) % 100}%`, background: i % 3 ? glow : "#fff", animationDelay: `${(i % 6) * 0.15}s` }} />
              ))}
            </div>
          ) : null}
          <div className={`text-center ${banner.cls}`}>
            <div className={`font-display font-black ${banner.big ? "text-5xl" : "text-4xl"} sm:text-6xl`} style={glow ? { textShadow: `0 0 18px ${glow}, 0 0 40px ${glow}` } : undefined}>
              {banner.title}
            </div>
            {banner.sub ? <div className="mt-1 font-display text-2xl font-black tabular sm:text-3xl">{banner.sub}</div> : null}
            {banner.who ? <div className="mt-1 text-sm font-bold sm:text-base">{banner.who}</div> : null}
          </div>
        </div>
      ) : frame && flash ? (
        <div className="pointer-events-none absolute inset-x-0 top-9 flex justify-center">
          <span
            className={`event-enter rounded-md px-3 py-1 font-display text-sm font-black tracking-widest shadow-lg ${
              flash === "goal" ? "bg-lime text-ink" : flash === "save" ? "bg-cyan text-ink" : flash === "card" ? "bg-live text-white" : "bg-amber text-ink"
            }`}
          >
            {flash === "goal"
              ? frame.type === "shootout_kick" && frame.pens
                ? `GOAL! ${frame.pens[0]}–${frame.pens[1]}`
                : "GOAL!"
              : flash === "card"
                ? frame.type === "red_card"
                  ? "RED CARD"
                  : "BOOKED"
                : BADGE[flash]}
          </span>
        </div>
      ) : null}
      {frame?.won && !banner ? (
        // WON IT: a challenge cue, not a result — in the winning side's colour, under any result badge still showing.
        <div className={`pointer-events-none absolute inset-x-0 ${flash ? "top-[4.25rem]" : "top-9"} flex justify-center`}>
          <span className="event-enter rounded-md px-3 py-1 font-display text-sm font-black tracking-widest shadow-lg" style={{ background: frame.won === "home" ? hc : ac, color: textOn(frame.won === "home" ? hc : ac) }} data-testid="won-badge">
            WON IT
          </span>
        </div>
      ) : null}
      {hud ? (
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 font-display text-[11px] font-bold tracking-wider text-white shadow-lg sm:text-xs" data-testid="pitch-hud">
          {hud}
        </div>
      ) : null}
      {strip ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center font-display text-[11px] font-bold tracking-widest text-white" data-testid="pen-strip">
          {strip}
        </div>
      ) : null}
      {pen ? (
        <div className={`pointer-events-none absolute inset-x-0 ${strip ? "bottom-7" : "bottom-3"} flex justify-center px-2`}>
          <span className={`goal-pop rounded-md px-3 py-1 text-center font-display font-black tracking-wide shadow-lg ${pen.cls}`} data-testid="pen-banner">
            {pen.text}
          </span>
        </div>
      ) : null}
        {replay ? <span className="chip chip-amber absolute right-2 top-2">Replay</span> : null}
      </div>
    </>
  );
}
