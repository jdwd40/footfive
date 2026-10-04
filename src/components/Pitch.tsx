/**
 * Stateless SVG pitch: draws one Frame (10 players + ball). The parent ticks the playhead;
 * nothing animates in here.
 */
import type { TeamPublic } from "../lib/pocketbase";
import type { Frame } from "../domain/sim";

type Props = {
  frame: Frame | null;
  home: TeamPublic;
  away: TeamPublic;
  replay?: boolean;
};

const W = 100;
const H = 64;

export default function Pitch({ frame, home, away, replay }: Props) {
  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  const ball = frame?.ball ?? ([50, 32] as [number, number]);
  const lift = frame?.lift ?? 0;
  const flash = frame && frame.p > 0.62 ? frame.flash : null;
  // Match goals (not shootout kicks): big banner once the ball is in (flash gate) and through the celebration.
  const goal = frame && frame.flash === "goal" && (frame.type === "celebration" || (flash && (frame.type === "goal" || frame.type === "penalty_goal"))) ? frame : null;
  // Shootout stakes, from the setup's kick flags (shootout_kick events don't carry win/must).
  const kick = frame?.kick;
  const team = frame?.side === "away" ? away : home;
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
      <div className="relative w-full overflow-hidden rounded-xl border border-line bg-[#0a2416]" data-testid="pitch">
        <svg viewBox={`-4 -3 ${W + 8} ${H + 6}`} className="block h-auto w-full" role="img" aria-label={frame ? frame.caption : "Pitch"}>
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
          const r = p.hot ? 2.2 : 1.7;
          return (
            <g key={`${p.side}-${p.name}`} transform={`translate(${p.x} ${p.y})`} data-testid="player">
              <ellipse cx={0} cy={r} rx={r} ry={0.6} fill="rgba(0,0,0,0.35)" />
              {p.hot ? <circle r={r + 0.7} fill="none" stroke="#fff" strokeWidth={0.5} data-ring /> : null}
              <circle r={r} fill={p.gk ? "#c6ff00" : isAway ? "#f4f7ff" : c} stroke={p.gk || isAway ? c : "rgba(255,255,255,0.7)"} strokeWidth={isAway || p.gk ? 0.9 : 0.3} data-kit />
              <text y={r * 0.42} textAnchor="middle" fontWeight={700} fill={p.gk || isAway ? "#0b1404" : "#fff"} fontSize={r * 1.1}>
                {p.no}
              </text>
            </g>
          );
        })}

        {/* ball: shadow on the ground, ball lifted by height */}
        <ellipse cx={ball[0]} cy={ball[1] + 0.9} rx={0.9} ry={0.35} fill="rgba(0,0,0,0.45)" />
        <circle cx={ball[0]} cy={ball[1] - lift * 3} r={0.85 + lift * 0.35} fill="#fff" stroke="#111" strokeWidth="0.2" />

        {flash === "goal" ? <circle cx={ball[0]} cy={32} r={9} fill="url(#glow)" opacity={0.7} /> : null}
      </svg>

      {goal ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/30" data-testid="goal-banner">
          <div className="goal-pop text-center">
            <div className="font-display text-5xl font-black text-white sm:text-6xl" style={{ textShadow: `0 0 18px ${goal.side === "away" ? ac : hc}, 0 0 40px ${goal.side === "away" ? ac : hc}` }}>
              GOOOAL!
            </div>
            <div className="mt-1 text-sm font-bold text-white sm:text-base">
              {goal.who}
              {goal.score ? ` · ${goal.score[0]}–${goal.score[1]}` : ""}
            </div>
          </div>
        </div>
      ) : frame && flash ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
          <span
            className={`event-enter rounded-md px-3 py-1 font-display text-sm font-black tracking-widest shadow-lg ${
              flash === "goal" ? "bg-lime text-ink" : flash === "save" ? "bg-cyan text-ink" : flash === "card" ? "bg-live text-white" : "bg-amber text-ink"
            }`}
          >
            {flash === "goal"
              ? "GOAL!"
              : flash === "save"
                ? "SAVED"
                : flash === "wood"
                  ? "WOODWORK"
                  : flash === "card"
                    ? frame.type === "red_card"
                      ? "RED CARD"
                      : "BOOKED"
                    : flash === "pen"
                      ? "PENALTY"
                      : "NO GOAL"}
          </span>
        </div>
      ) : null}
      {pen ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-2">
          <span className={`goal-pop rounded-md px-3 py-1 text-center font-display font-black tracking-wide shadow-lg ${pen.cls}`} data-testid="pen-banner">
            {pen.text}
          </span>
        </div>
      ) : null}
        {replay ? <span className="chip chip-amber absolute left-2 top-2">Replay</span> : null}
      </div>
    </>
  );
}
