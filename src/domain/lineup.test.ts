import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue #19: setLineup validates the whole lineup on reads made inside its transaction
// before writing anything, and keeps the previous starter and reserve ordering.
const require = createRequire(import.meta.url);
const mgmt = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/managementService.js")) as {
  setLineup: (app: unknown, userId: string, starters: unknown, subs?: unknown) => { ok: boolean };
};

type Row = { id: string; team: string; role: string; is_starter: boolean; sort_order: number };
const ROLES = ["gk", "att", "mid", "mid", "def", "att", "gk"];
const roster = (): Row[] => ROLES.map((role, i) => ({ id: `p${i}`, team: "t1", role, is_starter: i < 5, sort_order: i }));

/**
 * In-memory PocketBase stand-in. It never rolls back, so any write made before a rejection
 * stays visible, and it counts reads and saves made outside the transaction.
 */
function world(rows: Row[]) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  db.set("f0", { id: "f0", team: "t2", role: "gk", is_starter: true, sort_order: 0 });
  const teams = [{ id: "t1", manager: "u1" }, { id: "t2", manager: "u2" }];
  let saves = 0;
  let inTx = false;
  let outside = 0;
  const record = (row: Row) => {
    const f: Record<string, unknown> = { ...row };
    return { id: row.id, get: (k: string) => f[k], set: (k: string, v: unknown) => void (f[k] = v), fields: f };
  };
  const app = {
    findRecordsByFilter: (collection: string, _f: string, _s: string, _l: number, _o: number, p: { u?: string; t?: string }) => {
      if (!inTx) outside++;
      return collection === "proball_teams"
        ? teams.filter((t) => t.manager === p.u).map((t) => ({ id: t.id, get: (k: string) => (t as Record<string, unknown>)[k] }))
        : [...db.values()].filter((r) => r.team === p.t).sort((a, b) => a.sort_order - b.sort_order).map(record);
    },
    save: (r: ReturnType<typeof record>) => {
      if (!inTx) outside++;
      saves++;
      db.set(r.id, { ...(r.fields as Row) });
    },
    runInTransaction: (fn: (t: unknown) => void) => {
      inTx = true;
      try {
        fn(app);
      } finally {
        inTx = false;
      }
    },
  };
  const team = () => [...db.values()].filter((r) => r.team === "t1").sort((a, b) => (a.id < b.id ? -1 : 1));
  return { app, team, saves: () => saves, outside: () => outside };
}

/** The pre-#19 ordering for a valid lineup, applied to rows in their current roster order. */
function previousOrder(rows: Row[], starters: string[], subs: string[] | null | undefined) {
  const subList = subs && subs.length ? [...subs] : [];
  for (const r of [...rows].sort((a, b) => a.sort_order - b.sort_order)) {
    const isSt = starters.includes(r.id);
    if (!isSt && subList.length < 2 && !subList.includes(r.id)) subList.push(r.id);
    r.is_starter = isSt;
    r.sort_order = isSt ? starters.indexOf(r.id) : 5 + Math.max(0, subList.indexOf(r.id));
  }
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.BadRequestError = class BadRequestError extends Error {};
  g.ForbiddenError = class ForbiddenError extends Error {};
});
afterEach(() => {
  delete g.BadRequestError;
  delete g.ForbiddenError;
});

const FIVE = ["p0", "p1", "p2", "p3", "p4"];

describe("setLineup rejects an invalid lineup before any write", () => {
  const cases: [string, unknown, unknown, RegExp, string?][] = [
    ["missing starters", undefined, undefined, /Exactly 5 starters required/],
    ["starters as a string", "p0p1p", undefined, /Exactly 5 starters required/],
    ["starters as an object", { length: 5, 0: "p0" }, undefined, /Exactly 5 starters required/],
    ["four starters", FIVE.slice(0, 4), undefined, /Exactly 5 starters required/],
    ["six starters", [...FIVE, "p5"], undefined, /Exactly 5 starters required/],
    ["numeric starter", ["p0", "p1", "p2", "p3", 4], undefined, /Invalid starter id/],
    ["empty starter id", ["p0", "p1", "p2", "p3", ""], undefined, /Invalid starter id/],
    ["foreign starter", ["p0", "p1", "p2", "p3", "f0"], undefined, /Invalid starter id/],
    ["inherited key as starter", ["p0", "p1", "p2", "p3", "constructor"], undefined, /Invalid starter id/],
    ["goalkeeper five times", ["p0", "p0", "p0", "p0", "p0"], undefined, /5 different players/],
    ["duplicate outfield starter", ["p0", "p1", "p1", "p2", "p3"], undefined, /5 different players/],
    ["no goalkeeper", ["p1", "p2", "p3", "p4", "p5"], undefined, /include a goalkeeper/],
    ["subs false", FIVE, false, /Subs must be a list/],
    ["subs zero", FIVE, 0, /Subs must be a list/],
    ["subs empty string", FIVE, "", /Subs must be a list/],
    ["subs as a string", FIVE, "p5", /Subs must be a list/],
    ["subs as an object", FIVE, { 0: "p5", length: 1 }, /Subs must be a list/],
    ["foreign sub", FIVE, ["f0"], /Invalid sub id/],
    ["numeric sub", FIVE, [5], /Invalid sub id/],
    ["inherited key as sub", FIVE, ["toString"], /Invalid sub id/],
    ["starter as sub", FIVE, ["p5", "p0"], /starter cannot also be a sub/],
    ["duplicate sub", FIVE, ["p6", "p6"], /Subs must be different players/],
    ["not a manager", FIVE, undefined, /do not manage a team/, "u9"],
  ];
  for (const [name, starters, subs, message, user = "u1"] of cases) {
    it(name, () => {
      const w = world(roster());
      const before = w.team();
      expect(() => mgmt.setLineup(w.app, user, starters, subs)).toThrow(message);
      expect(w.saves()).toBe(0);
      expect(w.team()).toEqual(before);
    });
  }
});

describe("setLineup saves a valid lineup", () => {
  it("reads the manager and roster and saves every player inside one transaction", () => {
    const w = world(roster());
    mgmt.setLineup(w.app, "u1", ["p6", "p1", "p2", "p3", "p4"], ["p0"]);
    expect(w.saves()).toBe(7);
    expect(w.outside()).toBe(0);
  });

  it("keeps the previous order for omitted, null, empty, partial and full subs", () => {
    const w = world(roster());
    const reference = roster();
    const steps: [string[], string[] | null | undefined][] = [
      [["p0", "p2", "p3", "p4", "p5"], undefined],
      [["p6", "p1", "p2", "p3", "p4"], null],
      [["p0", "p1", "p2", "p3", "p6"], []],
      [["p4", "p3", "p0", "p1", "p5"], ["p6"]],
      [["p0", "p1", "p2", "p3", "p4"], ["p6", "p5"]],
      [["p0", "p1", "p2", "p3", "p4"], ["p5", "p6"]],
      [["p0", "p6", "p5", "p3", "p1"], ["p4"]], // two goalkeepers start
      [["p2", "p0", "p4", "p5", "p1"], ["p6", "p3"]],
    ];
    for (const [starters, subs] of steps) {
      expect(mgmt.setLineup(w.app, "u1", starters, subs)).toEqual({ ok: true });
      previousOrder(reference, starters, subs);
      expect(w.team(), JSON.stringify([starters, subs])).toEqual([...reference].sort((a, b) => (a.id < b.id ? -1 : 1)));
    }
  });
});
