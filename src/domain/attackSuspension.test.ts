/** #229: a published build-up already reveals the attack; no selection can be accepted until it resolves. */
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchEvent } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js"), markets = lib("markets.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");
const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true };
};
const play = (i: number) => {
  const st = eng.createMatch({ fixtureId: "s" + i, seed: eng.hashSeed("suspend" + i), kickoffAt: 0, home: team(i % 16), away: team((i % 16 + 1 + Math.floor(i / 16) % 15) % 16), timing: eng.buildTiming(6000, 1) });
  const events: MatchEvent[] = eng.advanceTo(st, Infinity).filter((e: MatchEvent) => !e.cos);
  return { st, events };
};

describe("published attacks suspend markets from the first row (#229)", () => {
  it("blocks every row of normal/counter attacks until the public result, and reopens on every terminal turnover or shot result", () => {
    const seen = new Set<string>();
    const catalogued = new Set<string>();
    let attacks = 0;
    const fx = { status: "live", kickoffAt: 0, model: { lh: 0.02, la: 0.02 }, home: { id: "h", name: "Home", abbr: "H" }, away: { id: "a", name: "Away", abbr: "A" } };
    for (let i = 0; i < 240; i++) {
      const { events } = play(i);
      for (let j = 0; j < events.length; j++) {
        const first = events[j];
        if (first.t !== "build_up") continue;
        attacks++;
        if (first.ctr) seen.add("counter");
        let resolved = false;
        for (let k = j; k < events.length && events[k].chain === first.chain; k++) {
          const e = events[k];
          const terminal = ["tackle", "interception", "save", "block", "miss", "woodwork"].includes(e.t) && !e.loose;
          if (terminal) {
            resolved = true;
            seen.add(e.t + (e.stop ? ":deep" : ""));
            expect(e.st.d, `terminal ${i}/${e.seq} ${e.t}`).toBe(0);
            expect(markets.fixtureState(fx, e.st, e.at).closed).toBeNull();
          }
          if (["goal", "penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork"].includes(e.t)) {
            resolved = true;
            seen.add(e.t);
            // Goals and penalty results keep the existing hold until their explicit restart.
            expect(e.st.d).toBe(1);
          }
          if (resolved) continue; // goals keep danger set through the restart; boards can follow a result
          expect(e.st.d, `attack ${i}/${e.seq} ${e.t}`).toBe(1);
          expect(markets.fixtureState(fx, e.st, e.at).closed).toBe("Suspended — incident in progress");
          // Exercise selection rejection for every kind of incident; the whole fixture state gates every other row.
          const kind = e.t + (e.ctr ? ":counter" : "") + (e.loose ? ":loose" : "");
          if (!catalogued.has(kind)) {
            catalogued.add(kind);
            const cat = markets.fixtureMarkets(fx, e.st, e.min, e.at);
            for (const m of cat.markets) for (const s of m.sel) {
              expect(markets.findSelection(cat, m.key, s.id)).toEqual({ closed: "Suspended — incident in progress" });
            }
          }
        }
        expect(resolved, `attack ${i}/${first.seq}`).toBe(true);
        const reopen = events.slice(j + 1).find((e) => !e.st.d);
        expect(reopen, `attack ${i}/${first.seq} never reopened`).toBeDefined();
        expect(reopen!.min - first.min).toBeLessThanOrEqual(1);
      }
    }
    expect(attacks).toBeGreaterThan(6000);
    for (const kind of ["counter", "tackle", "interception", "tackle:deep", "interception:deep", "save", "block", "miss", "woodwork", "goal", "penalty_saved", "penalty_missed", "penalty_woodwork"]) expect(seen.has(kind), kind).toBe(true);
  }, 20000);

  it("reloading between simulation steps preserves the entire stream and final state", () => {
    for (let i = 0; i < 16; i++) {
      const full = play(i);
      let st = eng.createMatch({ fixtureId: "s" + i, seed: eng.hashSeed("suspend" + i), kickoffAt: 0, home: team(i % 16), away: team((i % 16 + 1 + Math.floor(i / 16) % 15) % 16), timing: eng.buildTiming(6000, 1) });
      const events: MatchEvent[] = [];
      while (st.phase !== "finished") {
        events.push(...eng.advanceTo(st, st.nextAt).filter((e: MatchEvent) => !e.cos));
        st = JSON.parse(JSON.stringify(st));
      }
      expect(events).toEqual(full.events);
      expect(st).toEqual(JSON.parse(JSON.stringify(full.st)));
    }
  });
});
