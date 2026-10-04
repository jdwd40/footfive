/**
 * Full 5-v-5 frame: maps a Scene's named actors onto real lineup players and parks the rest
 * at formation anchors drifted toward the ball, so all 10 players are always on the pitch.
 */
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";
import { sample, sampleN, short, type Actor, type Pt, type Scene } from "./scenes";

export type Player = { side: Side; name: string; no: number; gk: boolean; x: number; y: number; hot: boolean /* named in the event */ };
export type Frame = { ball: Pt; lift: number; players: Player[]; caption: string; flash: Scene["flash"]; type: string; seq: number; p: number } & Pick<Scene, "side" | "who" | "score" | "kick">;
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

function starters(list: LineupPlayer[], side: Side, sentOff?: Set<string>) {
  const live = list.filter((p) => p.starter && !sentOff?.has(side + ":" + p.name));
  const gk = live.find((p) => p.role === "gk") ?? live[0];
  return gk ? [gk, ...live.filter((p) => p !== gk).slice(0, 4)] : [];
}

export function frameAt(scene: Scene, t: number, lineups: Lineups | null, sentOff?: Set<string>): Frame {
  const ball = sample(scene.ball, t);
  const players: Player[] = [];
  for (const side of ["home", "away"] as Side[]) {
    const mirror = side === "away";
    starters(lineups?.[side] ?? [], side, sentOff).forEach((p, i) => {
      const gk = i === 0;
      const ax = mirror ? 100 - ANCHORS[i][0] : ANCHORS[i][0];
      const ay = ANCHORS[i][1];
      const x = gk ? ax : clamp(ax + (ball[0] - ax) * 0.3, 1, 99);
      const y = clamp(ay + (ball[1] - ay) * (gk ? 0.4 : 0.3), 2, 62);
      players.push({ side, name: p.name, no: p.no, gk, x, y, hot: false });
    });
  }
  // Named actors ride their path: keepers bind to the GK, labels to short(name), the rest to the nearest free teammate.
  const unlabelled: Actor[] = [];
  for (const a of scene.actors) {
    if (a.side === "ref") continue;
    const p = a.keeper ? players.find((q) => q.side === a.side && q.gk) : a.label ? players.find((q) => q.side === a.side && !q.hot && short(q.name) === a.label) : null;
    if (p) place(p, a, t);
    else if (!a.keeper && !a.label) unlabelled.push(a);
  }
  for (const a of unlabelled) {
    const [x, y] = sample(a.path, t);
    let best: Player | undefined;
    for (const q of players) if (q.side === a.side && !q.hot && !q.gk && (!best || Math.hypot(q.x - x, q.y - y) < Math.hypot(best.x - x, best.y - y))) best = q;
    if (best) place(best, a, t);
  }
  return { ball, lift: sampleN(scene.ballHeight, t), players, caption: scene.caption, flash: scene.flash ?? null, type: scene.type, seq: scene.seq, p: t, side: scene.side, who: scene.who, score: scene.score, kick: scene.kick };
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
  return { ...target, ball, lift: prev.lift + (target.lift - prev.lift) * kb, players };
}

/** Current event at server time `t` (last with `at ≤ t`), its predecessor, and ms elapsed since it. */
export function playhead(events: MatchEvent[], t: number) {
  let i = events.length - 1;
  while (i >= 0 && events[i].at > t) i--;
  if (i < 0) return null;
  const cur = events[i];
  return { cur, prev: events[i - 1] as MatchEvent | undefined, elapsed: t - cur.at };
}
