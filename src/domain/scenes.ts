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
};
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
 * connects across scene boundaries.
 */
export function sceneFor(e: MatchEvent, prevBall: Pt, minuteMs: number): Scene | null {
  const s = build(e, prevBall, minuteMs);
  // Every scene starts where the last one left the ball; anything that would jump gets a lead-in keyframe.
  if (s && (s.ball[0][0] !== prevBall[0] || s.ball[0][1] !== prevBall[1])) {
    s.ball = [prevBall, ...s.ball];
    if (s.ballHeight) s.ballHeight = [s.ballHeight[0], ...s.ballHeight];
  }
  return s;
}

function build(e: MatchEvent, prevBall: Pt, minuteMs: number): Scene | null {
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
      const markerStart = clampPt([recv[0] + toward(atk, 6) + jit(s, 2, 3), recv[1] + jit(s, 3, 7)]);
      // The ball was left deep in a box and nobody in the passer's shirt is on it: the engine leaves it with the keeper (or
      // blocker) after a failed attack. Either the other team took it there (`turn`, the opponent on it launches it clear) or
      // the passer's own keeper is holding it (same side regains, `from` inside his own box) and distributes. The named passer
      // collects it in midfield and moves it on. Same engine positions, no teleport, no attacker in the keeper's hands.
      const backward = !!e.turn && toward(atk, recv[0] - passer[0]) < -12;
      const ownBox = !e.turn && toward(atk, passer[0] - goalX(def)) <= 15;
      if (backward || ownBox) {
        const inBox = ownBox || toward(atk, passer[0] - goalX(atk)) >= -15;
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
            { id: "clear", side: ownBox ? atk : def, keeper: inBox, path: [passer, passer, clampPt([passer[0] + toward(def, 2), passer[1]]), clampPt([passer[0] + toward(def, 3), passer[1]])] },
            { id: "p", side: atk, label: short(e.p), path: [pStart, clampPt([mid[0] - toward(atk, 1), mid[1] + 1]), mid, clampPt([mid[0] + toward(atk, 2), mid[1]])] },
            { id: "r", side: atk, label: short(e.p2), path: [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), clampPt([recv[0] - toward(atk, 3), recv[1]]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv] },
            { id: "m", side: def, path: [markerStart, markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
          ],
        };
      }
      const lift = e.t === "cross" ? [0, 0.9, 0] : e.t === "through_ball" ? [0, 0.15, 0] : [0, 0, 0];
      return {
        ...base,
        ms: d(run ? 2000 : e.t === "cross" ? 2000 : 1500),
        ball: [passer, lerp(passer, recv, 0.5), recv],
        ballHeight: lift,
        actors: [
          { id: "p", side: atk, label: run ? short(e.p) : short(e.p), path: run ? [passer, lerp(passer, recv, 0.5), recv] : [lerp(passer, [passer[0] - toward(atk, 1), passer[1]], 1), passer, clampPt([passer[0] + toward(atk, 3), passer[1]])] },
          ...(run
            ? []
            : [{ id: "r", side: atk, label: short(e.p2), path: [clampPt([recv[0] - toward(atk, 4), recv[1] + jit(s, 4, 4)]), lerp(recv, [recv[0] - toward(atk, 2), recv[1]], 0.5), recv] as Pt[] }]),
          { id: "m", side: def, path: [markerStart, lerp(markerStart, recv, 0.35), lerp(markerStart, recv, 0.6)] },
        ],
      };
    }
    case "tackle":
    case "interception": {
      const at = from;
      const end = ball;
      return {
        ...base,
        ms: d(1600),
        ball: [at, lerp(at, end, 0.3), end],
        actors: [
          { id: "lost", side: def, label: short(e.p2), path: [clampPt([at[0] - toward(def, 2), at[1]]), at, clampPt([at[0] - toward(def, 1), at[1] + 2])] },
          { id: "win", side, label: short(e.p), path: [clampPt([at[0] + toward(side, -5), at[1] + 4]), at, end] },
        ],
      };
    }
    case "shot": {
      const shotFrom = ball;
      return {
        ...base,
        ms: d(1300),
        ball: [prevBall, shotFrom, shotFrom],
        ballHeight: e.header ? [0.9, 0.6, 0.6] : [0, 0, 0],
        actors: [
          { id: "s", side: atk, label: short(e.p), path: [clampPt([shotFrom[0] - toward(atk, 3), shotFrom[1] + 1]), shotFrom, shotFrom] },
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
        impact: net,
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

/** Sample keyframes at t ∈ [0,1] with easing. */
export function sample(path: Pt[], t: number): Pt {
  if (path.length === 1) return path[0];
  const seg = path.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * seg;
  const i = Math.floor(x);
  const f = x - i;
  const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
  return lerp(path[i], path[i + 1], e);
}

export function sampleN(vals: number[] | undefined, t: number) {
  if (!vals || !vals.length) return 0;
  const seg = vals.length - 1;
  const x = Math.min(0.9999, Math.max(0, t)) * seg;
  const i = Math.floor(x);
  return vals[i] + (vals[i + 1] - vals[i]) * (x - i);
}
