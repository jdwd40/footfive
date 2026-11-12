/**
 * #208: the break summary and pre-match builders, against real engine matches (the PocketBase hook modules) where it matters: the
 * shot map and the goals must agree with the engine's own published statistics and score, and never use anything after the break.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LineupPlayer, MatchEvent } from "../lib/pocketbase";
import { breakCard, breakSummary, CARD_MS, formation, goalsOf, playerLine, shotMap, SUMMARY_DELAY_MS, topPlayers } from "./breaks";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const timing = eng.buildTiming(6000, 1); // live pace: 6000 ms a match minute
const full = (seed: number, h = seed % 16, a = (seed * 5 + 3) % 16): MatchEvent[] =>
  eng.advanceTo(eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(h), away: team(a === h ? (a + 1) % 16 : a), timing }), 1e12);
const SEEDS = Array.from({ length: 80 }, (_, i) => i + 1);
const matches = SEEDS.map((s) => full(s));
const SUMMARY_TYPES = ["half_time", "end_of_normal_time", "match_end"];

describe("break summary from real engine matches", () => {
  it("the shot map has exactly the attempts the published Shots and On target counts have, per side, at every summary break", () => {
    let breaks = 0;
    let pens = 0;
    for (const ev of matches) {
      for (const b of ev.filter((e) => SUMMARY_TYPES.includes(e.t))) {
        const s = breakSummary(ev, b.seq)!;
        breaks++;
        expect(s.st).toBe(b.st);
        ([0, 1] as const).forEach((i) => {
          const side = i ? "away" : "home";
          const mine = s.shots.filter((x) => x.side === side);
          expect(mine.length, `seed shots ${side} at ${b.t}`).toBe(b.st.x[i][0]);
          expect(mine.filter((x) => x.result === "goal" || x.result === "save").length).toBe(b.st.x[i][1]);
          expect(mine.filter((x) => x.result === "goal").length).toBe(b.st.sc[i]);
        });
        pens += s.shots.filter((x) => x.pen).length;
      }
    }
    expect(breaks).toBeGreaterThan(SEEDS.length * 2 - 1); // half-time and full time in every match, the 90 in some
    expect(pens, "penalties are on the map too").toBeGreaterThan(0);
  });

  it("draws every attempt in the half it was struck in: home attacks right, away left, whichever half of the match", () => {
    for (const ev of matches) {
      for (const s of shotMap(ev)) {
        if (s.side === "home") expect(s.x).toBeGreaterThan(50);
        else expect(s.x).toBeLessThan(50);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(64);
      }
    }
  });

  it("lists the match goals in order with the score each one made, and never a shootout kick", () => {
    for (const ev of matches) {
      const goals = goalsOf(ev);
      const end = ev.at(-1)!.st.sc;
      expect(goals.filter((g) => g.side === "home").length).toBe(end[0]);
      expect(goals.filter((g) => g.side === "away").length).toBe(end[1]);
      goals.forEach((g, i) => {
        expect(g.score[0] + g.score[1]).toBe(i + 1);
        if (i) expect(g.min).toBeGreaterThanOrEqual(goals[i - 1].min);
      });
    }
  });

  it("the half-time summary is the same whatever has been published after the break", () => {
    for (const ev of matches.slice(0, 20)) {
      const ht = ev.find((e) => e.t === "half_time")!;
      const now = breakSummary(ev.filter((e) => e.seq <= ht.seq), ht.seq);
      expect(breakSummary(ev, ht.seq)).toEqual(now);
      expect(now!.goals.every((g) => g.seq < ht.seq)).toBe(true);
      expect(now!.kind).toBe("ht");
    }
  });

  it("is none for a break without a summary (extra-time half-time, the shootout) or an ordinary event", () => {
    const ev = matches[0];
    expect(breakSummary(ev, ev.find((e) => e.t === "pass")!.seq)).toBeNull();
    const et = matches.flatMap((m) => m).find((e) => e.t === "et_half_time" || e.t === "shootout_start");
    if (et) expect(breakSummary(matches.find((m) => m.includes(et))!, et.seq)).toBeNull();
  });

  it("ranks a match's scorers and busy keepers among its top players, from the events alone", () => {
    for (const ev of matches) {
      const top = topPlayers(ev);
      expect(top.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < top.length; i++) expect(top[i - 1].rating).toBeGreaterThanOrEqual(top[i].rating);
      const goals = goalsOf(ev);
      // A two-goal scorer always makes the top three (two goals outweigh anything but another brace), unless he was sent off.
      const reds = new Set(ev.filter((e) => e.t === "red_card").map((e) => `${e.side}:${e.p}`));
      const tally = new Map<string, number>();
      for (const g of goals) if (!reds.has(`${g.side}:${g.p}`)) tally.set(`${g.side}:${g.p}`, (tally.get(`${g.side}:${g.p}`) ?? 0) + 1);
      const braces = [...tally].filter(([, n]) => n >= 2).length;
      if (braces && braces <= 3) for (const [k, n] of tally) if (n >= 2) expect(top.map((p) => `${p.side}:${p.name}`), k).toContain(k);
      for (const p of top) expect(playerLine(p)).not.toBe("");
    }
  });
});

describe("top players", () => {
  const base = { at: 0, min: 10, text: "", st: {} as MatchEvent["st"] };
  const e = (seq: number, t: string, side: "home" | "away", p: string, more: Partial<MatchEvent> = {}): MatchEvent => ({ ...base, seq, t, side, p, ...more });
  it("credits goals and attempts to the shooter, a save to the keeper (a penalty save to the other side's keeper), a block and balls won to the defender", () => {
    const ev = [
      e(1, "shot", "home", "H. Nine", { chain: 1, ball: [85, 30] }),
      e(2, "goal", "home", "H. Nine", { chain: 1, p2: "A. Keeper" }),
      e(3, "shot", "home", "H. Nine", { chain: 3, ball: [80, 40] }),
      e(4, "save", "away", "A. Keeper", { chain: 3, p2: "H. Nine" }),
      e(5, "penalty_saved", "home", "H. Nine", { p2: "A. Keeper" }),
      e(6, "tackle", "away", "A. Back"),
      e(7, "yellow_card", "away", "A. Back"),
      e(8, "shot", "away", "A. Ten", { chain: 8, ball: [20, 30] }),
      e(9, "block", "home", "H. Wall", { chain: 8, p2: "A. Ten" }),
    ];
    const top = topPlayers(ev, 5);
    // The engine counts a saved penalty on target (and as a shot), so the map and these lines do too.
    expect(top[0]).toMatchObject({ side: "home", name: "H. Nine", goals: 1, shots: 3, onTarget: 3 });
    expect(playerLine(top[0])).toBe("1 goal · 3 shots (3 on target)");
    const keeper = top.find((p) => p.name === "A. Keeper")!;
    expect(keeper).toMatchObject({ side: "away", saves: 2 });
    expect(playerLine(keeper)).toBe("2 saves");
    expect(top.find((p) => p.name === "H. Wall")).toMatchObject({ blocks: 1 });
    expect(top.find((p) => p.name === "A. Back")).toBeUndefined(); // a ball won and a booking: nothing to show
  });
  it("leaves out a shot whose result is not shown yet, and cosmetic attempts", () => {
    const ev = [e(1, "shot", "home", "H. Nine", { chain: 1, ball: [85, 30] }), e(2, "shot", "away", "A. Ten", { ball: [20, 30], cos: 1 }), e(3, "miss", "away", "A. Ten", { cos: 1 })];
    expect(shotMap(ev)).toEqual([]);
    expect(topPlayers(ev)).toEqual([]);
  });
});

describe("break timing", () => {
  const ev = (t: string, at: number) => ({ seq: 9, at, t, min: 45, text: "", st: {} as MatchEvent["st"] }) as MatchEvent;
  it("leaves the large banner alone for 5 s, then runs the four cards (pairs on a wide pitch) through the 30 s half-time", () => {
    const ht = ev("half_time", 1000);
    expect(breakCard(ht, 1000)).toBeNull();
    expect(breakCard(ht, 1000 + SUMMARY_DELAY_MS - 1)).toBeNull();
    const at = (s: number) => breakCard(ht, 1000 + s * 1000);
    expect(at(5)).toMatchObject({ kind: "ht", page: 0, pair: 0, cardMs: CARD_MS });
    expect(at(11)).toMatchObject({ page: 1, pair: 0 });
    expect(at(17)).toMatchObject({ page: 2, pair: 1 });
    expect(at(23)).toMatchObject({ page: 3, pair: 1 });
    expect(at(29.9)).toMatchObject({ page: 3 });
    expect(at(30)).toBeNull(); // the break is over: whatever the restart's timing, the summary never outlives it
  });
  it("fits the 20 s break before extra time, never shows at the extra-time half-time, and holds at full time, cycling", () => {
    const et = ev("end_of_normal_time", 0);
    expect(breakCard(et, 5000)).toMatchObject({ kind: "et", page: 0, cardMs: 3750 });
    expect(breakCard(et, 5000 + 3 * 3750)).toMatchObject({ page: 3 });
    expect(breakCard(et, 20000)).toBeNull();
    expect(breakCard(ev("et_half_time", 0), 8000)).toBeNull();
    expect(breakCard(ev("shootout_start", 0), 8000)).toBeNull();
    const ft = ev("match_end", 0);
    expect(breakCard(ft, 5000 + 4 * CARD_MS)).toMatchObject({ kind: "ft", page: 0 });
    expect(breakCard(ft, 3_600_000)).not.toBeNull();
    expect(breakCard(null, 0)).toBeNull();
  });
});

describe("pre-match formation", () => {
  const side = (p: string): LineupPlayer[] => [
    { name: `${p} Att`, no: 9, role: "att", starter: true },
    { name: `${p} Sub`, no: 12, role: "def", starter: false },
    { name: `${p} Def`, no: 4, role: "def", starter: true },
    { name: `${p} Keep`, no: 1, role: "gk", starter: true },
    { name: `${p} Mid`, no: 8, role: "mid", starter: true },
    { name: `${p} Util`, no: 6, role: "util", starter: true },
  ];
  it("puts the five starters in each half, keeper on his line, defenders behind attackers, mirrored for the away side", () => {
    const h = formation(side("H"), "home");
    const a = formation(side("A"), "away");
    expect(h.map((s) => s.p.name)).toEqual(["H Keep", "H Def", "H Util", "H Mid", "H Att"]);
    expect(h[0]).toMatchObject({ x: 6, y: 32 });
    expect(h.every((s) => s.x < 50)).toBe(true);
    expect(a.every((s) => s.x > 50)).toBe(true);
    a.forEach((s, i) => expect(s.x).toBe(100 - h[i].x));
    expect(h.find((s) => s.p.role === "def")!.x).toBeLessThan(h.find((s) => s.p.role === "att")!.x);
    expect(formation([], "home")).toEqual([]);
  });
});
