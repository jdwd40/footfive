/**
 * Fitness and investments (#135) — one fitness policy for the engine, scouting estimates and AI line-ups;
 * cheaper (not bigger) upgrades; batteries unchanged. Runs against the real PocketBase hook modules.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const eff = lib("effectiveStats.js");
const bal = lib("balance.js");
const mgmt = lib("managementService.js") as { aiLineup: (players: object[]) => Array<{ id: string; role: string; is_starter: boolean }> };
const { BALANCE } = bal;

type Fitness = { energyImpact: number; conditionImpact: number };
type Variant = { energy?: number; condition?: number; attack?: number; oc?: boolean };
type Ev = { seq: number; at: number; t: string; side?: string; min: number; st: { ph: string; sc: number[] } };

const ROLES = ["gk", "def", "mid", "mid", "att", "att", "def"];
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const player = (o: object = {}) => ({ attack: 70, defence: 70, role: "mid", energy: 100, condition: 100, intensity: "balanced", ...o });

/** Run `fn` under another fitness policy (the old 0.65/0.70 constants), always restoring the shipped one. */
function withFitness<T>(fitness: Fitness, fn: () => T): T {
  const shipped = BALANCE.fitness;
  BALANCE.fitness = fitness;
  try {
    return fn();
  } finally {
    BALANCE.fitness = shipped;
  }
}
const OLD: Fitness = { energyImpact: 0.65, conditionImpact: 0.7 };

/** Manual grade-B squad: seven players, five starters; `v` applies to the whole squad except Overclock's paid debit. */
const squad = (id: string, attack: number, defence: number, v: Variant = {}) => ({
  id,
  name: id,
  abbr: id.slice(0, 3).toUpperCase(),
  grade: "B",
  ai: false,
  stance: "balanced",
  oc: !!v.oc,
  players: ROLES.map((role, i) => ({
    id: `${id}-p${i}`,
    name: `${id} ${i}`,
    role,
    attack: attack + (i >= 2 && i <= 4 ? v.attack || 0 : 0),
    defence,
    energy: v.oc && i < 5 ? Math.max(0, (v.energy ?? 100) - BALANCE.overclockEnergyCost) : v.energy ?? 100,
    condition: v.condition ?? 100,
    intensity: "balanced",
    is_starter: i < 5,
  })),
});
const kickoff = (home: object, away: object, seed = 1) =>
  eng.createMatch({ fixtureId: "fit-" + seed, seed, kickoffAt: 0, home, away, timing: eng.buildTiming(8000, 1) });
const rates = (home: object, away: object): { home: number; away: number } => eng.goalRates(kickoff(home, away));

describe("one bounded fitness policy", () => {
  it("is a flatter, monotone, bounded curve: full fitness costs nothing and an empty tank never zeroes a player", () => {
    const { energyImpact, conditionImpact } = BALANCE.fitness;
    for (const k of [energyImpact, conditionImpact]) {
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(OLD.energyImpact);
      expect(eff.fitnessFactor(100, k)).toBe(1);
      expect(eff.fitnessFactor(0, k)).toBeCloseTo(1 - k, 12);
      for (let x = 0; x < 100; x += 5) expect(eff.fitnessFactor(x + 5, k)).toBeGreaterThan(eff.fitnessFactor(x, k));
    }
  });

  it("tired or worn players still lose output, but less than under the old 0.65/0.70 constants", () => {
    const full = eff.effectivePlayerStats(player(), {});
    for (const worn of [{ energy: 60 }, { condition: 50 }, { energy: 20, condition: 40 }]) {
      const now = eff.effectivePlayerStats(player(worn), {});
      const old = withFitness(OLD, () => eff.effectivePlayerStats(player(worn), {}));
      expect(now.attack).toBeLessThan(full.attack);
      expect(now.defence).toBeLessThan(full.defence);
      expect(now.attack).toBeGreaterThan(old.attack);
      expect(now.defence).toBeGreaterThan(old.defence);
    }
    // The old constants reproduce the old formula exactly: the policy is the only thing that changed.
    const old60 = withFitness(OLD, () => eff.effectivePlayerStats(player({ energy: 60, condition: 50 }), {}));
    expect(old60.energyFactor).toBeCloseTo(0.35 + 0.65 * 0.6, 12);
    expect(old60.conditionFactor).toBeCloseTo(0.3 + 0.7 * 0.5, 12);
  });

  it("keeps the existing clamps, defaults and sent-off behaviour", () => {
    const at = (o: object) => eff.effectivePlayerStats(player(o), {});
    expect(at({ energy: 150, condition: 180 })).toEqual(at({}));
    expect(at({ energy: -20, condition: -5 })).toEqual(at({ energy: 0, condition: 0 }));
    expect(at({ energy: null, condition: undefined })).toEqual(at({}));
    expect(eff.effectivePlayerStats(player({ energy: 40 }), { sentOff: true })).toEqual({ attack: 0, defence: 0, energyFactor: 0, conditionFactor: 0 });
  });

  it("drives the engine's chance model: a tired side creates less and concedes more, by less than before", () => {
    const opp = squad("opp", 70, 70);
    const full = rates(squad("sub", 70, 70), opp);
    const tired = rates(squad("sub", 70, 70, { energy: 60 }), opp);
    const oldTired = withFitness(OLD, () => rates(squad("sub", 70, 70, { energy: 60 }), opp));
    expect(tired.home).toBeLessThan(full.home);
    expect(tired.away).toBeGreaterThan(full.away);
    expect(tired.home).toBeGreaterThan(oldTired.home);
    expect(tired.away).toBeLessThan(oldTired.away);
    // In-match wear itself is unchanged: drain per minute, so stored energy/condition move exactly as before.
    const st = kickoff(squad("sub", 70, 70), opp, 3);
    while (st.minute < 20) eng.advanceTo(st, st.nextAt);
    const gk = st.teams.home.players.find((p: { role: string; is_starter: boolean }) => p.role === "gk" && p.is_starter);
    expect(gk.energy).toBeCloseTo(100 - 20 * BALANCE.energyDrainPerMinute, 9);
    expect(gk.condition).toBeCloseTo(100 - 20 * BALANCE.conditionWearPerMinute, 9);
  });

  it("paid Overclock still costs its energy and stays worth it for a tired squad", () => {
    expect(BALANCE.overclockEnergyCost).toBe(8);
    const opp = squad("opp", 70, 70);
    for (const energy of [100, 60]) {
      const off = rates(squad("sub", 70, 70, { energy }), opp);
      const on = rates(squad("sub", 70, 70, { energy, oc: true }), opp);
      expect(on.home).toBeGreaterThan(off.home);
      expect(on.away).toBeLessThan(off.away);
    }
  });
});

describe("AI line-ups use the same fitness policy", () => {
  // One keeper and six midfielders: the algorithm picks the keeper plus the four fittest outfield players.
  const roster = (overrides: Record<string, object>) =>
    ["g", "a", "b", "c", "d", "e", "star"].map((id, i) => ({
      id,
      name: id,
      role: id === "g" ? "gk" : "mid",
      attack: 70,
      defence: 70,
      energy: 100,
      condition: 100,
      sort_order: i,
      ...overrides[id],
    }));
  const starters = (list: Array<{ id: string; is_starter: boolean }>) => list.filter((p) => p.is_starter).map((p) => p.id);

  it("keeps a tired star the engine still rates above a fresh reserve, where the old weights benched him", () => {
    const players = roster({ star: { attack: 90, defence: 90, energy: 40 } });
    expect(starters(mgmt.aiLineup(players))).toEqual(["g", "a", "b", "c", "star"]);
    const star = eff.effectivePlayerStats({ ...players[6], intensity: "balanced" }, {});
    const fresh = eff.effectivePlayerStats({ ...players[1], intensity: "balanced" }, {});
    expect(star.attack).toBeGreaterThan(fresh.attack);
    expect(star.defence).toBeGreaterThan(fresh.defence);
    expect(withFitness(OLD, () => starters(mgmt.aiLineup(players)))).toEqual(["g", "a", "b", "c", "d"]);
  });

  it("keeps the selection algorithm: the fittest four outfield, roster order on ties, inputs untouched", () => {
    const players = roster({ a: { condition: 20 } });
    const before = clone(players);
    const list = mgmt.aiLineup(players);
    expect(players).toEqual(before);
    expect(list.map((p) => p.id)).toEqual(players.map((p) => p.id));
    expect(starters(list)).toEqual(["g", "b", "c", "d", "e"]);
    expect(starters(mgmt.aiLineup(roster({})))).toEqual(["g", "a", "b", "c", "d"]);
  });
});

describe("investments", () => {
  it("upgrades stay +1 per purchase but cost less: prospective prices, no bigger stat step", () => {
    expect(BALANCE.upgradeBaseCost).toBe(80);
    expect(BALANCE.upgradeGrowth).toBe(1.04);
    expect(BALANCE.attrMax).toBe(100);
    expect([50, 60, 70, 80, 90].map(bal.upgradeCost)).toEqual([118, 175, 259, 384, 568]);
    let thirty = 0;
    for (let n = 0; n < 3; n++) for (let level = 70; level < 80; level++) thirty += bal.upgradeCost(level);
    expect(thirty).toBe(9330); // +10 on three 70-rated players (34,974 at the old 1.08 growth)
    for (let level = 40; level < 99; level++) expect(bal.upgradeCost(level + 1)).toBeGreaterThanOrEqual(bal.upgradeCost(level));
  });

  it("an upgrade still makes the side stronger in the engine", () => {
    const opp = squad("opp", 70, 70);
    const base = rates(squad("sub", 70, 70), opp);
    const upgraded = rates(squad("sub", 70, 70, { attack: 10 }), opp);
    expect(upgraded.home).toBeGreaterThan(base.home);
  });

  it("batteries are unchanged: up to 40 energy each for 180 credits", () => {
    expect(BALANCE.batteryRestore).toBe(40);
    expect(BALANCE.batteryCost).toBe(180);
  });
});

describe("same configuration, same match", () => {
  const VARIANTS: Variant[] = [{ energy: 60 }, { condition: 50 }, { energy: 20 }, { attack: 10 }, { energy: 60, oc: true }];
  const PROFILES = [[70, 70], [90, 70], [70, 90]];
  const input = (i: number) => {
    const subject = squad("subject", 70, 70, VARIANTS[i % VARIANTS.length]);
    const [a, d] = PROFILES[i % PROFILES.length];
    const opponent = squad("opponent", a, d);
    return i % 2 ? { home: opponent, away: subject, seed: 2000 + i } : { home: subject, away: opponent, seed: 2000 + i };
  };
  const full = (i: number) => {
    const { home, away, seed } = input(i);
    const st = kickoff(home, away, seed);
    return { st, events: eng.advanceTo(st, Infinity) as Ev[] };
  };
  const persisted = (i: number) => {
    const { home, away, seed } = input(i);
    let st = kickoff(home, away, seed);
    const events: Ev[] = [];
    let steps = 0;
    while (st.phase !== "finished") {
      expect(++steps).toBeLessThan(500);
      st = clone(st);
      const cursor = st.nextAt;
      expect(eng.advanceTo(st, cursor - 1)).toEqual([]);
      events.push(...eng.advanceTo(st, cursor));
    }
    return { st, events };
  };
  const same = (a: { st: object; events: Ev[] }, b: { st: object; events: Ev[] }, label: string) => {
    expect(hash(b.events), label).toBe(hash(a.events));
    expect(hash(b.st), label).toBe(hash(a.st));
  };

  it("repeats and resumes 200 tired, worn, upgraded and overclocked matches identically, with valid streams", () => {
    for (let i = 0; i < 200; i++) {
      const ref = full(i);
      same(ref, full(i), `repeat ${i}`);
      same(ref, persisted(i), `resume ${i}`);
      const { st, events } = ref;
      expect(st.phase).toBe("finished");
      expect(events.at(-1)?.t).toBe("match_end");
      events.forEach((e, n) => {
        expect(e.seq).toBe(n + 1);
        if (n) expect(e.at).toBeGreaterThanOrEqual(events[n - 1].at);
      });
      expect(st.score).toEqual(["home", "away"].map((side) => events.filter((e) => (e.t === "goal" || e.t === "penalty_goal") && e.side === side).length));
      for (const side of ["home", "away"]) {
        for (const p of st.teams[side].players) {
          expect(p.energy).toBeGreaterThanOrEqual(0);
          expect(p.condition).toBeGreaterThanOrEqual(0);
          expect(p.energy).toBeLessThanOrEqual(p.e0);
          expect(p.condition).toBeLessThanOrEqual(p.c0);
        }
      }
    }
  }, 120_000);
});
