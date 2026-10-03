/**
 * Lightweight SVG highlight player. Plays one Scene at a time with requestAnimationFrame;
 * actors keep their identity between scenes so movement connects. Reduced motion → the
 * final frame of each scene is shown instead of the movement.
 */
import { useEffect, useRef, useState } from "react";
import type { TeamPublic } from "../lib/pocketbase";
import { sample, sampleN, type Scene } from "../domain/scenes";

type Props = {
  scene: Scene | null;
  home: TeamPublic;
  away: TeamPublic;
  reduced: boolean;
  onDone: () => void;
  replay?: boolean;
};

const W = 100;
const H = 64;

export default function Pitch({ scene, home, away, reduced, onDone, replay }: Props) {
  const [t, setT] = useState(1);
  const raf = useRef(0);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!scene) return;
    if (scene.ms <= 0) {
      setT(1); // static frame (late join / idle)
      return;
    }
    if (reduced) {
      setT(1);
      const id = setTimeout(() => doneRef.current(), Math.min(scene.ms, 2200));
      return () => clearTimeout(id);
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / scene.ms);
      setT(p);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setTimeout(() => doneRef.current(), scene.important ? 900 : 250);
    };
    setT(0);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [scene, reduced]);

  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  const ball = scene ? sample(scene.ball, t) : ([50, 32] as [number, number]);
  const lift = scene ? sampleN(scene.ballHeight, t) : 0;
  const flashOn = scene?.flash && t > 0.62;

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-line bg-[#0a2416]" data-testid="pitch">
      <svg viewBox={`-4 -3 ${W + 8} ${H + 6}`} className="block h-auto w-full" role="img" aria-label={scene ? scene.caption : "Pitch"}>
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

        {scene?.actors.map((a) => {
          const [x, y] = sample(a.path, t);
          const c = a.side === "home" ? hc : a.side === "away" ? ac : "#111";
          const isAway = a.side === "away";
          const ref = a.side === "ref";
          return (
            <g key={a.id} transform={`translate(${x} ${y})`}>
              <ellipse cx={0} cy={1.6} rx={1.7} ry={0.6} fill="rgba(0,0,0,0.35)" />
              <circle
                r={a.keeper ? 1.9 : 1.7}
                fill={ref ? "#ffd400" : a.keeper ? "#c6ff00" : isAway ? "#f4f7ff" : c}
                stroke={ref ? "#111" : a.keeper ? c : isAway ? c : "rgba(255,255,255,0.7)"}
                strokeWidth={isAway || a.keeper ? 0.7 : 0.3}
              />
              {a.label ? (
                <text y={-2.6} textAnchor="middle" className="pitch-label" fontWeight={700} fill="#fff" stroke="#000" strokeWidth="0.5" paintOrder="stroke">
                  {a.label}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* ball: shadow on the ground, ball lifted by height */}
        <ellipse cx={ball[0]} cy={ball[1] + 0.9} rx={0.9} ry={0.35} fill="rgba(0,0,0,0.45)" />
        <circle cx={ball[0]} cy={ball[1] - lift * 3} r={0.85 + lift * 0.35} fill="#fff" stroke="#111" strokeWidth="0.2" />

        {flashOn && scene?.flash === "goal" ? <circle cx={scene.ball[scene.ball.length - 1][0]} cy={32} r={9} fill="url(#glow)" opacity={0.7} /> : null}
      </svg>

      {scene && flashOn && scene.flash ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
          <span
            className={`event-enter rounded-md px-3 py-1 font-display text-sm font-black tracking-widest shadow-lg ${
              scene.flash === "goal" ? "bg-lime text-ink" : scene.flash === "save" ? "bg-cyan text-ink" : scene.flash === "card" ? "bg-live text-white" : "bg-amber text-ink"
            }`}
          >
            {scene.flash === "goal"
              ? "GOAL!"
              : scene.flash === "save"
                ? "SAVED"
                : scene.flash === "wood"
                  ? "WOODWORK"
                  : scene.flash === "card"
                    ? scene.type === "red_card"
                      ? "RED CARD"
                      : "BOOKED"
                    : scene.flash === "pen"
                      ? "PENALTY"
                      : "NO GOAL"}
          </span>
        </div>
      ) : null}
      {replay ? <span className="chip chip-amber absolute left-2 top-2">Replay</span> : null}
    </div>
  );
}
