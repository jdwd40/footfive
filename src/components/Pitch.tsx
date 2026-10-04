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

  return (
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
          return (
            <g key={`${p.side}-${p.name}`} transform={`translate(${p.x} ${p.y})${p.hot ? " scale(1.15)" : ""}`} data-testid="player">
              <ellipse cx={0} cy={1.6} rx={1.7} ry={0.6} fill="rgba(0,0,0,0.35)" />
              <circle r={p.gk ? 1.9 : 1.7} fill={p.gk ? "#c6ff00" : isAway ? "#f4f7ff" : c} stroke={p.gk || isAway ? c : "rgba(255,255,255,0.7)"} strokeWidth={isAway || p.gk ? 0.7 : 0.3} />
              {p.hot ? (
                <text y={-2.6} textAnchor="middle" className="pitch-label" fontWeight={700} fill="#fff" stroke="#000" strokeWidth="0.5" paintOrder="stroke">
                  {p.name}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* ball: shadow on the ground, ball lifted by height */}
        <ellipse cx={ball[0]} cy={ball[1] + 0.9} rx={0.9} ry={0.35} fill="rgba(0,0,0,0.45)" />
        <circle cx={ball[0]} cy={ball[1] - lift * 3} r={0.85 + lift * 0.35} fill="#fff" stroke="#111" strokeWidth="0.2" />

        {flash === "goal" ? <circle cx={ball[0]} cy={32} r={9} fill="url(#glow)" opacity={0.7} /> : null}
      </svg>

      {frame && flash ? (
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
      {replay ? <span className="chip chip-amber absolute left-2 top-2">Replay</span> : null}
    </div>
  );
}
