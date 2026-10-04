import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sample, sceneFor, short, type Pt, type Scene } from "./scenes";
import { frameAt, playhead } from "./sim";
import type { LineupPlayer, MatchEvent } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

type EnginePlayer = { name: string; role: string; is_starter: boolean };
function team(i: number) {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) as EnginePlayer[] };
}
function lineup(players: EnginePlayer[]): LineupPlayer[] {
  return players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
}

/** Ten full simulated matches with their frozen lineups. */
function matches(n = 10) {
  const out: Array<{ events: MatchEvent[]; lineups: { home: LineupPlayer[]; away: LineupPlayer[] } }> = [];
  for (let i = 0; i < n; i++) {
    const home = team(i % 16);
    const away = team((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "f" + i, seed: 1000 + i, kickoffAt: 0, home, away, timing: eng.buildTiming(1000, 1) });
    out.push({ events: eng.advanceTo(st, 1e12), lineups: { home: lineup(home.players), away: lineup(away.players) } });
  }
  return out;
}

const idle = (e: MatchEvent, ball: Pt): Scene => ({ key: `${e.seq}`, seq: e.seq, type: e.t, ms: 0, ball: [ball], actors: [], caption: e.text, important: false });

describe("frameAt", () => {
  const ms = matches();
  const TS = [0, 0.5, 1];

  it("every frame has exactly 10 players inside the pitch, one keeper per side", () => {
    for (const m of ms) {
      let prev: Pt = [50, 32];
      for (const e of m.events) {
        const s = sceneFor(e, prev) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        for (const t of TS) {
          const f = frameAt(s, t, m.lineups);
          const bad = f.players.filter((p) => p.x < 0 || p.x > 100 || p.y < 0 || p.y > 64);
          const gks = [f.players.filter((p) => p.side === "home" && p.gk).length, f.players.filter((p) => p.side === "away" && p.gk).length];
          const home = f.players.filter((p) => p.side === "home").length;
          if (f.players.length !== 10 || bad.length || gks[0] !== 1 || gks[1] !== 1 || home !== 5) {
            expect.fail(`${e.t} #${e.seq} t=${t}: ${f.players.length} players, ${bad.length} off-pitch, gks ${gks}, home ${home}`);
          }
        }
      }
    }
  });

  it("the scorer in a goal scene is the hot player riding the actor path", () => {
    let n = 0;
    for (const m of ms) {
      let prev: Pt = [50, 32];
      for (const e of m.events) {
        const s = sceneFor(e, prev) ?? idle(e, prev);
        prev = s.ball[s.ball.length - 1];
        if (e.t !== "goal") continue;
        const scorer = s.actors.find((a) => a.id === "s")!;
        for (const t of TS) {
          const f = frameAt(s, t, m.lineups);
          const hot = f.players.find((p) => p.side === e.side && short(p.name) === scorer.label);
          expect(hot, `${e.text}`).toBeTruthy();
          expect(hot!.hot).toBe(true);
          const [x, y] = sample(scorer.path, t);
          expect(Math.hypot(hot!.x - x, hot!.y - y)).toBeLessThan(2);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  it("skips sent-off players and survives missing lineups", () => {
    const m = ms[0];
    const e = m.events[5];
    const s = sceneFor(e, [50, 32]) ?? idle(e, [50, 32]);
    const off = m.lineups.home.filter((p) => p.starter && p.role !== "gk")[0];
    const f = frameAt(s, 0.5, m.lineups, new Set(["home:" + off.name]));
    expect(f.players).toHaveLength(9);
    expect(f.players.some((p) => p.name === off.name)).toBe(false);
    expect(frameAt(s, 0.5, null).players).toHaveLength(0);
  });
});

describe("playhead", () => {
  const ev = (seq: number, at: number) => ({ seq, at, t: "pass", min: 1, text: `e${seq}`, st: {} as MatchEvent["st"] }) as MatchEvent;
  const evs = [ev(1, 1000), ev(2, 2000), ev(3, 2100), ev(4, 6000)];
  it("picks the last event at or before t, with its predecessor and the time elapsed since it", () => {
    expect(playhead(evs, 500)).toBeNull();
    expect(playhead(evs, 1500)).toEqual({ cur: evs[0], prev: undefined, elapsed: 500 });
    expect(playhead(evs, 2050)).toEqual({ cur: evs[1], prev: evs[0], elapsed: 50 });
    expect(playhead(evs, 99999)).toEqual({ cur: evs[3], prev: evs[2], elapsed: 93999 });
  });
  it("a later event arriving never changes progress through the current one", () => {
    const before = playhead(evs, 7250)!;
    const after = playhead([...evs, ev(5, 7300)], 7250)!;
    expect(after.cur).toBe(before.cur);
    expect(after.elapsed).toBe(1250);
    expect(before.elapsed).toBe(1250);
  });
});
