import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sceneFor, urgencyOf, withCoaching, type Pt, type Scene, type Stances } from "./scenes";
import { FWD_LEAD, URGE_BOX, URGE_HOLD, URGE_KEEPER, frameAt, possession, shapeAt, type Frame } from "./sim";
import type { LineupPlayer, MatchEvent, Side } from "../lib/pocketbase";

// #216: a side behind and on Attack (as the published coaching events say) pushes up; its keeper comes up late; a pulse marks its spells on the ball.
const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type EnginePlayer = { name: string; role: string; is_starter: boolean };
function team(i: number, managed?: { stance: string }) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) as EnginePlayer[], ai: !managed, ...managed };
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

/** Simulated matches in which a side is behind from 70'. AI sides publish their switch to Attack; managed sides (`managed`: both
 * teams, never coached during the match) publish no coaching event at all, whatever their kick-off stance. */
function lateChases(n: number, managed?: { stance: string }) {
  const out: Array<{ events: MatchEvent[]; lineups: { home: LineupPlayer[]; away: LineupPlayer[] }; side: Side }> = [];
  for (let i = 0; out.length < n && i < 400; i++) {
    const home = team(i % 16, managed);
    const away = team((i * 7 + 3) % 16, managed);
    const st = eng.createMatch({ fixtureId: "u" + i, seed: 2160 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(6000, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    const at70 = events.filter((e) => e.st?.ph === "second_half" && e.min < 70).at(-1)?.st.sc;
    const side: Side | null = !at70 ? null : at70[0] < at70[1] ? "home" : at70[1] < at70[0] ? "away" : null;
    if (side) out.push({ events, lineups: { home: lineup(home.players), away: lineup(away.players) }, side });
  }
  return out;
}

const ev = (e: Partial<MatchEvent>): MatchEvent => ({ seq: 1, at: 0, t: "pass", min: 75, text: "", st: { sc: [0, 1], ph: "second_half" } as MatchEvent["st"], ...e });

describe("#216 urgency: behind and on Attack (published), or behind from 70'", () => {
  it("is set for a side behind on Attack (published), or behind from 70' whatever its stance; never level, leading, at a break or full time", () => {
    const early = ev({ side: "home", min: 60 });
    expect(urgencyOf(early, {})).toBeNull(); // behind before 70', no Attack published
    expect(urgencyOf(ev({ min: 69, st: { sc: [0, 1], ph: "first_half" } as MatchEvent["st"] }), {})).toBeNull();
    const stances = withCoaching({}, ev({ t: "coaching", side: "home", stance: "attack" }));
    expect(urgencyOf(early, stances)).toEqual({ side: "home", late: false }); // a manager's Attack while behind counts at once
    expect(urgencyOf(ev({ min: 86 }), stances)).toEqual({ side: "home", late: true });
    expect(urgencyOf(ev({ min: 116, st: { sc: [1, 2], ph: "extra_time_2" } as MatchEvent["st"] }), stances)).toEqual({ side: "home", late: true });
    expect(urgencyOf(ev({ st: { sc: [1, 1], ph: "second_half" } as MatchEvent["st"] }), stances)).toBeNull(); // level again
    expect(urgencyOf(ev({ min: 60, st: { sc: [1, 0], ph: "second_half" } as MatchEvent["st"] }), stances)).toBeNull(); // the leader on Attack: no chase
    expect(urgencyOf(ev({ min: 75, st: { sc: [1, 0], ph: "second_half" } as MatchEvent["st"] }), stances)).toEqual({ side: "away", late: false }); // ...the side behind does
    for (const ph of ["finished", "et_break", "shootout", "half_time"]) expect(urgencyOf(ev({ t: "match_end", st: { sc: [0, 1], ph } as MatchEvent["st"] }), stances)).toBeNull();
    // From 70' the side behind chases whatever its stance: a managed side left on Balanced or Defend, or one whose default stance is
    // already Attack (it never publishes a coaching event, so the stances know nothing of it).
    const balanced = withCoaching({}, ev({ t: "coaching", side: "home", stance: "balanced" }));
    const defend = withCoaching({}, ev({ t: "coaching", side: "home", stance: "defend" }));
    for (const s of [balanced, defend, {}]) {
      expect(urgencyOf(ev({ min: 70 }), s)).toEqual({ side: "home", late: false });
      expect(urgencyOf(ev({ min: 85 }), s)).toEqual({ side: "home", late: false });
      expect(urgencyOf(ev({ min: 88 }), s)).toEqual({ side: "home", late: true });
      expect(urgencyOf(ev({ min: 95, st: { sc: [1, 2], ph: "extra_time_1" } as MatchEvent["st"] }), s)).toEqual({ side: "home", late: false });
      expect(urgencyOf(ev({ min: 69 }), s)).toBeNull();
    }
    expect(withCoaching(stances, ev({ t: "pass", side: "home", stance: "defend" }))).toBe(stances); // only coaching events fold in
  });

  it("chasing forwards push on and hold up near the box, but stay short of its edge unless the ball itself takes them there", () => {
    for (let bx = 10; bx <= 90; bx += 5) {
      for (const i of [3, 4]) {
        const [x] = shapeAt(i, bx, 32, true, false, "push");
        const [plain] = shapeAt(i, bx, 32, true);
        expect(x).toBeGreaterThanOrEqual(plain); // never behind his ordinary run
        expect(x).toBeGreaterThanOrEqual(Math.min(URGE_HOLD, 94));
        if (bx + FWD_LEAD <= URGE_BOX) expect(x).toBeLessThanOrEqual(URGE_BOX); // short of the penalty-area line (x 85)
      }
    }
  });

  const games = lateChases(6);
  it("finds simulated matches with a late chase", () => expect(games.length).toBe(6));

  it("pushes the chasing side up the pitch with the ball (never before 70' for the AI: it only goes to Attack then), and the leader sits deeper", () => {
    let pushed = 0;
    let gain = 0;
    let lead = 0;
    for (const g of games) {
      for (const { e, s, plain } of build(g.events, 6000)) {
        if (e.min < 70) expect(s.urge, `#${e.seq} before 70'`).toBeUndefined();
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

  /** The pulse on every frame of every scene: only during the chasing side's own spells on the ball, never before 70' (these sides
   * only chase from then), never from the full-time whistle on. Returns how many frames pulsed. */
  function pulses(g: (typeof games)[number]) {
    const scenes = build(g.events, 6000);
    const end = scenes.findIndex(({ e }) => e.t === "match_end");
    let on = 0;
    for (const [i, { e, s }] of scenes.entries()) {
      for (const t of [0.3, 1, 1.5]) {
        const f = frameAt(s, t, g.lineups);
        if (e.min < 70 || i >= end) expect(f.urge, `${e.t} #${e.seq}`).toBeUndefined();
        if (f.urge) {
          expect(f.urge).toBe(s.urge!.side);
          expect(possession(s)).toBe(f.urge);
          on++;
        } else if (s.urge && possession(s) === s.urge.side) expect.fail(`${e.t} #${e.seq}: the chasing side has the ball but no pulse`);
      }
    }
    expect(scenes[end].s.urge).toBeUndefined(); // full time: nothing to chase
    return on;
  }

  it("pulses only during the chasing side's spells on the ball, from 70' to the final whistle", () => {
    for (const g of games) expect(pulses(g)).toBeGreaterThan(0);
  });

  for (const stance of ["balanced", "defend", "attack"]) {
    it(`a managed side on ${stance} from kick-off (no coaching event published) behind from 70' chases and pulses too`, () => {
      const managed = lateChases(3, { stance });
      expect(managed.length).toBe(3);
      for (const g of managed) {
        expect(g.events.some((e) => e.t === "coaching")).toBe(false);
        const urged = build(g.events, 6000).filter(({ s }) => s.urge);
        expect(urged.length).toBeGreaterThan(0);
        for (const { e, s } of urged) {
          expect(e.min).toBeGreaterThanOrEqual(70);
          const sc = e.st.sc;
          expect(s.urge!.side).toBe(sc[0] < sc[1] ? "home" : "away"); // the side behind on the event's own score
        }
        expect(pulses(g)).toBeGreaterThan(0);
      }
    });
  }
});
