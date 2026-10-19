// @vitest-environment node
// Issues #4/#22: retention drains every eligible fixture in one run, never purges events a
// consumer still needs, and reports exact counts. The service runs against an in-memory
// SQLite copy of the columns it reads, so its real SQL decides eligibility here; the
// actual-PB suite covers PocketBase itself.
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type Result = {
  preview: boolean;
  retention_days: number;
  examined: number;
  deleted: number;
  skipped: string[];
  eligible: string[];
  error: string;
  fixtures_deleted: number;
  scans_deleted: number;
  eligible_total: number;
  scans_eligible: number;
  failed: number;
};

const retention = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/retentionService.js"),
) as {
  getRetentionDays: ($app: unknown) => number;
  runRetention: ($app: unknown, opts?: { preview?: boolean; days?: number }) => Result;
  retentionStatus: ($app: unknown) => { match_summaries: number; events_purged: number; never: boolean };
};

type Params = Record<string, string>;
type Exp = { sql: string; params: Params };

// PocketBase globals the service uses.
class FakeRecord {}
Object.assign(globalThis, {
  $dbx: { exp: (sql: string, params: Params = {}) => ({ sql, params }) },
  arrayOf: () => [],
  Record: FakeRecord,
});

const SCHEMA = `
CREATE TABLE shared_tournaments (id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE shared_rounds (id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE shared_fixtures (id TEXT PRIMARY KEY, tournament TEXT NOT NULL, round TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE match_states (id TEXT PRIMARY KEY, fixture TEXT NOT NULL, finalised BOOLEAN NOT NULL DEFAULT FALSE,
  progression_settled BOOLEAN NOT NULL DEFAULT FALSE, state_json TEXT, events_json TEXT, updated TEXT);
CREATE TABLE match_events (id INTEGER PRIMARY KEY, fixture TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE match_summaries (id TEXT PRIMARY KEY, fixture_id TEXT NOT NULL, tournament_id TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '', events_purged BOOLEAN NOT NULL DEFAULT FALSE, goals_json TEXT);
CREATE TABLE shared_bets (id INTEGER PRIMARY KEY, fixture TEXT NOT NULL DEFAULT '', round TEXT NOT NULL DEFAULT '',
  market TEXT NOT NULL DEFAULT '', status TEXT NOT NULL);
CREATE TABLE coaching_commands (id INTEGER PRIMARY KEY, fixture TEXT NOT NULL);
CREATE TABLE tactical_scans (id TEXT PRIMARY KEY, created TEXT NOT NULL);
`;
const TABLES = ["shared_fixtures", "match_states", "match_events", "match_summaries", "shared_bets", "coaching_commands", "tactical_scans"];

const DAY = 86_400_000;
const NOW = Date.now();
const pbDate = (ms: number) => new Date(ms).toISOString().replace("T", " ");
const OLD = pbDate(NOW - 60 * DAY);

/** `{:name}` placeholders become SQLite named parameters. */
function bindable(sql: string) {
  return sql.replace(/\{:(\w+)\}/g, ":$1");
}

function where(exps: Exp[]) {
  if (!exps.length) return { sql: "", params: {} };
  return {
    sql: " WHERE " + exps.map((e) => "(" + bindable(e.sql) + ")").join(" AND "),
    params: Object.assign({}, ...exps.map((e) => e.params)) as Params,
  };
}

class Row {
  id: string;
  private data: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    this.data = data;
    this.id = String(data.id);
  }
  getString(key: string) {
    return String(this.data[key] ?? "");
  }
}

/** The PocketBase app surface the service uses, backed by real SQLite. */
function world(opts: { afterPage?: (table: string) => void; retentionDays?: number } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const worldRow = {
    values: { retention_days: opts.retentionDays ?? 30 } as Record<string, unknown>,
    get(k: string) {
      return this.values[k] ?? null;
    },
    set(k: string, v: unknown) {
      this.values[k] = v;
    },
  };
  const app = {
    countRecords(table: string, ...exps: Exp[]) {
      const w = where(exps);
      return (db.prepare(`SELECT count(*) AS n FROM ${table}${w.sql}`).get(w.params) as { n: number }).n;
    },
    recordQuery(table: string) {
      const exps: Exp[] = [];
      let order: string[] = [];
      let limit = -1;
      const q = {
        andWhere(e: Exp) {
          exps.push(e);
          return q;
        },
        orderBy(...cols: string[]) {
          order = cols;
          return q;
        },
        limit(n: number) {
          limit = n;
          return q;
        },
        all(rows: Row[]) {
          const w = where(exps);
          const sql = `SELECT * FROM ${table}${w.sql} ORDER BY ${order.join(", ")} LIMIT ${limit}`;
          for (const r of db.prepare(sql).all(w.params)) rows.push(new Row(r as Record<string, unknown>));
          opts.afterPage?.(table);
        },
      };
      return q;
    },
    runInTransaction(fn: (tx: unknown) => void) {
      db.exec("SAVEPOINT tx");
      try {
        fn(app);
        db.exec("RELEASE tx");
      } catch (err) {
        db.exec("ROLLBACK TO tx");
        db.exec("RELEASE tx");
        throw err;
      }
    },
    db() {
      return {
        newQuery: (sql: string) => ({
          bind: (params: Params) => ({ execute: () => db.prepare(bindable(sql)).run(params) }),
        }),
      };
    },
    findRecordsByFilter: (col: string) => (col === "world" ? [worldRow] : []),
    findCollectionByNameOrId: () => {
      throw new Error("retention_runs is not modelled here");
    },
    save: () => {},
  };

  const ins = (table: string, row: Record<string, string | number>) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
      ...keys.map((k) => row[k]),
    );
  };
  ins("shared_tournaments", { id: "t_done", status: "complete" });
  ins("shared_tournaments", { id: "t_done2", status: "complete" });
  ins("shared_tournaments", { id: "t_live", status: "active" });
  ins("shared_rounds", { id: "r_done", status: "completed" });
  ins("shared_rounds", { id: "r_rf", status: "completed" });
  ins("shared_rounds", { id: "r_completing", status: "completing" });
  ins("shared_rounds", { id: "r_other", status: "completed" });

  /** A finished, settled fixture with three event rows, state, coaching and a summary. */
  function fixture(
    id: string,
    o: {
      completed?: string;
      tournament?: string;
      round?: string;
      status?: string;
      summaryTournament?: string;
      finalised?: number;
      settled?: number;
      purged?: number;
      noFixture?: boolean;
      noState?: boolean;
    } = {},
  ) {
    const tournament = o.tournament ?? "t_done";
    if (!o.noFixture) ins("shared_fixtures", { id, tournament, round: o.round ?? "r_done", status: o.status ?? "finished" });
    if (!o.noState) {
      ins("match_states", {
        id: "ms_" + id,
        fixture: id,
        finalised: o.finalised ?? 1,
        progression_settled: o.settled ?? 1,
        state_json: JSON.stringify({ keep: id }),
        events_json: JSON.stringify([{ legacy: id }]),
        updated: OLD,
      });
    }
    for (let seq = 1; seq <= 3; seq++) ins("match_events", { fixture: id, seq });
    ins("coaching_commands", { fixture: id });
    ins("match_summaries", {
      id: "sum_" + id,
      fixture_id: id,
      tournament_id: o.summaryTournament ?? tournament,
      completed_at: o.completed ?? OLD,
      events_purged: o.purged ?? 0,
      goals_json: JSON.stringify([{ scorer: id }]),
    });
  }
  const bet = (o: { fixture?: string; round?: string; market: string; status: string }) => ins("shared_bets", o);
  const scan = (id: string, created: string) => ins("tactical_scans", { id, created });

  const one = (sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Record<string, unknown>;
  const purged = () =>
    (db.prepare("SELECT fixture_id FROM match_summaries WHERE events_purged ORDER BY fixture_id").all() as { fixture_id: string }[]).map(
      (r) => r.fixture_id,
    );
  const dump = () =>
    JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  const eventCount = (fx: string) => one("SELECT count(*) AS n FROM match_events WHERE fixture = ?", fx).n;
  return { app, db, worldRow, fixture, bet, scan, one, purged, dump, eventCount };
}

describe("retention eligibility", () => {
  it("purges only fixtures whose detailed events no settlement or progression still reads", () => {
    const w = world();
    w.fixture("ok_plain");
    // Positive controls: none of these needs the events.
    w.fixture("ok_won_bet");
    w.bet({ fixture: "ok_won_bet", round: "r_done", market: "next_goal", status: "won" });
    w.bet({ round: "r_done", market: "champion", status: "open" });
    w.bet({ market: "semis", status: "open" });
    w.bet({ round: "r_other", market: "round_first", status: "open" });
    w.fixture("ok_no_state", { noState: true });
    w.fixture("ok_blank_summary_tournament", { summaryTournament: "" });
    // Protected: each one fails exactly one condition.
    w.fixture("no_live", { status: "live" });
    w.fixture("no_scheduled", { status: "scheduled" });
    w.fixture("no_round_completing", { round: "r_completing" });
    w.fixture("no_tournament_active", { tournament: "t_live" });
    w.fixture("no_tournament_mismatch", { summaryTournament: "t_done2" });
    w.fixture("no_orphan", { noFixture: true });
    w.fixture("no_round_missing", { round: "r_missing" });
    w.fixture("no_tournament_missing", { tournament: "t_missing" });
    w.fixture("no_not_finalised", { finalised: 0 });
    w.fixture("no_progression_pending", { settled: 0 });
    w.fixture("no_open_next_goal");
    w.bet({ fixture: "no_open_next_goal", round: "r_done", market: "next_goal", status: "open" });
    w.fixture("no_locked_winner");
    w.bet({ fixture: "no_locked_winner", round: "r_done", market: "winner", status: "locked" });
    w.fixture("no_round_first_a", { round: "r_rf" });
    w.fixture("no_round_first_b", { round: "r_rf" });
    w.bet({ round: "r_rf", market: "round_first", status: "open" });
    w.fixture("no_recent", { completed: pbDate(NOW - DAY) });
    w.fixture("no_date_empty", { completed: "" });
    w.fixture("no_date_feb30", { completed: "2026-02-30 00:00:00.000Z" });
    w.fixture("no_date_iso", { completed: new Date(NOW - 60 * DAY).toISOString() });
    w.fixture("no_date_junk", { completed: "garbage" });
    w.fixture("no_already_purged", { purged: 1 });

    const r = retention.runRetention(w.app, { days: 30 });

    expect(w.purged()).toEqual(
      ["no_already_purged", "ok_blank_summary_tournament", "ok_no_state", "ok_plain", "ok_won_bet"].sort(),
    );
    expect(r).toMatchObject({ fixtures_deleted: 4, eligible_total: 4, examined: 4, failed: 0, error: "" });
    for (const fx of ["ok_plain", "ok_won_bet", "ok_no_state", "ok_blank_summary_tournament"]) {
      expect(w.eventCount(fx)).toBe(0);
    }
    // Everything protected keeps its events and legacy events_json.
    const kept = w.db.prepare("SELECT fixture_id FROM match_summaries WHERE fixture_id LIKE 'no_%'").all() as { fixture_id: string }[];
    for (const { fixture_id } of kept) {
      expect(w.eventCount(fixture_id), fixture_id).toBe(3);
      const st = w.one("SELECT events_json FROM match_states WHERE fixture = ?", fixture_id);
      if (st) expect(st.events_json, fixture_id).toBe(JSON.stringify([{ legacy: fixture_id }]));
    }
  });

  it("keeps everything but the expired event detail byte for byte", () => {
    const w = world();
    w.fixture("fx_a");
    w.fixture("fx_b", { status: "live" });
    const before = {
      summary: w.one("SELECT * FROM match_summaries WHERE fixture_id = 'fx_a'"),
      state: w.one("SELECT * FROM match_states WHERE fixture = 'fx_a'"),
      coaching: w.db.prepare("SELECT * FROM coaching_commands ORDER BY id").all(),
      otherEvents: w.db.prepare("SELECT * FROM match_events WHERE fixture = 'fx_b' ORDER BY id").all(),
    };

    retention.runRetention(w.app, { days: 30 });

    expect(w.one("SELECT * FROM match_summaries WHERE fixture_id = 'fx_a'")).toEqual({ ...before.summary, events_purged: 1 });
    expect(w.one("SELECT * FROM match_states WHERE fixture = 'fx_a'")).toEqual({ ...before.state, events_json: "[]" });
    expect(w.eventCount("fx_a")).toBe(0);
    expect(w.db.prepare("SELECT * FROM coaching_commands ORDER BY id").all()).toEqual(before.coaching);
    expect(w.db.prepare("SELECT * FROM match_events WHERE fixture = 'fx_b' ORDER BY id").all()).toEqual(before.otherEvents);
  });
});

describe("retention progress", () => {
  it("drains more than 200 eligible fixtures queued behind 250 older blocked ones in one run", () => {
    const w = world();
    for (let i = 0; i < 250; i++) {
      w.fixture(`blocked_${String(i).padStart(3, "0")}`, { tournament: "t_live", completed: pbDate(NOW - 90 * DAY) });
    }
    for (let i = 0; i < 230; i++) {
      // Groups of ten share one completed_at.
      w.fixture(`elig_${String(i).padStart(3, "0")}`, { completed: pbDate(NOW - 60 * DAY + Math.floor(i / 10) * 1000) });
    }

    const r = retention.runRetention(w.app, { days: 30 });

    expect(r).toMatchObject({ fixtures_deleted: 230, examined: 230, eligible_total: 230, deleted: 230, failed: 0 });
    expect(w.purged()).toHaveLength(230);
    expect(w.purged().every((fx) => fx.startsWith("elig_"))).toBe(true);
    expect(r.eligible).toHaveLength(50);
  });

  it("walks same-date ties in id order, each fixture once", () => {
    const w = world();
    const later = pbDate(NOW - 59 * DAY);
    for (const id of ["tie_e", "tie_a", "tie_d", "tie_b", "tie_c"]) w.fixture(id);
    w.fixture("after_x", { completed: later });
    w.fixture("before_z", { completed: pbDate(NOW - 61 * DAY) });

    const r = retention.runRetention(w.app, { days: 30 });

    expect(r.eligible).toEqual(["before_z", "tie_a", "tie_b", "tie_c", "tie_d", "tie_e", "after_x"]);
    expect(r).toMatchObject({ fixtures_deleted: 7, examined: 7 });
  });

  it("rechecks each fixture in its own transaction after the page was read", () => {
    let changed = false;
    const w = world({
      afterPage: (table) => {
        if (table !== "match_summaries" || changed) return;
        changed = true;
        // Between the page read and the per-fixture purge: a bet appears, a state reopens.
        w.bet({ fixture: "fx_2", round: "r_done", market: "next_goal", status: "open" });
        w.db.prepare("UPDATE match_states SET progression_settled = FALSE WHERE fixture = 'fx_3'").run();
      },
    });
    for (const id of ["fx_1", "fx_2", "fx_3", "fx_4"]) w.fixture(id);

    const r = retention.runRetention(w.app, { days: 30 });

    expect(w.purged()).toEqual(["fx_1", "fx_4"]);
    expect(r.skipped).toEqual(["fx_2:no_longer_eligible", "fx_3:no_longer_eligible"]);
    expect(r).toMatchObject({ examined: 4, fixtures_deleted: 2, failed: 0 });
    expect(w.eventCount("fx_2")).toBe(3);
    expect(w.eventCount("fx_3")).toBe(3);
  });

  it("writes nothing for a candidate whose summary now belongs to another fixture", () => {
    let moved = false;
    const w = world({
      afterPage: (table) => {
        if (table !== "match_summaries" || moved) return;
        moved = true;
        // After the page read, fx_1's summary row is re-pointed at fx_other (itself eligible).
        w.db.prepare("UPDATE match_summaries SET fixture_id = 'fx_other' WHERE id = 'sum_fx_1'").run();
      },
    });
    w.fixture("fx_1");
    w.fixture("fx_2");
    w.fixture("fx_other", { noState: true, completed: pbDate(NOW - 10 * DAY) });
    w.db.prepare("DELETE FROM match_summaries WHERE id = 'sum_fx_other'").run();
    const fx1State = w.one("SELECT * FROM match_states WHERE fixture = 'fx_1'");

    const r = retention.runRetention(w.app, { days: 30 });

    expect(r.skipped).toEqual(["fx_1:no_longer_eligible"]);
    expect(r).toMatchObject({ examined: 2, fixtures_deleted: 1, failed: 0 });
    expect(w.one("SELECT * FROM match_states WHERE fixture = 'fx_1'")).toEqual(fx1State);
    expect(w.eventCount("fx_1")).toBe(3);
    expect(w.eventCount("fx_other")).toBe(3);
    expect(w.one("SELECT events_purged FROM match_summaries WHERE id = 'sum_fx_1'").events_purged).toBe(0);
    expect(w.purged()).toEqual(["fx_2"]);
  });

  it("rolls a failing fixture back alone and carries on with the next ones", () => {
    const w = world();
    for (const id of ["fx_a", "fx_b", "fx_c"]) w.fixture(id);
    w.db.exec(
      "CREATE TRIGGER fail_b BEFORE DELETE ON match_events WHEN OLD.fixture = 'fx_b' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );

    const r = retention.runRetention(w.app, { days: 30 });

    expect(w.purged()).toEqual(["fx_a", "fx_c"]);
    expect(r).toMatchObject({ examined: 3, fixtures_deleted: 2, failed: 1, deleted: 2 });
    expect(r.error).toMatch(/fx_b: .*injected/);
    // The state clear ran before the failing delete and was rolled back with it.
    expect(w.one("SELECT events_json FROM match_states WHERE fixture = 'fx_b'").events_json).toBe(
      JSON.stringify([{ legacy: "fx_b" }]),
    );
    expect(w.eventCount("fx_b")).toBe(3);

    const again = retention.runRetention(w.app, { days: 30 });
    expect(again).toMatchObject({ examined: 1, fixtures_deleted: 0, failed: 1 });
  });

  it("drains every expired scan past 50 and keeps current ones", () => {
    const w = world();
    // Fresh scans sort first by id; the expired ones must still all go.
    for (let i = 0; i < 60; i++) w.scan(`a_fresh_${String(i).padStart(2, "0")}`, pbDate(NOW - i * 1000));
    for (let i = 0; i < 130; i++) w.scan(`z_old_${String(i).padStart(3, "0")}`, pbDate(NOW - 40 * DAY + (i % 7)));

    const r = retention.runRetention(w.app, { days: 30 });

    expect(r).toMatchObject({ scans_eligible: 130, scans_deleted: 130, deleted: 130, failed: 0 });
    expect(w.one("SELECT count(*) AS n FROM tactical_scans").n).toBe(60);
    expect(w.one("SELECT count(*) AS n FROM tactical_scans WHERE id LIKE 'z_old_%'").n).toBe(0);
  });
});

describe("retention reporting", () => {
  it("counts status exactly past 500 summaries", () => {
    const w = world();
    for (let i = 0; i < 620; i++) w.fixture(`fx_${i}`, { status: "live", purged: i < 333 ? 1 : 0 });

    const s = retention.retentionStatus(w.app);

    expect(s).toMatchObject({ match_summaries: 620, events_purged: 333, never: false });
  });

  it("preview counts exactly, lists a bounded keyset page and writes nothing", () => {
    const w = world();
    for (let i = 0; i < 75; i++) w.fixture(`fx_${String(i).padStart(2, "0")}`);
    w.fixture("held", { status: "live" });
    for (let i = 0; i < 55; i++) w.scan(`old_${i}`, pbDate(NOW - 40 * DAY));
    w.scan("new_1", pbDate(NOW));
    const before = w.dump();

    const r = retention.runRetention(w.app, { preview: true, days: 30 });

    expect(w.dump()).toBe(before);
    expect(w.worldRow.values.last_retention_at).toBeUndefined();
    expect(r).toMatchObject({
      preview: true,
      deleted: 0,
      fixtures_deleted: 0,
      scans_deleted: 0,
      failed: 0,
      eligible_total: 75,
      scans_eligible: 55,
      examined: 50,
      error: "",
    });
    expect(r.eligible).toEqual(Array.from({ length: 50 }, (_, i) => `fx_${String(i).padStart(2, "0")}`));
  });

  it("Never (0) skips deletion", () => {
    const w = world({ retentionDays: 0 });
    w.fixture("fx_a");
    w.scan("old", pbDate(NOW - 400 * DAY));
    const before = w.dump();

    const r = retention.runRetention(w.app);

    expect(w.dump()).toBe(before);
    expect(r.retention_days).toBe(0);
    expect(r.skipped.some((s) => /Never/i.test(s))).toBe(true);
    expect(r).toMatchObject({ deleted: 0, fixtures_deleted: 0, scans_deleted: 0, eligible_total: 0, failed: 0 });
  });

  it("supported day values include 7 30 90", () => {
    for (const d of [7, 30, 90]) {
      const r = retention.runRetention(world().app, { preview: true, days: d });
      expect(r.retention_days).toBe(d);
      expect(r.deleted).toBe(0);
    }
  });
});
