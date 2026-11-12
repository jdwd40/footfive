/**
 * #205: each move's on-pitch signature, as pure data from a scene and its progress — a faint pass line, a curved lofted cross, a
 * through ball into marked space with the runner sprinting, a long rising strike, the frame rattling, the keeper's dive or claim.
 *
 * Nothing here reads anything but the scene being drawn, so a shot (whose scene is built from the shot event alone) draws the same
 * whatever its result turns out to be; dives, claims and the woodwork only exist on result scenes. One effect per frame, with a
 * fixed set of drawn nodes (Pitch), so a fast-forwarded backlog can never pile effects up.
 */
import type { Side } from "../lib/pocketbase";
import { goalX, sample, sampleN, type Actor, type Pt, type Scene } from "./scenes";

/** A drawn point: pitch x, y and the ball's lift there (0..1). */
export type FxPt = [number, number, number];
export type Fx = {
  kind: Scene["move"] | null;
  line: FxPt[]; // the move's line (empty: none): straight for a pass, the traced arc of a cross, the wake of a long strike
  alpha: number; // line opacity now
  spot?: { at: Pt; alpha: number }; // through ball: the space it is played into
  sprint?: { key: string; to: Pt; alpha: number }; // speed lines behind this player (side:no), running towards `to`
  burst?: { at: Pt; alpha: number; r: number }; // woodwork: the frame rattles where it was hit
};
export type KeeperPose = { side: Side; pose: "dive" | "claim"; dir: Pt /* unit, pitch coords */; k: number /* 0..1 */; step?: Pt /* a claim's come-off-the-line offset, applied by the drawing only once revealed */ };

/** How long a pass line takes to fade (real ms of scene time: a fast-forward fades it as fast as it plays the pass). */
export const PASS_FADE_MS = 650;
/** A traced arc or wake stays this long after the ball arrives. */
export const TRACE_FADE_MS = 500;
/** How long the woodwork rattle lasts. */
export const BURST_MS = 600;
/** Points in a traced line: fixed, whatever the move. */
export const TRACE_N = 9;
/** A cross bends this share of its length towards goal (an in-swinger) at the middle of its flight. */
export const CROSS_BEND = 0.14;
/** A dive leans this much forward (per unit across): towards the ball, not just along the line. */
export const DIVE_FORWARD = 0.75;
/** The drawn ball trails its target by about this much (sim's smooth: ball time constant), so a traced line ends where it is drawn. */
export const DRAW_LAG_MS = 90;
const MIN_LEG = 5; // shorter ball movements (a touch, a lay back) get no line

const eq = (a?: Pt, b?: Pt) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Every function takes the scene as authored (`scene`: its keyframe structure — holds, the impact keyframe) and, optionally, the same
 * scene re-routed from where the ball was drawn (`geo`, see sim's fromStart: same keyframe count, points blended) for coordinates.
 */
const index = (scene: Scene, p?: Pt) => (p ? scene.ball.findIndex((q) => eq(q, p)) : -1);
/** Progress at which the ball reaches the scene's impact keyframe (1 if none). */
function impactT(scene: Scene) {
  const i = index(scene, scene.impact);
  return i > 0 ? i / (scene.ball.length - 1) : 1;
}

/** The cross's delivery: from the winger's spot to where it drops (the first keyframe on the scene's final spot), and when. */
function crossLeg(scene: Scene, geo: Scene) {
  if (scene.type !== "cross" || geo.ball.length !== scene.ball.length) return null;
  const i = index(scene, scene.ball[scene.ball.length - 1]);
  if (i < 1) return null;
  const seg = scene.ball.length - 1;
  return { a: geo.ball[i - 1], b: geo.ball[i], t0: (i - 1) / seg, t1: i / seg };
}

/** Lateral offset of a cross in flight: a sine bulge towards the attacked goal line, zero at the winger and where it drops. */
export function crossBend(scene: Scene, t: number, geo: Scene = scene): Pt {
  const leg = crossLeg(scene, geo);
  if (!leg || t <= leg.t0 || t >= leg.t1) return [0, 0];
  const [dx, dy] = [leg.b[0] - leg.a[0], leg.b[1] - leg.a[1]];
  const len = Math.hypot(dx, dy);
  if (len < MIN_LEG) return [0, 0];
  let [nx, ny] = [-dy / len, dx / len];
  const goalward = goalX((scene.side || "home") as Side) > 50 ? 1 : -1;
  if (nx * goalward < 0) [nx, ny] = [-nx, -ny];
  const k = Math.sin((Math.PI * (t - leg.t0)) / (leg.t1 - leg.t0)) * CROSS_BEND * len;
  return [nx * k, ny * k];
}

/** The ball's canonical spot at `t` (the keyframes, plus a cross's bend). */
export function ballAt(scene: Scene, t: number, geo: Scene = scene): Pt {
  const [x, y] = sample(geo.ball, t);
  const [bx, by] = crossBend(scene, t, geo);
  return [x + bx, y + by];
}

/** `TRACE_N` points of the ball's drawn flight from `t0` to `t1`. */
function trace(scene: Scene, geo: Scene, t0: number, t1: number): FxPt[] {
  return Array.from({ length: TRACE_N }, (_, i) => {
    const t = t0 + ((t1 - t0) * i) / (TRACE_N - 1);
    const [x, y] = ballAt(scene, t, geo);
    return [x, y, sampleN(geo.ballHeight, t)];
  });
}

/** Passes along the ground between holds (a repeated keyframe), each with the progress it is played at. A carry or hold-up's first
 * touch is his own, not a pass; a keeper's distribution is collected (at keyframe 2) and moved on. */
function legs(scene: Scene, geo: Scene) {
  const b = scene.ball;
  const g = geo.ball.length === b.length ? geo.ball : b;
  const seg = b.length - 1;
  const cuts = new Set<number>();
  if (scene.touch === "carry" || scene.touch === "hold") cuts.add(1);
  if (scene.actors.some((a) => a.id === "clear")) cuts.add(2);
  const out: { a: Pt; b: Pt; t0: number }[] = [];
  let i0 = scene.touch === "carry" || scene.touch === "hold" ? 1 : 0;
  for (let k = i0 + 1; k <= seg; k++) {
    const hold = eq(b[k], b[k - 1]);
    if (hold || cuts.has(k) || k === seg) {
      const i1 = hold ? k - 1 : k;
      if (i1 > i0 && dist(g[i0], g[i1]) >= MIN_LEG) out.push({ a: g[i0], b: g[i1], t0: i0 / seg });
      i0 = k;
    }
  }
  return out;
}

/**
 * The effect for one frame of `scene` (`geo`: the same scene re-routed to where the ball was drawn). `keyOf` resolves an actor id to
 * the drawn player (side:no) for speed lines. Returns null when the scene has no signature.
 */
export function moveFx(scene: Scene, t: number, keyOf: (id: string) => string | undefined, geo: Scene = scene): Fx | null {
  const ms = scene.ms || 1;
  const lag = DRAW_LAG_MS / ms;
  const fx: Fx = { kind: scene.move ?? null, line: [], alpha: 0 };
  switch (scene.move) {
    case "pass":
    case "through": {
      const leg = legs(scene, geo).filter((l) => l.t0 <= t).pop();
      if (leg) {
        const age = (t - leg.t0) * ms;
        fx.line = [[...leg.a, 0], [...leg.b, 0]];
        fx.alpha = scene.move === "pass" ? 0.5 * clamp01(1 - age / PASS_FADE_MS) : 0.7 * clamp01(1 - age / (ms + PASS_FADE_MS));
      }
      if (scene.move === "through" && t < 1) {
        const end = geo.ball[geo.ball.length - 1];
        fx.spot = { at: end, alpha: 0.85 * clamp01((1 - t) / 0.2) };
        const key = keyOf("r");
        if (key) fx.sprint = { key, to: end, alpha: 0.8 * clamp01((0.95 - t) / 0.2) };
      }
      break;
    }
    case "cross": {
      const leg = crossLeg(scene, geo);
      if (leg && t > leg.t0) {
        fx.line = trace(scene, geo, leg.t0, Math.max(leg.t0, Math.min(t - lag, leg.t1)));
        fx.alpha = 0.75 * clamp01(1 - ((t - leg.t1) * ms) / TRACE_FADE_MS);
      }
      break;
    }
    case "long": {
      if (scene.type === "shot") {
        // Run-up and strike: speed lines behind the shooter as he arrives on it, and the rising wake behind the ball. The wake is where
        // the ball has been, never where it is going: the same for every outcome.
        fx.line = trace(scene, geo, 0, Math.max(0, Math.min(1, t - lag)));
        fx.alpha = 0.6;
        const s = scene.actors.find((a) => a.id === "s");
        const key = s && keyOf("s");
        if (key && t < 0.45) fx.sprint = { key, to: [goalX((scene.side || "home") as Side), 32], alpha: 0.85 * clamp01((0.45 - t) / 0.3) };
      } else {
        // The result carries the strike on to where it is decided (the impact), then the wake fades.
        const ti = impactT(scene);
        fx.line = trace(scene, geo, 0, Math.max(0, Math.min(t - lag, ti)));
        fx.alpha = 0.6 * clamp01(1 - ((t - ti) * ms) / TRACE_FADE_MS);
      }
      break;
    }
  }
  if ((scene.type === "woodwork" || scene.type === "penalty_woodwork") && scene.impact) {
    const age = (t - impactT(scene)) * ms;
    if (age >= 0 && age < BURST_MS) fx.burst = { at: scene.impact, alpha: 1 - age / BURST_MS, r: 1 + (2.5 * age) / BURST_MS };
  }
  const [first, last] = [fx.line[0], fx.line[fx.line.length - 1]];
  if (!first || !last || fx.alpha <= 0.01 || Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.3) {
    fx.line = [];
    fx.alpha = 0;
  }
  return fx.line.length || fx.spot || fx.sprint || fx.burst ? fx : null;
}

/** The keeper's pose at `t`, from the result scene's keeper move (none elsewhere). */
export function keeperPose(scene: Scene, t: number): KeeperPose | null {
  const m = scene.keeper;
  const gk: Actor | undefined = scene.actors.find((a) => a.keeper && a.side !== "ref");
  if (!m || !gk || gk.side === "ref") return null;
  const [a, b, c, d] = m.at;
  const k = t < a ? 0 : t < b ? (t - a) / (b - a) : t <= c ? 1 : t < d ? 1 - (t - c) / (d - c) : 0;
  if (k <= 0) return null;
  const from = gk.path[0];
  const dx = m.to[0] - from[0];
  const dy = m.to[1] - from[1];
  const len = Math.hypot(dx, dy);
  // He goes forward as well as across (a keeper attacks the ball), so a dive along his line still reads as a dive; a claim faces the
  // play when he barely moves.
  const fwd = goalX(gk.side) > 50 ? 1 : -1;
  const [ux, uy] = len > 0.2 ? [dx / len, dy / len] : [fwd, 0];
  const [vx, vy] = m.pose === "dive" ? [ux + fwd * DIVE_FORWARD, uy] : [ux, uy];
  const n = Math.hypot(vx, vy) || 1;
  return { side: gk.side, pose: m.pose, dir: [vx / n, vy / n], k, ...(m.step ? { step: m.step } : {}) };
}
