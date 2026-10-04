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
  ms: number;
  ball: Pt[]; // keyframes over the scene (evenly spaced)
  ballHeight?: number[]; // optional lift per keyframe (0..1), for chips/crosses/headers
  actors: Actor[];
  caption: string;
  flash?: "goal" | "save" | "miss" | "wood" | "card" | "pen" | null;
  focus?: Side | null; // celebrating side
  side?: Side | null; // event side (banners)
  who?: string; // event's main player
  score?: [number, number]; // score after the event
  kick?: MatchEvent["kick"];
};

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
  return { key: `${e.seq}`, seq: e.seq, type: e.t, caption: e.text, flash: null as Scene["flash"], side: e.side ?? null, who: e.p, score: e.st?.sc, kick: e.kick };
}

/**
 * Build the scene for one event. `prevBall` is where the previous scene ended, so movement
 * connects across scene boundaries.
 */
export function sceneFor(e: MatchEvent, prevBall: Pt, minuteMs: number): Scene | null {
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
      return { ...base, ms: d(1600), ball: [[50, 32], [50, 32]], actors: [] }; // everyone walks back to the kick-off anchors
    case "kickoff":
    case "second_half":
    case "extra_time":
    case "et_second_half":
      return {
        ...base,
        ms: d(1600),
        ball: [[50, 32], [50, 32], clampPt([50 + toward(side, -10), 32 + jit(s, 1, 8)])],
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
      const lift = e.t === "cross" ? [0, 0.9, 0] : e.t === "through_ball" ? [0, 0.15, 0] : [0, 0, 0];
      const markerStart = clampPt([recv[0] + toward(atk, 6) + jit(s, 2, 3), recv[1] + jit(s, 3, 7)]);
      return {
        ...base,
        ms: d(run ? 2200 : e.t === "cross" ? 2000 : 1500),
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
      const run = (e.from as Pt) || prevBall;
      return {
        ...base,
        ms: d(1300),
        ball: [run, shotFrom, shotFrom],
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
      if (e.t === "penalty_goal" && e.pen) return penaltyScene(e, "goal", d);
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
        ms: d(3800, 1800),
        ball: [shotFrom, target, net, net, net],
        actors: [
          { id: "s", side: atk, label: short(e.p), path: [shotFrom, shotFrom, lerp(shotFrom, corner, 0.5), corner, corner] },
          { id: "gk", side: other(atk), keeper: true, label: short(e.p2), path: [gk, dive, dive, dive, gk] },
          { id: "t1", side: atk, path: [t1, t1, lerp(t1, m1, 0.5), m1, m1] },
          { id: "t2", side: atk, path: [t2, t2, lerp(t2, m2, 0.5), m2, m2] },
        ],
        flash: "goal",
        focus: atk,
      };
    }
    case "celebration": {
      // Ball stays in the net, banner stays up; the scorer and two mates hold the huddle by the corner flag.
      const [corner, m1, m2] = huddle(side, prevBall[1]);
      const bob = (p: Pt): Pt => [p[0], p[1] + (corner[1] > GOAL_Y ? -1 : 1)];
      return {
        ...base,
        ms: d(2000, 1500),
        ball: [prevBall],
        actors: [
          { id: "s", side, label: short(e.p), path: [corner, bob(corner), corner] },
          { id: "t1", side, path: [m1, lerp(m1, corner, 0.3), m1] },
          { id: "t2", side, path: [m2, lerp(m2, corner, 0.3), m2] },
        ],
        flash: "goal",
        focus: side,
      };
    }
    case "save": {
      // event side = defending team; shooter attacks the other way
      const shooterSide = other(side);
      const target = (e.target as Pt) || [goalX(shooterSide), GOAL_Y];
      const shotFrom = (e.from as Pt) || prevBall;
      const gk = keeperSpot(side);
      const catchPt: Pt = [gk[0], target[1]];
      const parry: Pt = clampPt([ball[0], ball[1] + (target[1] > GOAL_Y ? 6 : -6)]);
      return {
        ...base,
        ms: d(2600),
        ball: [shotFrom, lerp(shotFrom, catchPt, 0.85), catchPt, parry],
        actors: [
          { id: "gk", side, keeper: true, label: short(e.p), path: [gk, lerp(gk, catchPt, 0.7), catchPt, catchPt] },
          { id: "s", side: shooterSide, label: short(e.p2), path: [shotFrom, shotFrom, clampPt([shotFrom[0] + toward(shooterSide, 3), shotFrom[1]]), clampPt([shotFrom[0] + toward(shooterSide, 4), shotFrom[1]])] },
        ],
        flash: "save",
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
          { id: "b", side, label: short(e.p), path: [clampPt([blockAt[0] + toward(shooterSide, 3), blockAt[1] + 4]), blockAt, blockAt] },
          { id: "s", side: shooterSide, label: short(e.p2), path: [shotFrom, shotFrom, shotFrom] },
          { id: "gk", side, keeper: true, path: [keeperSpot(side), keeperSpot(side), keeperSpot(side)] },
        ],
        flash: "miss",
      };
    }
    case "woodwork":
    case "miss": {
      const target = (e.target as Pt) || [goalX(side), GOAL_Y + 10];
      const shotFrom = (e.from as Pt) || prevBall;
      const out: Pt = e.t === "woodwork" ? (ball as Pt) : [goalX(side) + toward(side, 3), target[1] + (target[1] > GOAL_Y ? 3 : -3)];
      const gk = keeperSpot(other(side));
      return {
        ...base,
        ms: d(2300),
        ball: [shotFrom, lerp(shotFrom, target, 0.6), target, out],
        ballHeight: e.t === "miss" && (e as MatchEvent & { high?: number }).high ? [0, 0.5, 1, 1] : undefined,
        actors: [
          { id: "s", side, label: short(e.p), path: [shotFrom, shotFrom, clampPt([shotFrom[0] + toward(side, 2), shotFrom[1]]), clampPt([shotFrom[0] + toward(side, 2), shotFrom[1]])] },
          { id: "gk", side: other(side), keeper: true, path: [gk, [gk[0], GOAL_Y + (target[1] - GOAL_Y) * 0.4], [gk[0], GOAL_Y + (target[1] - GOAL_Y) * 0.5], gk] },
        ],
        flash: e.t === "woodwork" ? "wood" : "miss",
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
      };
    }
    case "penalty_awarded": {
      const spot = (e.ball as Pt) || [goalX(side) + toward(side, -11), GOAL_Y];
      return {
        ...base,
        ms: d(2800, 1800),
        ball: [prevBall, spot, spot],
        actors: [
          { id: "fouled", side, label: short(e.p), path: [prevBall, clampPt([spot[0] + toward(side, 3), spot[1] + 2]), clampPt([spot[0] + toward(side, 3), spot[1] + 2])] },
          { id: "off", side: other(side), label: short(e.p2), path: [clampPt([spot[0] + toward(side, 6), spot[1] + 4]), clampPt([spot[0] + toward(side, 4), spot[1] + 3]), clampPt([spot[0] + toward(side, 4), spot[1] + 3])] },
          { id: "ref", side: "ref", path: [clampPt([spot[0] - toward(side, 10), spot[1] - 12]), clampPt([spot[0] - toward(side, 2), spot[1] - 6]), clampPt([spot[0] - toward(side, 1), spot[1] - 5])] },
        ],
        flash: "pen",
      };
    }
    case "penalty_setup":
    case "shootout_setup":
      return setupScene(e, d);
    case "penalty_saved":
    case "penalty_missed":
    case "penalty_woodwork":
      return e.pen ? penaltyScene(e, e.pen.outcome, d) : null;
    case "shootout_kick":
      return e.pen ? penaltyScene(e, e.pen.outcome, d) : null;
    default:
      return null; // period markers, coaching, shootout_start/end, match_end → caption only
  }
}

/** Shootouts are taken at one end (towards x=100) whichever team is kicking. */
function geomSide(e: MatchEvent, side: Side): Side {
  return e.t.startsWith("shootout") ? "home" : side;
}

/** Shooter waiting at the spot, keeper on the line. Same geometry in-match and in shootouts. */
function setupScene(e: MatchEvent, d: ReturnType<typeof pace>): Scene {
  const side = (e.side || "home") as Side;
  const def = other(side);
  const g = geomSide(e, side);
  const spot: Pt = [goalX(g) + toward(g, -11), GOAL_Y];
  const gk = keeperSpot(other(g));
  return {
    ...head(e),
    ms: d(2600, 1800),
    ball: [spot, spot],
    actors: [
      { id: "taker", side, label: short(e.p), path: [clampPt([spot[0] - toward(g, 8), spot[1] + 6]), clampPt([spot[0] - toward(g, 4), spot[1] + 3])] },
      { id: "gk", side: def, keeper: true, label: short(e.p2), path: [[gk[0], GOAL_Y - 1.5], [gk[0], GOAL_Y + 1.5]] },
    ],
    flash: "pen",
  };
}

/** Run-up, strike, ball path and keeper dive from the engine's penalty plan. */
function penaltyScene(e: MatchEvent, outcome: string, d: ReturnType<typeof pace>): Scene {
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
    flash = "miss";
  }
  const strikeAt: Pt = outcome === "save" ? [gk[0], diveY] : outcome === "woodwork" ? [line, pen.post === "bar" ? y : pen.post === "left" ? 28 : 36] : target;
  return {
    ...head(e),
    ms: d(3400, 1800),
    ball: [spot, spot, spot, strikeAt, end],
    ballHeight: pen.height === 2 || pen.post === "bar" ? [0, 0, 0, 1, 1] : pen.height === 1 ? [0, 0, 0, 0.5, 0.3] : undefined,
    actors: [
      { id: "taker", side, label: short(e.p), path: [runStart, lerp(runStart, spot, 0.5), clampPt([spot[0] - toward(g, 1), spot[1]]), spot, spot] },
      { id: "gk", side: def, keeper: true, label: short(e.p2), path: [gk, gk, gk, [gk[0], diveY], [gk[0], diveY]] },
    ],
    flash,
    focus: outcome === "goal" ? side : outcome === "save" ? def : null,
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
