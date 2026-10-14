/**
 * Full 5-v-5 frame: maps a Scene's named actors onto real lineup players and parks the rest
 * at formation anchors drifted toward the ball, so all 10 players are always on the pitch.
 */
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";
import { FULL_CAM, sample, sampleN, short, type Actor, type Cam, type Pt, type Scene } from "./scenes";

export type Player = { side: Side; name: string; no: number; gk: boolean; x: number; y: number; hot: boolean /* named in the event */ };
export type Frame = { ball: Pt; lift: number; players: Player[]; carrier?: string | null /* side:no, candidate only: renderer also requires drawn contact */; won?: Side | null /* WON IT cue: the challenge winner's side, for WON_MS from the moment he has the ball */; ref: Pt /* referee: his actor path, else trailing play */; caption: string; flash: Scene["flash"]; type: string; seq: number; p: number; cam: Cam } & Pick<Scene, "ms" | "side" | "who" | "score" | "kick" | "pens" | "flashAt" | "by" | "phase">;
export type Lineups = { home: LineupPlayer[]; away: LineupPlayer[] };

// Home anchors; mirror x for away. GK first, then D, D, F, F by starter order.
const ANCHORS: Pt[] = [
  [4, 32],
  [20, 20],
  [20, 44],
  [42, 24],
  [42, 40],
];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Open-play scenes in which `scene.side` has the ball: that side's shape moves up the pitch with it (#102). */
const IN_PLAY = new Set(["build_up", "pass", "through_ball", "dribble", "cross", "tackle", "interception", "shot", "bounce"]);
/** Possession side of a scene, or null when nobody is building an attack (set pieces, breaks, results). */
export function possession(scene: Scene): Side | null {
  return scene.side && IN_PLAY.has(scene.type) ? scene.side : null;
}
/**
 * Team shape (#102): where outfielder `i` (1..4) of a side stands, in that side's own frame (attacking → x=100), given the ball
 * `bx`/`by` in that same frame. With the ball, the whole block advances with it: defenders step up behind the ball, forwards run
 * ahead of it, so the shape carries up the field as the ball progresses. Without it, the old gentle drift towards the ball.
 */
export function shapeAt(i: number, bx: number, by: number, attacking: boolean): Pt {
  const [ax, ay] = ANCHORS[i];
  if (!attacking) return [clamp(ax + (bx - ax) * 0.3, 1, 99), clamp(ay + (by - ay) * 0.3, 2, 62)];
  const fwd = i >= 3;
  const push = (bx - 30) * (fwd ? 0.75 : 0.6); // the block moves up with the ball
  const x = clamp(ax + Math.max(0, push) + Math.min(0, push) * 0.4, 4, fwd ? 94 : Math.max(8, bx - 4));
  return [x, clamp(ay + (by - ay) * 0.25, 2, 62)];
}
/**
 * Same scene re-routed from `start`: the ball path (and the carrier's, if an actor stands on the ball) is translated by
 * `start − ball[0]`, the offset blending out keyframe by keyframe so the destination — which the next scene depends on — is
 * untouched and the ball never doubles back via the authored route. Points already off the pitch (a net) stay put.
 * Challenge winners and intermediate ball participants follow the same offset through contact.
 * The scene object itself stays shared and unmutated.
 */
function fromStart(scene: Scene, start: Pt): Scene {
  const [x0, y0] = scene.ball[0];
  const dx = start[0] - x0;
  const dy = start[1] - y0;
  if (!dx && !dy) return scene;
  const blend = (path: Pt[]): Pt[] => {
    const n = path.length - 1;
    return path.map(([x, y], i) => {
      const w = n ? 1 - i / n : 1;
      return [clamp(x + dx * w, Math.min(0, x), Math.max(100, x)), clamp(y + dy * w, Math.min(0, y), Math.max(64, y))];
    });
  };
  const near = scene.actors.filter((a) => a.side !== "ref" && !a.keeper).sort((a, b) => Math.hypot(a.path[0][0] - x0, a.path[0][1] - y0) - Math.hypot(b.path[0][0] - x0, b.path[0][1] - y0))[0];
  const onBall = near && Math.hypot(near.path[0][0] - x0, near.path[0][1] - y0) < 3 ? near : null;
  return { ...scene, ball: blend(scene.ball), actors: scene.actors.map((a) => {
    const winner = scene.won !== undefined && a.side === scene.side && (a.id === "win" || a.id === "p");
    const rides = a.rides && a.side === scene.side;
    return a === onBall || winner || rides ? { ...a, path: blend(a.path) } : a;
  }) };
}
const other = (s?: Side | null): Side => (s === "home" ? "away" : "home");
const PEN_ARC = new Set(["penalty_setup", "shootout_setup", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork", "shootout_kick"]);
/** Routine play: once the scene is over the carrier keeps going until the next event instead of standing on the ball. */
const DWELL = new Set(["pass", "build_up", "dribble", "through_ball", "tackle", "interception", "bounce", "kickoff", "restart"]); // not a cross: it ends at head height in the box, waiting for the header
/** The tunnel, off the bottom touchline: everyone walks off to it over a break's first 6 s (and stays), and on from it over a restart's first 4 s. */
const TUNNEL: Pt = [50, 70];
const WALK_OFF = new Set(["half_time", "end_of_normal_time", "et_half_time", "match_end"]);
const WALK_ON = new Set(["kickoff", "second_half", "extra_time", "et_second_half"]);

function starters(list: LineupPlayer[], side: Side, sentOff?: Set<string>) {
  const live = list.filter((p) => p.starter && !sentOff?.has(side + ":" + p.name));
  const gk = live.find((p) => p.role === "gk") ?? live[0];
  return gk ? [gk, ...live.filter((p) => p !== gk).slice(0, 4)] : [];
}

/** Result badges that outlive their scene: SAVED!, WOODWORK, WIDE/OVER/BLOCKED and every shootout reveal stay 2.5 s (real ms, however short the new scene) into the next one. Match goals have the banner, cards their own type-specific text. */
const LINGER_MS = 2500;
/** WON IT stays this long (real ms, into the winner's dwell) from the moment the challenge winner has the ball. */
export const WON_MS = 1500;
const LINGERING = new Set(["save", "wood", "miss", "over", "block"]);
function lingers(prev: Scene | undefined, scene: Scene, t: number) {
  return !!prev?.flash && !scene.flash && scene.ms > 0 && t * scene.ms < LINGER_MS && (prev.type === "shootout_kick" || LINGERING.has(prev.flash));
}

/** Dwell choreography: the carrier jogs on and lays the ball off to a mate every cycle, so a wait between events reads as passing, not a long solo carry. */
const DWELL_SPEED = 4.5; // units per second as the dwell starts (≈ a jog on a 40 m pitch), easing off as the advance runs out
const DWELL_CYCLE = 3000; // ms between lay-offs
const DWELL_PASS = 450; // ms the lay-off takes
const DWELL_LANE = 6; // lateral gap between the two lanes
/** The next event starts where this scene left the ball, so whatever ground the dwell gains is given back at the transition.
 * The advance is therefore bounded, not timed: at most DWELL_ADVANCE (approached, never passed) and never beyond the attacking
 * side's DWELL_LINE (x70 for home, x30 for away), so nobody runs into the box ahead of a midfield or build-up event. After that the
 * two lanes keep laying the ball off where they are, however late the next event is: a long gap circulates, it neither shuttles nor freezes. */
export const DWELL_ADVANCE = 8;
export const DWELL_LINE = 70;

/** Possession choreography, separate from hot (actor binding). Ground passes are free flight too.
 * These windows only nominate an actor; Pitch checks the smoothed ball is actually at that player.
 */
function carrierActor(scene: Scene, t: number): string | null {
  switch (scene.type) {
    case "build_up": case "pass": case "through_ball": case "cross": case "dribble": {
      if (scene.actors.some(a => a.id === "clear")) return t <= 0.02 ? "clear" : t >= 0.97 ? "r" : t >= 0.64 && t <= 0.7 ? "p" : null;
      const lost = scene.actors.find(a => a.id === "lost"); // turnover contest: the old side's holder (a keeper only plays it out), then the winner
      const w = scene.won ?? 1;
      if (lost) return t >= 0.97 ? "r" : t >= w && t <= w + 0.22 ? "p" : t <= (lost.keeper ? 0.04 : w - 0.04) ? "lost" : null;
      if (scene.actors.some(a => a.id === "l")) return t <= 0.08 ? "p" : t >= 1 / 3 && t <= 0.64 ? "l" : t >= 0.97 ? "r" : null; // lay-off, touch, forward release
      if (scene.type === "cross") return t <= 0.04 ? "p" : t >= 0.25 && t <= 0.5 ? "r" : t >= 0.75 ? (scene.actors.some(a => a.id === "h") ? "h" : "p") : null; // feeder, winger, the arriving runner
      return scene.type === "dribble" ? "p" : t <= 0.08 ? "p" : t >= 0.97 ? "r" : null;
    }
    case "tackle": case "interception": return t >= (scene.won ?? 0.5) ? "win" : t <= (scene.type === "tackle" ? 0.45 : 0.08) ? "lost" : null;
    case "save": return t >= 2 / 3 ? "gk" : null;
    case "block": return t >= 0.5 ? "b" : null;
    case "woodwork": return t >= 0.97 ? "gk" : null;
    case "bounce": return t >= 0.8 ? "c" : null;
    case "shot": return t >= 0.5 ? "s" : null;
    case "restart": return "w";
    case "penalty_setup": case "shootout_setup": return t < 0.2 ? "taker" : null;
    case "penalty_goal": case "penalty_saved": case "penalty_missed": case "penalty_woodwork": case "shootout_kick": return t >= 0.43 && t <= 0.5 ? "taker" : null;
    default: return null;
  }
}

/**
 * `t` is progress through the scene; past 1 it keeps counting (1 + ms over / scene.ms) so the hold can evolve. `startBall`: where the
 * previous scene actually left the ball (dwell), re-routing this one from there. `prevScene`: its result badge lingers into this scene's first 2.5 s.
 * `elapsedMs`: real ms since the scene began, when `t` stops tracking it (reduced motion holds t = 1, a replay holds its last frame); WON IT times off it.
 */
export function frameAt(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>, nowMs = 0, startBall?: Pt, prevScene?: Scene, elapsedMs?: number): Frame {
  const { ball: b, players, unlabelled, ref } = layout(startBall ? fromStart(scene, startBall) : scene, t, lineups, sentOff);
  const ball: Pt = [b[0], b[1]]; // copy: sample() may hand back the scene's own keyframe
  const bind = binding(scene, lineups, sentOff);
  for (const a of unlabelled) {
    const q = players.find((p) => p.side + ":" + p.no === bind[a.id] && !p.hot);
    if (q) place(q, a, t);
  }
  const actor = scene.actors.find(a => a.id === carrierActor(scene, t));
  const owner = actor && players.find(p => p.side === actor.side && (actor.keeper ? p.gk : actor.label ? short(p.name) === actor.label : p.side + ":" + p.no === bind[actor.id]));
  let carrier = owner ? owner.side + ":" + owner.no : null;
  const rawOver = Math.max(0, t - 1) * scene.ms;
  if (rawOver > 0 && !scene.flash && scene.side && DWELL.has(scene.type)) {
    const over = rawOver;
    // Dwell: two lanes jog on from the scene end at DWELL_SPEED, easing to a stop within the bounded advance (never turning
    // back, never past the line). The ball is laid off between the lanes every DWELL_CYCLE, so the two nearest teammates keep
    // passing instead of one of them carrying forever; the nearest opponent closes to four in front of whoever has it.
    const dir = scene.side === "home" ? 1 : -1;
    const room = clamp(DWELL_LINE - (dir > 0 ? b[0] : 100 - b[0]), 0, DWELL_ADVANCE); // a ball already past the line is carried neither on nor back
    const x = b[0] + (room ? dir * room * (1 - Math.exp(-(DWELL_SPEED * over) / 1000 / room)) : 0);
    const mdir = dir; // the way they face: the advance only ever goes forward
    const laneY = clamp(b[1] + (b[1] > 32 ? -DWELL_LANE : DWELL_LANE), 2, 62); // second lane, towards the middle of the pitch
    const cyc = over % DWELL_CYCLE;
    const n = Math.floor(over / DWELL_CYCLE);
    const s0 = n % 2; // lane holding the ball at the start of this cycle
    const s = cyc < DWELL_CYCLE - DWELL_PASS ? s0 : s0 + (1 - 2 * s0) * ((cyc - (DWELL_CYCLE - DWELL_PASS)) / DWELL_PASS); // 0 = first lane, 1 = second; eases across during the lay-off
    ball[0] = x + mdir * (s - 0.5) * 2 * 0.6; // the receiver is a touch ahead, so the lay-off goes forward
    ball[1] = clamp(b[1] + (laneY - b[1]) * s + 1.2 * Math.sin((2 * Math.PI * over) / 1600), 2, 62);
    const [a, m] = players.filter((p) => p.side === scene.side && !p.gk).sort((p, q) => Math.hypot(p.x - b[0], p.y - b[1]) - Math.hypot(q.x - b[0], q.y - b[1]));
    const onA = s < 0.5;
    const weaveY = clamp(b[1] + 1.2 * Math.sin((2 * Math.PI * over) / 1600), 2, 62);
    if (a) Object.assign(a, { x: clamp(onA ? ball[0] - mdir * 0.8 : x - mdir * 2.5, 0, 100), y: onA ? ball[1] : weaveY, hot: onA });
    if (m) Object.assign(m, { x: clamp(onA ? x + mdir * 2 : ball[0] - mdir * 0.8, 0, 100), y: onA ? laneY : ball[1], hot: !onA });
    const holder = onA ? a : m;
    carrier = cyc < DWELL_CYCLE - DWELL_PASS && holder ? holder.side + ":" + holder.no : null;
    const marker = players.filter((p) => p.side !== scene.side && !p.gk).sort((p, q) => Math.hypot(p.x - ball[0], p.y - ball[1]) - Math.hypot(q.x - ball[0], q.y - ball[1]))[0];
    if (marker) {
      const k = Math.min(1, over / 1500); // closes down over the first 1.5 s, then tracks four in front of the ball
      marker.x = clamp(marker.x + (ball[0] + mdir * 4 - marker.x) * k, 0, 100);
      marker.y = clamp(marker.y + (ball[1] - marker.y) * k, 0, 64);
    }
  } else if (t >= 1 && nowMs) {
    // Idle breathing: scene over, nothing newer yet — everyone sways a touch so the frame never looks frozen.
    ball[0] += Math.sin(nowMs / 400) * 0.4;
    for (const p of players) {
      const amp = p.hot ? 0.4 : 0.25;
      const ph = p.hot ? 0 : p.no * 1.7;
      p.x += Math.sin(nowMs / 400 + ph) * amp;
      p.y += Math.cos(nowMs / 400 + ph) * amp * 0.5;
    }
  }
  const flash = lingers(prevScene, scene, t) ? prevScene!.flash! : scene.flash ?? null;
  const sinceWon = scene.won !== undefined ? (elapsedMs ?? t * scene.ms) - scene.won * scene.ms : -1;
  const won = scene.side && sinceWon >= 0 && sinceWon < WON_MS ? scene.side : null;
  // No ref actor: he trails play — ten behind the ball, and on the half of the pitch the ball is not on, sliding smoothly
  // through the middle (no side flip when the ball crosses the centre line) — so he is always on the pitch and only ever jogs (smooth) into a scene.
  const home: Pt = [clamp(ball[0] - (scene.side === "away" ? -10 : 10), 0, 100), clamp(32 + (32 - ball[1]) * 0.6, 0, 64)];
  let refPt = ref ?? home;
  let cam = scene.cam ?? FULL_CAM;
  const walk = WALK_OFF.has(scene.type) ? 6000 : WALK_ON.has(scene.type) ? 4000 : 0;
  if (walk) {
    // Tunnel walk: each one's target is eased between where he would stand and the tunnel (sample's ease); smoothing makes it a glide.
    const f = Math.min(1, (t * scene.ms) / walk);
    const to = (p: Pt): Pt => (WALK_OFF.has(scene.type) ? sample([p, TUNNEL], f) : sample([TUNNEL, p], f));
    for (const p of players) [p.x, p.y] = to([p.x, p.y]);
    refPt = to(refPt);
    // Return the ball during the break, before the next period reflects ends. Centre is invariant under that projection.
    if (WALK_OFF.has(scene.type) && scene.type !== "match_end") [ball[0], ball[1]] = sample([b, [50, 32]], f);
  } else if (scene.type === "shootout_start") {
    // Shootout intro (10 s): everyone walks to the centre circle (0–35 %) and huddles there in two arcs of five (35–70 %); then the
    // keepers go to the shootout end — the first kick's keeper on his line, the other by the post — and the rest line the halfway
    // line in two rows (70–100 %). The ref is at the spot; the camera holds the full pitch until the keepers set off, then glides in.
    const seg = (a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
    const lineGk = other(scene.side); // faces the first kick
    for (const side of ["home", "away"] as Side[]) {
      players.filter((p) => p.side === side).forEach((p, i) => {
        const ang = (Math.PI * (i - 2)) / 6 + (side === "home" ? Math.PI : 0); // five on a ±60° arc, home facing away across the spot
        const ring: Pt = [50 + 6 * Math.cos(ang), 32 + 6 * Math.sin(ang)];
        const end: Pt = p.gk ? [97, side === lineGk ? 32 : 39] : [side === "home" ? 56 : 60, 17 + i * 6]; // inside the pen cam (x ≥ 48 + label margin)
        [p.x, p.y] = t < 0.35 ? sample([[p.x, p.y], ring], seg(0, 0.35)) : t < 0.7 ? ring : sample([ring, end], seg(0.7, 1));
      });
    }
    refPt = [86, 19]; // beside the box, where setupScene / penaltyScene keep him (penRefSpot("home"))
    if (t < 0.7) cam = FULL_CAM;
  }
  return { ball, lift: sampleN(scene.ballHeight, t), players, carrier, won, ref: refPt, caption: scene.caption, flash, type: scene.type, seq: scene.seq, p: Math.min(1, t), ms: scene.ms, cam, side: scene.side, who: scene.who, score: scene.score, kick: scene.kick, pens: scene.pens, flashAt: scene.flashAt, by: scene.by, phase: scene.phase };
}

/** Formation players drifted toward the ball, named actors placed; unlabelled actors returned for binding. */
function layout(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>) {
  const ball = sample(scene.ball, t);
  // After a goal the defending side backs off to the centre for the restart while the scorer celebrates.
  const backOff = scene.flash === "goal" && (scene.type === "celebration" || t > 0.5) ? other(scene.side) : null;
  const players: Player[] = [];
  const poss = possession(scene);
  for (const side of ["home", "away"] as Side[]) {
    const mirror = side === "away";
    const b: Pt = side === backOff ? [50, 32] : ball;
    const own = (x: number) => (mirror ? 100 - x : x); // own frame <-> pitch x (self-inverse)
    starters(lineups?.[side] ?? [], side, sentOff).forEach((p, i) => {
      const gk = i === 0;
      const ax = own(ANCHORS[i][0]);
      const ay = ANCHORS[i][1];
      let x = ax;
      let y = clamp(ay + (b[1] - ay) * 0.4, 2, 62);
      if (!gk) {
        const [sx, sy] = shapeAt(Math.min(i, 4), own(b[0]), b[1], poss === side && side !== backOff);
        x = own(sx);
        y = sy;
      }
      players.push({ side, name: p.name, no: p.no, gk, x, y, hot: false });
    });
  }
  // Penalty: everyone who isn't taking or saving lines the edge of the D, home and away alternating.
  if (scene.cam && PEN_ARC.has(scene.type)) {
    const x = scene.cam[0] + scene.cam[2] / 2 > 50 ? 80 : 20; // which end the camera looks at
    const named = new Set(scene.actors.map((a) => (a.keeper ? a.side + ":gk" : a.label)));
    const free = (side: Side) => players.filter((p) => !named.has(p.gk ? side + ":gk" : short(p.name)) && p.side === side);
    const h = free("home");
    const a = free("away");
    const arc: Player[] = [];
    for (let i = 0; h.length || a.length; i++) arc.push(((i % 2 ? a : h).shift() ?? (i % 2 ? h : a).shift())!);
    arc.forEach((p, i) => {
      p.y = 10 + (i * 44) / Math.max(1, arc.length - 1);
      p.x = x + (x > 50 ? -1 : 1) * 4 * (1 - Math.abs(p.y - 32) / 22); // bows away from the goal at the top of the D
    });
  }
  // Named actors ride their path: keepers bind to the GK, labels to short(name).
  const unlabelled: Actor[] = [];
  let ref: Pt | undefined;
  for (const a of scene.actors) {
    if (a.side === "ref") {
      ref = sample(a.path, t);
      continue;
    }
    const p = a.keeper ? players.find((q) => q.side === a.side && q.gk) : a.label ? players.find((q) => q.side === a.side && !q.hot && short(q.name) === a.label) : null;
    if (p) place(p, a, t);
    else if (!a.keeper && !a.label) unlabelled.push(a);
  }
  return { ball, players, unlabelled, ref };
}

/** Unlabelled actor → player key, decided once per scene (nearest free outfield teammate at t=0) so the binding never flips mid-scene. */
const bindings = new WeakMap<Scene, Record<string, string>>(); // ponytail: keyed by scene object — seq repeats across fixtures, and scenes are memoised per event list
function binding(scene: Scene, lineups: Lineups | null, sentOff?: Set<string>) {
  const hit = bindings.get(scene);
  if (hit) return hit;
  const { players, unlabelled } = layout(scene, 0, lineups, sentOff);
  const out: Record<string, string> = {};
  for (const a of unlabelled) {
    const [x, y] = a.path[0];
    let best: Player | undefined;
    for (const q of players) if (q.side === a.side && !q.hot && !q.gk && (!best || Math.hypot(q.x - x, q.y - y) < Math.hypot(best.x - x, best.y - y))) best = q;
    if (best) {
      best.hot = true;
      out[a.id] = best.side + ":" + best.no;
    }
  }
  if (players.length) bindings.set(scene, out); // lineups absent → nothing to bind yet, try again next frame
  return out;
}

function place(p: Player, a: Actor, t: number) {
  const [x, y] = sample(a.path, t);
  p.x = clamp(x, 0, 100);
  p.y = clamp(y, 0, 64);
  p.hot = true;
}

/** Rendered frame chases the target: exponential approach per value, players and the ref speed-capped so nobody teleports. A gap over a second (suspended tab) snaps instead: nothing to chase from. The ref is a slow walker who ignores small target shifts, so he repositions rarely and never darts. */
const MAX_SPEED = 60; // units per second
const REF_SPEED = 14;
const REF_DEADBAND = 4; // units: a target this close is "where he already is"
export function smooth(prev: Frame | null, target: Frame, dtMs: number): Frame {
  if (!prev || dtMs > 1000) return target;
  dtMs = Math.min(100, dtMs); // a stutter still reads as a chase, not a jump
  const k = (tau: number) => 1 - Math.exp(-dtMs / tau);
  const kb = k(90);
  const kp = k(220);
  const chase = (ax: number, ay: number, bx: number, by: number, kk: number, speed: number): Pt => {
    let dx = (bx - ax) * kk;
    let dy = (by - ay) * kk;
    const d = Math.hypot(dx, dy);
    const maxStep = (speed * dtMs) / 1000;
    if (d > maxStep) {
      dx *= maxStep / d;
      dy *= maxStep / d;
    }
    return [ax + dx, ay + dy];
  };
  const was = new Map(prev.players.map((p) => [p.side + ":" + p.no, p]));
  const players = target.players.map((p) => {
    const q = was.get(p.side + ":" + p.no);
    if (!q) return p;
    // Crosses compress a wide delivery and box arrival into the match pace.
    // Only its involved attackers sprint; everyone else keeps the ordinary chase.
    const crossSprint = target.type === "cross" && p.hot && p.side === target.side;
    const [x, y] = chase(q.x, q.y, p.x, p.y, crossSprint ? k(70) : kp, crossSprint ? 120 : MAX_SPEED);
    return { ...p, x, y };
  });
  const ball: Pt = [prev.ball[0] + (target.ball[0] - prev.ball[0]) * kb, prev.ball[1] + (target.ball[1] - prev.ball[1]) * kb];
  const kc = k(350);
  const cam = target.cam.map((v, i) => prev.cam[i] + (v - prev.cam[i]) * kc) as Cam;
  const ref = Math.hypot(target.ref[0] - prev.ref[0], target.ref[1] - prev.ref[1]) < REF_DEADBAND ? prev.ref : chase(prev.ref[0], prev.ref[1], target.ref[0], target.ref[1], k(900), REF_SPEED);
  return { ...target, ball, lift: prev.lift + (target.lift - prev.lift) * kb, players, ref, cam };
}

/**
 * May the result show? Only once the scene reaches its flash moment AND the *displayed* ball has got to the impact
 * point (the drawn ball lags the target). `reached` latches for the scene's life so the badge never flickers off.
 * A ball first drawn already past the impact (late join, resumed tab) counts. Nothing else does: a result event that
 * lands late (scene already over) still waits for the drawn ball — `settle` guarantees it gets there next tick.
 */
export function reveal(scene: Scene, p: number, ball: Pt, reachedBefore: boolean) {
  const reached = reachedBefore || arrived(scene, ball);
  return { reached, revealed: !scene.flash || (p >= (scene.flashAt ?? 0.62) && reached) };
}
/** Scene over but the drawn ball still short of the impact (late result event, frames still coming): the ball goes on the impact this tick — players keep chasing — so the reveal, which follows the drawn ball, never lags a finished shot by more than one frame. */
export function settle(scene: Scene, p: number, frame: Frame, reachedBefore: boolean): Frame {
  const i = scene.impact;
  return i && p >= 1 && !reachedBefore && !arrived(scene, frame.ball) ? { ...frame, ball: [i[0], i[1]] } : frame;
}
/** Is `ball` on the impact point (1.5 of slack) or past it along the shot? Scenes without an impact have nothing to reach. */
function arrived(scene: Scene, ball: Pt) {
  const i = scene.impact;
  return !i || Math.hypot(ball[0] - i[0], ball[1] - i[1]) < 1.5 || crossed(scene.ball[0], i, ball);
}
/** Is `ball` at or beyond `impact` along the line from `start`? (projection onto start→impact, 1.5 of slack) */
function crossed(start: Pt, impact: Pt, ball: Pt) {
  const vx = impact[0] - start[0];
  const vy = impact[1] - start[1];
  return (ball[0] - start[0]) * vx + (ball[1] - start[1]) * vy >= vx * vx + vy * vy - 1.5;
}

/** Players sent off by the events published up to `seq` (inclusive): `side:name`. */
export function sentOffAt(events: MatchEvent[], seq: number) {
  const out = new Set<string>();
  for (const e of events) if (e.seq <= seq && e.t === "red_card" && e.side && e.p) out.add(e.side + ":" + e.p);
  return out;
}

/** Current event at server time `t` (last with `at ≤ t`), its predecessor, and ms elapsed since it. */
export function playhead(events: MatchEvent[], t: number) {
  let i = events.length - 1;
  while (i >= 0 && events[i].at > t) i--;
  if (i < 0) return null;
  const cur = events[i];
  return { cur, prev: events[i - 1] as MatchEvent | undefined, elapsed: t - cur.at };
}
