/**
 * Highlight scenes: a pure mapping from published match events to short 2D animations.
 *
 * Coordinates: pitch 0..100 (x, home attacks →) by 0..64 (y). Home goal at x=0, away at x=100,
 * goal mouth y 28..36. The engine already gives ball positions; scenes only add movement between
 * them, so a scene's outcome always matches its event (a save is saved, a goal goes in, ...).
 */
import type { MatchEvent, Side } from "../lib/pocketbase";

export type Pt = [number, number];
export type Actor = {
  id: string;
  side: Side | "ref";
  label?: string; // shown name/number for the relevant player
  keeper?: boolean;
  rides?: boolean; // intermediate ball contact: reroute this actor with the ball when the scene starts off its authored path
  path: Pt[]; // keyframes, evenly spaced over the scene
};
export type Scene = {
  key: string;
  seq: number;
  type: string;
  phase?: string; // this event's snapshot, never the latest fixture or wall clock
  ms: number;
  ball: Pt[]; // keyframes over the scene (evenly spaced)
  ballHeight?: number[]; // optional lift per keyframe (0..1), for chips/crosses/headers
  actors: Actor[];
  caption: string;
  flash?: "goal" | "save" | "miss" | "over" | "block" | "wood" | "card" | "pen" | null; // result badge: miss = wide, over = over the bar
  focus?: Side | null; // celebrating side
  side?: Side | null; // event side (banners)
  who?: string; // event's main player
  score?: [number, number]; // score after the event
  kick?: MatchEvent["kick"];
  pens?: [number, number]; // shootout score after the event
  by?: MatchEvent["st"]["by"]; // how the match was won (match_end)
  cam?: Cam; // broadcast camera (SVG viewBox); full pitch when absent
  flashAt?: number; // progress at which the result badge may show (default 0.62)
  impact?: Pt; // where the result happens (net, keeper's hands, post, out point); result scenes only
  tempo?: Tempo; // #105: phase-of-play pace for the movement around this event (never its timing)
  touch?: Touch; // plain pass: how the passer plays it (#104)
  won?: number; // challenge scenes: progress at which the winner (`side`) has the ball — a WON IT cue, not a result (no reveal gate, no hold)
};
/** #104: a plain pass is a quick one-touch ball, a carry up the field before the release, or a hold-up (shield, then lay it on). */
export type Touch = "quick" | "carry" | "hold";
/** Deterministic hash of the event sequence in [0, 1): presentation variety without Math.random. */
export function seqHash(seq: number, k = 0) {
  let h = (seq * 2654435761 + k * 40503) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function touchStyle(seq: number): Touch {
  const h = seqHash(seq, 104);
  return h < 0.4 ? "quick" : h < 0.75 ? "carry" : "hold";
}
/** #105: counters and quick passing are fast, patient build-up slow. Only movement speed follows it; scene lengths do not. */
export type Tempo = "fast" | "normal" | "slow";
const FAST = new Set(["tackle", "interception", "through_ball", "cross", "shot", "dribble"]);
export function tempoFor(e: MatchEvent, s: Scene): Tempo {
  if (e.turn || FAST.has(e.t)) return "fast";
  const from = e.from as Pt | undefined;
  const fwd = from && e.ball && e.side ? toward(e.side, e.ball[0] - from[0]) : 0;
  if (e.t === "pass" && (s.touch === "carry" || fwd > 18)) return "fast";
  if (e.t === "build_up" || s.touch === "hold") return "slow";
  return "normal";
}
export type Cam = [number, number, number, number];
export const FULL_CAM: Cam = [-4, -3, 108, 77]; // bottom margin reaches the tunnel at y=70

const GOAL_Y = 32;

/** Goal line the side attacks. */
export function goalX(side: Side) {
  return side === "home" ? 100 : 0;
}
function toward(side: Side, d: number) {
  return side === "home" ? d : -d;
}
function clampPt([x, y]: Pt): Pt {
  return [Math.max(1, Math.min(99, x)), Math.max(2, Math.min(62, y))];
}
function lerp(a: Pt, b: Pt, t: number): Pt {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** Small deterministic jitter from the event sequence (variety without randomness). */
function jit(seq: number, k: number, amp: number) {
  const s = Math.sin(seq * 12.9898 + k * 78.233) * 43758.5453;
  return (s - Math.floor(s) - 0.5) * 2 * amp;
}
function other(side: Side): Side {
  return side === "home" ? "away" : "home";
}
export function short(name?: string) {
  if (!name) return undefined;
  const parts = name.split(" ");
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(" ")}` : name;
}
function keeperSpot(defSide: Side): Pt {
  return [defSide === "home" ? 3 : 97, GOAL_Y];
}
/** Where the referee stands for a penalty at goal `g`: the top corner of the box, clear of the ball path, the goal mouth, the run-up and the arc of waiting players. */
export function penRefSpot(g: Side): Pt {
  return [goalX(g) + toward(g, -14), GOAL_Y - 13];
}
/** Camera window `w` wide centred on (cx, cy) at the full-pitch aspect (so the SVG never reflows on a zoom), kept inside the full-pitch margins. */
function camAt(cx: number, cy: number, w: number): Cam {
  const [fx, fy, fw, fh] = FULL_CAM;
  const h = (w * fh) / fw;
  return [Math.max(fx, Math.min(fx + fw - w, cx - w / 2)), Math.max(fy, Math.min(fy + fh - h, cy - h / 2)), w, h];
}
/** Broadcast camera for a penalty: 56 wide (the box and the goal fit) centred 12 in from the attacked goal line. */
function penCam(g: Side): Cam {
  return camAt(goalX(g) + toward(g, -12), GOAL_Y, 56);
}
/** Celebration spots by the nearest corner flag of the attacked end: scorer, mate 1, mate 2. */
function huddle(atk: Side, y: number): [Pt, Pt, Pt] {
  const c: Pt = [goalX(atk) + toward(atk, -6), y >= GOAL_Y ? 58 : 6];
  const inward = c[1] > GOAL_Y ? -1 : 1;
  return [c, clampPt([c[0] - toward(atk, 4), c[1] + inward * 3]), clampPt([c[0] - toward(atk, 2), c[1] + inward * 4])];
}

/** Scene lengths were written for 15 s/min; scale to the match pace. Clock-pausing scenes keep a floor so they stay watchable. */
function pace(minuteMs: number) {
  const k = Math.max(0.15, Math.min(1, minuteMs / 15000));
  return (base: number, floor = 0) => Math.max(floor, Math.round(base * k));
}

/** Fields every scene copies from its event. */
function head(e: MatchEvent) {
  const so = e.st?.so;
  return { key: `${e.seq}`, seq: e.seq, type: e.t, phase: e.st?.ph, caption: e.text, flash: null as Scene["flash"], side: e.side ?? null, who: e.p, score: e.st?.sc, kick: e.kick, pens: so ? ([so.h, so.a] as [number, number]) : undefined, by: e.st?.by };
}

/**
 * Build the scene for one event. `prevBall` is where the previous scene ended, so movement
 * connects across scene boundaries. `next`: the following published event, if already fetched — only a cross reads it,
 * and only to put its own header's runner on his box point (see the cross scene); nothing of it reaches the scene's metadata.
 */
export function sceneFor(e: MatchEvent, prevBall: Pt, minuteMs: number, next?: MatchEvent): Scene | null {
  const s = build(e, prevBall, minuteMs, next);
  if (s) s.tempo = tempoFor(e, s);
  // Every scene starts where the last one left the ball; anything that would jump gets a lead-in keyframe.
  if (s && (s.ball[0][0] !== prevBall[0] || s.ball[0][1] !== prevBall[1])) {
    // #107: the previous scene already struck it a little way along this scene's first leg (a header off a cross): carry on from
    // there instead of a lead-in back to the strike point, so the ball never doubles back.
    if (s.ball.length > 1 && onLeg(s.ball[0], s.ball[1], prevBall)) {
      s.ball = [prevBall, ...s.ball.slice(1)];
      return s;
    }
    s.ball = [prevBall, ...s.ball];
    if (s.ballHeight) s.ballHeight = [s.ballHeight[0], ...s.ballHeight];
  }
  return s;
}

/** Is `p` part-way along a → b (strictly after a, before b, within 2.5 of the line)? */
function onLeg(a: Pt, b: Pt, p: Pt) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-6) return false;
  const u = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  const perp = Math.abs((p[0] - a[0]) * vy - (p[1] - a[1]) * vx) / Math.sqrt(len2);
  return u > 0 && u < 1 && perp < 2.5;
}

function build(e: MatchEvent, prevBall: Pt, minuteMs: number, next?: MatchEvent): Scene | null {
  const d = pace(minuteMs);
  const side = (e.side || "home") as Side;
  const atk = side;
  const def = other(side);
  const ball = (e.ball as Pt) || prevBall;
  const from = ((e.from as Pt) || prevBall) as Pt;
  const base = head(e);
  const s = e.seq;

  switch (e.t) {
    case "restart":
      // The restarting side walks the ball to the spot (centre after a goal, their own box after a failed penalty).
      return { ...base, ms: d(1300), ball: [prevBall, ball, ball], actors: [{ id: "w", side, path: [prevBall, ball, clampPt([ball[0] - toward(side, 2), ball[1]])] }] };
    case "kickoff":
    case "second_half":
    case "extra_time":
    case "et_second_half":
      return {
        ...base,
        ms: e.t === "kickoff" ? d(1300) : 3000, // period restarts carry a banner: give it a life
        ball: [prevBall, [50, 32], [50, 32]],
        actors: [
          { id: "a", side, label: short(e.p), path: [[50 + toward(side, -1.5), 33], [50, 32], [50 + toward(side, -4), 32]] },
          { id: "b", side, path: [[50 + toward(side, -12), 32 + jit(s, 1, 8)], [50 + toward(side, -11), 32 + jit(s, 1, 8)], clampPt([50 + toward(side, -10), 33 + jit(s, 1, 8)])] },
          { id: "d", side: other(side), path: [[50 + toward(side, 10), 26], [50 + toward(side, 9), 28], [50 + toward(side, 6), 30]] },
        ],
      };
    case "build_up":
    case "pass":
    case "through_ball":
    case "dribble":
    case "cross": {
      const passer = from;
      const recv = ball;
      const run = e.t === "dribble";
      // #184: a build-up names only its collector (`p`, no `p2`) — he has the ball on the engine's spot and the next pass is his —
      // so he is the receiver here, and the team-mate who plays it to him from `from` is unlabelled. Routes and ids are unchanged.
      const collector = e.t === "build_up" && !e.p2;
      const pLabel = collector ? undefined : short(e.p);
      const rLabel = collector ? short(e.p) : short(e.p2);
      const markerStart = clampPt([recv[0] + toward(atk, 6) + jit(s, 2, 3), recv[1] + jit(s, 3, 7)]);
      // A turnover (`turn`: the other side had the ball) is a contest for it, never a clearance: their player is on the ball where
      // the engine left it and the named player wins it (`won`: WON IT), then moves it on to the engine's spot. An outfielder is
      // challenged where he stands; a keeper (or blocker) holding it deep in his box after a failed attack plays it out and the
      // pass is cut out in midfield. Same engine positions, no teleport, no attacker in the keeper's hands.
      if (e.turn && (e.t === "pass" || e.t === "build_up")) {
        const lat = passer[1] > GOAL_Y ? -1 : 1; // towards the middle of the pitch
        const off = (p: Pt, along: number, across: number): Pt => clampPt([p[0] + toward(def, along), p[1] + lat * across]); // `along`: the old side's attacking direction
        const r: Actor = { id: "r", side: atk, label: rLabel, path: [] };
        const m: Actor = { id: "m", side: def, path: [] };
        if (toward(atk, passer[0] - goalX(atk)) >= -15) {
          const mid = lerp(passer, recv, 0.55);
          r.path = [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 3), recv[1]]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv];
          m.path = [markerStart, markerStart, markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)];
          return {
            ...base,
            ms: d(1900),
            won: 0.5,
            ball: [passer, lerp(passer, mid, 0.5), mid, mid, recv],
            ballHeight: [0, 0.25, 0, 0, 0],
            actors: [
              { id: "lost", side: def, keeper: true, path: [passer, passer, off(passer, 2, 0), off(passer, 3, 0), off(passer, 3, 0)] },
              { id: "tgt", side: def, path: [off(mid, 9, -3), off(mid, 6.5, -2), off(mid, 4, -1.5), off(mid, 3.5, -1.5), off(mid, 3.5, -1.5)] }, // the pass he meant
              { id: "p", side: atk, label: pLabel, path: [off(mid, -2, 5), off(mid, -1, 2.5), mid, mid, clampPt([mid[0] + toward(atk, 2), mid[1]])] },
              r,
              m,
            ],
          };
        }
        const c = off(passer, 1.5, 0); // the holder takes a touch on
        r.path = [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv];
        m.path = [markerStart, markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)];
        return {
          ...base,
          ms: d(1500),
          won: 1 / 3,
          ball: [passer, c, c, recv],
          actors: [
            { id: "lost", side: def, path: [off(passer, -0.8, 0), off(c, -0.8, 0), off(c, 1.5, -2.2), off(c, 2.5, -2.8)] },
            { id: "p", side: atk, label: pLabel, path: [off(c, 6, 3), c, c, clampPt([c[0] + toward(atk, 1.5), c[1]])] },
            r,
            m,
          ],
        };
      }
      // The ball was left deep in the passer's own box with his keeper (same side regains, `from` inside his own box after a failed
      // attack): the keeper distributes and the named passer collects it in midfield and moves it on.
      const ownBox = !e.turn && toward(atk, passer[0] - goalX(def)) <= 15;
      if (ownBox) {
        const mid = lerp(passer, recv, 0.55);
        // A short distribution would start the collector in the keeper's hands: place him
        // beside the collection point instead (exactly 4 units off the keeper's spot).
        let pStart: Pt = clampPt([mid[0] - toward(atk, 3), mid[1] + 2]);
        if (Math.hypot(pStart[0] - passer[0], pStart[1] - passer[1]) < 3.5) {
          const dx = mid[0] - passer[0];
          const dy = mid[1] - passer[1];
          const len = Math.hypot(dx, dy) || 1;
          pStart = clampPt([passer[0] + (dx / len) * 3.2 - (dy / len) * 2.4, passer[1] + (dy / len) * 3.2 + (dx / len) * 2.4]);
        }
        return {
          ...base,
          ms: d(1900),
          ball: [passer, lerp(passer, mid, 0.5), mid, recv],
          ballHeight: [0, 0.7, 0, 0],
          actors: [
            { id: "clear", side: atk, keeper: true, path: [passer, passer, clampPt([passer[0] + toward(def, 2), passer[1]]), clampPt([passer[0] + toward(def, 3), passer[1]])] },
            { id: "p", side: atk, label: pLabel, path: [pStart, clampPt([mid[0] - toward(atk, 1), mid[1] + 1]), mid, clampPt([mid[0] + toward(atk, 2), mid[1]])] },
            { id: "r", side: atk, label: rLabel, path: [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 3), recv[1]]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv] },
            { id: "m", side: def, path: [markerStart, markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
          ],
        };
      }
      if (e.t === "through_ball") {
        // Played into space: the runner starts behind the marker (the defensive line), well short of where the ball is going, and runs
        // onto it there; the marker steps up, turns late and is left trailing. Same endpoints and labels, a ground ball with a touch of lift.
        const run = Math.max(6, Math.min(14, toward(atk, recv[0] - passer[0]) - 2));
        const wide = recv[1] > GOAL_Y ? 1 : -1; // he comes in from the touchline side
        const rStart = clampPt([recv[0] - toward(atk, run), recv[1] + wide * 5]);
        const mStart = clampPt([rStart[0] + toward(atk, 3), rStart[1] - wide * 2]);
        return {
          ...base,
          ms: d(1500),
          ball: [passer, lerp(passer, recv, 0.5), recv],
          ballHeight: [0, 0.15, 0],
          actors: [
            { id: "p", side: atk, label: short(e.p), path: [lerp(passer, [passer[0] - toward(atk, 1), passer[1]], 1), passer, clampPt([passer[0] + toward(atk, 3), passer[1]])] },
            { id: "r", side: atk, label: short(e.p2), path: [rStart, lerp(rStart, recv, 0.45), recv] },
            { id: "m", side: def, path: [mStart, clampPt([mStart[0] - toward(atk, 1), mStart[1]]), clampPt([recv[0] - toward(atk, 3), recv[1] + wide * 2.5])] },
          ],
        };
      }
      if (e.t === "cross") {
        // Wide delivery: the feeder plays it along the ground to the winger, who holds his wide line and crosses; a runner attacks the
        // box and meets the lifted ball there. Runner and box point come from the next published event when it is this cross's own
        // header (a shot with `header`, same side and chain, the very next seq): the player who heads it is the one who arrives — the
        // feeder himself carries on into the box when he is the one. Otherwise an unlabelled runner attacks the far post: no named
        // outcome is invented. Nothing else is read from `next`; the scene's metadata is this event's.
        const header = next && next.t === "shot" && !!next.header && next.side === e.side && next.chain === e.chain && next.seq === e.seq + 1 && next.ball ? next : null;
        const box: Pt = header ? (header.ball as Pt) : [goalX(atk) - toward(atk, 13), recv[1] < GOAL_Y ? GOAL_Y + 4 : GOAL_Y - 4];
        const hLabel = header && short(header.p) !== short(e.p2) ? short(header.p) : undefined;
        const feederRuns = !!hLabel && hLabel === short(e.p);
        const fwd = (p: Pt, k: number): Pt => clampPt([p[0] + toward(atk, k), p[1]]);
        const hStart = clampPt([box[0] - toward(atk, 11), GOAL_Y + (GOAL_Y - box[1]) * 0.5]); // from the far side of the goal's centre line
        return {
          ...base,
          ms: d(2000),
          ball: [passer, recv, recv, box, box],
          ballHeight: [0, 0, 0, 0, 0, 0.9, 0.6, 0.6, 0.6], // along the ground to the winger, then the cross: highest in flight, head height at the box
          actors: [
            { id: "p", side: atk, label: short(e.p), rides: true, path: feederRuns ? [fwd(passer, -1), lerp(passer, box, 0.35), lerp(passer, box, 0.7), box, box] : [fwd(passer, -1), fwd(passer, 1), fwd(passer, 3), fwd(passer, 4), fwd(passer, 4)] },
            { id: "r", side: atk, label: short(e.p2), rides: true, path: [fwd(recv, -4), recv, recv, fwd(recv, 1), fwd(recv, 1)] },
            ...(feederRuns ? [] : [{ id: "h", side: atk, label: hLabel, rides: true, path: [hStart, hStart, lerp(hStart, box, 0.4), box, box] } as Actor]),
            { id: "m", side: def, path: [markerStart, markerStart, lerp(markerStart, recv, 0.5), lerp(markerStart, recv, 0.65), lerp(markerStart, recv, 0.65)] },
          ],
        };
      }
      if (e.t === "pass" && toward(atk, recv[0] - passer[0]) < -5) {
        // A backward midfield pass is built on, not a retreat: it is laid off to a teammate a few yards behind the engine's spot, who
        // takes a touch and releases it forward into the named receiver there. Same endpoints and labels; the extra man is unlabelled.
        const lat = recv[1] > GOAL_Y ? -1 : 1; // towards the middle of the pitch
        const at = (p: Pt, along: number, across: number): Pt => clampPt([p[0] + toward(atk, along), p[1] + lat * across]);
        const lay = at(recv, -5, 4);
        return {
          ...base,
          ms: d(2000),
          ball: [passer, lay, lay, recv],
          actors: [
            { id: "p", side: atk, label: short(e.p), path: [lerp(passer, [passer[0] - toward(atk, 1), passer[1]], 1), passer, clampPt([passer[0] + toward(atk, 3), passer[1]])] },
            { id: "l", side: atk, rides: true, path: [at(lay, -2, 0), lay, lay, at(lay, 2, 0)] },
            { id: "r", side: atk, label: short(e.p2), path: [at(recv, -3, -3), at(recv, -3, -3), at(recv, -1.5, -1.5), recv] },
            { id: "m", side: def, path: [markerStart, markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
          ],
        };
      }
      const lift = [0, 0, 0];
      const touch = run ? undefined : touchStyle(s);
      if (touch === "carry" || touch === "hold") {
        // Carry: he runs it up towards the receiver (up to 8) and releases halfway. Hold: he shields it, a touch back and across,
        // then lays it on. Either way the ball keeps moving — no stand-still before the pass — and the endpoints are the engine's.
        const len = Math.hypot(recv[0] - passer[0], recv[1] - passer[1]) || 1;
        const k = Math.min(8, len * 0.45) / len;
        const lat = passer[1] > GOAL_Y ? -1 : 1;
        const touchPt: Pt = touch === "carry" ? clampPt(lerp(passer, recv, k)) : clampPt([passer[0] - toward(atk, 1.2), passer[1] + lat * 1.8]);
        const by = (p: Pt): Pt => clampPt([p[0] - toward(atk, 0.8), p[1]]);
        return {
          ...base,
          ms: d(1500),
          touch,
          ball: [passer, touchPt, recv],
          ballHeight: lift,
          actors: [
            { id: "p", side: atk, label: pLabel, path: [by(passer), by(touchPt), clampPt([touchPt[0] + toward(atk, 2), touchPt[1]])] },
            { id: "r", side: atk, label: rLabel, path: [clampPt([recv[0] - toward(atk, 6), recv[1] + jit(s, 4, 4)]), lerp(recv, [recv[0] - toward(atk, 3), recv[1]], 0.5), recv] },
            { id: "m", side: def, path: [markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
          ],
        };
      }
      const ahead = toward(atk, recv[0] - passer[0]);
      if (touch === "quick" && ahead > 24) {
        // #106: a long ball — lifted over the midfield, the receiver chasing it from deep onto the drop.
        return {
          ...base,
          ms: d(1500),
          touch,
          ball: [passer, lerp(passer, recv, 0.5), recv],
          ballHeight: [0, 0.8, 0],
          actors: [
            { id: "p", side: atk, label: pLabel, path: [lerp(passer, [passer[0] - toward(atk, 1), passer[1]], 1), passer, clampPt([passer[0] + toward(atk, 3), passer[1]])] },
            { id: "r", side: atk, label: rLabel, path: [clampPt([recv[0] - toward(atk, 12), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 5), recv[1]]), recv] },
            { id: "m", side: def, path: [markerStart, lerp(markerStart, recv, 0.4), clampPt([recv[0] + toward(atk, 2.5), recv[1] + 2])] },
          ],
        };
      }
      return {
        ...base,
        ms: d(run ? 2000 : 1500),
        touch,
        ball: [passer, lerp(passer, recv, 0.5), recv],
        ballHeight: lift,
        actors: [
          { id: "p", side: atk, label: pLabel, path: run ? [passer, lerp(passer, recv, 0.5), recv] : [lerp(passer, [passer[0] - toward(atk, 1), passer[1]], 1), passer, clampPt([passer[0] + toward(atk, 3), passer[1]])] },
          ...(run
            ? []
            : [{ id: "r", side: atk, label: rLabel, path: [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv] as Pt[] }]),
          { id: "m", side: def, path: [markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
        ],
      };
    }
    case "tackle":
    case "interception": {
      // A visible challenge: the loser has the ball at `from` and takes it on (tackle) or plays it (interception) towards `ball`;
      // the winner closes from goal-side and has it there halfway through (`won`: WON IT), then keeps it. Engine spots unchanged.
      const at = from;
      const end = ball;
      const lat = at[1] > GOAL_Y ? -1 : 1; // towards the middle of the pitch
      const off = (p: Pt, along: number, across: number): Pt => clampPt([p[0] + toward(def, along), p[1] + lat * across]); // `along`: the loser's attacking direction
      const near = lerp(at, end, 0.6);
      const tackle = e.t === "tackle";
      return {
        ...base,
        ms: d(1600),
        won: 0.5,
        ball: [at, near, end, end, end],
        actors: [
          { id: "lost", side: def, label: short(e.p2), path: tackle ? [off(at, -0.8, 0), off(near, -0.8, 0), off(end, -1.2, 0), off(end, 2, -2), off(end, 3, -2.5)] : [off(at, -0.8, 0), off(at, 1, 0), off(at, 2, 0), off(at, 2, 0), off(at, 2, 0)] },
          ...(tackle ? [] : [{ id: "tgt", side: def, path: [off(end, 9, -3), off(end, 6.5, -2), off(end, 4.5, -1.5), off(end, 4, -1.5), off(end, 4, -1.5)] as Pt[] }]), // the pass he meant
          { id: "win", side, label: short(e.p), path: [off(end, 7, 3.5), off(end, 4, 2), end, end, end] },
        ],
      };
    }
    case "shot": {
      const shotFrom = ball;
      if (e.header) {
        // #107: the runner meets the cross and heads it at once — the ball leaves his head towards goal from the first frame, no
        // stand-still in the box. It covers only the first stretch (the result scene carries on from there, see onLeg).
        const aim: Pt = [goalX(atk), GOAL_Y];
        const gkH = keeperSpot(def);
        return {
          ...base,
          ms: d(1300),
          ball: [shotFrom, lerp(shotFrom, aim, 0.1), lerp(shotFrom, aim, 0.2)],
          ballHeight: [0.6, 0.55, 0.5],
          actors: [
            { id: "s", side: atk, label: short(e.p), path: [shotFrom, lerp(shotFrom, aim, 0.06), lerp(shotFrom, aim, 0.08)] },
            { id: "gk", side: def, keeper: true, path: [gkH, [gkH[0] + toward(atk, -1.5), GOAL_Y + (shotFrom[1] - GOAL_Y) * 0.15], [gkH[0] + toward(atk, -2), GOAL_Y + (shotFrom[1] - GOAL_Y) * 0.2]] },
            { id: "d", side: def, path: [clampPt([shotFrom[0] + toward(atk, 6), shotFrom[1] + 5]), clampPt([shotFrom[0] + toward(atk, 4), shotFrom[1] + 2]), clampPt([shotFrom[0] + toward(atk, 3), shotFrom[1] + 1])] },
          ],
        };
      }
      return {
        ...base,
        ms: d(1300),
        ball: [prevBall, shotFrom, shotFrom],
        ballHeight: e.header ? [0.6, 0.6, 0.6] : [0, 0, 0], // a header: the cross scene brought it to his head at the box point
        actors: [
          { id: "s", side: atk, label: short(e.p), path: e.header ? [shotFrom, shotFrom, shotFrom] : [clampPt([shotFrom[0] - toward(atk, 3), shotFrom[1] + 1]), shotFrom, shotFrom] },
          { id: "gk", side: def, keeper: true, path: [keeperSpot(def), [keeperSpot(def)[0] + toward(atk, -1.5), GOAL_Y + (shotFrom[1] - GOAL_Y) * 0.15], [keeperSpot(def)[0] + toward(atk, -2), GOAL_Y + (shotFrom[1] - GOAL_Y) * 0.2]] },
          { id: "d", side: def, path: [clampPt([shotFrom[0] + toward(atk, 6), shotFrom[1] + 5]), clampPt([shotFrom[0] + toward(atk, 4), shotFrom[1] + 2]), clampPt([shotFrom[0] + toward(atk, 3), shotFrom[1] + 1])] },
        ],
      };
    }
    case "goal":
    case "penalty_goal": {
      if (e.t === "penalty_goal" && e.pen) return penaltyScene(e, prevBall, "goal", d);
      const target = (e.target as Pt) || [goalX(atk), GOAL_Y];
      const shotFrom = prevBall;
      const gk = keeperSpot(other(atk));
      const dive: Pt = [gk[0], GOAL_Y + (target[1] > GOAL_Y ? -2.5 : 2.5)];
      const net: Pt = [goalX(atk) + toward(atk, 2), target[1]];
      const [corner, m1, m2] = huddle(atk, net[1]);
      const t1: Pt = clampPt([shotFrom[0] - toward(atk, 12), shotFrom[1] + 10]);
      const t2: Pt = clampPt([shotFrom[0] - toward(atk, 8), shotFrom[1] - 10]);
      return {
        ...base,
        ms: d(3800, 2400),
        ball: [shotFrom, target, net, net, net],
        actors: [
          { id: "s", side: atk, label: short(e.p), path: [shotFrom, shotFrom, lerp(shotFrom, corner, 0.5), corner, corner] },
          { id: "gk", side: other(atk), keeper: true, label: short(e.p2), path: [gk, dive, dive, dive, gk] },
          { id: "t1", side: atk, path: [t1, t1, lerp(t1, m1, 0.5), m1, m1] },
          { id: "t2", side: atk, path: [t2, t2, lerp(t2, m2, 0.5), m2, m2] },
        ],
        flash: "goal",
        focus: atk,
        // GOAL shows the instant the ball crosses the line (p = 0.25, ball on `target`), not at the default 0.62 hold
        // after it has already settled in the net (#98): no gap between the goal and its message.
        flashAt: 0.25,
        impact: target,
      };
    }
    case "celebration": {
      // Ball stays in the net, banner stays up; the scorer and two mates hold the huddle by the corner flag.
      const [corner, m1, m2] = huddle(side, prevBall[1]);
      const bob = (p: Pt): Pt => [p[0], p[1] + (corner[1] > GOAL_Y ? -1 : 1)];
      return {
        ...base,
        ms: d(2000, 2600), // the GOOOAL banner lives here: never under 2.6 s
        ball: [prevBall],
        actors: [
          { id: "s", side, label: short(e.p), path: [corner, bob(corner), corner] },
          { id: "t1", side, path: [m1, lerp(m1, corner, 0.3), m1] },
          { id: "t2", side, path: [m2, lerp(m2, corner, 0.3), m2] },
        ],
        flash: "goal",
        focus: side,
        flashAt: 0, // the goal is already in: banner and caption from the first frame
        impact: prevBall,
      };
    }
    case "save": {
      // event side = defending team; shooter attacks the other way
      const shooterSide = other(side);
      const target = (e.target as Pt) || [goalX(shooterSide), GOAL_Y];
      const shotFrom = (e.from as Pt) || prevBall;
      const gk = keeperSpot(side);
      const catchPt: Pt = [gk[0], target[1]];
      const held = jit(s, 6, 1) > 0; // catch and hold, or parry and gather: the keeper ends up with the ball either way
      const parry: Pt = held ? catchPt : clampPt([ball[0], ball[1] + (target[1] > GOAL_Y ? 6 : -6)]);
      return {
        ...base,
        ms: d(2600),
        ball: [shotFrom, lerp(shotFrom, catchPt, 0.85), catchPt, parry],
        actors: [
          { id: "gk", side, keeper: true, label: short(e.p), path: [gk, lerp(gk, catchPt, 0.7), catchPt, parry] },
          { id: "s", side: shooterSide, label: short(e.p2), path: [shotFrom, shotFrom, clampPt([shotFrom[0] + toward(shooterSide, 3), shotFrom[1]]), clampPt([shotFrom[0] + toward(shooterSide, 4), shotFrom[1]])] },
        ],
        flash: "save",
        impact: catchPt,
      };
    }
    case "block": {
      const shooterSide = other(side);
      const shotFrom = (e.from as Pt) || prevBall;
      const blockAt: Pt = clampPt([shotFrom[0] + toward(shooterSide, 4), shotFrom[1] + jit(s, 5, 2)]);
      const rebound: Pt = ball;
      return {
        ...base,
        ms: d(1900),
        ball: [shotFrom, blockAt, rebound],
        actors: [
          { id: "b", side, label: short(e.p), path: [clampPt([blockAt[0] + toward(shooterSide, 3), blockAt[1] + 4]), blockAt, rebound] }, // closes down, blocks, wins the loose ball
          { id: "s", side: shooterSide, label: short(e.p2), path: [shotFrom, shotFrom, shotFrom] },
          { id: "gk", side, keeper: true, path: [keeperSpot(side), keeperSpot(side), keeperSpot(side)] },
        ],
        flash: "block",
        impact: blockAt,
      };
    }
    case "woodwork":
    case "miss": {
      const target = (e.target as Pt) || [goalX(side), GOAL_Y + 10];
      const shotFrom = (e.from as Pt) || prevBall;
      const out: Pt = e.t === "woodwork" ? (ball as Pt) : [goalX(side) + toward(side, 3), target[1] + (target[1] > GOAL_Y ? 3 : -3)];
      const gk = keeperSpot(other(side));
      const high = e.t === "miss" && !!(e as MatchEvent & { high?: number }).high;
      return {
        ...base,
        ms: d(2300),
        ball: [shotFrom, lerp(shotFrom, target, 0.6), target, out],
        ballHeight: high ? [0, 0.5, 1, 1] : undefined,
        actors: [
          { id: "s", side, label: short(e.p), path: [shotFrom, shotFrom, clampPt([shotFrom[0] + toward(side, 2), shotFrom[1]]), clampPt([shotFrom[0] + toward(side, 2), shotFrom[1]])] },
          { id: "gk", side: other(side), keeper: true, path: [gk, [gk[0], GOAL_Y + (target[1] - GOAL_Y) * 0.4], [gk[0], GOAL_Y + (target[1] - GOAL_Y) * 0.5], e.t === "woodwork" ? out : gk] }, // off the woodwork: the keeper gathers the rebound
        ],
        flash: e.t === "woodwork" ? "wood" : high ? "over" : "miss",
        impact: target,
      };
    }
    case "bounce": {
      const hit = from; // the wall
      return { ...base, ms: d(1400), ball: [prevBall, hit, lerp(hit, ball, 0.5), ball], actors: [{ id: "c", side, label: short(e.p), path: [clampPt([ball[0] - toward(side, 6), ball[1]]), clampPt([ball[0] - toward(side, 4), ball[1]]), ball, ball] }] };
    }
    case "foul":
    case "yellow_card":
    case "red_card": {
      const at = ball || prevBall;
      return {
        ...base,
        ms: d(e.t === "foul" ? 1500 : 2200),
        ball: [at, at],
        actors: [
          { id: "o", side, label: short(e.p), path: [clampPt([at[0] + 3, at[1] + 2]), at] },
          ...(e.p2 ? [{ id: "v", side: other(side), label: short(e.p2), path: [clampPt([at[0] - 1, at[1]]), clampPt([at[0] - 1, at[1] + 1])] as Pt[] }] : []),
          { id: "ref", side: "ref" as const, path: [clampPt([at[0] - 8, at[1] - 8]), clampPt([at[0] - 4, at[1] - 4])] },
        ],
        flash: e.t === "foul" ? null : "card",
        impact: e.t === "foul" ? undefined : at,
      };
    }
    case "penalty_awarded": {
      // Fills the engine's award wait (balance.js penAwardMs), whatever the pace: the fouled player is down (0–30 %), the ref
      // runs in and points to the spot as the ball goes there (30–55 %), the fouled player gets up to the spot, the offender
      // walks three away (55–80 %), two teammates close four on the spot and the keeper walks back to his line.
      const spot = (e.ball as Pt) || [goalX(side) + toward(side, -11), GOAL_Y];
      const at = prevBall;
      const seg = (t: number, a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
      const walk = (from: Pt, to: Pt, a: number, b: number) => keys((t) => lerp(from, to, seg(t, a, b)));
      const closer = (p: Pt): Pt => lerp(p, spot, 4 / Math.max(4, Math.hypot(p[0] - spot[0], p[1] - spot[1])));
      const offAt: Pt = clampPt([at[0] + toward(side, 2), at[1] + 2]);
      const gk = keeperSpot(def);
      const m1: Pt = clampPt([spot[0] - toward(side, 10), spot[1] - 9]);
      const m2: Pt = clampPt([spot[0] - toward(side, 12), spot[1] + 8]);
      const refIn: Pt = clampPt([spot[0] - toward(side, 12), spot[1] - 12]);
      const refPoint: Pt = clampPt([spot[0] - toward(side, 2), spot[1] - 5]);
      const refSpot = penRefSpot(side);
      return {
        ...base,
        ms: 5000,
        ball: walk(at, spot, 0.3, 0.55),
        actors: [
          { id: "fouled", side, label: short(e.p), path: walk(clampPt([at[0], at[1] + 1.5]), clampPt([spot[0] - toward(side, 3), spot[1] + 2]), 0.3, 0.6) },
          { id: "off", side: def, label: short(e.p2), path: walk(offAt, clampPt([offAt[0] + toward(side, 3), offAt[1] + 1]), 0.55, 0.8) },
          { id: "ref", side: "ref", path: keys((t) => (t < 0.6 ? lerp(refIn, refPoint, seg(t, 0.3, 0.55)) : lerp(refPoint, refSpot, seg(t, 0.6, 0.9)))) }, // runs in to point, then backs off to his penalty spot before the walk-up
          { id: "t1", side, path: walk(m1, closer(m1), 0.2, 0.9) },
          { id: "t2", side, path: walk(m2, closer(m2), 0.3, 1) },
          { id: "gk", side: def, keeper: true, path: walk(clampPt([gk[0] - toward(side, 4), GOAL_Y + 4]), gk, 0.4, 0.9) },
        ],
        flash: "pen",
        cam: penCam(side),
        impact: spot,
      };
    }
    case "shootout_end":
      return { ...base, ms: 0, ball: [prevBall], actors: [{ id: "ref", side: "ref", path: [penRefSpot("home")] }], cam: penCam("home") };
    case "half_time":
    case "end_of_normal_time":
    case "et_half_time":
    case "shootout_start": {
      // Ball held where it was; the banner lives the whole break — real ms, whatever the pace, like the setup scenes.
      const BREAK: Record<string, number> = { half_time: 30000, end_of_normal_time: 20000, et_half_time: 10000, shootout_start: 10000 }; // matches balance.js halfTimeMs / etBreakMs / etHalfTimeMs / shootoutIntroMs
      return { ...base, ms: BREAK[e.t], ball: [prevBall], actors: [], cam: e.t === "shootout_start" ? penCam("home") : undefined }; // shootout intro: frameAt choreographs it and holds the full pitch for the first 70 %
    }
    case "match_end":
      return { ...base, ms: 5000, ball: [prevBall], actors: [] }; // full-time banner; the last event, so it holds
    case "penalty_setup":
    case "shootout_setup":
      return setupScene(e, prevBall);
    case "penalty_saved":
    case "penalty_missed":
    case "penalty_woodwork":
      return e.pen ? penaltyScene(e, prevBall, e.pen.outcome, d) : null;
    case "shootout_kick":
      return e.pen ? penaltyScene(e, prevBall, e.pen.outcome, d) : null;
    default:
      return null; // coaching → caption only
  }
}

/** Shootouts are taken at one end (towards x=100) whichever team is kicking. */
function geomSide(e: MatchEvent, side: Side): Side {
  return e.t.startsWith("shootout") ? "home" : side;
}

/** Keyframes sampled from a function of progress, evenly spaced as `sample` expects. */
function keys(f: (t: number) => Pt, n = 20): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => f(i / n));
}

/**
 * Setup fills the engine's whole wait for the kick (regardless of pace, so nothing freezes): the taker brings the ball
 * to the spot (0–20 %), walks six back (20–45 %) and settles with a breathing sway; the keeper bounces on his line;
 * the referee jogs in from twelve away to six beside the spot. Same geometry in-match and in shootouts.
 */
function setupScene(e: MatchEvent, prevBall: Pt): Scene {
  const side = (e.side || "home") as Side;
  const def = other(side);
  const g = geomSide(e, side);
  const spot: Pt = [goalX(g) + toward(g, -11), GOAL_Y];
  const gk = keeperSpot(other(g));
  const back: Pt = clampPt([spot[0] - toward(g, 6), spot[1] + 2]);
  const refSpot = penRefSpot(g);
  const place = (from: Pt, t: number) => lerp(from, spot, Math.min(1, t / 0.2));
  return {
    ...head(e),
    ms: e.t === "shootout_setup" ? 6000 : 5000, // matches balance.js shootoutRevealMs / penSetupMs: the kick event lands when this ends
    ball: keys((t) => place(prevBall, t)),
    actors: [
      { id: "taker", side, label: short(e.p), path: keys((t) => (t < 0.2 ? place(clampPt(prevBall), t) : t < 0.45 ? lerp(spot, back, (t - 0.2) / 0.25) : [back[0], back[1] + 0.3 * Math.sin((2 * Math.PI * (t - 0.45)) / 0.2)])) },
      { id: "gk", side: def, keeper: true, label: short(e.p2), path: keys((t) => [gk[0], GOAL_Y + 2 * Math.sin(2 * Math.PI * 4 * t)]) },
      { id: "ref", side: "ref", path: [refSpot] }, // already on his spot (smoothing jogs him there from wherever he was) and still for the whole walk-up
    ],
    flash: "pen",
    cam: penCam(g),
    impact: spot,
  };
}

/** Run-up, strike, ball path and keeper dive from the engine's penalty plan. */
function penaltyScene(e: MatchEvent, prevBall: Pt, outcome: string, d: ReturnType<typeof pace>): Scene {
  const side = (e.side || "home") as Side;
  const def = other(side);
  const pen = e.pen!;
  const g = geomSide(e, side); // shootouts: every kick at the same end
  const spot: Pt = [goalX(g) + toward(g, -11), GOAL_Y];
  const gk = keeperSpot(other(g));
  const line = goalX(g);
  const col = pen.col; // -2..2 (|2| = wide)
  const y = GOAL_Y + col * 2.6;
  const target: Pt = [line, y];
  const diveY = GOAL_Y + pen.dive * 2.8;
  const runStart: Pt = clampPt([spot[0] - toward(g, 3 + pen.run * 2), spot[1] + (pen.run === 1 ? -4 : pen.run === 2 ? 4 : 2)]);
  let end: Pt;
  let flash: Scene["flash"];
  if (outcome === "goal") {
    end = [line + toward(g, 2), y];
    flash = "goal";
  } else if (outcome === "save") {
    end = clampPt([gk[0] + toward(other(g), 4), diveY + (pen.dive >= 0 ? 5 : -5)]);
    flash = "save";
  } else if (outcome === "woodwork") {
    const postY = pen.post === "bar" ? y : pen.post === "left" ? 28 : 36;
    end = clampPt([line + toward(other(g), 5), postY + (pen.post === "left" ? -4 : 4)]);
    flash = "wood";
  } else {
    end = [line + toward(g, 3), pen.height === 2 ? y : y + (col < 0 ? -3 : 3)];
    flash = pen.height === 2 ? "over" : "miss";
  }
  const strikeAt: Pt = outcome === "save" ? [gk[0], diveY] : outcome === "woodwork" ? [line, pen.post === "bar" ? y : pen.post === "left" ? 28 : 36] : target;
  return {
    ...head(e),
    ms: d(3400, 1800),
    ball: [prevBall, spot, spot, strikeAt, end], // on the spot by 25 %, still there at 50 %: nothing gives the outcome away
    ballHeight: pen.height === 2 || pen.post === "bar" ? [0, 0, 0, 1, 1] : pen.height === 1 ? [0, 0, 0, 0.5, 0.3] : undefined,
    actors: [
      { id: "taker", side, label: short(e.p), path: [runStart, lerp(runStart, spot, 0.4), spot, spot, spot] }, // accelerating run-up, strike at 50 %
      { id: "gk", side: def, keeper: true, label: short(e.p2), path: [gk, gk, gk, [gk[0], diveY], [gk[0], diveY]] }, // dives at the strike, not before
      { id: "ref", side: "ref", path: [penRefSpot(g)] }, // holds his spot through run-up, strike and result: never wanders into the ball path or the view
    ],
    flash,
    flashAt: 0.75,
    cam: penCam(g),
    focus: outcome === "goal" ? side : outcome === "save" ? def : null,
    impact: strikeAt,
  };
}

/**
 * Sample keyframes at t ∈ [0,1]. #106: motion only slows where it really stops — into a hold (repeated keyframe) or the
 * path's end — and only builds up out of a hold; through a moving keyframe it keeps its speed, so nobody pauses before a pass,
 * shot or run. A path builds up from its first keyframe, where the previous scene left everyone.
 */
export function sample(path: Pt[], t: number): Pt {
  if (path.length === 1) return path[0];
  const seg = path.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * seg;
  const i = Math.floor(x);
  const f = x - i;
  const same = (a?: Pt, b?: Pt) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const easeIn = i === 0 || same(path[i - 1], path[i]);
  const easeOut = i === seg - 1 || same(path[i + 1], path[i + 2]);
  const e = easeIn && easeOut ? (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2) : easeOut ? f * (2 - f) : easeIn ? f * f : f;
  return lerp(path[i], path[i + 1], e);
}

export function sampleN(vals: number[] | undefined, t: number) {
  if (!vals || !vals.length) return 0;
  const seg = vals.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * seg;
  const i = Math.floor(x);
  return vals[i] + (vals[i + 1] - vals[i]) * (x - i);
}
