/**
 * SVG pitch: draws one Frame (10 players + ball). The parent ticks the playhead; nothing animates in here. The only state is
 * the last ~TRAIL_MS of drawn ball positions, for the ball's motion trail (#204) — presentation only.
 */
import { memo, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { Side, TeamPublic } from "../lib/pocketbase";
import type { Frame } from "../domain/sim";
import type { Fx } from "../domain/moves";
import { FULL_CAM } from "../domain/scenes";
import { kitsFor } from "./kits";

type Props = {
  frame: Frame | null;
  home: TeamPublic;
  away: TeamPublic;
  replay?: boolean;
  revealed: boolean; // MatchPage decides when the result may show (flash moment + displayed ball at the impact point)
  hud?: ReactNode; // compact score / clock / shootout strip pinned to the pitch's top-left corner
  minute?: number; // #206: the drawn event's match minute, for the goal screen
  replayed?: boolean; // #206: this goal's replay has already started: the live celebration keeps the GOAL! chip, no second big screen or cheer
  summary?: ReactNode; // #208: a break summary, under the break banner docked at the top of the pitch
  overlay?: ReactNode; // #208: the pre-match line-ups (its own overlay inside the pitch box)
};

const W = 100;
const H = 64;
const R = 1.45; // referee body radius (his figure is unchanged by #204)
/** Result badge per flash kind (what actually happened, never a generic "no goal"); shootout goals and cards are special-cased below. */
const BADGE: Record<string, string> = { goal: "GOAL!", save: "SAVED!", wood: "WOODWORK", miss: "WIDE", over: "OVER", block: "BLOCKED", pen: "PENALTY" };
/** #206: result scenes whose save or woodwork gets the reveal pulse. */
const EMPH_TYPES = new Set(["save", "woodwork", "penalty_saved", "penalty_woodwork", "shootout_kick"]);
/** #206: arms raised above the head (a celebrating outfielder). */
const CHEER_SLEEVES = "M -1.3 -1.55 L -2.1 -3.4 L -1.3 -3.7 L -0.8 -1.85 Z M 1.3 -1.55 L 2.1 -3.4 L 1.3 -3.7 L 0.8 -1.85 Z";

// Shirt outline in player-local units (about 4.5 wide, 4 tall), drawn from above like a kit icon. The player's x/y is its centre.
const BODY = "M -1.3 -1.55 L -0.55 -1.95 Q 0 -1.4 0.55 -1.95 L 1.3 -1.55 L 1.3 1.95 L -1.3 1.95 Z";
const SLEEVES = "M -1.3 -1.55 L -2.25 -0.8 L -1.75 0.1 L -1.3 -0.2 Z M 1.3 -1.55 L 2.25 -0.8 L 1.75 0.1 L 1.3 -0.2 Z";
const GK_SLEEVES = "M -1.3 -1.55 L -2.3 -0.6 L -2.05 1 L -1.45 1 L -1.3 0.1 Z M 1.3 -1.55 L 2.3 -0.6 L 2.05 1 L 1.45 1 L 1.3 0.1 Z";
const GLOVES = "M -2.15 1 h 0.8 v 0.75 h -0.8 Z M 1.35 1 h 0.8 v 0.75 h -0.8 Z";
// #205: a keeper diving or claiming has both arms stretched out past his head, gloves at the tips (the figure turns to the ball).
const REACH_SLEEVES = "M -1.3 -1.55 L -1.75 -3.6 L -0.85 -3.75 L -0.55 -1.95 Z M 1.3 -1.55 L 1.75 -3.6 L 0.85 -3.75 L 0.55 -1.95 Z";
const REACH_GLOVES = "M -1.95 -4.5 h 1.05 v 0.85 h -1.05 Z M 0.9 -4.5 h 1.05 v 0.85 h -1.05 Z";
/** Drawn height of a lifted ball (pitch units per unit of lift): the ball, its trail and the move lines share it. */
const LIFT_Y = 3;
/** #205: how each move's line is drawn (one path; colour, weight and dash name the move). */
const FX_LINE: Record<string, { stroke: string; width: number; dash?: string }> = {
  pass: { stroke: "#ffffff", width: 0.35 },
  through: { stroke: "#eaff7a", width: 0.45, dash: "1.6 1" },
  cross: { stroke: "#ffffff", width: 0.45, dash: "1.1 0.8" },
  long: { stroke: "#ffffff", width: 0.8 },
};
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
  const card = pose === "card-yellow" || pose === "card-red";
  // #206: a card is held straight up above his head (not at the offender), so it reads at a glance; a point aims at the target.
  // Close to the top touchline he holds it out to the side instead, so the card stays inside the drawn pitch.
  const arm: [number, number] = pose === "point" ? [dx / distance * 3.8, dy / distance * 3.8] : card ? (frame.ref[1] > 8 ? [dx < 0 ? -1.1 : 1.1, -4.4] : [dx < 0 ? -3.4 : 3.4, -0.6]) : [dx < 0 ? -1.8 : 1.8, -3.4];
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
          {card ? <rect className="pitch-figure-c" x={arm[0] - 1.25} y={arm[1] - 3.1} width={2.5} height={3.3} rx={0.25} fill={pose === "card-red" ? "#ff3344" : "#ffd400"} stroke="#fff" strokeWidth={0.4} data-testid="ref-card" /> : <circle cx={arm[0]} cy={arm[1]} r={0.3} fill="#f2c6a0" />}
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
/** #205: a claim's come-off-the-line offset (pitch units), eased in over CLAIM_EASE_MS of real time from the first frame it is drawn
 * (the reveal), so he steps out rather than jumps. `frame` is null while the result is held back. */
const CLAIM_EASE_MS = 220;
function useClaimStep(frame: Frame | null): [number, number] | null {
  const since = useRef<{ seq: number; at: number } | null>(null);
  const step = frame?.keeper?.pose === "claim" && frame.keeper.k >= 0.2 ? frame.keeper.step : undefined;
  if (!frame || !step) {
    since.current = null; // the next claim (or a replay of this one) steps out afresh
    return null;
  }
  const now = performance.now();
  if (since.current?.seq !== frame.seq) since.current = { seq: frame.seq, at: now };
  const f = Math.min(1, (now - since.current.at) / CLAIM_EASE_MS);
  const e = f * (2 - f);
  return [step[0] * e, step[1] * e];
}

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

/** A keeper's turn group (outfielders draw none). */
function Turn({ on, deg, children }: { on: boolean; deg: number; children: ReactNode }) {
  return on ? <g transform={deg ? `rotate(${deg.toFixed(1)}) scale(1 1.2)` : undefined} data-turn>{children}</g> : <>{children}</>; // a dive stretches him out
}

/**
 * #205: the current move's signature, always the same four nodes (hidden when unused) whatever is happening, so a fast-forwarded
 * backlog cannot pile effects up: a line (pass, through ball, cross arc, long-shot wake), the through ball's space, speed lines behind a
 * sprinting player and the woodwork's rattle (shown with the result, never before it).
 */
function MoveFx({ fx, players, projectX, revealed }: { fx: Fx | null; players: Frame["players"]; projectX: (x: number) => number; revealed: boolean }) {
  const style = FX_LINE[fx?.kind ?? ""] ?? FX_LINE.pass;
  const line = fx && fx.line.length > 1 && fx.alpha > 0 ? fx.line.map(([px, py, h], i) => `${i ? "L" : "M"} ${projectX(px).toFixed(2)} ${(py - h * LIFT_Y).toFixed(2)}`).join(" ") : null;
  const runner = fx?.sprint ? players.find((p) => p.side + ":" + p.no === fx.sprint!.key) : undefined;
  let streaks: string | null = null;
  if (runner && fx?.sprint) {
    const [rx, ry] = [projectX(runner.x), runner.y];
    const [tx, ty] = [projectX(fx.sprint.to[0]), fx.sprint.to[1]];
    const len = Math.hypot(tx - rx, ty - ry);
    if (len > 0.5) {
      const [ux, uy] = [(tx - rx) / len, (ty - ry) / len];
      streaks = [[-1.1, 3], [0, 4.4], [1.1, 3]]
        .map(([o, l]) => {
          const [ax, ay] = [rx - ux * 2 + -uy * o, ry - uy * 2 + ux * o];
          return `M ${ax.toFixed(2)} ${ay.toFixed(2)} L ${(ax - ux * l).toFixed(2)} ${(ay - uy * l).toFixed(2)}`;
        })
        .join(" ");
    }
  }
  const burst = fx?.burst && revealed ? fx.burst : null;
  return (
    <g data-testid="move-fx" data-kind={fx?.kind ?? undefined} className="move-fx" pointerEvents="none" fill="none" strokeLinecap="round">
      <path d={line ?? "M 0 0"} display={line ? undefined : "none"} stroke={style.stroke} strokeWidth={style.width} strokeDasharray={style.dash} opacity={fx?.alpha ?? 0} data-fx="line" />
      <circle cx={fx?.spot ? projectX(fx.spot.at[0]) : 0} cy={fx?.spot?.at[1] ?? 0} r={2} display={fx?.spot && fx.spot.alpha > 0 ? undefined : "none"} stroke="#eaff7a" strokeWidth={0.4} strokeDasharray="0.9 0.6" fill="rgba(234,255,122,0.14)" opacity={fx?.spot?.alpha ?? 0} data-fx="spot" />
      <path d={streaks ?? "M 0 0"} display={streaks && fx!.sprint!.alpha > 0 ? undefined : "none"} stroke="#ffffff" strokeWidth={0.45} opacity={fx?.sprint?.alpha ?? 0} data-fx="sprint" />
      <circle cx={burst ? projectX(burst.at[0]) : 0} cy={burst?.at[1] ?? 0} r={burst?.r ?? 1} display={burst ? undefined : "none"} stroke="#ffffff" strokeWidth={0.5} opacity={burst?.alpha ?? 0} data-fx="burst" />
    </g>
  );
}

export default function Pitch({ frame, home, away, replay, revealed, hud, minute, replayed, summary, overlay }: Props) {
  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  const kits = useMemo(() => kitsFor(home, away), [home, away]);
  // Project only at the drawing boundary. Smoothing, startBall and impact/reveal all stay canonical.
  // Breaks retain the outgoing end; ET starts right, ET2 left; every shootout kick stays at the left end.
  const flip = !!frame?.phase && ["second_half", "et_break", "extra_time_2", "shootout", "finished"].includes(frame.phase);
  const x = (v: number) => flip ? W - v : v;
  // #203: no camera zoom. The view is always the whole pitch (symmetric about x = 50, so the end switch needs no projection).
  const viewBox = FULL_CAM;
  // #205: a scene with a result (save, goal, miss, woodwork, block, penalty...) draws no move effect and no keeper pose until that result
  // is revealed to the viewer: up to then the keeper stands as he would for any outcome, and the dive, claim or beaten dive snaps in at
  // the reveal. Open-play scenes (no result) are never held.
  const held = !!frame?.flash && !revealed;
  const step = useClaimStep(held ? null : frame);
  const claimKeeper = step ? frame!.players.find((p) => p.gk && p.side === frame!.keeper!.side) : undefined;
  // He comes off his line with the ball: it moves with him when it is in his hands (the frame's own positions are untouched).
  const withBall = !!claimKeeper && !!frame && Math.hypot(claimKeeper.x - frame.ball[0], claimKeeper.y - frame.ball[1]) <= 2.5;
  const ball = [x((frame?.ball[0] ?? 50) + (withBall ? step![0] : 0)), (frame?.ball[1] ?? 32) + (withBall ? step![1] : 0)];
  const lift = frame?.lift ?? 0;
  const ballR = BALL_R + lift * 0.45;
  const drawnBall: [number, number] = [ball[0], ball[1] - lift * LIFT_Y];
  const trail = useTrail(frame ? drawnBall : null);
  // The carrier: the scene's candidate, only while the drawn ball is actually at his feet (unchanged rule; ring and name share it).
  const carrier = frame?.players.find((p) => frame.carrier === p.side + ":" + p.no && lift < 0.05 && Math.hypot(p.x - frame.ball[0], p.y - frame.ball[1]) <= 1.6) ?? null;
  const flash = frame && revealed ? frame.flash : null;
  // Match goals (not shootout kicks): big banner once the ball is in (flash gate) and through the celebration.
  // #206: a replay shows the small GOAL! chip instead: the big screen belongs to the live goal, which it follows.
  const goal = !replay && !replayed && frame && frame.flash === "goal" && (frame.type === "celebration" || (flash && (frame.type === "goal" || frame.type === "penalty_goal"))) ? frame : null;
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
    ? { id: "goal-banner", title: "GOOOAL!", sub: goal.score ? `${home.abbreviation} ${goal.score[0]}–${goal.score[1]} ${away.abbreviation}` : "", who: goal.who ? `${goal.who}${minute != null ? ` · ${minute}′` : ""}` : "", cls: "goal-pop text-white" }
    : ft
      ? { id: "ft-banner", title: "FULL-TIME", sub: `${team.name} go through!`, who: ft.by === "aet" ? "after extra time" : ft.by === "pens" && ft.pens ? `on penalties ${Math.max(...ft.pens)}–${Math.min(...ft.pens)}` : "", cls: "goal-pop text-lime" }
      : period
        ? { id: "period-banner", title: period, sub: "", who: "", cls: "event-enter text-amber" }
        : null;
  // #203: every banner fits the pitch at any width. A title breaks onto its own line at " · " / " — " (the separator stays in the
  // text, unseen), and its size follows the pitch width (cqw of the banner box) so the longest line fits, capped at the old 60 px.
  const titleLines = banner ? banner.title.split(/ ([·—]) /) : [];
  // #208: a break summary docks the break banner (half-time, end of 90, full time) at the top of the pitch, still large, with the
  // summary under it. The goal screen is never docked.
  // Past the scene's life (reduced motion holds p at 1; a late restart) the break's own title still heads its summary.
  const showSummary = !!summary && banner?.id !== "goal-banner";
  const dock = !showSummary ? null : banner ?? (frame && PERIOD[frame.type] ? { id: "period-banner", title: PERIOD[frame.type], sub: "", who: "", cls: "text-amber" } : null);
  const longest = Math.max(1, ...titleLines.filter((_, i) => i % 2 === 0).map((l) => l.length));
  const cheering = goal?.side ?? ft?.side ?? (frame?.type === "shootout_end" ? frame.side : null) ?? null;
  // A goal and its celebration share a score; a new goal restarts the cheer even for consecutive goals by the same side.
  const cue = goal && cheering ? `goal:${goal.score?.join("-") ?? goal.seq}` : cheering ? `winner:${cheering}` : "";
  // #206: the scorer and the mates who join him celebrate arms up, once the goal is in (pose only: their spots are the frame's).
  const celebrating = goal && (goal.type === "celebration" || goal.p >= 0.4) ? goal.side : null;
  // #206: a save or the woodwork gets a short pulse round the pitch, from the reveal (`flash` is already gated) and only in the result's
  // own scene (not the badge's linger into the next one). No zoom, no shift: one overlay, restarted per result.
  const emph = flash === "save" || flash === "wood" ? (EMPH_TYPES.has(frame!.type) ? flash : null) : null;
  const card = flash === "card" && (frame!.type === "yellow_card" || frame!.type === "red_card") ? frame : null;
  const pitchMaxWidth = `max(260px, calc((100vh - var(--pitch-chrome, 360px)) * ${(FULL_CAM[2] / FULL_CAM[3]).toFixed(4)}))`;

  return (
    <>
      <div className="stadium relative mx-auto w-full" style={{ maxWidth: pitchMaxWidth, "--home": hc, "--away": ac } as CSSProperties} data-testid="stadium">
      <Crowd cheering={cheering} cue={cue} />
      {/* Keep the camera aspect stable. Responsive chrome/insets live in CSS; tiny screens retain the old cap. */}
      <div className="match-pitch relative mx-auto w-full overflow-hidden rounded-xl border border-line bg-[#0a2416]" style={{ aspectRatio: `${FULL_CAM[2]}/${FULL_CAM[3]}`, maxWidth: pitchMaxWidth }} data-testid="pitch">
        <svg viewBox={viewBox.join(" ")} preserveAspectRatio="xMidYMid meet" className="block h-full w-full" role="img" aria-label={frame ? frame.caption : "Pitch"}>
        <Field />
        <MoveFx fx={held ? null : frame?.fx ?? null} players={frame?.players ?? []} projectX={x} revealed={revealed} />

        {frame?.players.map((p) => {
          const kit = p.gk ? (p.side === "home" ? kits.homeGk : kits.awayGk) : kits[p.side];
          const edge = kit.num === "#fff" ? "rgba(255,255,255,0.85)" : "rgba(5,10,20,0.8)";
          // #205: a result scene's dive or claim turns the keeper to the ball with both arms out (pose only: his spot is the frame's).
          const pose = !held && p.gk && frame.keeper && frame.keeper.side === p.side && frame.keeper.k >= 0.2 ? frame.keeper : null;
          // A dive lays him out towards the ball (his collar along `dir`); a claim keeps him upright, arms up, coming off his line.
          const turn = pose?.pose === "dive" ? (Math.atan2(flip ? -pose.dir[0] : pose.dir[0], -pose.dir[1]) * 180) / Math.PI : 0;
          return (
            <g key={`${p.side}-${p.name}`} transform={`translate(${x(p.x + (p === claimKeeper ? step![0] : 0))} ${p.y + (p === claimKeeper ? step![1] : 0)})`} data-testid="player" data-side={p.side} data-gk={p.gk || undefined} data-pose={pose?.pose ?? (!p.gk && celebrating === p.side && p.hot ? "cheer" : undefined)}>
              {/* keepers always carry this turn group (one fixed node each): the figure's own scale is CSS, so the turn sits outside it */}
              <Turn on={p.gk} deg={turn}>
              <g className="pitch-figure">
                <ellipse cx={0} cy={SHIRT_H} rx={2} ry={0.65} fill="rgba(0,0,0,0.35)" />
                {p === carrier ? <circle r={3.1} fill="rgba(255,255,255,0.12)" stroke="#fff" strokeWidth={0.45} data-ring /> : null}
                <path d={pose ? REACH_SLEEVES : p.gk ? GK_SLEEVES : celebrating === p.side && p.hot ? CHEER_SLEEVES : SLEEVES} fill={kit.sleeves} stroke={edge} strokeWidth={0.22} strokeLinejoin="round" data-sleeves />
                <path d={BODY} fill={kit.body} stroke={edge} strokeWidth={0.22} strokeLinejoin="round" data-kit />
                <path d={COLLAR} fill="none" stroke={kit.trim} strokeWidth={0.45} strokeLinecap="round" data-trim />
                {p.gk ? <path d={pose ? REACH_GLOVES : GLOVES} fill="#f4f7ff" stroke={edge} strokeWidth={0.15} data-gloves /> : null}
                <text y={0.95} textAnchor="middle" fontWeight={800} fill={kit.num} fontSize={2.3}>
                  {p.no}
                </text>
              </g>
              </Turn>
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

      {showSummary ? (
        // Its own element (keyed), never the big banner's node restyled: a node that changed size would count as a layout shift.
        <div key="break" className="pointer-events-none absolute inset-0 flex flex-col overflow-hidden bg-[#06130c]/85 px-[3%] pb-[1.5%] pt-[1.5%] [container-type:inline-size]" data-testid="break-overlay">
          {dock ? (
          <div className={`shrink-0 text-center ${dock.cls}`} data-testid={dock.id} data-docked>
            <div className="font-display font-black leading-tight" style={{ fontSize: `min(2rem, 6.5cqw, ${(88 / Math.max(1, dock.title.length)).toFixed(2)}cqw)` }} data-testid="banner-title">
              {dock.title}
            </div>
            {dock.sub || dock.who ? (
              <div className="font-bold leading-tight" style={{ fontSize: "min(1rem, 3.6cqw)" }} data-testid="banner-sub">
                {[dock.sub, dock.who].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </div>
          ) : null}
          <div className="mt-[1%] min-h-0 flex-1">{summary}</div>
        </div>
      ) : banner ? (
        <div key="banner" className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden bg-black/30 px-[4%] transition-opacity duration-1000 [container-type:inline-size]" style={dim ? { opacity: 0.85 } : undefined} data-testid={banner.id}>
          {glow ? (
            <div className="confetti absolute inset-x-0 top-0 h-0" aria-hidden>
              {Array.from({ length: 24 }, (_, i) => (
                <i key={i} style={{ left: `${(i * 4.3 + 2) % 100}%`, background: i % 3 ? glow : "#fff", animationDelay: `${(i % 6) * 0.15}s` }} />
              ))}
            </div>
          ) : null}
          <div className={`min-w-0 max-w-full text-center [overflow-wrap:anywhere] ${banner.cls} ${glow ? "goal-screen rounded-xl px-[5%] py-[2%]" : ""}`} style={glow ? ({ "--glow": glow } as CSSProperties) : undefined}>
            <div className="font-display font-black leading-none text-balance" style={{ fontSize: `min(3.75rem, ${(108 / longest).toFixed(2)}cqw)`, ...(glow ? { textShadow: `0 0 18px ${glow}, 0 0 40px ${glow}` } : null) }} data-testid="banner-title">
              {titleLines.map((part, i) => (i % 2 ? <span key={i} className="hidden">{` ${part} `}</span> : <span key={i} className="block">{part}</span>))}
            </div>
            {banner.sub ? <div className="mt-1 font-display font-black leading-tight tabular text-balance" style={{ fontSize: glow ? "min(2.5rem, 8cqw)" : "min(1.875rem, 6.5cqw)" }} data-testid="banner-sub">{banner.sub}</div> : null}
            {banner.who ? <div className="mt-1 font-bold leading-tight" style={{ fontSize: glow ? "min(1.5rem, 5.5cqw)" : "min(1rem, 4.5cqw)" }} data-testid="banner-who">{glow ? <span aria-hidden>⚽ </span> : null}{banner.who}</div> : null}
          </div>
        </div>
      ) : frame && flash ? (
        <div className="pointer-events-none absolute inset-x-0 top-9 flex justify-center">
          <span
            className={`event-enter rounded-md px-3 py-1 font-display font-black tracking-widest shadow-lg ${card ? "text-sm sm:text-base" : "text-sm"} ${
              flash === "goal" ? "bg-lime text-ink" : flash === "save" ? "bg-cyan text-ink" : flash === "card" ? (frame.type === "yellow_card" ? "bg-[#ffd400] text-ink" : "bg-live text-white") : "bg-amber text-ink"
            }`}
            data-testid={card ? "card-badge" : undefined}
          >
            {flash === "goal" ? (
              frame.type === "shootout_kick" && frame.pens ? (
                `GOAL! ${frame.pens[0]}–${frame.pens[1]}`
              ) : (
                "GOAL!"
              )
            ) : flash === "card" ? (
              <>
                {/* #206: the card itself, the decision and who got it */}
                <span className={`mr-1.5 inline-block h-[1.05em] w-[0.75em] rounded-[2px] border border-black/60 align-[-0.15em] ${frame.type === "red_card" ? "bg-[#ff3344]" : "bg-[#ffd400]"}`} aria-hidden />
                <span>{frame.type === "red_card" ? "RED CARD" : "BOOKED"}</span>
                {card && frame.who ? <span className="ml-1.5">· {frame.who.trim().split(/\s+/).at(-1)!.toUpperCase()}</span> : null}
              </>
            ) : (
              BADGE[flash]
            )}
          </span>
        </div>
      ) : null}
      {overlay}
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
        {emph ? <div key={`${replay ? "r" : "l"}:${frame!.seq}`} className={`pitch-emph pitch-emph-${emph}`} data-testid="pitch-emphasis" data-kind={emph} aria-hidden /> : null}
        {replay ? <span className="chip chip-amber absolute right-2 top-2">Replay</span> : null}
      </div>
      </div>
    </>
  );
}
