/** Issue #84: richer commentary is a read-only layer over published events. Crafted rows pin the rules; seeded engine matches pin that it is true of real play and leaves the match alone. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchEvent, Side } from "../lib/pocketbase";
import { commentaryLine, feedRows } from "./commentary";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const LABELS = { home: "HOM", away: "AWA" };
const line = (events: MatchEvent[], i = events.length - 1) => commentaryLine(events, i, LABELS);
const at = (s: number | null) => ({ clk: s == null ? null : { s, run: 1 } }) as unknown as MatchEvent["st"];
const row = (seq: number, t: string, s: number | null, more: Partial<MatchEvent> = {}): MatchEvent => ({ seq, at: seq * 1000, t, min: 1, side: "home", p: "K. Vale", text: `engine ${seq}`, st: at(s), ...more });
const shot = (seq: number, s: number | null, more: Partial<MatchEvent> = {}) => row(seq, "shot", s, { header: 0, long: 0, ...more });
/** Rows keep seq contiguous from 1, as the feed does. */
const feed = (...rows: Array<(seq: number) => MatchEvent>) => rows.map((f, i) => f(i + 1));
const S = (s: number | null, more?: Partial<MatchEvent>) => (seq: number) => shot(seq, s, more);
const R = (t: string, s: number | null, more?: Partial<MatchEvent>) => (seq: number) => row(seq, t, s, more);

describe("shot streaks", () => {
  it("reports the third shot in the window with the team and the shot's own line", () => {
    const l = line(feed(S(100), S(200), S(300)));
    expect(l).toContain("3rd");
    expect(l).toContain("HOM");
    expect(l).toContain("engine 3");
  });

  it("carries on counting, with correct ordinals", () => {
    const shots = (n: number) => Array.from({ length: n }, (_, i) => S(10 * i));
    expect(line(feed(...shots(4)))).toContain("4th");
    expect(line(feed(...shots(11)))).toContain("11th");
    expect(line(feed(...shots(12)))).toContain("12th");
    expect(line(feed(...shots(13)))).toContain("13th");
    expect(line(feed(...shots(21)))).toContain("21st");
    expect(line(feed(...shots(22)))).toContain("22nd");
    expect(line(feed(...shots(23)))).toContain("23rd");
  });

  it("stays quiet on a team's first and second shots", () => {
    expect(line(feed(S(100)))).toBe("engine 1");
    expect(line(feed(S(100), S(200)))).toBe("engine 2");
  });

  it("counts a shot exactly five minutes back and not one a second older", () => {
    expect(line(feed(S(100), S(200), S(400)))).toContain("3rd");
    expect(line(feed(S(99), S(200), S(400)))).toBe("engine 3");
  });

  it("excludes cosmetic shots, and never builds a line on one", () => {
    expect(line(feed(S(100), S(150, { cos: 1 }), S(200)))).toBe("engine 3");
    expect(line(feed(S(100), S(150), S(200, { cos: 1 })))).toBe("engine 3");
  });

  it("keeps the two teams apart", () => {
    expect(line(feed(S(100), S(150, { side: "away" }), S(200)))).toBe("engine 3");
    const l = line(feed(S(100), S(120, { side: "away" }), S(150), S(180, { side: "away" }), S(200, { side: "away" })));
    expect(l).toContain("3rd");
    expect(l).toContain("AWA");
    expect(l).not.toContain("HOM");
  });

  it("counts a penalty kick, an official shot with no shot row, but not a result row of the other side", () => {
    expect(line(feed(R("penalty_saved", 100), S(150), S(200)))).toContain("3rd");
    // The keeper's save carries the defending side.
    expect(line(feed(S(100), R("save", 110, { side: "away" }), S(120, { side: "away" }), S(150, { side: "away" })))).toBe("engine 4");
  });

  it("falls back on a seq gap in the window, a feed that starts late or no clock", () => {
    const gap = feed(S(100), S(150), S(200));
    gap[2] = { ...gap[2], seq: 9 };
    expect(line(gap)).toBe("engine 3");
    const late = feed(S(100), S(150), S(200)).map((e) => ({ ...e, seq: e.seq + 40 }));
    expect(line(late)).toBe("engine 3");
    expect(line(feed(S(100), S(150), S(null)))).toBe("engine 3");
    expect(line(feed(S(100), S(null), S(200)))).toBe("engine 3");
  });

  it("needs history only as far back as the window", () => {
    const late = feed(R("pass", 10), S(100), S(150), S(200)).map((e) => ({ ...e, seq: e.seq + 40 }));
    expect(line(late)).toBe("engine 4"); // the first row is inside the window: what came before it is unknown
    late[0] = { ...late[0], st: at(-200) }; // the first row is now outside the window, so the count is proven
    expect(line(late)).toContain("3rd");
  });
});

describe("special shots", () => {
  it("a header or long shot gets its own line, with no result in it", () => {
    for (let seq = 1; seq < 60; seq++) {
      const h = line([shot(seq, 100, { header: 1 })]);
      expect(h).toMatch(/header/i);
      expect(h).toContain("K. Vale");
      const l = line([shot(seq, 100, { long: 1 })]);
      expect(l).toMatch(/distance|long.range/i);
      expect(l).not.toMatch(/header/i);
      for (const x of [h, l]) expect(x).not.toMatch(/goal|save|post|bar|wide|over|block/i);
    }
  });

  it("an unmarked shot, or one with no metadata at all, keeps the engine text", () => {
    expect(line([shot(1, 100)])).toBe("engine 1");
    expect(line([row(1, "shot", 100)])).toBe("engine 1");
    expect(line([shot(1, 100, { header: 1, p: undefined })])).toBe("engine 1");
  });

  it("a cosmetic long shot is still a long shot", () => {
    expect(line([shot(1, 100, { long: 1, cos: 1 })])).toMatch(/distance|long.range/i);
  });
});

describe("woodwork", () => {
  const wood = (more: Partial<MatchEvent>) => (seq: number) => row(seq, "woodwork", 110, { chain: 1, post: "left", ...more });

  it("names the frame the engine published: bar or post, never the other", () => {
    for (let n = 0; n < 30; n++) {
      const pad = Array.from({ length: n }, () => R("pass", 1));
      expect(line(feed(...pad, wood({ post: "bar", chain: undefined })))).toContain("crossbar");
      for (const post of ["left", "right"]) {
        const l = line(feed(...pad, wood({ post, chain: undefined })));
        expect(l).toContain("the post");
        expect(l).not.toContain("bar");
      }
    }
  });

  it("carries the shot type from the same chain, and claims none without it", () => {
    expect(line(feed(S(100, { chain: 1, header: 1 }), wood({})))).toContain("header");
    expect(line(feed(S(100, { chain: 1, long: 1 }), wood({})))).toContain("long-range effort");
    expect(line(feed(S(100, { chain: 1 }), wood({})))).toContain("effort");
    const other = line(feed(S(100, { chain: 7, header: 1 }), wood({})));
    expect(other).toContain("effort");
    expect(other).not.toContain("header");
    expect(line([row(50, "woodwork", 110, { chain: 49, post: "bar" })])).toContain("effort");
  });

  it("reads a penalty's post from its plan and calls it a penalty, in the match and the shootout", () => {
    const pen = { col: 1, height: 2, dive: 0, post: "bar", run: 0, outcome: "woodwork" };
    expect(line([row(1, "penalty_woodwork", 100, { pen })])).toMatch(/penalty.*crossbar/);
    expect(line([row(1, "shootout_kick", null, { pen, kick: { no: 1, sd: 0, outcome: "woodwork" } })])).toMatch(/penalty.*crossbar/);
    expect(line([row(1, "shootout_kick", null, { pen: { ...pen, outcome: "goal" }, kick: { no: 1, sd: 0, outcome: "goal" } })])).toBe("engine 1");
  });

  it("falls back when the row does not say where it hit", () => {
    expect(line([row(1, "woodwork", 100)])).toBe("engine 1");
  });
});

describe("selection", () => {
  it("every other event keeps the engine text", () => {
    for (const t of ["goal", "save", "miss", "block", "pass", "penalty_goal"]) expect(line([row(1, t, 100, { header: 1, long: 1, post: "bar" })])).toBe("engine 1");
  });

  it("varies with seq and repeats exactly for the same inputs", () => {
    const seen = new Set<string>();
    for (let seq = 1; seq < 200; seq++) {
      const a = line([shot(seq, 100, { long: 1 })]);
      expect(line([shot(seq, 100, { long: 1 })])).toBe(a);
      seen.add(a);
    }
    expect(seen.size).toBe(3);
  });
});

// ---- real matches

type Ev = MatchEvent;
type State = { phase: string; nextAt: number; seed: number; rc: number; score: [number, number]; winner: Side | null; by: string | null; so: unknown; stats: unknown };
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const TIMING = eng.buildTiming(6000, 1);
const match = (seed: number): State => eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 7 + 3) % 16), timing: TIMING });
const SEEDS = Array.from({ length: 200 }, (_, i) => 1000 + i);
const runs = SEEDS.map((seed) => {
  const st = match(seed);
  return { seed, st, events: eng.advanceTo(st, 1e13) as Ev[] };
});
const render = (events: Ev[]) => events.map((_, i) => line(events, i));
const summary = (st: State, events: Ev[]) => ({ score: st.score, winner: st.winner, by: st.by, so: st.so, stats: st.stats, rc: st.rc, last: events.at(-1)?.st.x, goals: events.filter((e) => e.t === "goal" || e.t === "penalty_goal").map((e) => [e.seq, e.side, e.p]) });
/** Engine at the parent of this change (no engine file is touched by #84): score, winner, how, shootout, stats, RNG counter, published stats and scorers of all 200 seeds. */
// #217 re-pin (408d73e7… → 0e9d0171…): the more-shots balance tuning intentionally changes seeded outcomes; see docs/balance-217.md.
const BASELINE = "0e9d017182972a3d21829ee2bee2406dc545385504547adb32fae91b9a602677";

describe("seeded matches (issue #84)", () => {
  it("outcomes, scorelines and official stats are the pre-change engine's", () => {
    const sha = createHash("sha256").update(JSON.stringify(runs.map(({ st, events }) => summary(st, events)))).digest("hex");
    expect(sha).toBe(BASELINE);
  });

  it("rendering commentary after every step changes nothing in the match", () => {
    for (const { seed, st: plain, events: plainEvents } of runs.slice(0, 40)) {
      const st = match(seed);
      const seen: Ev[] = [];
      while (st.phase !== "finished") {
        const from = seen.length;
        seen.push(...(eng.advanceTo(st, st.nextAt) as Ev[]));
        for (let i = from; i < seen.length; i++) line(seen, i);
      }
      expect(JSON.stringify(seen), `seed ${seed}`).toBe(JSON.stringify(plainEvents));
      expect(JSON.stringify(st), `seed ${seed}`).toBe(JSON.stringify(plain));
    }
  });

  it("every streak count matches the official stat snapshots", () => {
    let checked = 0;
    for (const { events } of runs) {
      // Official shots of each side, by clock, straight from the published stats rather than from row types.
      const log: Record<Side, number[]> = { home: [], away: [] };
      events.forEach((e, i) => {
        const prev = events[i - 1]?.st.x ?? [[0], [0]];
        (["home", "away"] as const).forEach((side, k) => {
          if (e.st.x[k][0] > prev[k][0]) log[side].push(e.st.clk!.s);
        });
        const m = /(\d+)(?:st|nd|rd|th)\b.*shot in 5 minutes/.exec(line(events, i));
        const expected = e.t === "shot" && !e.cos && e.side ? log[e.side].filter((s) => e.st.clk!.s - s <= 300).length : 0;
        if (e.t === "shot" && !e.cos && expected >= 3) {
          expect(m?.[1]).toBe(String(expected));
          expect(line(events, i)).toContain(LABELS[e.side!]);
          checked++;
        } else expect(m).toBeNull();
      });
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("a line never depends on later events, and repeats exactly", () => {
    for (const { events } of runs.slice(0, 40)) {
      const full = render(events);
      expect(render(events)).toEqual(full);
      for (const cut of [events.length >> 2, events.length >> 1, events.length - 1]) expect(render(events.slice(0, cut))).toEqual(full.slice(0, cut));
    }
  });

  it("real woodwork and special shots all come out accurately", () => {
    let wood = 0;
    let special = 0;
    for (const { events } of runs) {
      events.forEach((e, i) => {
        const l = line(events, i);
        if (e.t === "woodwork") {
          wood++;
          expect(l).toContain(e.post === "bar" ? "crossbar" : "the post");
          const s = events[i - 1];
          expect(l).toContain(s.header ? "header" : s.long ? "long-range effort" : "effort");
        }
        if (e.t === "shot" && (e.header || e.long)) {
          special++;
          expect(l).toMatch(e.header ? /header/i : /distance|long.range/i);
        }
      });
    }
    expect(wood).toBeGreaterThan(50);
    expect(special).toBeGreaterThan(100);
  });
});

// ---- Match events list (#203)

const LISTED = new Set(["kickoff", "shot", "goal", "save", "miss", "block", "woodwork", "penalty_awarded", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork", "yellow_card", "half_time"]);
const listed = (e: MatchEvent) => LISTED.has(e.t);
const texts = (events: MatchEvent[]) => feedRows(events, listed).map((r) => r.text);

describe("match events list: one row per attack (#203)", () => {
  it("puts a shot and its result on one row, the result's, and keeps both lines", () => {
    const ev = feed(R("kickoff", 0), S(300, { chain: 4, text: "Vale lets fly!" }), R("save", 300, { chain: 4, side: "away", text: "Great save by Moss" }));
    const rows = feedRows(ev, listed);
    expect(rows.map((r) => r.text)).toEqual(["engine 1", "Vale lets fly! — Great save by Moss"]);
    expect(rows[1].e).toBe(ev[2]); // its time, styling and replay are the result's
    expect(rows[1].lead).toBe(ev[1]); // its badge is the shooter's side, not the keeper's
  });

  it("shows the shot alone until its result is published, so the list never grows and shrinks", () => {
    const ev = feed(S(300, { chain: 4, text: "Vale lets fly!" }), R("miss", 300, { chain: 4, text: "Vale drags it wide" }));
    expect(texts(ev.slice(0, 1))).toEqual(["Vale lets fly!"]);
    expect(texts(ev)).toHaveLength(1);
  });

  it("pairs a cosmetic shot with its result, but never a result with a shot from another attack", () => {
    expect(texts(feed(S(300, { cos: 1, text: "From range!" }), R("miss", 300, { cos: 1, text: "Wide" })))).toEqual(["From range! — Wide"]);
    expect(texts(feed(S(300, { chain: 4, text: "A" }), R("block", 300, { chain: 5, text: "B" })))).toEqual(["A", "B"]);
    expect(texts(feed(S(300, { chain: 4, text: "A" }), R("pass", 300, { chain: 4 }), R("goal", 310, { chain: 4, text: "B" })))).toEqual(["A", "B"]);
  });

  it("gives a penalty kick its cause, and a second penalty is called a new foul, not a retake", () => {
    const award = (chain: number, text: string) => R("penalty_awarded", 2300, { chain, side: "away", text });
    const ev = feed(
      award(7, "PENALTY to MET! P. Blue is brought down by W. Scott"),
      R("penalty_setup", 2300, { chain: 7, side: "away" }),
      R("penalty_woodwork", 2300, { chain: 7, side: "away", text: "R. Chrome hits the bar from the spot!" }),
      R("restart", 2300, { side: "home" }),
      award(9, "PENALTY to MET! M. Pulse is brought down by O. Henry"),
    );
    const rows = feedRows(ev, listed);
    expect(rows.map((r) => r.text)).toEqual([
      "PENALTY to MET! P. Blue is brought down by W. Scott — R. Chrome hits the bar from the spot!",
      "PENALTY to MET! M. Pulse is brought down by O. Henry (2nd penalty of the match, a new foul in the box)",
    ]);
    expect(rows[0].e.t).toBe("penalty_woodwork");
    const kicked = [...ev, R("penalty_goal", 2700, { chain: 9, side: "away", text: "PENALTY SCORED! R. Chrome scores for MET" })(6)];
    expect(texts(kicked)[1]).toBe("PENALTY to MET! M. Pulse is brought down by O. Henry (2nd penalty of the match, a new foul in the box) — PENALTY SCORED! R. Chrome scores for MET");
  });

  it("on real matches: every listed event is on exactly one row, attacks are never split, and nothing is dropped", () => {
    let pairs = 0;
    let pens = 0;
    for (const { events } of runs.slice(0, 60)) {
      const shown = events.filter(listed);
      const rows = feedRows(events, listed);
      for (const e of shown) expect(rows.some((r) => r.text.includes(e.text)), `${e.t} #${e.seq}`).toBe(true);
      const merged = rows.filter((r) => r.e.t !== "penalty_awarded" && r.text !== r.e.text);
      expect(rows.length).toBe(shown.length - merged.length);
      pairs += merged.length;
      for (const r of rows) {
        expect(r.e.t, r.text).not.toBe("shot"); // finished matches: every shot is on its result's row
        if (r.e.t.startsWith("penalty_")) {
          pens++;
          expect(r.text, r.text).toContain("brought down by");
        }
      }
    }
    expect(pairs).toBeGreaterThan(300);
    expect(pens).toBeGreaterThan(3);
  });
});
