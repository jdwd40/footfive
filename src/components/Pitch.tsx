/**
 * SVG pitch: draws one Frame (10 players + ball). The parent ticks the playhead; nothing animates in here. The only state is
 * the last ~TRAIL_MS of drawn ball positions, for the ball's motion trail (#204) — presentation only.
 */
import { memo, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { Side, TeamPublic } from "../lib/pocketbase";
import type { Frame } from "../domain/sim";
import { FULL_CAM } from "../domain/scenes";
import { kitsFor } from "./kits";

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
const R = 1.45; // referee body radius (his figure is unchanged by #204)
/** Result badge per flash kind (what actually happened, never a generic "no goal"); shootout goals and cards are special-cased below. */
const BADGE: Record<string, string> = { goal: "GOAL!", save: "SAVED!", wood: "WOODWORK", miss: "WIDE", over: "OVER", block: "BLOCKED", pen: "PENALTY" };

// Shirt outline in player-local units (about 4.5 wide, 4 tall), drawn from above like a kit icon. The player's x/y is its centre.
const BODY = "M -1.3 -1.55 L -0.55 -1.95 Q 0 -1.4 0.55 -1.95 L 1.3 -1.55 L 1.3 1.95 L -1.3 1.95 Z";
const SLEEVES = "M -1.3 -1.55 L -2.25 -0.8 L -1.75 0.1 L -1.3 -0.2 Z M 1.3 -1.55 L 2.25 -0.8 L 1.75 0.1 L 1.3 -0.2 Z";
const GK_SLEEVES = "M -1.3 -1.55 L -2.3 -0.6 L -2.05 1 L -1.45 1 L -1.3 0.1 Z M 1.3 -1.55 L 2.3 -0.6 L 2.05 1 L 1.45 1 L 1.3 0.1 Z";
const GLOVES = "M -2.15 1 h 0.8 v 0.75 h -0.8 Z M 1.35 1 h 0.8 v 0.75 h -0.8 Z";
const COLLAR = "M -0.55 -1.95 Q 0 -1.4 0.55 -1.95";
const SHIRT_H = 1.95;
const BALL_R = 1.15;
/** Ball trail: drawn from where the ball was this long ago, at most this long (pitch units); longer jumps are cuts, not motion. */
const TRAIL_MS = 140;
const TRAIL_MAX = 7;
const TRAIL_CUT = 20;
type Sample = { x: number; y: number; t: number };

/** A figure with a fixed-size shirt, head and boots; gestures are drawn from the published event's pose, without CSS animation. */
function Referee({ frame, projectX }: { frame: Frame; projectX: (x: number) => number }) {
  const pose = frame.refPose ?? "run";
  const aim = frame.refAim ?? [frame.ref[0] + 1, frame.ref[1]];
  const dx = projectX(aim[0]) - projectX(frame.ref[0]);
  const dy = aim[1] - frame.ref[1];
  const distance = Math.hypot(dx, dy) || 1;
  const arm: [number, number] = pose === "point" ? [dx / distance * 3.8, dy / distance * 3.8] : [dx < 0 ? -1.8 : 1.8, -3.4];
  const card = pose === "card-yellow" || pose === "card-red";
  return (
    <g transform={`translate(${projectX(frame.ref[0])} ${frame.ref[1]})`} data-testid="ref" data-pose={pose} role="img" aria-label={`Referee: ${pose.replaceAll("-", " ")}`}>
      <ellipse cy={2} rx={1.5} ry={0.55} fill="rgba(0,0,0,0.35)" />
      <path d="M -0.6 1 L -1.1 2.3 M 0.6 1 L 1.1 2.3" fill="none" stroke="#111" strokeWidth={0.8} strokeLinecap="round" />
      <circle r={R} fill="#ffd400" stroke="#000" strokeWidth={0.3} data-ref-body />
      <circle cy={-2.2} r={0.75} fill="#f2c6a0" stroke="#000" strokeWidth={0.25} />
      {pose === "whistle" ? (
        <g data-testid="ref-whistle">
          <path d="M 1 0 L 2 -1 L 0.8 -2" fill="none" stroke="#ffd400" strokeWidth={0.7} strokeLinecap="round" />
          <circle cx={0.9} cy={-2} r={0.35} fill="#fff" stroke="#000" strokeWidth={0.2} />
          <path d="M 1.8 -3 L 2.8 -3.5 M 2 -2.2 L 3.1 -2.2" stroke="#fff" strokeWidth={0.3} />
        </g>
      ) : pose === "point" || card ? (
        <>
          <line x1={arm[0] * 0.25} y1={0} x2={arm[0]} y2={arm[1]} stroke="#111" strokeWidth={1} strokeLinecap="round" />
          <line x1={arm[0] * 0.25} y1={0} x2={arm[0]} y2={arm[1]} stroke="#ffd400" strokeWidth={0.65} strokeLinecap="round" data-ref-arm />
          {card ? <rect x={arm[0] - 0.7} y={arm[1] - 1.6} width={1.4} height={1.8} rx={0.15} fill={pose === "card-red" ? "#ff3344" : "#ffd400"} stroke="#111" strokeWidth={0.25} data-testid="ref-card" /> : <circle cx={arm[0]} cy={arm[1]} r={0.3} fill="#f2c6a0" />}
        </>
      ) : <path d="M -1 0 L -2 1 M 1 0 L 1.8 0.8" fill="none" stroke="#ffd400" strokeWidth={0.65} strokeLinecap="round" />}
    </g>
  );
}

/** Two patterned sections, with CSS doing the cheering. Ordinary pitch ticks do not update this subtree. */
const Crowd = memo(function Crowd({ cheering, cue }: { cheering: Side | null; cue: string }) {
  return (["home", "away"] as const).map(side => (
    <div
      key={cheering === side ? `${side}:${cue}` : side}
      className={`stadium-stand stadium-${side}${cheering === side ? " cheer" : ""}`}
      data-testid={`${side}-crowd`}
      aria-hidden
    />
  ));
});

/** Static grass, markings, goals and floodlight spill: no props, so ordinary ticks never re-render or re-diff it. */
const Field = memo(function Field() {
  return (
    <>
      <defs>
        <pattern id="stripes" width="20" height={H} patternUnits="userSpaceOnUse">
          <rect width="10" height={H} fill="#1a5a30" />
          <rect x="10" width="10" height={H} fill="#164f2a" />
        </pattern>
        <pattern id="cross" width={W} height="8" patternUnits="userSpaceOnUse">
          <rect width={W} height="4" fill="rgba(255,255,255,0.035)" />
        </pattern>
        <pattern id="net" width="0.9" height="0.9" patternUnits="userSpaceOnUse">
          <path d="M 0 0 L 0.9 0.9 M 0.9 0 L 0 0.9" stroke="rgba(255,255,255,0.35)" strokeWidth="0.12" />
        </pattern>
        <radialGradient id="glow">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="flood">
          <stop offset="0%" stopColor="#fff6d6" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#fff6d6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="vignette" cx="50%" cy="50%" r="70%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.32" />
        </radialGradient>
      </defs>
      {/* apron (inside the fixed viewBox, so the stadium frame adds no layout) */}
      <rect x={-4} y={-3} width={108} height={77} fill="#0d3019" />
      <rect x={-1.5} y={-1.5} width={W + 3} height={H + 3} fill="#123f22" />
      <rect x={0} y={0} width={W} height={H} fill="url(#stripes)" />
      <rect x={0} y={0} width={W} height={H} fill="url(#cross)" />
      <rect x={-4} y={-3} width={108} height={77} fill="url(#vignette)" />
      <g data-testid="floodlights">
        {[[0, 0], [W, 0], [0, H], [W, H]].map(([cx, cy]) => <circle key={`${cx}:${cy}`} cx={cx} cy={cy} r={18} fill="url(#flood)" />)}
      </g>
      <g stroke="rgba(255,255,255,0.78)" strokeWidth="0.4" fill="none" data-testid="markings">
        <rect x={0} y={0} width={W} height={H} />
        <line x1={50} y1={0} x2={50} y2={H} />
        <circle cx={50} cy={32} r={8} />
        <rect x={0} y={16} width={15} height={32} />
        <rect x={85} y={16} width={15} height={32} />
        <rect x={0} y={25} width={5} height={14} />
        <rect x={95} y={25} width={5} height={14} />
        <path d="M 15 25.07 A 8 8 0 0 1 15 38.93 M 85 25.07 A 8 8 0 0 0 85 38.93" />
        <path d={`M 1.2 0 A 1.2 1.2 0 0 1 0 1.2 M ${W - 1.2} 0 A 1.2 1.2 0 0 0 ${W} 1.2 M 0 ${H - 1.2} A 1.2 1.2 0 0 1 1.2 ${H} M ${W} ${H - 1.2} A 1.2 1.2 0 0 0 ${W - 1.2} ${H}`} />
        <g fill="rgba(255,255,255,0.85)" stroke="none">
          <circle cx={50} cy={32} r={0.45} />
          <circle cx={11} cy={32} r={0.4} />
          <circle cx={89} cy={32} r={0.4} />
        </g>
      </g>
      {/* goals (net behind the line) */}
      <g fill="url(#net)" stroke="#fff" strokeWidth="0.45">
        <rect x={-3} y={28} width={3} height={8} />
        <rect x={100} y={28} width={3} height={8} />
      </g>
    </>
  );
});

/** Where the drawn ball was about TRAIL_MS ago, from this component's own recent samples (presentation only). */
function useTrail(pos: [number, number] | null) {
  const hist = useRef<Sample[]>([]);
  const h = hist.current;
  if (!pos) {
    h.length = 0;
    return null;
  }
  const t = performance.now();
  while (h.length && (t - h[0].t > TRAIL_MS || h.length > 12)) h.shift();
  const tail = h[0];
  if (!h.length || h[h.length - 1].t !== t || h[h.length - 1].x !== pos[0] || h[h.length - 1].y !== pos[1]) h.push({ x: pos[0], y: pos[1], t });
  if (!tail) return null;
  const dx = pos[0] - tail.x;
  const dy = pos[1] - tail.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.6 || len > TRAIL_CUT) return null; // resting ball, or a cut (scene snap, change of ends)
  const k = Math.min(len, TRAIL_MAX) / len;
  return { x: pos[0] - dx * k, y: pos[1] - dy * k };
}

export default function Pitch({ frame, home, away, replay, revealed, hud }: Props) {
  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  const kits = useMemo(() => kitsFor(home, away), [home, away]);
  // Project only at the drawing boundary. Smoothing, startBall and impact/reveal all stay canonical.
  // Breaks retain the outgoing end; ET starts right, ET2 left; every shootout kick stays at the left end.
  const flip = !!frame?.phase && ["second_half", "et_break", "extra_time_2", "shootout", "finished"].includes(frame.phase);
  const x = (v: number) => flip ? W - v : v;
  // #203: no camera zoom. The view is always the whole pitch (symmetric about x = 50, so the end switch needs no projection).
  const viewBox = FULL_CAM;
  const ball = [x(frame?.ball[0] ?? 50), frame?.ball[1] ?? 32];
  const lift = frame?.lift ?? 0;
  const ballR = BALL_R + lift * 0.45;
  const drawnBall: [number, number] = [ball[0], ball[1] - lift * 3];
  const trail = useTrail(frame ? drawnBall : null);
  // The carrier: the scene's candidate, only while the drawn ball is actually at his feet (unchanged rule; ring and name share it).
  const carrier = frame?.players.find((p) => frame.carrier === p.side + ":" + p.no && lift < 0.05 && Math.hypot(p.x - frame.ball[0], p.y - frame.ball[1]) <= 1.6) ?? null;
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
    ? { id: "goal-banner", title: "GOOOAL!", sub: goal.score ? `${home.abbreviation} ${goal.score[0]}–${goal.score[1]} ${away.abbreviation}` : "", who: goal.who, cls: "goal-pop text-white" }
    : ft
      ? { id: "ft-banner", title: "FULL-TIME", sub: `${team.name} go through!`, who: ft.by === "aet" ? "after extra time" : ft.by === "pens" && ft.pens ? `on penalties ${Math.max(...ft.pens)}–${Math.min(...ft.pens)}` : "", cls: "goal-pop text-lime" }
      : period
        ? { id: "period-banner", title: period, sub: "", who: "", cls: "event-enter text-amber" }
        : null;
  // #203: every banner fits the pitch at any width. A title breaks onto its own line at " · " / " — " (the separator stays in the
  // text, unseen), and its size follows the pitch width (cqw of the banner box) so the longest line fits, capped at the old 60 px.
  const titleLines = banner ? banner.title.split(/ ([·—]) /) : [];
  const longest = Math.max(1, ...titleLines.filter((_, i) => i % 2 === 0).map((l) => l.length));
  const cheering = goal?.side ?? ft?.side ?? (frame?.type === "shootout_end" ? frame.side : null) ?? null;
  // A goal and its celebration share a score; a new goal restarts the cheer even for consecutive goals by the same side.
  const cue = goal && cheering ? `goal:${goal.score?.join("-") ?? goal.seq}` : cheering ? `winner:${cheering}` : "";
  const pitchMaxWidth = `max(260px, calc((100vh - var(--pitch-chrome, 360px)) * ${(FULL_CAM[2] / FULL_CAM[3]).toFixed(4)}))`;

  return (
    <>
      <div className="stadium relative mx-auto w-full" style={{ maxWidth: pitchMaxWidth, "--home": hc, "--away": ac } as CSSProperties} data-testid="stadium">
      <Crowd cheering={cheering} cue={cue} />
      {/* Keep the camera aspect stable. Responsive chrome/insets live in CSS; tiny screens retain the old cap. */}
      <div className="match-pitch relative mx-auto w-full overflow-hidden rounded-xl border border-line bg-[#0a2416]" style={{ aspectRatio: `${FULL_CAM[2]}/${FULL_CAM[3]}`, maxWidth: pitchMaxWidth }} data-testid="pitch">
        <svg viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" role="img" aria-label={frame ? frame.caption : "Pitch"}>
        <Field />

        {frame?.players.map((p) => {
          const kit = p.gk ? (p.side === "home" ? kits.homeGk : kits.awayGk) : kits[p.side];
          const edge = kit.num === "#fff" ? "rgba(255,255,255,0.85)" : "rgba(5,10,20,0.8)";
          return (
            <g key={`${p.side}-${p.name}`} transform={`translate(${x(p.x)} ${p.y})`} data-testid="player" data-side={p.side} data-gk={p.gk || undefined}>
              <g className="pitch-figure">
                <ellipse cx={0} cy={SHIRT_H} rx={2} ry={0.65} fill="rgba(0,0,0,0.35)" />
                {p === carrier ? <circle r={3.1} fill="rgba(255,255,255,0.12)" stroke="#fff" strokeWidth={0.45} data-ring /> : null}
                <path d={p.gk ? GK_SLEEVES : SLEEVES} fill={kit.sleeves} stroke={edge} strokeWidth={0.22} strokeLinejoin="round" data-sleeves />
                <path d={BODY} fill={kit.body} stroke={edge} strokeWidth={0.22} strokeLinejoin="round" data-kit />
                <path d={COLLAR} fill="none" stroke={kit.trim} strokeWidth={0.45} strokeLinecap="round" data-trim />
                {p.gk ? <path d={GLOVES} fill="#f4f7ff" stroke={edge} strokeWidth={0.15} data-gloves /> : null}
                <text y={0.95} textAnchor="middle" fontWeight={800} fill={kit.num} fontSize={2.3}>
                  {p.no}
                </text>
              </g>
            </g>
          );
        })}

        {frame ? <Referee frame={frame} projectX={x} /> : null}

        {/* ball: a short trail (fixed nodes, hidden at rest and across cuts), shadow on the ground, ball lifted by height */}
        <g data-testid="ball-trail" className="ball-trail" display={trail ? undefined : "none"} pointerEvents="none">
          {(() => {
            const t = trail ?? { x: drawnBall[0], y: drawnBall[1] };
            const dx = drawnBall[0] - t.x;
            const dy = drawnBall[1] - t.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = (-dy / len) * ballR * 0.85;
            const ny = (dx / len) * ballR * 0.85;
            const at = (k: number) => [t.x + dx * k, t.y + dy * k];
            const [ax, ay] = at(0.35);
            const [bx, by] = at(0.68);
            return (
              <>
                <path d={`M ${drawnBall[0] + nx} ${drawnBall[1] + ny} L ${t.x} ${t.y} L ${drawnBall[0] - nx} ${drawnBall[1] - ny} Z`} fill="#fff" opacity={0.28} />
                <circle cx={ax} cy={ay} r={ballR * 0.55} fill="#fff" opacity={0.25} />
                <circle cx={bx} cy={by} r={ballR * 0.75} fill="#fff" opacity={0.4} />
              </>
            );
          })()}
        </g>
        {/* Shadow and ball keep their own cx/cy (gameplay specs read them); phones scale them about their own centres. */}
        <ellipse className="pitch-figure-c" cx={ball[0]} cy={ball[1] + 0.9} rx={1.2} ry={0.45} fill="rgba(0,0,0,0.45)" />
        <circle className="pitch-figure-c" cx={drawnBall[0]} cy={drawnBall[1]} r={ballR} fill="#fff" stroke="#111" strokeWidth="0.25" data-testid="ball" />

        {carrier ? (
          // Under the carrier, kept inside the pitch at the touchlines; scales with the figures on phones.
          <g transform={`translate(${Math.min(93, Math.max(7, x(carrier.x)))} ${carrier.y})`}>
            <text
              className="pitch-figure"
              y={SHIRT_H + 2.6}
              textAnchor="middle"
              fontSize={2}
              fontWeight={800}
              letterSpacing={0.1}
              fill="#fff"
              stroke="rgba(0,0,0,0.8)"
              strokeWidth={0.55}
              paintOrder="stroke"
              data-testid="carrier-name"
            >
              {carrier.name.trim().split(/\s+/).at(-1)!.toUpperCase()}
            </text>
          </g>
        ) : null}

        {flash === "goal" ? <circle cx={ball[0]} cy={32} r={9} fill="url(#glow)" opacity={0.7} /> : null}
      </svg>

      {banner ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden bg-black/30 px-[4%] transition-opacity duration-1000 [container-type:inline-size]" style={dim ? { opacity: 0.85 } : undefined} data-testid={banner.id}>
          {glow ? (
            <div className="confetti absolute inset-x-0 top-0 h-0" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} style={{ left: `${(i * 4.3 + 2) % 100}%`, background: i % 3 ? glow : "#fff", animationDelay: `${(i % 6) * 0.15}s` }} />
              ))}
            </div>
          ) : null}
          <div className={`min-w-0 max-w-full text-center [overflow-wrap:anywhere] ${banner.cls}`}>
            <div className="font-display font-black leading-none text-balance" style={{ fontSize: `min(3.75rem, ${(108 / longest).toFixed(2)}cqw)`, ...(glow ? { textShadow: `0 0 18px ${glow}, 0 0 40px ${glow}` } : null) }} data-testid="banner-title">
              {titleLines.map((part, i) => (i % 2 ? <span key={i} className="hidden">{` ${part} `}</span> : <span key={i} className="block">{part}</span>))}
            </div>
            {banner.sub ? <div className="mt-1 font-display font-black leading-tight tabular text-balance" style={{ fontSize: "min(1.875rem, 6.5cqw)" }}>{banner.sub}</div> : null}
            {banner.who ? <div className="mt-1 font-bold leading-tight" style={{ fontSize: "min(1rem, 4.5cqw)" }}>{banner.who}</div> : null}
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
      </div>
    </>
  );
}
