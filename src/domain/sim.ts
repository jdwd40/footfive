/**
 * Full 5-v-5 frame: maps a Scene's named actors onto real lineup players and parks the rest
 * at formation anchors drifted toward the ball, so all 10 players are always on the pitch.
 */
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";
import { goalX, sample, sampleN, seqHash, short, type Actor, type Pt, type Scene } from "./scenes";
import { crossBend, keeperPose, moveFx, type Fx, type KeeperPose } from "./moves";

export type Player = { side: Side; name: string; no: number; gk: boolean; x: number; y: number; hot: boolean /* named in the event */ };
export type RefPose = "run" | "whistle" | "point" | "card-yellow" | "card-red";
export type Frame = { ball: Pt; lift: number; players: Player[]; carrier?: string | null /* side:no, candidate only: renderer also requires drawn contact */; won?: Side | null /* WON IT cue: the challenge winner's side, for WON_MS from the moment he has the ball */; ref: Pt /* referee: his actor path, else trailing play */; refPose?: RefPose; refAim?: Pt /* canonical target: offender, free-kick direction or penalty spot */; caption: string; flash: Scene["flash"]; type: string; seq: number; p: number; runs?: string[] /* #189: side:no of attackers running from where they were drawn: smooth gives them the cross's sprint */; fx?: Fx /* #205: this move's signature (one at a time) */; keeper?: KeeperPose /* #205: a result scene's dive or claim */ } & Pick<Scene, "ms" | "side" | "who" | "score" | "kick" | "pens" | "flashAt" | "by" | "phase" | "tempo">;
export type Lineups = { home: LineupPlayer[]; away: LineupPlayer[] };
/** #189: where each player (side:no) was drawn on a scene's first tick, so its runners start from there. */
export type PlayerStarts = Readonly<Record<string, Pt>>;

// Home anchors; mirror x for away. GK first, then D, D, F, F by starter order.
const ANCHORS: Pt[] = [
  [4, 32],
  [20, 20],
  [20, 44],
  [42, 24],
  [42, 40],
];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** #184: an attacking forward off the ball stays at least this far ahead of it, and this far to one side of its lane. */
export const FWD_LEAD = 12;
export const FWD_WIDTH = 14;
/** #189: with the ball wide, the inner forward attacks the box this far past the goal's centre line. */
export const FWD_BOX = 4;
/** #213: a defending forward off the ball holds at least this far upfield of it (and FWD_WIDTH to one side of its lane). */
export const SCREEN_LEAD = 9;
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
export function shapeAt(i: number, bx: number, by: number, attacking: boolean, defending = false): Pt {
  const [ax, ay] = ANCHORS[i];
  const fwd = i >= 3;
  if (attacking) {
    const push = (bx - 30) * (fwd ? 0.75 : 0.6); // the block moves up with the ball
    const x = clamp(ax + Math.max(0, push) + Math.min(0, push) * 0.4, 4, fwd ? 94 : Math.max(8, bx - 4));
    // #184: the forwards make the runs — a pass ahead of the ball and wide of its lane, one either side — so the support is out
    // in space rather than round the ball; each moves smoothly with it. The defenders below keep their lanes behind the ball.
    // #189: with the ball wide, the outer one holds the touchline (the clamp) and the inner one attacks the box beyond the goal's centre.
    if (fwd) {
      const w = Math.max(FWD_WIDTH, Math.abs(32 - by) + FWD_BOX);
      return [clamp(Math.max(x, bx + FWD_LEAD), 4, 94), clamp(by + (i === 3 ? -w : w), 4, 60)];
    }
    // Off the ball (#103): the supporting defenders find space — nobody stands in the carrier's lane.
    let y = ay + (by - ay) * 0.25;
    if (Math.abs(y - by) < 9) y = by + (y >= by ? 9 : -9);
    if (y < 4 || y > 60) y = by + (y < by ? 9 : -9);
    // #189: the far-side one is the wide outlet — the further the ball is over the other side, the closer he holds his own touchline.
    y += clamp(((32 - by) * Math.sign(ay - 32)) / 16, 0, 1) * ((ay > 32 ? 58 : 6) - y);
    return [x, clamp(y, 2, 62)];
  }
  if (defending) {
    // Off the ball (#103): defenders track goal-side of the ball and squeeze across to it (#189: a third of the way, not half, so the
    // block keeps its width). #213: the forwards screen the lanes either side of it, a little upfield, as the attacking ones run
    // (#184) — not on the ball's spot, where they crowded round the carrier with the defenders once play reached their half.
    if (fwd) {
      const w = Math.max(FWD_WIDTH, Math.abs(32 - by) + FWD_BOX);
      return [clamp(Math.max(ax + (bx - ax) * 0.5, bx + SCREEN_LEAD), 6, 94), clamp(by + (i === 3 ? -w : w), 4, 60)];
    }
    const x = clamp(Math.min(ax + (bx - ax) * 0.45, bx - 5), 4, 80);
    const y = ay + (by - ay) * 0.3;
    return [x, clamp(y, 2, 62)];
  }
  return [clamp(ax + (bx - ax) * 0.3, 1, 99), clamp(ay + (by - ay) * 0.3, 2, 62)];
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
  const layoff = scene.actors.some((a) => a.id === "l");
  const blend = (path: Pt[]): Pt[] => {
    // #214: a backward pass's lay-off man (FF-69) keeps his touch a hold however far the dwell left the ball (a switch of play: the
    // far wing): the held keyframes take the weight of the last of them, so the offset goes in the leg to him, the release unchanged.
    const n = path.length - 1;
    const last = path.map((_, i) => i);
    if (layoff) for (let i = n - 1; i >= 1; i--) if (path[i][0] === path[i + 1][0] && path[i][1] === path[i + 1][1]) last[i] = last[i + 1];
    return path.map(([x, y], i) => {
      const w = n ? 1 - last[i] / n : 1;
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

/** #189: formation slots go by role, not squad order — defenders take the back two, attackers the front two (unknown: util). */
const ROLE_RANK = new Map([["def", 0], ["util", 1], ["mid", 2], ["att", 3]]); // a Map: no inherited keys ("constructor", "__proto__")
const rank = (p: LineupPlayer) => ROLE_RANK.get(p.role) ?? 1;
function starters(list: LineupPlayer[], side: Side, sentOff?: Set<string>) {
  const live = list.filter((p) => p.starter && !sentOff?.has(side + ":" + p.name));
  const gk = live.find((p) => p.role === "gk") ?? live[0];
  return gk ? [gk, ...live.filter((p) => p !== gk).slice(0, 4).sort((a, b) => rank(a) - rank(b))] : [];
}

/** Result badges that outlive their scene: SAVED!, WOODWORK, WIDE/OVER/BLOCKED and every shootout reveal stay 2.5 s (real ms) after that scene ends, and only into a next scene that actually starts inside that window. Match goals have the banner, cards their own type-specific text. */
export const LINGER_MS = 2500;
/** WON IT stays this long (real ms, into the winner's dwell) from the moment the challenge winner has the ball. */
export const WON_MS = 1500;
const LINGERING = new Set(["save", "wood", "miss", "over", "block"]);
function lingers(prev: Scene | undefined, scene: Scene, t: number) {
  return !!prev?.flash && !scene.flash && scene.ms > 0 && t * scene.ms < LINGER_MS && (prev.type === "shootout_kick" || LINGERING.has(prev.flash));
}

/** Small result chips only. A goal, celebration or card keeps its own flash for the whole scene. */
function transientFlash(scene: Scene): boolean {
  return !!scene.flash && (scene.type === "shootout_kick" || LINGERING.has(scene.flash));
}

/**
 * Dwell choreography (#214): between engine events routine play drives on. The carrier jogs forward and every DWELL_CYCLE lays it off
 * diagonally forward — to the other lane, now and then to a wide man overlapping him on the outside, occasionally switching play to
 * the far wing — and the receiver carries on. The team's shape moves up with the ball. Positions are a pure function of the dwell
 * clock (the schedule is replayed from the start each frame), so a frame never depends on the one before it.
 */
export const DWELL_SPEED = 5.5; // units per second carried (≈ a jog on a 40 m pitch); a slow phase (×0.7) still makes visible ground
export const DWELL_CARRY = 1500; // ms the holder carries it before each lay-off
export const DWELL_PASS = 650; // ms a lay-off takes: a rolled pass (≈ 30 units/s at its quickest), not a flick, so one cut short by the next event leaves the ball nearly still
const DWELL_SWITCH_MS = 1800; // ms a switch of play to the far wing hangs in the air (a long, lifted ball)
export const DWELL_CYCLE = DWELL_CARRY + DWELL_PASS;
/** Forward ground a lay-off gains (a switch of play gains a little more): every lay-off goes diagonally forward, never square. */
export const DWELL_LAYOFF = 4;
const DWELL_SWITCH_GAIN = 6;
/** #189: lateral gap between the two lanes, and how far in front the closing marker stands. */
export const DWELL_LANE = 12;
export const DWELL_MARK = 6;
/** An overlapping run goes this far outside the carrier's lane. */
export const DWELL_OVERLAP = 8;
/** A switch of play lands on the far wing at this y (y < 12 or > 52). */
export const DWELL_WING: readonly [number, number] = [8, 56];
/** The next event starts where this scene left the ball, so whatever ground the dwell gains is given back at the transition (the
 * next scene is re-routed from the drawn ball into its own destination: no snap). The advance is therefore bounded, not timed: at
 * most DWELL_ADVANCE (approached smoothly, never passed) and never beyond the attacking side's DWELL_LINE (x70 for home, x30 for
 * away) — DWELL_LINE_ATT (x76, short of the D and the box at x85) for a side whose ball is already in the opposition half — so nobody
 * runs into the box ahead of a midfield or build-up event. After that the lay-offs go on where they are, however late the next event. */
export const DWELL_ADVANCE = 14;
export const DWELL_LINE = 70;
export const DWELL_LINE_ATT = 76;
/** ms over which a player leaving a dwell role (or a scene's actor once it ends) eases back into the team's shape. */
const DWELL_RELEASE = 1200;
/** Ground made of the dwell's distance budget `d`, within `room`: full pace to three quarters of it, then easing to a stop at `room`. */
function dwellGain(d: number, room: number) {
  if (room <= 0) return 0;
  const u = d / room;
  return room * (u <= 0.75 ? u : u >= 1.25 ? 1 : 0.75 + (u - 0.75) - (u - 0.75) ** 2);
}
const easeIO = (f: number) => (f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f));
const lerpPt = (a: Pt, b: Pt, f: number): Pt => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
type LayOff = "diag" | "overlap" | "switch";
type DwellCycle = { t0: number; carryEnd: number; end: number; d0: number; dCarry: number; dEnd: number; kind: LayOff | null; holder: string; y0: number; recv: string | null; y1: number; marker: string | null; markerSince: number };
const shapeMap = (ps: Player[]) => new Map(ps.map((p): [string, Pt] => [p.side + ":" + p.no, [p.x, p.y]]));
/**
 * The dwell's schedule up to `over` (dwell-clock ms): who holds it, each lay-off's kind, lanes and receiver, the closing marker, and
 * where the ball is. `players` is the frame as the scene ended (its actors on their end spots). Receivers and markers are picked
 * from where the players stood then, moved on with the ball — so a pick never depends on the frame being drawn.
 */
function dwell(scene: Scene, b: Pt, over: number, players: Player[]) {
  const side = scene.side!;
  const dir = side === "home" ? 1 : -1;
  const a0 = dir > 0 ? b[0] : 100 - b[0];
  const room = clamp((a0 >= 50 ? DWELL_LINE_ATT : DWELL_LINE) - a0, 0, DWELL_ADVANCE); // a ball already past the line is carried neither on nor back
  const xAt = (dist: number) => b[0] + dir * dwellGain(dist, room);
  const key = (p: Player) => p.side + ":" + p.no;
  const ref = shapeMap(players);
  const mates = players.filter((p) => p.side === side && !p.gk).map(key);
  const opps = players.filter((p) => p.side !== side && !p.gk).map(key);
  const released = new Map<string, { at: number; spot: Pt }>();
  for (const p of players) if (p.hot) released.set(key(p), { at: 0, spot: [p.x, p.y] });
  const guess = (k: string, tau: number, shift: number): Pt => {
    const r = ref.get(k)!;
    const home: Pt = [r[0] + shift, r[1]];
    const rel = released.get(k);
    return rel ? lerpPt(rel.spot, home, easeIO((tau - rel.at) / DWELL_RELEASE)) : home;
  };
  const nearest = (cands: string[], to: Pt, tau: number, shift: number) => {
    let best: string | null = null;
    let bd = Infinity;
    for (const k of cands) {
      const [x, y] = guess(k, tau, shift);
      const dd = Math.hypot(x - to[0], y - to[1]);
      if (dd < bd) [best, bd] = [k, dd];
    }
    return best;
  };
  let holder = nearest(mates, b, 0, 0) ?? "";
  let t0 = 0;
  let d0 = 0;
  let y0 = b[1];
  let prevKind: LayOff | null = null;
  let marker: string | null = null;
  let markerSince = 0;
  let cy: DwellCycle;
  for (let k = 0; ; k++) {
    const carryEnd = t0 + DWELL_CARRY;
    const dCarry = d0 + (DWELL_SPEED * DWELL_CARRY) / 1000;
    const shift = xAt(d0) - b[0];
    const out = y0 > 32 ? 1 : -1; // towards the nearer touchline
    const wing = y0 > 32 ? DWELL_WING[0] : DWELL_WING[1];
    const h = seqHash(scene.seq, 214 + k);
    // Mostly a lay-off to the other lane; often an overlap round the outside when there is room; now and then a switch of play.
    const others = mates.filter((m) => m !== holder);
    const behind = others.filter((m) => dir * (guess(m, t0, shift)[0] - xAt(d0)) < -2); // an overlap comes from behind the carrier
    const kind: LayOff = h < 0.18 && prevKind !== "switch" && Math.abs(wing - y0) >= 30 ? "switch" : h < 0.5 && behind.length && Math.abs(y0 + out * DWELL_OVERLAP - 32) <= 28 ? "overlap" : "diag";
    const y1: number = kind === "switch" ? wing : kind === "overlap" ? y0 + out * DWELL_OVERLAP : clamp(y0 + (Math.abs(y0 + out * DWELL_LANE - 32) <= 28 ? out : -out) * DWELL_LANE, 2, 62);
    const dEnd: number = dCarry + (kind === "switch" ? DWELL_SWITCH_GAIN : DWELL_LAYOFF);
    const look: Pt = kind === "overlap" ? [xAt(d0) - dir * 6, y0 + out * (DWELL_OVERLAP + 2)] : [xAt(dEnd), y1];
    const recv = nearest(kind === "overlap" ? behind : others, look, t0, shift);
    const mk = nearest(opps, [xAt(d0), y0], t0, shift);
    if (mk !== marker) {
      if (marker) released.set(marker, { at: t0, spot: [xAt(d0) + dir * DWELL_MARK, y0] });
      [marker, markerSince] = [mk, t0];
    }
    const end: number = recv ? carryEnd + (kind === "switch" ? DWELL_SWITCH_MS : DWELL_PASS) : Infinity; // nobody to lay it off to: he carries on
    cy = { t0, carryEnd, end, d0, dCarry, dEnd, kind: recv ? kind : null, holder, y0, recv, y1: recv ? y1 : y0, marker, markerSince };
    if (over < end) break;
    released.set(holder, { at: carryEnd, spot: [xAt(dCarry) - dir * 0.8, y0] });
    released.delete(recv!);
    [holder, t0, d0, y0, prevKind] = [recv!, end, dEnd, y1, kind];
  }
  const inPass = !!cy.kind && over >= cy.carryEnd;
  let ball: Pt;
  let lift: number | null = null;
  if (!inPass) {
    const u = (over - cy.t0) / DWELL_CARRY;
    ball = [xAt(cy.d0 + (DWELL_SPEED * (over - cy.t0)) / 1000), cy.y0 + (cy.y0 > 32 ? -1 : 1) * 1.2 * Math.sin(Math.PI * u)]; // a gentle weave in from the line
  } else {
    released.set(cy.holder, { at: cy.carryEnd, spot: [xAt(cy.dCarry) - dir * 0.8, cy.y0] });
    const f = (over - cy.carryEnd) / (cy.end - cy.carryEnd);
    const e = f * (1.5 - 0.5 * f); // struck, then rolling on into the receiver's stride (still moving at about his carrying pace)
    ball = [xAt(cy.dCarry + (cy.dEnd - cy.dCarry) * e), cy.y0 + (cy.y1 - cy.y0) * e];
    if (cy.kind === "switch") lift = 0.6 * Math.sin(Math.PI * f);
  }
  ball = [clamp(ball[0], 0, 100), clamp(ball[1], 2, 62)];
  return { ball, ballT0: [xAt(cy.d0), cy.y0] as Pt, lift, cy, inPass, dir, released, xAt, reception: [xAt(cy.dEnd) - dir * 0.8, cy.y1] as Pt };
}
/** Idle drift: amplitude (units) and time constant (ms per radian); peak speed IDLE_AMP / IDLE_TAU ≈ 0.6 units/s. */
export const IDLE_AMP = 0.6;
export const IDLE_TAU = 1000;
/** #105: dwell clock rate by tempo — a fast phase moves it on quicker, a slow one keeps it longer (same bounded advance). */
export const dwellRate = (tempo?: Scene["tempo"]) => (tempo === "fast" ? 1.5 : tempo === "slow" ? 0.7 : 1);

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
      if (scene.touch === "carry" || scene.touch === "hold") return t <= 0.48 ? "p" : t >= 0.97 ? "r" : null; // on the ball until the release (#104)
      return scene.type === "dribble" ? "p" : t <= 0.08 ? "p" : t >= 0.97 ? "r" : null;
    }
    case "tackle": case "interception": return t >= (scene.won ?? 0.5) ? "win" : t <= (scene.type === "tackle" ? 0.45 : 0.08) ? "lost" : null;
    case "save": return t >= 2 / 3 ? "gk" : null;
    case "block": return t >= 0.5 ? "b" : null;
    case "woodwork": return t >= 0.97 ? "gk" : null;
    case "bounce": return t >= 0.8 ? "c" : null;
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
 * `startPlayers`: where everyone was drawn as this scene began (#189): its receiver, runner and marker run from there.
 */
export function frameAt(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>, nowMs = 0, startBall?: Pt, prevScene?: Scene, elapsedMs?: number, startPlayers?: PlayerStarts): Frame {
  const routed = startBall ? fromStart(scene, startBall) : scene;
  const bridged = startPlayers ? bridge(scene, routed, startPlayers, lineups, sentOff) : null;
  const { ball: b, players, unlabelled, ref } = layout(bridged?.scene ?? routed, t, lineups, sentOff);
  const ball: Pt = [b[0], b[1]]; // copy: sample() may hand back the scene's own keyframe
  if (scene.type === "cross") {
    // #205: the delivery curls in (a bend in flight only: the winger's spot and the drop are untouched).
    const [bx, by] = crossBend(scene, t, routed);
    ball[0] += bx;
    ball[1] += by;
  }
  const bind = binding(scene, lineups, sentOff);
  for (const a of unlabelled) {
    const q = players.find((p) => p.side + ":" + p.no === bind[a.id] && !p.hot);
    if (q) place(q, a, t);
  }
  const actor = scene.actors.find(a => a.id === carrierActor(scene, t));
  const owner = actor && players.find(p => p.side === actor.side && (actor.keeper ? p.gk : actor.label ? short(p.name) === actor.label : p.side + ":" + p.no === bind[actor.id]));
  let carrier = owner ? owner.side + ":" + owner.no : null;
  const pinned = new Set<Player>(); // #184: the dwell's own movers, kept out of the spacing like the scene's actors
  const rawOver = Math.max(0, t - 1) * scene.ms;
  let dwellLift: number | null = null;
  if (rawOver > 0 && !scene.flash && scene.side && DWELL.has(scene.type)) {
    // #105: a fast phase keeps running and moves it on quicker, a slow one jogs and keeps it longer (same bounded advance).
    const over = rawOver * dwellRate(scene.tempo);
    const d = dwell(scene, b, over, players);
    [ball[0], ball[1]] = d.ball;
    dwellLift = d.lift;
    // The block moves up with the ball (#102 shape keyed on the dwell's ball, not the scene's end); the scene's actors and anyone
    // leaving a dwell role ease back into it from where they were.
    // The two supporting defenders of the side on the ball keep the lateral spot they had as the scene ended: their #103 rule (out of
    // the carrier's lane) jumps them 18 across whenever the ball crosses their line, and the dwell's lay-offs cross it all the time.
    const holdY = new Map([...shapeMap(layout(routed, t, lineups, sentOff, b).players)].filter(([k]) => k.startsWith(scene.side + ":")).filter((_, i) => i === 1 || i === 2));
    const shapeFor = (at: Pt) => {
      const m = shapeMap(layout(routed, t, lineups, sentOff, at).players);
      for (const [k, [, y]] of holdY) m.set(k, [m.get(k)![0], y]);
      return m;
    };
    const shapeNow = shapeFor(d.ball);
    const shapeT0 = shapeFor(d.ballT0);
    const base = (k: string, tau: number, shape: Map<string, Pt>): Pt => {
      const home = shape.get(k)!;
      const rel = d.released.get(k);
      return rel ? lerpPt(rel.spot, home, easeIO((tau - rel.at) / DWELL_RELEASE)) : home;
    };
    const byKey = new Map(players.map((p) => [p.side + ":" + p.no, p]));
    for (const [k, p] of byKey) if (shapeNow.has(k)) [p.x, p.y] = base(k, over, shapeNow);
    const { cy, inPass, dir } = d;
    const holder = byKey.get(cy.holder);
    const recv = cy.recv ? byKey.get(cy.recv) : undefined;
    const marker = cy.marker ? byKey.get(cy.marker) : undefined;
    if (holder && !inPass) Object.assign(holder, { x: clamp(ball[0] - dir * 0.8, 0, 100), y: ball[1], hot: true });
    if (holder && inPass) holder.hot = false;
    if (recv) {
      const start = base(cy.recv!, cy.t0, shapeT0);
      const u = (over - cy.t0) / DWELL_CARRY;
      // The overlap: from behind the carrier, round him on the outside, onto the ball ahead of him.
      const path: Pt[] = cy.kind === "overlap" ? [start, [d.xAt(cy.d0 + (DWELL_SPEED * DWELL_CARRY) / 2000) - dir * 2.5, cy.y1], d.reception] : [start, d.reception];
      const [x, y] = inPass ? d.reception : sample(path, u);
      Object.assign(recv, { x: clamp(x, 0, 100), y: clamp(y, 0, 64), hot: inPass });
    }
    if (marker) {
      // The nearest opponent as the holder gets it closes down over 1.2 s, then tracks DWELL_MARK in front of the ball.
      const [mx, my] = lerpPt([marker.x, marker.y], [ball[0] + dir * DWELL_MARK, ball[1]], easeIO((over - cy.markerSince) / 1200));
      marker.x = clamp(mx, 0, 100);
      marker.y = clamp(my, 0, 64);
    }
    carrier = holder && !inPass ? cy.holder : null;
    for (const p of [holder, recv, marker]) if (p) pinned.add(p);
  } else if (t >= 1 && nowMs) {
    // Idle drift (#106): scene over, nothing newer yet — players ease slowly about their spot (a 6 s cycle, never an on-the-spot
    // wobble), the ball stays where it was, so the frame never looks frozen and nothing jitters.
    for (const p of players) {
      const ph = p.no * 1.7 + (p.side === "away" ? 0.9 : 0);
      p.x += Math.sin(nowMs / IDLE_TAU + ph) * IDLE_AMP;
      p.y += Math.cos(nowMs / IDLE_TAU + ph) * IDLE_AMP * 0.5;
    }
  }
  // Open play only: walks, penalties and the shootout (every scene with a set-piece window) keep their choreography.
  if (!scene.cam && !WALK_OFF.has(scene.type) && !WALK_ON.has(scene.type)) spaceOut(players, pinned, possession(scene) ?? "home");
  const ownMs = elapsedMs != null ? elapsedMs : t * scene.ms;
  const ownFlash = scene.flash && (!transientFlash(scene) || ownMs < scene.ms + LINGER_MS) ? scene.flash : null;
  const flash = lingers(prevScene, scene, t) ? prevScene!.flash! : ownFlash;
  const sinceWon = scene.won !== undefined ? (elapsedMs ?? t * scene.ms) - scene.won * scene.ms : -1;
  const won = scene.side && sinceWon >= 0 && sinceWon < WON_MS ? scene.side : null;
  // No ref actor: he trails play — ten behind the ball, and on the half of the pitch the ball is not on, sliding smoothly
  // through the middle (no side flip when the ball crosses the centre line) — so he is always on the pitch and only ever jogs (smooth) into a scene.
  const home: Pt = [clamp(ball[0] - (scene.side === "away" ? -10 : 10), 0, 100), clamp(32 + (32 - ball[1]) * 0.6, 0, 64)];
  let refPt = ref ?? home;
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
    // line in two rows (70–100 %). The ref is at the spot. The view stays on the full pitch throughout (#203: no camera zoom).
    const seg = (a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)));
    const lineGk = other(scene.side); // faces the first kick
    for (const side of ["home", "away"] as Side[]) {
      players.filter((p) => p.side === side).forEach((p, i) => {
        const ang = (Math.PI * (i - 2)) / 6 + (side === "home" ? Math.PI : 0); // five on a ±60° arc, home facing away across the spot
        const ring: Pt = [50 + 6 * Math.cos(ang), 32 + 6 * Math.sin(ang)];
        const end: Pt = p.gk ? [97, side === lineGk ? 32 : 39] : [side === "home" ? 56 : 60, 17 + i * 6]; // inside the penalty window (x ≥ 48 + label margin)
        [p.x, p.y] = t < 0.35 ? sample([[p.x, p.y], ring], seg(0, 0.35)) : t < 0.7 ? ring : sample([ring, end], seg(0.7, 1));
      });
    }
    refPt = [86, 19]; // beside the box, where setupScene / penaltyScene keep him (penRefSpot("home"))
  }
  const runs = bridged && t <= 1 && bridged.runs.length ? { runs: bridged.runs } : {};
  // #205: the move's signature and the keeper's pose, from this scene alone (a shot's frames cannot depend on its result).
  const keyOf = (id: string) => {
    const a = scene.actors.find((x) => x.id === id);
    const p = a && a.side !== "ref" && players.find((q) => q.side === a.side && (a.keeper ? q.gk : a.label ? short(q.name) === a.label : q.side + ":" + q.no === bind[a.id]));
    return p ? p.side + ":" + p.no : undefined;
  };
  const fx = moveFx(scene, t, keyOf, routed);
  const keeper = keeperPose(scene, t);
  // Signals last through the final frame too: reduced motion already renders t = 1 without smoothing.
  let refPose: RefPose = "run";
  let refAim: Pt | undefined;
  if ((scene.type === "yellow_card" || scene.type === "red_card") && t >= 0.4) {
    refPose = scene.type === "yellow_card" ? "card-yellow" : "card-red";
    const offender = scene.actors.find(a => a.id === "o");
    refAim = offender ? sample(offender.path, t) : ball;
  } else if (scene.type === "foul") {
    refPose = t < 0.4 ? "whistle" : "point";
    refAim = [goalX(other(scene.side)), 32]; // foul.side is the offender, not the side taking the free kick
  } else if (scene.type === "penalty_awarded" && t >= 0.3) {
    refPose = "point";
    refAim = scene.impact; // the actual penalty spot, including the mirrored away end
  }
  return { ball, lift: dwellLift ?? sampleN(scene.ballHeight, t), players, carrier, won, ref: refPt, refPose, refAim, caption: scene.caption, flash, type: scene.type, seq: scene.seq, p: Math.min(1, t), ms: scene.ms, side: scene.side, who: scene.who, score: scene.score, kick: scene.kick, pens: scene.pens, flashAt: scene.flashAt, by: scene.by, phase: scene.phase, tempo: scene.tempo, ...runs, ...(fx ? { fx } : {}), ...(keeper ? { keeper } : {}) };
}

/** #189: scenes whose receiver/runner (`r`, a cross's `h`) and marker (`m`) run from where they were drawn. Turnover contests (`lost`) and
 * keeper distributions (`clear`) keep their own choreography; the passer, keepers, the ref and challenge paths never move. */
const BRIDGED = new Set(["pass", "through_ball", "cross"]);
const RUNNERS = new Set(["r", "h", "m"]);
function bridge(scene: Scene, routed: Scene, starts: PlayerStarts, lineups: Lineups | null, sentOff?: Set<string>) {
  if (!BRIDGED.has(scene.type) || scene.actors.some((a) => a.id === "lost" || a.id === "clear")) return null;
  const bind = binding(scene, lineups, sentOff);
  const key = (a: Actor) => {
    if (a.side === "ref") return undefined;
    const side = a.side;
    if (!a.label) return bind[a.id];
    const p = starters(lineups?.[side] ?? [], side, sentOff).find((q) => short(q.name) === a.label);
    return p && side + ":" + p.no;
  };
  const runs: string[] = [];
  const actors = routed.actors.map((a) => {
    const k = RUNNERS.has(a.id) && !a.keeper ? key(a) : undefined;
    const from = k ? starts[k] : undefined;
    if (!k || !from) return a;
    if (a.side === scene.side && a.id !== "m") runs.push(k); // the attackers sprint; the marker keeps the ordinary chase
    return { ...a, path: runIn(a.path, from, routed.ball, scene.type === "through_ball" && a.id === "r" ? scene.ms : 0) };
  });
  return { scene: { ...routed, actors }, runs };
}
/** #190: progress along a through-ball runner's straight race at evenly spaced keyframes: front-loaded, ending on his contact. */
const RACE = [0, 0.35, 0.62, 0.82, 0.94, 1];
/** #190: units/s on average (60 % of the 120 sprint) above which a through-ball runner's run-in races instead. */
const RACE_SPEED = 72;
/** #189: `path` from `from`: the offset fades out over the keyframes before the actor's first contact with the ball (else his last
 * keyframe), so he runs straight there rather than via his authored start, and that contact, his endpoint and the ball are untouched. */
function runIn(path: Pt[], from: Pt, ball: Pt[], raceMs = 0): Pt[] {
  const n = path.length - 1;
  if (!n) return path;
  let c = n;
  for (let i = 1; i < n; i++) {
    const [bx, by] = sample(ball, i / n);
    if (Math.hypot(path[i][0] - bx, path[i][1] - by) <= CONTACT) {
      c = i;
      break;
    }
  }
  // #190: a through ball's runner meets it at the end of a short scene. From far off (more than RACE_SPEED on average) the eased
  // run-in would leave him behind it, so he races straight at that contact instead, most of the way early: `sample` eases only the
  // first and last stretches, and the drawing's sprint cap still holds. Nearer, the run-in below arrives with the ball.
  const [cx, cy] = path[n];
  if (raceMs && c === n && Math.hypot(cx - from[0], cy - from[1]) > (RACE_SPEED * raceMs) / 1000) return RACE.map((f): Pt => [from[0] + (cx - from[0]) * f, from[1] + (cy - from[1]) * f]);
  const dx = from[0] - path[0][0];
  const dy = from[1] - path[0][1];
  return path.map(([x, y], i): Pt => (i < c ? [x + dx * (1 - i / c), y + dy * (1 - i / c)] : [x, y]));
}

/** Formation players drifted toward the ball, named actors placed; unlabelled actors returned for binding. */
function layout(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>, at?: Pt) {
  const ball = at ?? sample(scene.ball, t); // `at`: the bare shape round that ball instead (no actors, no set piece) — the dwell's
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
        const [sx, sy] = shapeAt(Math.min(i, 4), own(b[0]), b[1], poss === side && side !== backOff, !!poss && poss !== side && side !== backOff);
        x = own(sx);
        y = sy;
      }
      players.push({ side, name: p.name, no: p.no, gk, x, y, hot: false });
    });
  }
  if (at) return { ball, players, unlabelled: [] as Actor[], ref: undefined };
  // Penalty: everyone who isn't taking or saving lines the edge of the D, home and away alternating.
  if (scene.cam && PEN_ARC.has(scene.type)) {
    const x = scene.cam[0] + scene.cam[2] / 2 > 50 ? 80 : 20; // which end the set-piece window is at
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

/** #184: the room a formation player keeps from everyone else (two kits touch at 2.9; #189: 6, was 4). */
export const GAP = 6;
/**
 * Two shapes keyed off one ball stack opposite numbers on the same spot. Each formation outfielder (not an actor, keeper or
 * pinned dwell mover) steps away from everyone already placed who is nearer than GAP — half the shortfall from each of them at
 * once, a fixed few rounds, so one neighbour is left at GAP. Whatever cancels out (squeezed between two) takes him goal-side
 * instead, out of the squeeze. The possession side goes first, each side in starter order: deterministic, and it moves smoothly
 * with the ball. Actors, keepers, the ball and the ref never move.
 */
export function spaceOut(players: Player[], pinned: Set<Player>, first: Side) {
  const fixed = players.filter((p) => p.gk || p.hot || pinned.has(p));
  const free = players.filter((p) => !fixed.includes(p)).sort((p, q) => Number(p.side !== first) - Number(q.side !== first));
  for (const p of free) {
    const goalSide = p.side === "home" ? -1 : 1;
    for (let round = 0; round < 8; round++) {
      let dx = 0;
      let dy = 0;
      let need = 0;
      for (const q of fixed) {
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d >= GAP) continue;
        const [ux, uy] = d > 1e-6 ? [(p.x - q.x) / d, (p.y - q.y) / d] : [goalSide, 0]; // exactly on him: goal-side
        dx += (ux * (GAP - d)) / 2;
        dy += (uy * (GAP - d)) / 2;
        need += (GAP - d) / 2;
      }
      if (!need) break;
      dx += goalSide * (need - Math.hypot(dx, dy));
      p.x = clamp(p.x + dx, 1, 99);
      p.y = clamp(p.y + dy, 2, 62);
    }
    fixed.push(p);
  }
}

/** Rendered frame chases the target: exponential approach per value, players and the ref speed-capped so nobody teleports. A gap over a second (suspended tab) snaps instead: nothing to chase from. In open play the ref ignores small target shifts; officiating targets settle promptly at the same walking speed. */
const MAX_SPEED = 60; // units per second
const REF_SPEED = 14;
const REF_DEADBAND = 4; // units: a target this close is "where he already is"
/** #184: the carrier ring's contact reach (Pitch); within it, on the ground, the carrier is on the ball. */
const CONTACT = 1.6;
export function smooth(prev: Frame | null, target: Frame, dtMs: number): Frame {
  if (!prev || dtMs > 1000) return target;
  dtMs = Math.min(100, dtMs); // a stutter still reads as a chase, not a jump
  const k = (tau: number) => 1 - Math.exp(-dtMs / tau);
  const kb = k(90);
  const tempo = target.tempo === "fast" ? 0.65 : target.tempo === "slow" ? 1.45 : 1; // #105: fast phases sprint, slow ones jog
  const kp = k(220 * tempo);
  const runSpeed = MAX_SPEED / tempo;
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
    // #189: so do the attackers running from where they were drawn (`runs`), or they arrive after the ball.
    const crossSprint = (target.type === "cross" && p.hot && p.side === target.side) || !!target.runs?.includes(p.side + ":" + p.no);
    // #190: a through ball's runner races onto it and his marker chases, a step slower; the passer (and keepers) keep the ordinary chase.
    const through = target.type === "through_ball" && target.p < 1 && p.hot && !p.gk ? (p.side !== target.side ? "mark" : short(p.name) !== short(target.who) ? "run" : null) : null;
    // #184: the carrier with the ball at his feet (on the ground, within contact in the target, and already drawn by it) keeps the
    // ball's pace, so the drawn ball stays there. Flights have no carrier and a carrier still running in keeps the ordinary chase.
    // Capped at the sprint speed: never a teleport.
    const onBall = target.carrier === p.side + ":" + p.no && target.lift < 0.05 && Math.hypot(p.x - target.ball[0], p.y - target.ball[1]) <= CONTACT && Math.hypot(q.x - prev.ball[0], q.y - prev.ball[1]) <= 2 * CONTACT;
    const [x, y] = chase(q.x, q.y, p.x, p.y, onBall ? kb : crossSprint || through === "run" ? k(70) : through === "mark" ? k(110) : kp, onBall || crossSprint || through === "run" ? 120 : through === "mark" ? 100 : runSpeed);
    return { ...p, x, y };
  });
  const ball: Pt = [prev.ball[0] + (target.ball[0] - prev.ball[0]) * kb, prev.ball[1] + (target.ball[1] - prev.ball[1]) * kb];
  // A four-unit deadband would leave an officiating ref too far from the offender. Only his settling changes; speed stays capped.
  const officiating = target.type === "foul" || target.type === "yellow_card" || target.type === "red_card" || target.type === "penalty_awarded";
  const ref = Math.hypot(target.ref[0] - prev.ref[0], target.ref[1] - prev.ref[1]) < (officiating ? 0.05 : REF_DEADBAND) ? prev.ref : chase(prev.ref[0], prev.ref[1], target.ref[0], target.ref[1], k(officiating ? 150 : 900), REF_SPEED);
  return { ...target, ball, lift: prev.lift + (target.lift - prev.lift) * kb, players, ref };
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
