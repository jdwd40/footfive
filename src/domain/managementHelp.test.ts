import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #128: squad reads explain the factors effectivePlayerStats actually multiplied.
// Coaching is match tempo and is not one of those factors. The projection adds metadata only.
const require = createRequire(import.meta.url);
const lib = (f: string) => path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f);

type Pair = { attack: number; defence: number };
type Modifiers = {
  base: Pair;
  role: Pair;
  intensity: Pair;
  energy: number;
  condition: number;
  overclock: number;
};
type PublicPlayer = Record<string, unknown> & {
  id: string;
  attack: number;
  defence: number;
  role: string;
  energy: number;
  condition: number;
  intensity: string;
  is_starter: boolean;
  effective_attack: number;
  effective_defence: number;
  effective_modifiers: Modifiers;
};
type Help = { overclockBonus: number; overclockEnergyCost: number; overclockChargeCost: number; tacticalScanChargeCost: number };
type Squad = { players: PublicPlayer[]; managementHelp: Help };

const mgmt = require(lib("managementService.js")) as {
  getSquad: (app: unknown, userId: string) => Squad;
  materialisePlayerEnergy: (app: unknown, player: unknown) => number;
  commandChargeSpend: (app: unknown, userId: string, action: string) => { ok: boolean; bonus: number };
  chargeOverclockStarters: (tx: unknown, players: { id: string; is_starter: boolean; energy?: number }[]) => void;
};
const { BALANCE } = require(lib("balance.js")) as {
  BALANCE: {
    roleWeights: Record<string, Pair>;
    intensity: Record<string, Pair & { energyUse: number; condition: number }>;
    fitness: { energyImpact: number; conditionImpact: number };
    overclockBonus: number;
    overclockEnergyCost: number;
    commandChargeCosts: Record<string, number>;
    commandChargeMax: number;
    coaching: { balanced: { tempo: number; foul: number } };
  };
};
const eff = require(lib("effectiveStats.js")) as {
  effectivePlayerStats: (p: Record<string, unknown>, o?: Record<string, unknown>) => { attack: number; defence: number };
};

type Row = Record<string, unknown> & { id: string };
const COLLECTION: Record<string, string> = {};

/** In-memory PocketBase stand-in: copies on read, logs every save. */
function world(rows: Row[], team: Row, pace: string, extra: Record<string, Row[]> = {}) {
  const db = new Map<string, Row>();
  const put = (collection: string, row: Row) => {
    COLLECTION[row.id] = collection;
    db.set(row.id, { ...row });
  };
  rows.forEach((r) => put("proball_players", r));
  put("proball_teams", team);
  put("command_charge", { id: "cc1", user: "manager1", points: BALANCE.commandChargeMax, last_regen_at: pbDate(Date.now()) });
  put("world", { id: "world", pace });
  Object.entries(extra).forEach(([collection, list]) => list.forEach((r) => put(collection, r)));
  const record = (id: string) => {
    const f = { ...db.get(id)! };
    return {
      id,
      fields: f,
      get: (k: string) => f[k],
      set: (k: string, v: unknown) => void (f[k] = v),
      collection: () => ({ name: COLLECTION[id], fields: { getByName: (n: string) => (n in f ? { name: n } : null) } }),
    };
  };
  const saves: string[] = [];
  const of = (collection: string) => [...db.values()].filter((r) => COLLECTION[r.id] === collection).map((r) => record(r.id));
  const app = {
    db,
    saves,
    findRecordById: (_collection: string, id: string) => record(id),
    findRecordsByFilter: (collection: string) => (collection === "world" ? [record("world")] : of(collection)),
    save: (r: ReturnType<typeof record>) => {
      saves.push(`${COLLECTION[r.id]}/${r.id} ${JSON.stringify(r.fields)}`);
      db.set(r.id, { ...r.fields } as Row);
    },
    runInTransaction: (fn: (tx: unknown) => void) => fn(app),
  };
  return app;
}

const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-17T12:00:00Z");
const team = (extra: Partial<Row> = {}): Row => ({
  id: "team1", name: "Swirl", grade: "B", manager: "manager1", treasury: 2500, battery_count: 1,
  overclock_ready: false, overclock_cost_pending: false, overclock_fixture: "", ...extra,
});

// Every role and intensity, plus the fallbacks the shared policy applies.
const roster: Row[] = [
  { role: "gk", intensity: "balanced", attack: 30, defence: 82, energy: 100, condition: 100 },
  { role: "def", intensity: "passive", attack: 55, defence: 77, energy: 64, condition: 23 },
  { role: "mid", intensity: "aggressive", attack: 71, defence: 66, energy: 37, condition: 58 },
  { role: "att", intensity: "aggressive", attack: 88, defence: 41, energy: 0, condition: 0 },
  { role: "util", intensity: null, attack: 63, defence: 63, energy: null, condition: null },
  { role: "GK", intensity: "turbo", attack: 0, defence: null, energy: 91, condition: 12 },
  { role: null, intensity: "passive", attack: 99, defence: 1, energy: 13, condition: 100 },
].map((f, i) => ({ id: `p${i}`, name: `P${i}`, is_starter: i < 5, sort_order: i, energy_updated_at: pbDate(T0), ...f }));

/** The product effectivePlayerStats rounds, in that function's order, with no coaching term. */
const rebuild = (m: Modifiers, stat: keyof Pair) =>
  Math.round(m.base[stat] * m.role[stat] * m.intensity[stat] * m.energy * m.condition * m.overclock * 10) / 10;

function expectReconciled(players: PublicPlayer[], armed: boolean) {
  for (const p of players) {
    const m = p.effective_modifiers;
    expect(m).not.toHaveProperty("coaching");
    expect(m).not.toHaveProperty("stance");
    const numbers = [m.base, m.role, m.intensity].flatMap((x) => [x.attack, x.defence]).concat(m.energy, m.condition, m.overclock);
    expect(numbers.every(Number.isFinite), `${p.id} finite factors`).toBe(true);
    expect([rebuild(m, "attack"), rebuild(m, "defence")], `${p.id} reconciles`).toEqual([p.effective_attack, p.effective_defence]);
    const stats = eff.effectivePlayerStats(
      { attack: p.attack, defence: p.defence, role: p.role, energy: p.energy, condition: p.condition, intensity: p.intensity },
      { overclock: armed, coachingStance: "attack" },
    );
    expect([p.effective_attack, p.effective_defence], `${p.id} matches effectivePlayerStats`).toEqual([stats.attack, stats.defence]);
  }
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  g.BadRequestError = class BadRequestError extends Error {};
  g.ForbiddenError = class ForbiddenError extends Error {};
});
afterEach(() => {
  vi.useRealTimers();
  delete g.BadRequestError;
  delete g.ForbiddenError;
});

describe("effective_modifiers explain the squad's effective stats", () => {
  for (const armed of [false, true]) {
    it(`base x every factor gives the shown effective stats (Overclock ${armed ? "armed" : "not armed"})`, () => {
      const squad = mgmt.getSquad(world(roster, team({ overclock_ready: armed }), "live"), "manager1");
      expectReconciled(squad.players, armed);
      const m = Object.fromEntries(squad.players.map((p) => [p.id, p.effective_modifiers]));
      expect(m.p5.role).toEqual(m.p4.role);
      expect(m.p5.intensity).toEqual(m.p0.intensity);
      expect(m.p6.role).toEqual(m.p4.role);
      expect(m.p5.base).toEqual({ attack: 50, defence: 50 });
      expect(squad.players.find((p) => p.id === "p5")!.attack).toBe(0);
      expect([m.p4.energy, m.p4.condition]).toEqual([1, 1]);
      expect(new Set(squad.players.map((p) => p.effective_modifiers.overclock))).toEqual(new Set([armed ? squad.managementHelp.overclockBonus : 1]));
    });
  }

  it("follows the live policy rather than fixed numbers", () => {
    const shipped = {
      roleWeights: BALANCE.roleWeights,
      intensity: BALANCE.intensity,
      fitness: BALANCE.fitness,
      overclockBonus: BALANCE.overclockBonus,
      overclockEnergyCost: BALANCE.overclockEnergyCost,
      commandChargeCosts: BALANCE.commandChargeCosts,
    };
    try {
      BALANCE.roleWeights = { ...BALANCE.roleWeights, util: { attack: 0.77, defence: 0.91 } };
      BALANCE.intensity = { ...BALANCE.intensity, aggressive: { ...BALANCE.intensity.aggressive, attack: 1.21, defence: 0.86 } };
      BALANCE.fitness = { energyImpact: 0.5, conditionImpact: 0.2 };
      BALANCE.overclockBonus = 1.2;
      BALANCE.overclockEnergyCost = 9;
      BALANCE.commandChargeCosts = { ...BALANCE.commandChargeCosts, overclock: 3, tactical_scan: 2 };
      const squad = mgmt.getSquad(world(roster, team({ overclock_ready: true }), "live"), "manager1");
      expectReconciled(squad.players, true);
      expect(squad.players[5].effective_modifiers.role).toEqual({ attack: 0.77, defence: 0.91 });
      expect(squad.players[2].effective_modifiers.energy).toBeCloseTo(1 - 0.5 * 0.63, 12);
      expect(squad.managementHelp).toEqual({ overclockBonus: 1.2, overclockEnergyCost: 9, overclockChargeCost: 3, tacticalScanChargeCost: 2 });
      expect(squad.players[2].effective_modifiers).not.toHaveProperty("coaching");
    } finally {
      Object.assign(BALANCE, shipped);
    }
  });

  it("attributes a rise with no action to energy recovery alone", () => {
    const tired = [{ ...roster[2], energy: 40, energy_updated_at: pbDate(T0 - 3 * HOUR) }];
    const app = world(tired, team(), "live");
    const first = mgmt.getSquad(app, "manager1").players[0];
    vi.setSystemTime(T0 + HOUR);
    const later = mgmt.getSquad(app, "manager1").players[0];
    expect([first.energy, later.energy]).toEqual([76, 88]);
    expect(later.effective_attack).toBeGreaterThan(first.effective_attack);
    expect(later.effective_defence).toBeGreaterThan(first.effective_defence);
    const { energy: e1, ...rest1 } = first.effective_modifiers;
    const { energy: e2, ...rest2 } = later.effective_modifiers;
    expect(e2).toBeGreaterThan(e1);
    expect(rest2).toEqual(rest1);
    expectReconciled([first, later], false);
  });
});

describe("the projection keeps the existing energy writes and fields", () => {
  it("saves exactly what energy materialisation alone saves, and nothing on a repeat read", () => {
    const stale = roster.map((r, i) => ({ ...r, energy_updated_at: i % 2 ? pbDate(T0 - 2.37 * HOUR) : null }));
    const read = world(stale, team({ overclock_ready: true }), "live");
    const reference = world(stale, team({ overclock_ready: true }), "live");
    const squad = mgmt.getSquad(read, "manager1");
    stale.forEach((r) => mgmt.materialisePlayerEnergy(reference, reference.findRecordById("proball_players", r.id)));
    expect(read.saves.length).toBeGreaterThan(0);
    expect(read.saves).toEqual(reference.saves);
    expect([...read.db.entries()]).toEqual([...reference.db.entries()]);
    for (const p of squad.players) {
      expect(p).toHaveProperty("upgrade_cost");
      expect(p).toHaveProperty("effective_attack");
      expect(p.effective_modifiers).toBeTruthy();
    }
    read.saves.length = 0;
    mgmt.getSquad(read, "manager1");
    expect(read.saves).toEqual([]);
  });
});

describe("managementHelp describes what the actions do", () => {
  it("arming costs the shown Charge, previews the shown boost, and the five pay the shown energy at kick-off", () => {
    const fit = roster.map((r) => ({ ...r, energy: 70, energy_updated_at: pbDate(T0) }));
    // Arming needs a next kick-off (#42). The fake ignores filters, so this row must truly match one.
    const next = { id: "fx1", status: "scheduled", home_team: "team1", away_team: "team2", scheduled_at: pbDate(T0 + 60_000) };
    const app = world(fit, team(), "live", { shared_fixtures: [next] });
    const help = mgmt.getSquad(app, "manager1").managementHelp;
    const before = mgmt.getSquad(app, "manager1").players;

    expect(mgmt.commandChargeSpend(app, "manager1", "overclock").bonus).toBe(help.overclockBonus);
    expect(app.db.get("cc1")!.points).toBe(BALANCE.commandChargeMax - help.overclockChargeCost);

    const armed = mgmt.getSquad(app, "manager1").players;
    expectReconciled(armed, true);
    armed.forEach((p, i) => {
      expect(p.effective_modifiers.overclock).toBe(help.overclockBonus);
      expect(p.energy).toBe(before[i].energy);
    });

    mgmt.chargeOverclockStarters(app, armed.map((p) => ({ id: p.id, is_starter: p.is_starter })));
    for (const p of armed) {
      expect(app.db.get(p.id)!.energy, p.id).toBe(p.is_starter ? 70 - help.overclockEnergyCost : 70);
    }
  });
});
