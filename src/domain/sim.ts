/**
 * Full 5-v-5 frame: maps a Scene's named actors onto real lineup players and parks the rest
 * at formation anchors drifted toward the ball, so all 10 players are always on the pitch.
 */
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";
import { FULL_CAM, sample, sampleN, short, type Actor, type Cam, type Pt, type Scene } from "./scenes";

export type Player = { side: Side; name: string; no: number; gk: boolean; x: number; y: number; hot: boolean /* named in the event */ };
export type Frame = { ball: Pt; lift: number; players: Player[]; caption: string; flash: Scene["flash"]; type: string; seq: number; p: number; cam: Cam } & Pick<Scene, "side" | "who" | "score" | "kick" | "pens" | "flashAt">;
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
const other = (s?: Side | null): Side => (s === "home" ? "away" : "home");
const PEN_ARC = new Set(["penalty_setup", "shootout_setup", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork", "shootout_kick"]);
/** Routine play: once the scene is over the carrier keeps going until the next event instead of standing on the ball. */
const DWELL = new Set(["pass", "build_up", "dribble", "through_ball", "cross", "tackle", "interception", "bounce", "kickoff", "restart"]);

function starters(list: LineupPlayer[], side: Side, sentOff?: Set<string>) {
  const live = list.filter((p) => p.starter && !sentOff?.has(side + ":" + p.name));
  const gk = live.find((p) => p.role === "gk") ?? live[0];
  return gk ? [gk, ...live.filter((p) => p !== gk).slice(0, 4)] : [];
}

/** `t` is progress through the scene; past 1 it keeps counting (1 + ms over / scene.ms) so the hold can evolve. */
export function frameAt(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>, nowMs = 0): Frame {
  const { ball: b, players, unlabelled } = layout(scene, t, lineups, sentOff);
  const ball: Pt = [b[0], b[1]]; // copy: sample() may hand back the scene's own keyframe
  const bind = binding(scene, lineups, sentOff);
  for (const a of unlabelled) {
    const q = players.find((p) => p.side + ":" + p.no === bind[a.id] && !p.hot);
    if (q) place(q, a, t);
  }
  const over = Math.max(0, t - 1) * scene.ms;
  if (over > 0 && !scene.flash && scene.side && DWELL.has(scene.type)) {
    // Dwell: carrier jogs on at 3 u/s with a gentle weave, at most 10 from where the scene ended; nearest mate shadows 6 behind.
    const dir = scene.side === "home" ? 1 : -1;
    let dx = (dir * 3 * over) / 1000;
    let dy = 2 * Math.sin((2 * Math.PI * over) / 1600);
    const r = Math.hypot(dx, dy);
    if (r > 10) {
      dx *= 10 / r;
      dy *= 10 / r;
    }
    ball[0] = clamp(ball[0] + dx, 1, 99);
    ball[1] = clamp(ball[1] + dy, 2, 62);
    const [carrier, mate] = players.filter((p) => p.side === scene.side && !p.gk).sort((p, q) => Math.hypot(p.x - b[0], p.y - b[1]) - Math.hypot(q.x - b[0], q.y - b[1]));
    if (carrier) Object.assign(carrier, { x: clamp(ball[0] - dir * 0.8, 0, 100), y: ball[1], hot: true });
    if (mate) Object.assign(mate, { x: clamp(ball[0] - dir * 6, 0, 100), y: ball[1] });
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
  return { ball, lift: sampleN(scene.ballHeight, t), players, caption: scene.caption, flash: scene.flash ?? null, type: scene.type, seq: scene.seq, p: Math.min(1, t), cam: scene.cam ?? FULL_CAM, side: scene.side, who: scene.who, score: scene.score, kick: scene.kick, pens: scene.pens, flashAt: scene.flashAt };
}

/** Formation players drifted toward the ball, named actors placed; unlabelled actors returned for binding. */
function layout(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>) {
  const ball = sample(scene.ball, t);
  // After a goal the defending side backs off to the centre for the restart while the scorer celebrates.
  const backOff = scene.flash === "goal" && (scene.type === "celebration" || t > 0.5) ? other(scene.side) : null;
  const players: Player[] = [];
  for (const side of ["home", "away"] as Side[]) {
    const mirror = side === "away";
    const b: Pt = side === backOff ? [50, 32] : ball;
    starters(lineups?.[side] ?? [], side, sentOff).forEach((p, i) => {
      const gk = i === 0;
      const ax = mirror ? 100 - ANCHORS[i][0] : ANCHORS[i][0];
      const ay = ANCHORS[i][1];
      const x = gk ? ax : clamp(ax + (b[0] - ax) * 0.3, 1, 99);
      const y = clamp(ay + (b[1] - ay) * (gk ? 0.4 : 0.3), 2, 62);
      players.push({ side, name: p.name, no: p.no, gk, x, y, hot: false });
    });
  }
  // Penalty: everyone who isn't taking or saving lines the edge of the D, home and away alternating.
  if (scene.cam && PEN_ARC.has(scene.type)) {
    const x = scene.cam[0] > 50 ? 80 : 20;
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
  for (const a of scene.actors) {
    if (a.side === "ref") continue;
    const p = a.keeper ? players.find((q) => q.side === a.side && q.gk) : a.label ? players.find((q) => q.side === a.side && !q.hot && short(q.name) === a.label) : null;
    if (p) place(p, a, t);
    else if (!a.keeper && !a.label) unlabelled.push(a);
  }
  return { ball, players, unlabelled };
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

/** Rendered frame chases the target: exponential approach per value, players speed-capped so nobody teleports. */
const MAX_SPEED = 60; // units per second
export function smooth(prev: Frame | null, target: Frame, dtMs: number): Frame {
  if (!prev) return target;
  const k = (tau: number) => 1 - Math.exp(-dtMs / tau);
  const kb = k(90);
  const kp = k(220);
  const maxStep = (MAX_SPEED * dtMs) / 1000;
  const was = new Map(prev.players.map((p) => [p.side + ":" + p.no, p]));
  const players = target.players.map((p) => {
    const q = was.get(p.side + ":" + p.no);
    if (!q) return p;
    let dx = (p.x - q.x) * kp;
    let dy = (p.y - q.y) * kp;
    const d = Math.hypot(dx, dy);
    if (d > maxStep) {
      dx *= maxStep / d;
      dy *= maxStep / d;
    }
    return { ...p, x: q.x + dx, y: q.y + dy };
  });
  const ball: Pt = [prev.ball[0] + (target.ball[0] - prev.ball[0]) * kb, prev.ball[1] + (target.ball[1] - prev.ball[1]) * kb];
  const kc = k(350);
  const cam = target.cam.map((v, i) => prev.cam[i] + (v - prev.cam[i]) * kc) as Cam;
  return { ...target, ball, lift: prev.lift + (target.lift - prev.lift) * kb, players, cam };
}

/**
 * May the result show? Only once the scene reaches its flash moment AND the *displayed* ball has got to the impact
 * point (the drawn ball lags the target). `reached` latches for the scene's life so the badge never flickers off.
 */
export function reveal(scene: Scene, p: number, ball: Pt, reachedBefore: boolean) {
  const reached = reachedBefore || !scene.impact || Math.hypot(ball[0] - scene.impact[0], ball[1] - scene.impact[1]) < 1.5;
  return { reached, revealed: !scene.flash || (p >= (scene.flashAt ?? 0.62) && reached) };
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
