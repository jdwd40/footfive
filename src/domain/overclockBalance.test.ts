/**
 * Overclock edge (#134). Real hook engine and effectiveStats only.
 * OVERCLOCK_HOOKS points at a pb_hooks directory; the default is this worktree.
 * The >3% net-benefit case is the one that must fail on the old 1.06 bonus.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const hooks = process.env.OVERCLOCK_HOOKS
  ? path.resolve(process.env.OVERCLOCK_HOOKS)
  : path.resolve(__dirname, "../../pocketbase/pb_hooks");
const require = createRequire(import.meta.url);
const eng = require(path.join(hooks, "lib/matchEngine.js"));
const eff = require(path.join(hooks, "lib/effectiveStats.js"));
const { BALANCE } = require(path.join(hooks, "lib/balance.js"));

type Stance = "defend" | "balanced" | "attack";
type Intensity = "passive" | "balanced" | "aggressive";
type Player = {
  id: string;
  name: string;
  role: string;
  attack: number;
  defence: number;
  energy: number;
  condition: number;
  intensity: Intensity;
  is_starter: boolean;
};
type Team = {
  id: string;
  name: string;
  abbr: string;
  grade: string;
  ai: boolean;
  stance: Stance;
  oc?: boolean;
  overclock?: boolean;
  players: Player[];
};
type Profile = "peer" | "strongattack" | "strongdefence";

const ROLES = ["gk", "def", "mid", "mid", "att", "att", "def"];
const COST = 8;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const attrs: Record<Profile, { attack: number; defence: number }> = {
  peer: { attack: 70, defence: 70 },
  strongattack: { attack: 90, defence: 70 },
  strongdefence: { attack: 70, defence: 90 },
};

const roster = (id: string, attack: number, defence: number, energy: number, condition: number, intensity: Intensity): Player[] =>
  ROLES.map((role, i) => ({
    id: `${id}-p${i}`,
    name: `${id} Player ${i}`,
    role,
    attack,
    defence,
    energy,
    condition,
    intensity,
    is_starter: i < 5,
  }));

const team = (id: string, attack: number, defence: number, energy = 100, condition = 100, intensity: Intensity = "balanced", stance: Stance = "balanced"): Team => ({
  id,
  name: id,
  abbr: id.slice(0, 3).toUpperCase(),
  grade: "B",
  ai: false,
  stance,
  players: roster(id, attack, defence, energy, condition, intensity),
});

/** Pay the configured cost from the five starters only, then mark oc. Never a free bonus. */
function paid(side: Team, cost = BALANCE.overclockEnergyCost): Team {
  let starters = 0;
  const players = side.players.map(p => {
    if (!p.is_starter) return { ...p };
    starters += 1;
    return { ...p, energy: Math.min(100, Math.max(0, p.energy - cost)) };
  });
  if (starters !== 5) throw new Error("expected five starters");
  return { ...side, oc: true, players };
}

const kickoff = (home: Team, away: Team, seed = 1000) =>
  eng.createMatch({
    fixtureId: `overclock-${seed}-peer-e100c100-home`,
    seed,
    kickoffAt: 0,
    timing: eng.buildTiming(8000, 1),
    home,
    away,
  });

const subject = (energy = 100, condition = 100, intensity: Intensity = "balanced", stance: Stance = "balanced") =>
  team("subject", 70, 70, energy, condition, intensity, stance);
const opponent = (profile: Profile) => team("opponent", attrs[profile].attack, attrs[profile].defence);

describe("paid overclock net benefit", () => {
  it("improves full-fitness effective attack and defence by more than 3%", () => {
    expect(BALANCE.overclockEnergyCost).toBe(COST);
    for (const role of ["gk", "def", "mid", "att"]) {
      const input = { role, attack: 70, defence: 70, condition: 100, intensity: "balanced", is_starter: true };
      const unpaid = eff.effectivePlayerStats({ ...input, energy: 100 }, { overclock: false });
      const charged = eff.effectivePlayerStats({ ...input, energy: 100 - COST }, { overclock: true });
      expect(charged.attack / unpaid.attack).toBeGreaterThan(1.03);
      expect(charged.defence / unpaid.defence).toBeGreaterThan(1.03);
    }
  });
});

describe("kickoff prices, cost and bench", () => {
  it("stores the debited energy as e0 and prices the charged overclocked side", () => {
    expect(BALANCE.commandChargeCosts.overclock).toBe(2);
    expect(BALANCE.overclockEnergyCost).toBe(COST);
    const full = subject();
    const off = kickoff(full, opponent("peer"));
    const on = kickoff(paid(full), opponent("peer"));
    const free = kickoff({ ...full, oc: true }, opponent("peer"));
    const misnamed = kickoff({ ...full, overclock: true }, opponent("peer"));

    expect(off.teams.home.oc).toBe(false);
    expect(on.teams.home.oc).toBe(true);
    expect(on.teams.away.oc).toBe(false);
    expect(misnamed.teams.home.oc).toBe(false);
    for (const player of on.teams.home.players) {
      if (player.is_starter) {
        expect(player.energy).toBe(92);
        expect(player.e0).toBe(92);
      } else {
        expect(player.energy).toBe(100);
        expect(player.e0).toBe(100);
      }
    }
    expect(on.teams.away.players.every((p: { energy: number; e0: number }) => p.energy === 100 && p.e0 === 100)).toBe(true);
    expect(off.rc).toBe(0);

    const clamped = kickoff(paid(subject(5, 100)), opponent("peer"), 3);
    const lowStarters = clamped.teams.home.players.filter((p: { is_starter: boolean }) => p.is_starter);
    const lowBench = clamped.teams.home.players.filter((p: { is_starter: boolean }) => !p.is_starter);
    expect(lowStarters.map((p: { e0: number }) => p.e0)).toEqual([0, 0, 0, 0, 0]);
    expect(lowBench.map((p: { e0: number }) => p.e0)).toEqual([5, 5]);

    const priced = {
      off: eng.goalRates(off),
      on: eng.goalRates(on),
      free: eng.goalRates(free),
      costOnly: eng.goalRates(kickoff({ ...paid(full), oc: false }, opponent("peer"), 4)),
    };
    expect(priced.on.home).not.toBe(priced.free.home);
    expect(priced.on.home).not.toBe(priced.costOnly.home);
    expect(priced.free.home).toBeGreaterThan(priced.off.home);
    expect(priced.off.home).toBeGreaterThan(priced.costOnly.home);

    const vsDefence = eng.goalRates(kickoff(paid(full), opponent("strongdefence"), 5));
    const vsAttack = eng.goalRates(kickoff(paid(full), opponent("strongattack"), 6));
    expect(vsDefence.home).toBeLessThan(priced.on.home);
    expect(vsAttack.away).toBeGreaterThan(priced.on.away);
  });

  it("charges the away subject and leaves the home opponent intact", () => {
    const st = kickoff(opponent("peer"), paid(subject(60, 100)), 7);
    expect(st.teams.away.oc).toBe(true);
    expect(st.teams.home.oc).toBe(false);
    expect(st.teams.away.players.filter((p: { is_starter: boolean }) => p.is_starter).every((p: { e0: number }) => p.e0 === 52)).toBe(true);
    expect(st.teams.away.players.filter((p: { is_starter: boolean }) => !p.is_starter).every((p: { e0: number }) => p.e0 === 60)).toBe(true);
    expect(st.teams.home.players.every((p: { e0: number }) => p.e0 === 100)).toBe(true);
  });
});

describe("existing tactics still combine with overclock", () => {
  it("keeps the stance tradeoff, higher aggressive attack, and the intensity wear cost on a paid side", () => {
    const defend = eng.goalRates(kickoff(paid(subject(100, 100, "balanced", "defend")), opponent("peer"), 8));
    const attack = eng.goalRates(kickoff(paid(subject(100, 100, "balanced", "attack")), opponent("peer"), 8));
    expect(attack.home).toBeGreaterThan(defend.home);
    expect(attack.away).toBeGreaterThan(defend.away);

    const sheet = { role: "mid", attack: 70, defence: 70, energy: 92, condition: 100, is_starter: true };
    const aggressive = eff.effectivePlayerStats({ ...sheet, intensity: "aggressive" }, { overclock: true });
    const passive = eff.effectivePlayerStats({ ...sheet, intensity: "passive" }, { overclock: true });
    expect(aggressive.attack).toBeGreaterThan(passive.attack);

    const worn = (intensity: Intensity) => {
      const st = kickoff(paid(subject(100, 100, intensity)), opponent("peer"), 21);
      const events = eng.advanceTo(st, Infinity);
      const starters = st.teams.home.players.filter((p: { is_starter: boolean }) => p.is_starter);
      return {
        energy: starters.reduce((n: number, p: { energy: number }) => n + p.energy, 0) / starters.length,
        condition: starters.reduce((n: number, p: { condition: number }) => n + p.condition, 0) / starters.length,
        events,
      };
    };
    const hard = worn("aggressive");
    const soft = worn("passive");
    expect(hard.energy).toBeLessThan(soft.energy);
    expect(hard.condition).toBeLessThan(soft.condition);

    const st = kickoff(paid(subject()), opponent("peer"), 22);
    let steps = 0;
    while (st.minute < 70 && st.phase !== "finished") {
      expect(++steps).toBeLessThan(200);
      eng.advanceTo(st, st.nextAt);
    }
    expect(st.minute).toBe(70);
    eng.queueStance(st, "home", "attack");
    const tail = eng.advanceTo(st, Infinity);
    const applied = tail.filter((e: { t: string; by?: string; side?: string }) => e.t === "coaching" && e.by === "manager" && e.side === "home");
    expect(applied).toHaveLength(1);
    expect(applied[0].min).toBe(71);
    expect(applied[0].stance).toBe("attack");
    expect(st.teams.home.stance).toBe("attack");
    expect(st.teams.home.oc).toBe(true);
    expect(st.pending.home).toBeUndefined();
  });
});

describe("OC-on determinism", () => {
  const PHASES = new Set(["pre", "first_half", "half_time", "second_half", "et_break", "extra_time_1", "et_half_time", "extra_time_2", "shootout", "finished"]);

  function validate(st: { phase: string; winner: string; by: string; seq: number; score: number[]; teams: { home: { players: { energy: number; condition: number }[] }; away: { players: { energy: number; condition: number }[] } } }, events: { t: string; seq: number; at: number; side?: string; min?: number; st: { ph: string; sc: number[] } }[]) {
    expect(st.phase).toBe("finished");
    expect(["home", "away"]).toContain(st.winner);
    expect(["normal", "aet", "pens"]).toContain(st.by);
    expect(events.filter(e => e.t === "match_end")).toHaveLength(1);
    expect(events.at(-1)?.t).toBe("match_end");
    expect(st.seq).toBe(events.length);
    let at = -Infinity;
    for (const [i, event] of events.entries()) {
      expect(event.seq).toBe(i + 1);
      expect(event.at).toBeGreaterThanOrEqual(at);
      at = event.at;
      expect(PHASES.has(event.st.ph)).toBe(true);
      expect(event.st.sc.every(n => Number.isInteger(n) && n >= 0)).toBe(true);
    }
    expect(st.score).toEqual(["home", "away"].map(side => events.filter(e => ["goal", "penalty_goal"].includes(e.t) && e.side === side).length));
    expect(events.at(-1)?.st.sc).toEqual(st.score);
    for (const side of ["home", "away"] as const) {
      for (const player of st.teams[side].players) {
        expect(player.energy).toBeGreaterThanOrEqual(0);
        expect(player.energy).toBeLessThanOrEqual(100);
        expect(player.condition).toBeGreaterThanOrEqual(0);
        expect(player.condition).toBeLessThanOrEqual(100);
      }
    }
  }

  function full(seed: number) {
    const st = kickoff(paid(subject()), opponent("peer"), seed);
    const events = eng.advanceTo(st, Infinity);
    return { st, events };
  }

  function persisted(seed: number) {
    let st = kickoff(paid(subject()), opponent("peer"), seed);
    let previousNow = -Infinity;
    let steps = 0;
    const events: { t: string; seq: number; at: number; side?: string; st: { ph: string; sc: number[] } }[] = [];
    while (st.phase !== "finished") {
      expect(++steps).toBeLessThan(500);
      st = clone(st);
      const cursor = st.nextAt;
      expect(Number.isFinite(cursor)).toBe(true);
      expect(cursor).toBeGreaterThanOrEqual(previousNow);
      if (cursor - 1 >= previousNow) {
        const before = hash(st);
        expect(eng.advanceTo(st, cursor - 1)).toEqual([]);
        expect(hash(st)).toBe(before);
      }
      events.push(...eng.advanceTo(st, cursor));
      previousNow = cursor;
      const after = hash(st);
      expect(eng.advanceTo(st, cursor)).toEqual([]);
      expect(hash(st)).toBe(after);
    }
    return { st, events };
  }

  function same(reference: { st: { score: number[]; stats: unknown; rc: number }; events: unknown[] }, actual: { st: { score: number[]; stats: unknown; rc: number }; events: unknown[] }, label: string) {
    expect(actual.st.score, label).toEqual(reference.st.score);
    expect(actual.st.stats, label).toEqual(reference.st.stats);
    expect(actual.st.rc, label).toBe(reference.st.rc);
    expect(hash(actual.events), label).toBe(hash(reference.events));
    expect(hash(actual.st), label).toBe(hash(reference.st));
  }

  it("repeats and resumes 200 seeds with the same score, stats, RNG and events", () => {
    for (let i = 0; i < 200; i++) {
      const seed = 1000 + i;
      const reference = full(seed);
      validate(reference.st, reference.events);
      same(reference, full(seed), `fresh ${seed}`);
      const replay = persisted(seed);
      same(reference, replay, `resume ${seed}`);
      validate(replay.st, replay.events);
    }
  }, 180_000);
});
