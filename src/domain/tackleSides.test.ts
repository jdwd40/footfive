// Issue #74: "X takes it off Y" / tackles / interceptions must involve players from opposite sides.
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const team = (i: number) => {
  const t = TEAMS[i];
  return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) };
};
const timing = eng.buildTiming(1000, 1);

describe("tackle / interception sides (#74)", () => {
  it("p and p2 are on opposite sides for every dispossession event across many seeds", () => {
    let checked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const h = seed % TEAMS.length;
      const a = (seed * 7 + 1) % TEAMS.length === h ? (h + 1) % TEAMS.length : (seed * 7 + 1) % TEAMS.length;
      const home = team(h), away = team(a);
      const sideOf = new Map<string, Set<string>>();
      for (const [s, t] of [["home", home], ["away", away]] as const)
        for (const p of t.players) (sideOf.get(p.name) ?? sideOf.set(p.name, new Set()).get(p.name)!).add(s);
      const shared = (n: string) => (sideOf.get(n)?.size ?? 0) > 1;
      const st = eng.createMatch({ fixtureId: "f" + seed, seed, kickoffAt: 0, home, away, timing });
      for (const e of eng.advanceTo(st, 1e12)) {
        const text: string = e.text ?? "";
        const dispossess = e.t === "tackle" || e.t === "interception" || / takes it off /.test(text);
        if (!dispossess || !e.p || !e.p2 || shared(e.p) || shared(e.p2)) continue;
        const sp = [...sideOf.get(e.p)!][0], sp2 = [...sideOf.get(e.p2)!][0];
        expect(sp, `${e.t} seed ${seed}: ${text}`).not.toBe(sp2);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
