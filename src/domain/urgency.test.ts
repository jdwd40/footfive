import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sceneFor, urgencyOf, withCoaching, type Pt, type Scene, type Stances } from "./scenes";
import { URGE_KEEPER, frameAt, possession, type Frame } from "./sim";
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";

// #216: a side behind and on Attack (as the published coaching events say) pushes up; its keeper comes up late; a pulse marks its spells on the ball.
const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type EnginePlayer = { name: string; role: string; is_starter: boolean };
function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) as EnginePlayer[], ai: true };
}
const lineup = (players: EnginePlayer[]): LineupPlayer[] => players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
const idle = (e: MatchEvent, ball: Pt): Scene => ({ key: `${e.seq}`, seq: e.seq, type: e.t, ms: 0, ball: [ball], actors: [], caption: e.text });
const along = (side: Side, x: number) => (side === "home" ? x : 100 - x);

/** Scenes as MatchPage builds them: with the stances folded from the events so far, and (for comparison) without any. */
function build(events: MatchEvent[], minuteMs: number) {
  const out: Array<{ e: MatchEvent; s: Scene; plain: Scene; stances: Stances }> = [];
  let prev: Pt = [50, 32];
  let stances: Stances = {};
  for (const [i, e] of events.entries()) {
    stances = withCoaching(stances, e);
    const s = sceneFor(e, prev, minuteMs, events[i + 1], 0, stances) ?? idle(e, prev);
    const plain = sceneFor(e, prev, minuteMs, events[i + 1], 0) ?? idle(e, prev);
    prev = s.ball[s.ball.length - 1];
    out.push({ e, s, plain, stances });
  }
  return out;
}

/** Simulated AI matches in which a side is behind from 70' (so the engine publishes its switch to Attack). */
function lateChases(n: number) {
  const out: Array<{ events: MatchEvent[]; lineups: { home: LineupPlayer[]; away: LineupPlayer[] }; side: Side }> = [];
  for (let i = 0; out.length < n && i < 200; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "u" + i, seed: 2160 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(6000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    const push = events.find((e) => e.t === "coaching" && e.stance === "attack" && e.min >= 70);
    if (push) out.push({ events, lineups: { home: lineup(home.players), away: lineup(away.players) }, side: push.side! });
  }
  return out;
}

const ev = (e: Partial<MatchEvent>): MatchEvent => ({ seq: 1, at: 0, t: "pass", min: 75, text: "", st: { sc: [0, 1], ph: "second_half" } as MatchEvent["st"], ...e });

describe("#216 urgency from published coaching events", () => {
  it("is only set once a coaching event has put the trailing side on Attack, and never on a level score, a break or full time", () => {
    const behind = ev({ side: "home" });
    expect(urgencyOf(behind, {})).toBeNull(); // trailing, but no Attack published yet
    const stances = withCoaching({}, ev({ t: "coaching", side: "home", stance: "attack" }));
    expect(urgencyOf(behind, stances)).toEqual({ side: "home", late: false });
    expect(urgencyOf(ev({ min: 86 }), stances)).toEqual({ side: "home", late: true });
    expect(urgencyOf(ev({ min: 116, st: { sc: [1, 2], ph: "extra_time_2" } as MatchEvent["st"] }), stances)).toEqual({ side: "home", late: true });
    expect(urgencyOf(ev({ st: { sc: [1, 1], ph: "second_half" } as MatchEvent["st"] }), stances)).toBeNull(); // level again
    expect(urgencyOf(ev({ st: { sc: [1, 0], ph: "second_half" } as MatchEvent["st"] }), stances)).toBeNull(); // the leader on Attack: no chase
    for (const ph of ["finished", "et_break", "shootout", "half_time"]) expect(urgencyOf(ev({ t: "match_end", st: { sc: [0, 1], ph } as MatchEvent["st"] }), stances)).toBeNull();
    // A later Balanced (equaliser, then the AI settles back) ends it; a non-coaching event never changes the stances.
    const settled = withCoaching(stances, ev({ t: "coaching", side: "home", stance: "balanced" }));
    expect(urgencyOf(behind, settled)).toBeNull();
    expect(withCoaching(stances, ev({ t: "pass", side: "home", stance: "defend" }))).toBe(stances);
  });

  const games = lateChases(6);
  it("finds simulated matches with a late chase", () => expect(games.length).toBe(6));

  it("pushes the chasing side up the pitch with the ball only after its coaching event, and the leader sits deeper", () => {
    let pushed = 0;
    let gain = 0;
    let lead = 0;
    for (const g of games) {
      const scenes = build(g.events, 6000);
      const at = scenes.findIndex(({ e }) => e.t === "coaching" && e.stance === "attack" && e.min >= 70);
      for (const [i, { e, s, plain }] of scenes.entries()) {
        if (i < at) expect(s.urge, `#${e.seq} before the coaching event`).toBeUndefined();
        if (!s.urge || possession(s) !== s.urge.side || !["build_up", "pass", "dribble", "through_ball", "cross"].includes(s.type)) continue;
        const side = s.urge.side;
        const mean = (f: Frame, sd: Side) => {
          const own = f.players.filter((p) => p.side === sd && !p.gk);
          return own.reduce((a, p) => a + along(sd, p.x), 0) / own.length;
        };
        const f = frameAt(s, 1.4, g.lineups, undefined, 0);
        const b = frameAt(plain, 1.4, g.lineups, undefined, 0);
        expect(f.ball).toEqual(b.ball); // presentation of the shape only: the ball's route is the event's
        gain += mean(f, side) - mean(b, side);
        lead += mean(f, side === "home" ? "away" : "home") - mean(b, side === "home" ? "away" : "home");
        pushed++;
      }
    }
    expect(pushed).toBeGreaterThan(20);
    expect(gain / pushed).toBeGreaterThan(8);
    expect(lead / pushed).toBeLessThan(-1);
  });

  it("brings the chasing keeper up in the last five minutes while his side has the ball, not before", () => {
    let late = 0;
    for (const g of games) {
      for (const { e, s, plain } of build(g.events, 6000)) {
        if (!s.urge || possession(s) !== s.urge.side || s.actors.some((a) => a.keeper)) continue;
        const side = s.urge.side;
        const gk = (sc: Scene) => along(side, frameAt(sc, 0.5, g.lineups).players.find((p) => p.side === side && p.gk)!.x);
        if (s.urge.late) {
          expect(e.min).toBeGreaterThanOrEqual(86);
          expect(gk(s) - gk(plain)).toBeCloseTo(URGE_KEEPER);
          late++;
        } else expect(gk(s)).toBe(gk(plain));
      }
    }
    expect(late).toBeGreaterThan(0);
  });

  it("pulses only during the chasing side's spells on the ball, from its coaching event to the final whistle", () => {
    for (const g of games) {
      const scenes = build(g.events, 6000);
      const at = scenes.findIndex(({ e }) => e.t === "coaching" && e.stance === "attack" && e.min >= 70);
      const end = scenes.findIndex(({ e }) => e.t === "match_end");
      let on = 0;
      for (const [i, { e, s }] of scenes.entries()) {
        for (const t of [0.3, 1, 1.5]) {
          const f = frameAt(s, t, g.lineups);
          if (i <= at || i >= end) expect(f.urge, `${e.t} #${e.seq}`).toBeUndefined();
          if (f.urge) {
            expect(f.urge).toBe(s.urge!.side);
            expect(possession(s)).toBe(f.urge);
            on++;
          } else if (s.urge && possession(s) === s.urge.side) expect.fail(`${e.t} #${e.seq}: the chasing side has the ball but no pulse`);
        }
      }
      expect(on).toBeGreaterThan(0);
      expect(scenes[end].s.urge).toBeUndefined(); // full time: nothing to chase
    }
  });
});
