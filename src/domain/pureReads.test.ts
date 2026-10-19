// Issue #25 (review B13/B22): the scheduled match preview reads energy without saving,
// at the view's own instant for both teams, and repair reports what it actually restored
// and charged. Real routes and rows are covered by tests/integration/squad-read-repair.mjs.
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f);
type Snap = { players: { id: string; name: string; energy: number }[] };
const mgmt = require(lib("managementService.js")) as {
  loadTeamSnapshot: (app: unknown, teamId: string, opts?: { readOnlyEnergy: boolean; now?: number }) => Snap;
  aiLineup: (players: Snap["players"]) => { id: string; name: string; is_starter: boolean }[];
  repairPlayer: (app: unknown, userId: string, playerId: string, points: unknown) => { ok: boolean; points: number; cost: number };
};
const world = require(lib("worldService.js")) as {
  matchView: (app: unknown, id: string, since: number, userId: string) => { lineups: Record<"home" | "away", { name: string; starter: boolean }[]> };
};
const { BALANCE } = require(lib("balance.js")) as { BALANCE: { repairCostPerPoint: number; startingTreasury: number } };

type Row = Record<string, unknown> & { id: string };
const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-19T12:00:00Z");

class FakeRecord {
  static seq = 0;
  id: string;
  collectionName: string;
  data: Record<string, unknown> = {};
  constructor(col?: { name: string }) {
    this.collectionName = col ? col.name : "";
    this.id = "r" + ++FakeRecord.seq;
  }
  get(k: string) {
    return this.data[k];
  }
  set(k: string, v: unknown) {
    this.data[k] = v;
  }
}

/**
 * In-memory app with transaction rollback. Every read is a copy; saves and
 * transactions are recorded. Only the queries these paths make are answered.
 */
function fakeApp(tables: Record<string, Row[]>, opts: { failLedger?: boolean } = {}) {
  const db: Record<string, Map<string, Row>> = {};
  for (const [name, rows] of Object.entries(tables)) db[name] = new Map(rows.map((r) => [r.id, { ...r }]));
  const rec = (name: string, row: Row) => Object.assign(new FakeRecord({ name }), { id: row.id, data: { ...row } });
  const all = (name: string) => [...(db[name] || new Map()).values()].map((r) => rec(name, r));
  const app = {
    db,
    saves: [] as string[],
    transactions: 0,
    paceReads: 0,
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (name: string, id: string) => {
      const r = db[name]?.get(id);
      if (!r) throw new Error("sql: no rows in result set");
      return rec(name, r);
    },
    findRecordsByFilter: (name: string, filter: string, _sort: string, _limit: number, _offset: number, p: Record<string, string> = {}) => {
      if (name === "world") {
        app.paceReads++;
        return all("world");
      }
      if (filter.includes("manager = {:u}")) return all(name).filter((r) => r.get("manager") === p.u);
      if (filter.includes("team = {:t}")) return all(name).filter((r) => r.get("team") === p.t);
      if (filter.includes("idempotency_key")) return all(name).filter((r) => r.get("idempotency_key") === p.k);
      if (name === "proball_teams" || name === "global_team_records") return all(name);
      return [];
    },
    save: (r: FakeRecord) => {
      if (opts.failLedger && r.collectionName === "team_finance_ledger") throw new Error("injected ledger failure");
      app.saves.push(`${r.collectionName}/${r.id}`);
      (db[r.collectionName] ||= new Map()).set(r.id, { ...r.data, id: r.id } as Row);
    },
    runInTransaction: (fn: (tx: unknown) => void) => {
      app.transactions++;
      const snapshot = Object.fromEntries(Object.entries(db).map(([k, m]) => [k, new Map([...m].map(([id, r]) => [id, { ...r }]))]));
      try {
        fn(app);
      } catch (err) {
        for (const k of Object.keys(db)) delete db[k];
        Object.assign(db, snapshot);
        throw err;
      }
    },
  };
  return app;
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  g.Record = FakeRecord;
  g.BadRequestError = class BadRequestError extends Error {};
  g.ForbiddenError = class ForbiddenError extends Error {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ["Record", "BadRequestError", "ForbiddenError"]) delete g[k];
});

/** Two AI sides whose pick depends on regenerated energy (low, stale, null and future stamps). */
function previewTables(): Record<string, Row[]> {
  const team = (id: string, abbr: string) => ({ id, name: `Team ${abbr}`, abbreviation: abbr, grade: "B", manager: "", slug: id });
  const players: Row[] = [];
  for (const t of ["team0", "team1"]) {
    [
      [10, NOW - 6 * HOUR], [95, NOW - HOUR], [30, NOW - 0.37 * HOUR], [70, null], [null, null],
      [5, NOW - 7.9 * HOUR], [60, NOW + HOUR], [88, NOW - 20 * HOUR],
    ].forEach(([energy, at], i) => {
      players.push({
        id: `${t}p${i}`, name: `${t}-P${i}`, team: t, role: i === 0 ? "gk" : "mid", attack: 40 + i, defence: 60 - i,
        condition: 80, intensity: "balanced", is_starter: i < 5, sort_order: i, energy,
        energy_updated_at: at == null ? null : pbDate(at as number),
      });
    });
  }
  return {
    world: [{ id: "world", key: "main", pace: "live" }],
    proball_teams: [team("team0", "AAA"), team("team1", "BBB")],
    proball_players: players,
    shared_fixtures: [{ id: "fx1", round: "r1", status: "scheduled", home_team: "team0", away_team: "team1", scheduled_at: pbDate(NOW + HOUR) }],
    shared_rounds: [{ id: "r1", round_key: "qf", status: "scheduled", scheduled_at: pbDate(NOW + HOUR) }],
  };
}

describe("scheduled match preview (production matchView)", () => {
  it("previews both teams at the view's own instant and saves no player", () => {
    const app = fakeApp(previewTables());
    const before = new Map(app.db.proball_players);
    const snapshot = vi.spyOn(mgmt, "loadTeamSnapshot");
    const view = world.matchView(app, "fx1", 0, "spectator");

    const previews = snapshot.mock.calls.map((c) => [c[1], c[2]]);
    expect(previews).toEqual([
      ["team0", { readOnlyEnergy: true, now: NOW }],
      ["team1", { readOnlyEnergy: true, now: NOW }],
    ]);
    expect(app.saves.filter((s) => s.startsWith("proball_players/"))).toEqual([]);
    expect(app.db.proball_players).toEqual(before);
    // The same five the old eager snapshot picked from these rows at this instant.
    for (const [side, id] of [["home", "team0"], ["away", "team1"]] as const) {
      const eager = fakeApp(previewTables());
      const pick = mgmt.aiLineup(mgmt.loadTeamSnapshot(eager, id).players).filter((p) => p.is_starter);
      expect(eager.saves.length).toBeGreaterThan(0); // the old path stamped these rows
      const shown = view.lineups[side].filter((p) => p.starter).map((p) => p.name);
      expect(shown).toHaveLength(5);
      expect(shown.sort()).toEqual(pick.map((p) => p.name).sort());
    }
  });

  it("a read-only snapshot reads pace once and uses the given instant even when the clock moved on", () => {
    const app = fakeApp(previewTables());
    vi.setSystemTime(NOW + 5 * HOUR);
    const later = mgmt.loadTeamSnapshot(app, "team0", { readOnlyEnergy: true, now: NOW });
    const eager = fakeApp(previewTables());
    vi.setSystemTime(NOW);
    const atNow = mgmt.loadTeamSnapshot(eager, "team0");
    expect(app.paceReads).toBe(1);
    expect(app.saves).toEqual([]);
    expect(later).toEqual(atNow);
  });
});

describe("repair reports what it actually restored and charged", () => {
  function repairWorld(condition: number | null, treasury: number | null, failLedger = false) {
    return fakeApp(
      {
        proball_teams: [{ id: "team1", manager: "manager1", treasury }],
        proball_players: [{ id: "p1", name: "Ann", team: "team1", condition }, { id: "x1", name: "Foe", team: "team2", condition: 50 }],
        team_finance_ledger: [],
      },
      { failLedger },
    );
  }
  const ledger = (app: ReturnType<typeof fakeApp>) => [...app.db.team_finance_ledger.values()];
  const per = () => BALANCE.repairCostPerPoint;

  it.each([
    [90, 25, 10],
    [50, 150, 50],
    [0, 100, 100],
    [99, "3", 1],
    [null, 5, 0],
  ])("condition %p, requested %p: applies and charges %p", (condition, requested, applied) => {
    const app = repairWorld(condition as number | null, 5000);
    if (applied === 0) {
      expect(() => mgmt.repairPlayer(app, "manager1", "p1", requested)).toThrow("Condition already full");
      expect(app.saves).toEqual([]);
      return;
    }
    const out = mgmt.repairPlayer(app, "manager1", "p1", requested);
    expect(out).toEqual({ ok: true, points: applied, cost: applied * per() });
    expect(app.db.proball_teams.get("team1")!.treasury).toBe(5000 - applied * per());
    expect(app.db.proball_players.get("p1")!.condition).toBe((condition as number) + applied);
    expect(ledger(app)).toHaveLength(1);
    expect(ledger(app)[0]).toMatchObject({ team: "team1", amount: -applied * per(), type: "repair", description: `Repair +${applied} for Ann`, balance_after: 5000 - applied * per(), player_id: "p1" });
  });

  it("charges the starting treasury when none is stored", () => {
    const app = repairWorld(90, null);
    expect(mgmt.repairPlayer(app, "manager1", "p1", 25)).toEqual({ ok: true, points: 10, cost: 120 });
    expect(app.db.proball_teams.get("team1")!.treasury).toBe(BALANCE.startingTreasury - 120);
  });

  it.each([
    ["zero", 0, "Invalid repair points"],
    ["negative", -5, "Invalid repair points"],
    ["non-numeric", "lots", "Invalid repair points"],
  ])("rejects %s points with no write", (_n, points, message) => {
    const app = repairWorld(50, 5000);
    expect(() => mgmt.repairPlayer(app, "manager1", "p1", points)).toThrow(message);
    expect(app.saves).toEqual([]);
  });

  it("rejects a foreign player and insufficient treasury with no write", () => {
    const app = repairWorld(50, 100);
    expect(() => mgmt.repairPlayer(app, "manager1", "x1", 10)).toThrow("Not your player");
    expect(() => mgmt.repairPlayer(app, "manager1", "p1", 10)).toThrow("Insufficient team treasury");
    expect(app.saves).toEqual([]);
    expect(() => mgmt.repairPlayer(app, "nobody", "p1", 10)).toThrow("You do not manage a team");
  });

  it("a late ledger failure rolls back the treasury and condition", () => {
    const app = repairWorld(90, 5000, true);
    expect(() => mgmt.repairPlayer(app, "manager1", "p1", 25)).toThrow("injected ledger failure");
    expect(app.db.proball_teams.get("team1")!.treasury).toBe(5000);
    expect(app.db.proball_players.get("p1")!.condition).toBe(90);
    expect(ledger(app)).toEqual([]);
  });
});
