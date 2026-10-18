import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Issue #18: materialisePlayerEnergy keeps its read-and-save semantics (squad, scan and
// engine-snapshot reads round and re-stamp exactly as before), but saves a fresh copy of
// the player read inside a transaction, so a stale record can no longer overwrite a
// concurrent paid change.
const require = createRequire(import.meta.url);
const mgmt = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/managementService.js")) as {
  loadTeamSnapshot: (app: unknown, teamId: string) => { players: { id: string; energy: number }[] };
  getSquad: (app: unknown, userId: string) => { players: { id: string; energy: number }[] };
  materialisePlayerEnergy: (app: unknown, player: unknown, pace?: string) => number;
};
const eff = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/effectiveStats.js")) as {
  materialiseEnergy: (s: number, last: number, now: number, r: number) => number;
};
const bal = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js")) as {
  getTiming: (p: string) => { energyRegenPerHour: number };
};

type Row = Record<string, unknown> & { id: string };
const record = (row: Row) => {
  const f = { ...row };
  return {
    id: f.id,
    get: (k: string) => f[k],
    set: (k: string, v: unknown) => void (f[k] = v),
    fields: f,
    collection: () => ({ fields: { getByName: (n: string) => (n in f ? { name: n } : null) } }),
  };
};
type Rec = ReturnType<typeof record>;

/** In-memory PocketBase stand-in: every read returns a copy, save writes it back. */
function world(rows: Row[], pace: string) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const team = { id: "team1", name: "Team", grade: "B", overclock_ready: false, treasury: 2500 };
  const app = {
    db,
    findRecordById: (collection: string, id: string) => record(collection === "proball_teams" ? team : db.get(id)!),
    findRecordsByFilter: (collection: string) =>
      collection === "world" ? [record({ id: "w", pace })]
        : collection === "proball_players" ? [...db.values()].map(record)
          : collection === "proball_teams" ? [record(team)] : [],
    save: (r: Rec) => void db.set(r.id, { ...r.fields } as Row),
    runInTransaction: (fn: (tx: unknown) => void) => fn(app),
  };
  return app;
}

const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
const parse = (v: unknown) => (v == null || v === "" ? NaN : Date.parse(String(v).replace(" ", "T")));

/** The pre-#18 materialisePlayerEnergy, applied to a stored row: the reference semantics. */
function previousRead(row: Row, now: number, regenPerHour: number) {
  const stored = row.energy == null ? 100 : (row.energy as number);
  const last = parse(row.energy_updated_at);
  const energy = eff.materialiseEnergy(stored, last, now, regenPerHour);
  if (energy !== stored || isNaN(last)) {
    row.energy = Math.round(energy);
    row.energy_updated_at = pbDate(now);
  }
  return Math.round(energy);
}

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-14T12:00:00Z");
const players: Row[] = [
  { energy: 40, energy_updated_at: pbDate(T0 - 3 * HOUR) },
  { energy: 55, energy_updated_at: pbDate(T0 - 0.37 * HOUR) },
  { energy: 100, energy_updated_at: pbDate(T0 - 10 * HOUR) },
  { energy: 0, energy_updated_at: pbDate(T0 - 100 * HOUR) },
  { energy: 73, energy_updated_at: pbDate(T0 + HOUR) },
  { energy: 70, energy_updated_at: null },
  { energy: null, energy_updated_at: null },
  { energy: 12, energy_updated_at: pbDate(T0 - 1234567) },
].map((f, i) => ({ id: `p${i}`, name: `P${i}`, role: i === 0 ? "GK" : "DEF", attack: 50, defence: 50, condition: 90, is_starter: i < 5, sort_order: i, ...f }));

// Reads seconds to hours apart, so each read rounds away a fraction of regeneration.
const READS = [0, 7_000, 13_000, 61_000, 20 * 60_000, 2.37 * HOUR, 30 * HOUR];

afterEach(() => vi.useRealTimers());

describe("energy reads keep the previous read-and-save history", () => {
  for (const pace of ["dev", "live"]) {
    it(`${pace} pace: squad and engine-snapshot reads return and store what the old path did`, () => {
      vi.useFakeTimers();
      const rate = bal.getTiming(pace).energyRegenPerHour;
      const app = world(players, pace);
      const reference = players.map((p) => ({ ...p }));
      READS.forEach((offset, step) => {
        const now = T0 + offset;
        vi.setSystemTime(now);
        const read = step % 2 ? mgmt.getSquad(app, "manager1").players : mgmt.loadTeamSnapshot(app, "team1").players;
        const expected = reference.map((row) => previousRead(row, now, rate));
        expect(read.map((p) => p.energy), `read at +${offset}ms`).toEqual(expected);
        expect(players.map((p) => app.db.get(p.id)), `stored after +${offset}ms`).toEqual(reference);
      });
    });
  }
});

describe("a stale record cannot overwrite a paid change", () => {
  it("saves regeneration onto the fresh row and hands the fresh values back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const rate = bal.getTiming("live").energyRegenPerHour;
    const row: Row = { id: "p1", name: "P1", energy: 40, condition: 55, energy_updated_at: pbDate(T0) };
    const app = world([row], "live");
    const stale = app.findRecordById("proball_players", "p1"); // read before the paid change
    // A paid Rapid Charge and Field Repair commit after that read.
    app.db.set("p1", { ...row, energy: 58, condition: 70, energy_updated_at: pbDate(T0) });

    const now = T0 + 10 * 60_000;
    vi.setSystemTime(now);
    const energy = mgmt.materialisePlayerEnergy(app, stale, "live");
    const paid = Math.round(eff.materialiseEnergy(58, T0, now, rate));
    expect(energy).toBe(paid);
    expect(app.db.get("p1")).toMatchObject({ energy: paid, condition: 70, energy_updated_at: pbDate(now) });
    expect([stale.get("energy"), stale.get("energy_updated_at")]).toEqual([paid, pbDate(now)]);
    // The previous path saved the stale record itself, losing both paid effects.
    const previous = { ...row };
    previousRead(previous, now, rate);
    expect([previous.energy, previous.condition]).toEqual([Math.round(eff.materialiseEnergy(40, T0, now, rate)), 55]);
  });
});
