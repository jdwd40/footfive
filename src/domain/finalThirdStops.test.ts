/**
 * #218: about half of the attacks that end in a tackle or interception first reach the final third (a cross, through ball or
 * dribble into x 74–82) and die there: a last-ditch tackle, a clearance or a keeper claim. Markets suspend with the progression
 * and reopen with the turnover; the live view draws the sequence without a jump and leaves the ball with the defending side.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sampleN, sceneFor, short, type Pt, type Scene } from "./scenes";
import { frameAt, type Lineups } from "./sim";
import type { MatchEvent, Side } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const mkt = lib("markets.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const PROGRESSIONS = new Set(["through_ball", "dribble", "cross"]);
const along = (side: Side, x: number) => (side === "home" ? x : 100 - x);
const other = (s: Side): Side => (s === "home" ? "away" : "home");
const end = (s: Scene): Pt => s.ball[s.ball.length - 1];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};

type Played = { events: MatchEvent[]; lineups: Lineups };
function play(n: number, seed0: number): Played[] {
  const out: Played[] = [];
  for (let i = 0; i < n; i++) {
    const st = eng.createMatch({ fixtureId: "ft" + i, seed: seed0 + i, kickoffAt: 0, home: team(i % 16), away: team((i * 5 + 3) % 16), timing: eng.buildTiming(1000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    const lineups = Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;
    out.push({ events: events.filter((e) => !e.cos), lineups });
  }
  return out;
}

describe("failed attacks that reach the final third (issue #218)", () => {
  const matches = play(60, 21800);
  const stops = matches.flatMap(({ events }) => events.flatMap((e, i) => ((e.t === "tackle" || e.t === "interception") && e.chain && e.stop ? [{ e, prog: events[i - 1], next: events[i + 1] }] : [])));
  const challenges = matches.flatMap(({ events }) => events.filter((e) => (e.t === "tackle" || e.t === "interception") && e.chain));

  it("about half of the attacking tackles and interceptions come after a progression into x 74–82, with every kind of stop", () => {
    const share = stops.length / challenges.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
    const kinds = new Set<string>();
    for (const { e, prog } of stops) {
      const atk = other(e.side as Side);
      expect(PROGRESSIONS.has(prog.t), `#${e.seq}`).toBe(true);
      expect(prog).toMatchObject({ side: atk, chain: e.chain, seq: e.seq - 1 });
      expect(along(atk, prog.ball![0]), `#${prog.seq}`).toBeGreaterThanOrEqual(74);
      expect(along(atk, prog.ball![0]), `#${prog.seq}`).toBeLessThanOrEqual(82);
      // The turnover is met where the progression left it (a cross: in the box it was delivered to).
      if (prog.t === "cross") expect(along(atk, e.from![0])).toBeGreaterThanOrEqual(84);
      else expect(e.from).toEqual(prog.ball);
      if (e.stop === "claim") expect(along(atk, e.ball![0]), `claim #${e.seq} inside the area`).toBeGreaterThanOrEqual(86);
      if (e.stop === "claim") expect(e.p).toBe(matches.find((m) => m.events.includes(e))!.lineups[e.side as Side].find((p) => p.role === "gk")!.name);
      kinds.add(`${prog.t}:${e.stop}`);
    }
    expect([...kinds].sort()).toEqual(["cross:claim", "cross:clear", "dribble:clear", "dribble:tackle", "through_ball:claim", "through_ball:clear", "through_ball:tackle"]);
    // Tackles and interceptions that die before the final third are as before: no progression, no stop, short of x 74.
    for (const e of challenges.filter((c) => !c.stop)) expect(along(other(e.side as Side), e.ball![0])).toBeLessThanOrEqual(74);
  });

  it("suspends markets with the progression and reopens them with the turnover, so no market stays suspended", () => {
    const fx = { status: "live", kickoffAt: 0 };
    for (const { e, prog } of stops) {
      expect(prog.st.d, `progression #${prog.seq}`).toBe(1);
      expect(mkt.fixtureState(fx, prog.st, 1).closed).toBe("Suspended — incident in progress");
      expect(e.st.d, `turnover #${e.seq}`).toBe(0);
      expect(mkt.fixtureState(fx, e.st, 1).closed).toBeNull();
    }
    // Every real row that leaves markets suspended is followed, within the same attack, by one that reopens them (a goal stays
    // suspended through its celebration and kick-off; a penalty through its kick): none is left hanging.
    for (const { events } of matches) {
      for (let i = 0; i < events.length; i++) {
        if (!events[i].st.d) continue;
        const reopen = events.slice(i + 1).find((x) => !x.st.d);
        if (!reopen) expect(events.at(-1)!.t, `#${events[i].seq}`).toBe("match_end");
        else expect(reopen.seq - events[i].seq, `#${events[i].seq} ${events[i].t}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it("leaves the ball with the defending side: the next touch starts from the turnover's spot", () => {
    for (const { e, next } of stops) {
      if (!next || !next.from || !["build_up", "pass"].includes(next.t)) continue;
      expect(next.from, `#${next.seq}`).toEqual(e.ball);
      expect(!!next.turn, `#${next.seq}`).toBe(next.side !== e.side);
    }
  });

  it("draws each stop on the engine's spots: the keeper gathers a claim, a defender clears to a team-mate, a tackle is a contest", () => {
    const seen = new Set<string>();
    for (const { e, prog } of stops) {
      const lift = prog.t === "cross" ? 0.6 : 0;
      const s = sceneFor(e, e.from as Pt, 6000, undefined, lift)!;
      const side = e.side as Side;
      expect(s.ball[0]).toEqual(e.from);
      expect(end(s)).toEqual(e.ball);
      expect(s.flash ?? null).toBeNull(); // a cue, not a result
      const win = s.actors.find((a) => a.id === "win")!;
      const lost = s.actors.find((a) => a.id === "lost")!;
      expect(win.side).toBe(side);
      expect(lost.side).toBe(other(side));
      expect(lost.label).toBe(short(e.p2));
      expect(dist(sample(win.path, 0), s.ball[0])).toBeGreaterThan(2); // he has to get to it
      if (e.stop === "claim") {
        expect(win.keeper).toBe(true);
        expect(s.won).toBe(0.5);
        for (const t of [0.5, 0.75]) expect(dist(sample(win.path, t), sample(s.ball, t)), `claim #${e.seq} t=${t}`).toBeLessThan(1.5);
        expect(sampleN(s.ballHeight, 0) > 0).toBe(prog.t === "cross"); // a cross is caught in the air, a through ball gathered
      } else if (e.stop === "clear") {
        const col = s.actors.find((a) => a.id === "col")!;
        expect(col.side).toBe(side);
        expect(dist(sample(win.path, s.won!), sample(s.ball, s.won!)), `clear #${e.seq}`).toBeLessThan(1.5); // contact on WON IT
        for (const t of [0.75, 1]) expect(dist(sample(col.path, t), sample(s.ball, t)), `clear #${e.seq} t=${t}`).toBeLessThan(1.5);
        expect(Math.max(...s.ballHeight!)).toBeGreaterThanOrEqual(0.9); // lofted clear
        expect(along(other(side), end(s)[0])).toBeLessThan(along(other(side), e.from![0]) - 15); // well away from goal, into midfield
      } else {
        expect(s.won).toBe(0.5);
        for (const t of [0.5, 0.75, 1]) expect(dist(sample(win.path, t), sample(s.ball, t)), `tackle #${e.seq} t=${t}`).toBeLessThan(1.5);
      }
      seen.add(e.stop!);
    }
    expect([...seen].sort()).toEqual(["claim", "clear", "tackle"]);
  });

  it("a cross the defence deals with is delivered to where it is met, without a named header-taker", () => {
    let n = 0;
    for (const { e, prog } of stops) {
      if (prog.t !== "cross") continue;
      n++;
      const s = sceneFor(prog, prog.from as Pt, 6000, e)!;
      expect(end(s), `#${prog.seq}`).toEqual(e.from);
      expect(s.actors.find((a) => a.id === "h")!.label).toBeUndefined();
    }
    expect(n).toBeGreaterThan(20);
  });

  it("plays the whole sequence in the live view without a teleport, and the defending side ends with the ball", () => {
    let checked = 0;
    for (const { events, lineups } of matches.slice(0, 20)) {
      let prev: Pt = [50, 32];
      let lift = 0;
      let last: Scene | null = null;
      events.forEach((e, i) => {
        const s = sceneFor(e, prev, 6000, events[i + 1], lift);
        if (!s) return;
        if (e.stop && last && PROGRESSIONS.has(last.type)) {
          checked++;
          // The turnover scene starts exactly where the progression's scene left the ball...
          expect(s.ball[0], `#${e.seq}`).toEqual(end(last));
          // ...and the drawn frames step smoothly through it (≤ 4 units per 1/60 s tick at 6 s minutes).
          let b = frameAt(last, 1, lineups).ball;
          for (let k = 0; k <= 60; k++) {
            const f = frameAt(s, k / 60, lineups);
            expect(dist(f.ball, b), `#${e.seq} t=${k}/60`).toBeLessThan(4);
            b = f.ball;
          }
          // At the end, the ball is at a defending player's feet (or the keeper's hands).
          const done = frameAt(s, 1, lineups);
          const holder = done.players.filter((p) => dist([p.x, p.y], done.ball) <= 1.6);
          expect(holder.some((p) => p.side === e.side), `#${e.seq} ${e.stop}`).toBe(true);
          expect(done.carrier?.startsWith(e.side + ":"), `#${e.seq} ${e.stop}`).toBe(true);
        }
        prev = end(s);
        lift = sampleN(s.ballHeight, 1);
        last = s;
      });
    }
    expect(checked).toBeGreaterThan(50);
  });
});
