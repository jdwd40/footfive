import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #42: Overclock needs a kick-off to apply to (a scheduled own fixture, or a team
// still in the active championship); Tactical Scan needs a scheduled own fixture. The
// squad's actionBlockers come from the same guards the spend runs before any Charge is
// touched, so a shown reason is exactly the rejection and a rejection writes nothing.
const require = createRequire(import.meta.url);
const lib = (f: string) => path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f);

type Blocker = { code: string; message: string } | null;
type Squad = Record<string, unknown> & { actionBlockers: { overclock: Blocker; tactical_scan: Blocker } };
const mgmt = require(lib("managementService.js")) as {
  getSquad: (app: unknown, userId: string) => Squad;
  commandChargeSpend: (app: unknown, userId: string, action: string, playerId?: unknown, fixtureId?: unknown) => Record<string, unknown>;
};
const { BALANCE } = require(lib("balance.js")) as {
  BALANCE: { commandChargeMax: number; commandChargeCosts: Record<string, number>; overclockBonus: number };
};

// Blocker reasons are the public rejection text: PocketBase ends a period-less API error
// with a period, so they carry theirs. Other messages are as the service throws them.
const MSG = {
  armed: "Overclock is already armed for your next kick-off.",
  unavailable: "Overclock is unavailable until the server update completes.",
  no_kickoff: "No upcoming fixture: Overclock is available when your team has another kick-off.",
  no_fixture: "No upcoming fixture to scan.",
  notUpcoming: "Only an upcoming fixture can be scanned",
  foreign: "Fixture does not involve your team",
  missing: "Fixture not found",
  invalid: "Invalid fixtureId",
  insufficient: "Insufficient Command Charge",
};

type Row = Record<string, unknown> & { id: string };
type Params = Record<string, unknown>;
const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "Z";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const HOUR = 3_600_000;

// Exactly the queries these paths make, applied for real. Any other query fails loudly,
// so a changed filter cannot pass by matching every row.
const own = (r: Row, p: Params) => r.home_team === p.t || r.away_team === p.t;
const QUERIES: Record<string, (r: Row, p: Params) => boolean> = {
  "proball_teams|manager = {:u}": (r, p) => r.manager === p.u,
  "proball_players|team = {:t}": (r, p) => r.team === p.t,
  "world|key = 'main'": (r) => r.key === "main",
  "command_charge|user = {:u}": (r, p) => r.user === p.u,
  'shared_fixtures|status = "scheduled" && (home_team = {:t} || away_team = {:t})': (r, p) => r.status === "scheduled" && own(r, p),
  'shared_fixtures|status = "live" && (home_team = {:t} || away_team = {:t})': (r, p) => r.status === "live" && own(r, p),
  'shared_tournaments|status = "active"': (r) => r.status === "active",
};
const NEXT_FIXTURE = 'shared_fixtures|status = "scheduled" && (home_team = {:t} || away_team = {:t})';
const ACTIVE = 'shared_tournaments|status = "active"';

type Rec = {
  id: string;
  fields: Row;
  table: string;
  get: (k: string) => unknown;
  set: (k: string, v: unknown) => void;
  collection: () => { name: string; fields: { getByName: (n: string) => { name: string } | null } };
};

let created = 0;
let legacyTeamSchema = false;
/** A record copy; proball_teams can lack overclock_cost_pending (hooks before migration 1750000019). */
function rec(table: string, row: Row): Rec {
  const f: Row = { ...row };
  const has = (n: string) => n in f && !(legacyTeamSchema && table === "proball_teams" && n === "overclock_cost_pending");
  return {
    get id() {
      return f.id;
    },
    set id(v: string) {
      f.id = v;
    },
    fields: f,
    table,
    get: (k) => f[k],
    set: (k, v) => void (f[k] = v),
    collection: () => ({ name: table, fields: { getByName: (n) => (has(n) ? { name: n } : null) } }),
  };
}
class FakeRecord {
  constructor(collection: { name: string }) {
    return rec(collection.name, { id: "" });
  }
}

type Setup = { team?: Partial<Row>; fixtures?: Row[]; tournaments?: Row[]; points?: number | null; paused?: boolean };
function world({ team = {}, fixtures = [], tournaments = [], points = BALANCE.commandChargeMax, paused = false }: Setup) {
  const tables: Record<string, Row[]> = {
    proball_teams: [
      { id: "team1", name: "Swirl", grade: "B", manager: "manager1", treasury: 2500, battery_count: 0, overclock_ready: false, overclock_cost_pending: false, overclock_fixture: "", eliminated: false, ...team },
      { id: "team2", name: "Rivals", grade: "A", manager: "", treasury: 2500, battery_count: 0, overclock_ready: false, overclock_cost_pending: false, overclock_fixture: "", eliminated: false },
    ],
    proball_players: ["team1", "team2"].flatMap((t) =>
      Array.from({ length: 7 }, (_, i) => ({
        id: `${t}p${i}`, team: t, name: `P${i}`, role: i ? "util" : "gk", intensity: "balanced", attack: 60, defence: 60,
        energy: 100, energy_updated_at: pbDate(T0), condition: 100, is_starter: i < 5, sort_order: i,
      })),
    ),
    world: [{ id: "w", key: "main", pace: "live", progression_paused: paused }],
    command_charge: points === null ? [] : [{ id: "cc1", user: "manager1", points, last_regen_at: pbDate(T0) }],
    shared_fixtures: fixtures,
    shared_tournaments: tournaments,
    tactical_scans: [],
  };
  const reads: string[] = [];
  const saves: string[] = [];
  const app = {
    tables,
    reads,
    saves,
    dump: () => JSON.stringify(tables),
    findRecordsByFilter: (table: string, filter: string, sort: string, limit: number, offset: number, params: Params = {}) => {
      const key = `${table}|${filter}`;
      const match = QUERIES[key];
      if (!match) throw new Error(`unexpected query ${key}`);
      reads.push(key);
      const rows = tables[table].filter((r) => match(r, params));
      if (sort) rows.sort((a, b) => ((a[sort] as string | number) < (b[sort] as string | number) ? -1 : 1));
      return rows.slice(offset, offset + limit).map((r) => rec(table, r));
    },
    findRecordById: (table: string, id: string) => {
      const row = tables[table].find((r) => r.id === id);
      if (!row) throw new Error("sql: no rows in result set");
      return rec(table, row);
    },
    findCollectionByNameOrId: (name: string) => ({ name }),
    save: (r: Rec) => {
      if (!r.id) r.id = `new${++created}`;
      saves.push(`${r.table}/${r.id}`);
      const list = tables[r.table];
      const at = list.findIndex((x) => x.id === r.id);
      if (at >= 0) list[at] = { ...r.fields };
      else list.push({ ...r.fields });
    },
    runInTransaction: (fn: (tx: unknown) => void) => fn(app),
  };
  return app;
}
type World = ReturnType<typeof world>;

const fx = (id: string, status: string, home = "team1", away = "team2", inMs = 60_000): Row => ({
  id, status, home_team: home, away_team: away, scheduled_at: pbDate(T0 + inMs), tournament: "t1",
});
const active = { id: "t1", number: 7, status: "active" };
const complete = { id: "t0", number: 6, status: "complete" };

class BadRequest extends Error {}
class Forbidden extends Error {}
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  g.BadRequestError = BadRequest;
  g.ForbiddenError = Forbidden;
  g.Record = FakeRecord;
  legacyTeamSchema = false;
});
afterEach(() => {
  vi.useRealTimers();
  delete g.BadRequestError;
  delete g.ForbiddenError;
  delete g.Record;
});

const spend = (app: World, action: string, fixtureId?: unknown) => mgmt.commandChargeSpend(app, "manager1", action, undefined, fixtureId);
const points = (app: World) => app.tables.command_charge[0]?.points;

/** The spend rejects with exactly `message` and writes nothing, not even a Charge row. */
function expectRejected(app: World, run: () => unknown, message: string) {
  const before = app.dump();
  const saves = app.saves.length;
  let error: unknown = null;
  try {
    run();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(BadRequest);
  expect((error as Error).message).toBe(message);
  expect(app.saves.slice(saves)).toEqual([]);
  expect(app.dump()).toBe(before);
}

// Rule B, one row per reachable team state. `overclock`/`scan` are the expected blockers.
const STATES: Array<{ name: string; setup: Setup; overclock: string | null; scan: string | null }> = [
  { name: "next fixture drawn and scheduled", setup: { fixtures: [fx("f1", "scheduled")], tournaments: [active] }, overclock: null, scan: null },
  { name: "progression paused before kick-off", setup: { fixtures: [fx("f1", "scheduled")], tournaments: [active], paused: true }, overclock: null, scan: null },
  {
    name: "knocked out, next championship drawn (eliminated reset, Round of 16 scheduled)",
    setup: { fixtures: [fx("f0", "finished", "team2", "team1", -HOUR), fx("f1", "scheduled")], tournaments: [complete, active] },
    overclock: null,
    scan: null,
  },
  { name: "own match live, still in the championship", setup: { fixtures: [fx("f1", "live")], tournaments: [active] }, overclock: null, scan: "no_fixture" },
  { name: "won, waiting for the round to finish", setup: { fixtures: [fx("f1", "finished"), fx("f2", "live", "team3", "team4")], tournaments: [active] }, overclock: null, scan: "no_fixture" },
  {
    name: "knocked out while other teams still have scheduled fixtures",
    setup: { team: { eliminated: true }, fixtures: [fx("f1", "finished"), fx("f2", "scheduled", "team2", "team3")], tournaments: [active] },
    overclock: "no_kickoff",
    scan: "no_fixture",
  },
  {
    name: "champion before the next championship is created",
    setup: { fixtures: [fx("f1", "finished")], tournaments: [{ id: "t1", number: 7, status: "complete" }] },
    overclock: "no_kickoff",
    scan: "no_fixture",
  },
];
describe("rule B: the squad's blockers are exactly the spend's outcome", () => {
  for (const state of STATES) {
    it(state.name, () => {
      const read = world(state.setup);
      const squad = mgmt.getSquad(read, "manager1");
      expect(read.saves).toEqual([]);
      const shown = squad.actionBlockers;
      expect(shown.overclock).toEqual(state.overclock && { code: state.overclock, message: MSG[state.overclock as keyof typeof MSG] });
      expect(shown.tactical_scan).toEqual(state.scan && { code: state.scan, message: MSG[state.scan as keyof typeof MSG] });

      const oc = world(state.setup);
      if (shown.overclock) {
        expectRejected(oc, () => spend(oc, "overclock"), shown.overclock.message);
      } else {
        expect(spend(oc, "overclock")).toEqual({ ok: true, action: "overclock", bonus: BALANCE.overclockBonus });
        const team = oc.tables.proball_teams[0];
        expect([team.overclock_ready, team.overclock_cost_pending, team.overclock_fixture]).toEqual([true, true, ""]);
        expect(points(oc)).toBe(BALANCE.commandChargeMax - BALANCE.commandChargeCosts.overclock);
        expect(mgmt.getSquad(oc, "manager1").actionBlockers.overclock).toEqual({ code: "armed", message: MSG.armed });
      }

      const scan = world(state.setup);
      if (shown.tactical_scan) {
        expectRejected(scan, () => spend(scan, "tactical_scan"), shown.tactical_scan.message);
      } else {
        expect(spend(scan, "tactical_scan")).toMatchObject({ ok: true, fixtureId: "f1" });
        expect(scan.tables.tactical_scans.map((r) => r.fixture_id)).toEqual(["f1"]);
        expect(points(scan)).toBe(BALANCE.commandChargeMax - BALANCE.commandChargeCosts.tactical_scan);
      }
    });
  }
});

describe("Overclock keeps its rejection order, all before any Charge is created or checked", () => {
  const knockedOut: Setup = { team: { eliminated: true }, fixtures: [fx("f1", "finished")], tournaments: [active] };

  it("already armed comes first, even with no Charge row and no next kick-off", () => {
    const app = world({ ...knockedOut, team: { eliminated: true, overclock_ready: true }, points: null });
    legacyTeamSchema = true;
    expect(mgmt.getSquad(app, "manager1").actionBlockers.overclock).toEqual({ code: "armed", message: MSG.armed });
    app.reads.length = 0;
    expectRejected(app, () => spend(app, "overclock"), MSG.armed);
    expect(app.reads.filter((q) => q === NEXT_FIXTURE || q === ACTIVE)).toEqual([]);
    expect(app.tables.command_charge).toEqual([]);
  });

  it("a missing server update comes before the kick-off check", () => {
    const app = world(knockedOut);
    legacyTeamSchema = true;
    expect(mgmt.getSquad(app, "manager1").actionBlockers.overclock).toEqual({ code: "unavailable", message: MSG.unavailable });
    expectRejected(app, () => spend(app, "overclock"), MSG.unavailable);
  });

  for (const charge of [null, 0, 1]) {
    it(`no next kick-off rejects before the balance (${charge === null ? "absent Charge row" : `${charge} Charge`})`, () => {
      const app = world({ ...knockedOut, points: charge });
      expectRejected(app, () => spend(app, "overclock"), MSG.no_kickoff);
      expect(app.tables.command_charge.length).toBe(charge === null ? 0 : 1);
    });
  }

  it("blockers leave the balance to the spend: an allowed arm still needs the Charge", () => {
    const app = world({ fixtures: [fx("f1", "live")], tournaments: [active], points: 1 });
    expect(mgmt.getSquad(app, "manager1").actionBlockers).toEqual({ overclock: null, tactical_scan: { code: "no_fixture", message: MSG.no_fixture } });
    expect(() => spend(app, "overclock")).toThrow(MSG.insufficient);
    expect(app.tables.proball_teams[0].overclock_ready).toBe(false);
  });
});

describe("an explicit Tactical Scan fixture must be the team's own, still to kick off", () => {
  const fixtures = [fx("own-live", "live"), fx("own-done", "finished", "team3", "team1"), fx("own-next", "scheduled", "team2", "team1"), fx("other-live", "live", "team2", "team3")];

  for (const [id, message] of [
    ["own-live", MSG.notUpcoming],
    ["own-done", MSG.notUpcoming],
    ["other-live", MSG.foreign],
    ["missing", MSG.missing],
    [42, MSG.invalid],
  ] as const) {
    it(`${id}: rejects with "${message}" before any Charge is created or checked`, () => {
      for (const charge of [null, 0, BALANCE.commandChargeMax]) {
        const app = world({ fixtures, tournaments: [active], points: charge });
        expectRejected(app, () => spend(app, "tactical_scan", id), message);
      }
    });
  }

  it("the team's scheduled fixture is scanned as before", () => {
    const app = world({ fixtures, tournaments: [active] });
    expect(spend(app, "tactical_scan", "own-next")).toMatchObject({ ok: true, action: "tactical_scan", fixtureId: "own-next", report: { teamName: "Rivals" } });
    expect(app.saves).toEqual(["command_charge/cc1", "tactical_scans/new" + created]);
  });
});

describe("the squad read shares its lookups and writes nothing", () => {
  const extraReads = (app: World) => app.reads.filter((q) => q === NEXT_FIXTURE || q === ACTIVE);

  for (const [name, setup, expected] of [
    ["armed", { team: { overclock_ready: true }, fixtures: [fx("f1", "live")], tournaments: [active] }, [NEXT_FIXTURE]],
    ["scheduled", { fixtures: [fx("f1", "scheduled")], tournaments: [active] }, [NEXT_FIXTURE]],
    ["live, still in", { fixtures: [fx("f1", "live")], tournaments: [active] }, [NEXT_FIXTURE, ACTIVE]],
    ["knocked out", { team: { eliminated: true }, tournaments: [active] }, [NEXT_FIXTURE]],
  ] as Array<[string, Setup, string[]]>) {
    it(`${name}: ${expected.length} added read(s), no saves`, () => {
      const app = world(setup);
      mgmt.getSquad(app, "manager1");
      expect(extraReads(app)).toEqual(expected);
      expect(app.saves).toEqual([]);
    });
  }

  it("adds actionBlockers after the existing payload keys", () => {
    const squad = mgmt.getSquad(world({ fixtures: [fx("f1", "scheduled")], tournaments: [active] }), "manager1");
    expect(Object.keys(squad)).toEqual([
      "team", "players", "averages", "managementOpen", "effectNote", "batteryCost", "batteryRestore",
      "repairCostPerPoint", "aiRules", "managementHelp", "actionBlockers",
    ]);
  });
});
