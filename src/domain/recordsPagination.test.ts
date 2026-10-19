// @vitest-environment node
// Issue #23: archive filters run in SQL before the limit, pages are stable and complete,
// tournament detail reads every match of the tournament (more than one internal page),
// unknown rounds are kept, and player/squad lookups are batched. The service runs
// against an in-memory SQLite copy of the columns it reads, so its real queries decide.
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type Item = Record<string, unknown> & { id: string };
type Page<K extends string> = Record<K, Item[]> & { page: number; perPage: number; hasMore: boolean };
type Filters = { tournamentId?: string; teamId?: string; roundKey?: string; shootoutOnly?: boolean; etOnly?: boolean };

class BadRequest extends Error {
  status = 400;
}
type Params = Record<string, string | number>;
type Exp = { sql: string; params: Params };
class FakeRecord {}
Object.assign(globalThis, {
  $dbx: { exp: (sql: string, params: Params = {}) => ({ sql, params }) },
  arrayOf: () => [],
  Record: FakeRecord,
  BadRequestError: BadRequest,
});

const records = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/recordsService.js")) as {
  matchArchivePage: (app: unknown, f: Filters, page?: unknown, perPage?: unknown) => Page<"matches">;
  listMatchArchive: (app: unknown, f?: Filters) => Item[];
  tournamentsPage: (app: unknown, page?: unknown, perPage?: unknown) => Page<"tournaments">;
  listTournaments: (app: unknown) => Item[];
  playerRecordsPage: (app: unknown, f: { teamId?: string; role?: string }, page?: unknown, perPage?: unknown) => Page<"players">;
  listPlayerRecords: (app: unknown, f: { leaders?: boolean; teamId?: string; role?: string }) => Item[];
  tournamentDetail: (app: unknown, id: string) => {
    matches: Item[];
    rounds: Record<string, Item[]>;
    bracket: unknown[];
    topScorer: { name: string; goals: number } | null;
  };
  teamDetail: (app: unknown, id: string) => {
    recentMatches: Item[];
    recentForm: string[];
    squad: { id: string; goals: number; appearances: number }[];
  };
};

const SCHEMA = `
CREATE TABLE match_summaries (id TEXT PRIMARY KEY, fixture_id TEXT, tournament_id TEXT NOT NULL DEFAULT '',
  round_key TEXT NOT NULL DEFAULT '', slot TEXT, home_team TEXT NOT NULL DEFAULT '', away_team TEXT NOT NULL DEFAULT '',
  home_name TEXT, away_name TEXT, score_home INTEGER, score_away INTEGER, shootout_home INTEGER, shootout_away INTEGER,
  winner_team TEXT, went_extra_time BOOLEAN NOT NULL DEFAULT FALSE, went_shootout BOOLEAN NOT NULL DEFAULT FALSE,
  stats_json TEXT, goals_json TEXT, cards_json TEXT, shootout_kicks_json TEXT, events_purged BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TEXT NOT NULL DEFAULT '');
CREATE TABLE tournament_summaries (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL DEFAULT '', number INTEGER,
  champion_name TEXT, runner_up_name TEXT, champion_team TEXT, runner_up_team TEXT, total_goals INTEGER,
  extra_time_matches INTEGER, shootout_matches INTEGER, bracket_json TEXT, highlights_json TEXT, completed_at TEXT);
CREATE TABLE shared_tournaments (id TEXT PRIMARY KEY, number INTEGER, status TEXT, champion_team TEXT);
CREATE TABLE proball_teams (id TEXT PRIMARY KEY, name TEXT, manager TEXT NOT NULL DEFAULT '', sort_order INTEGER);
CREATE TABLE proball_players (id TEXT PRIMARY KEY, team TEXT, name TEXT, role TEXT, sort_order INTEGER);
CREATE TABLE global_player_records (id TEXT PRIMARY KEY, player TEXT, player_name TEXT, team TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '', appearances INTEGER, goals INTEGER NOT NULL DEFAULT 0);
CREATE TABLE global_team_records (id TEXT PRIMARY KEY, team TEXT);
CREATE TABLE team_finance_ledger (id TEXT PRIMARY KEY, team TEXT, created TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT);
`;

const BASE = Date.UTC(2026, 0, 1);
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString().replace("T", " ");

class Row {
  id: string;
  private data: Record<string, unknown>;
  constructor(data: Record<string, unknown>) {
    this.data = data;
    this.id = String(data.id);
  }
  get(key: string) {
    return this.data[key];
  }
  getString(key: string) {
    return String(this.data[key] ?? "");
  }
}

const bindable = (sql: string) => sql.replace(/\{:(\w+)\}/g, ":$1");
/** PocketBase filter/sort strings used by the detail views, as SQLite. */
const pbFilter = (filter: string) => bindable(filter).replace(/\|\|/g, " OR ").replace(/&&/g, " AND ");
const pbSort = (sort: string) =>
  sort
    .split(",")
    .filter(Boolean)
    .map((s) => (s.startsWith("-") ? `${s.slice(1)} DESC` : `${s} ASC`))
    .join(", ");

/** The PocketBase app surface recordsService uses, backed by real SQLite, counting queries. */
function archive() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const calls: Record<string, number> = {};
  const count = (key: string) => {
    calls[key] = (calls[key] ?? 0) + 1;
  };
  const rowsOf = (sql: string, params: Params) =>
    (db.prepare(sql).all(params) as Record<string, unknown>[]).map((r) => new Row(r));
  const app = {
    recordQuery(table: string) {
      const exps: Exp[] = [];
      let order: string[] = [];
      let limit = -1;
      let offset = 0;
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
        offset(n: number) {
          offset = n;
          return q;
        },
        all(out: Row[]) {
          count("query:" + table);
          const where = exps.length ? " WHERE " + exps.map((e) => `(${bindable(e.sql)})`).join(" AND ") : "";
          const sort = order.length ? " ORDER BY " + order.join(", ") : "";
          const params = Object.assign({}, ...exps.map((e) => e.params)) as Params;
          out.push(...rowsOf(`SELECT * FROM ${table}${where}${sort} LIMIT ${limit} OFFSET ${offset}`, params));
        },
      };
      return q;
    },
    findRecordsByFilter(table: string, filter: string, sort: string, limit: number, offset: number, params: Params = {}) {
      count("filter:" + table);
      const order = sort ? ` ORDER BY ${pbSort(sort)}` : "";
      return rowsOf(`SELECT * FROM ${table} WHERE ${pbFilter(filter)}${order} LIMIT ${limit} OFFSET ${offset}`, params);
    },
    findRecordById(table: string, id: string) {
      count("byId:" + table);
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error("sql: no rows in result set");
      return new Row(row);
    },
  };
  const ins = (table: string, row: Record<string, string | number>) => {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(
      ...keys.map((k) => row[k]),
    );
  };
  const seeded: { id: string; tournament: string; round: string; home: string; away: string; completed: string; so: number; et: number }[] = [];
  function summary(
    id: string,
    o: { tournament?: string; round?: string; home?: string; away?: string; minute: number; so?: number; et?: number; scorers?: string[] },
  ) {
    const row = {
      id,
      tournament: o.tournament ?? "t_new",
      round: o.round ?? "r16",
      home: o.home ?? "team_a",
      away: o.away ?? "team_b",
      completed: at(o.minute),
      so: o.so ?? 0,
      et: o.et ?? 0,
    };
    seeded.push(row);
    ins("match_summaries", {
      id,
      fixture_id: "fx_" + id,
      tournament_id: row.tournament,
      round_key: row.round,
      slot: "s_" + id,
      home_team: row.home,
      away_team: row.away,
      home_name: "Home " + row.home,
      away_name: "Away " + row.away,
      score_home: 2,
      score_away: 1,
      shootout_home: 0,
      shootout_away: 0,
      winner_team: row.home,
      went_extra_time: row.et,
      went_shootout: row.so,
      stats_json: "{}",
      goals_json: JSON.stringify((o.scorers ?? []).map((player) => ({ player }))),
      cards_json: "[]",
      shootout_kicks_json: "[]",
      completed_at: row.completed,
    });
  }
  /** Ids in the public order: completed_at newest first, then id. */
  const ordered = (keep: (r: (typeof seeded)[number]) => boolean) =>
    seeded
      .filter(keep)
      .sort((a, b) => (a.completed === b.completed ? (a.id < b.id ? -1 : 1) : a.completed < b.completed ? 1 : -1))
      .map((r) => r.id);
  return { app, db, calls, ins, summary, ordered };
}

const ids = (items: Item[]) => items.map((m) => m.id);

describe("tournament detail reads every match", () => {
  it("aggregates matches, rounds, bracket and top scorer across more than one internal page", () => {
    const a = archive();
    // 150 newer matches elsewhere push the whole old tournament out of the newest 100.
    for (let i = 0; i < 150; i++) a.summary(`new_${String(i).padStart(3, "0")}`, { minute: 10_000 + i });
    const rounds = [
      ...Array(40).fill("r16"),
      ...Array(30).fill("qf"),
      ...Array(25).fill("sf"),
      ...Array(20).fill("final"),
      ...Array(9).fill("r32"),
      ...Array(6).fill(""),
    ];
    expect(rounds).toHaveLength(130);
    // 130 matches in groups of 13 sharing one completed_at; ids inserted out of order.
    rounds.forEach((round, i) => {
      const n = (i * 37) % 130;
      a.summary(`old_${String(n).padStart(3, "0")}`, {
        tournament: "t_old",
        round,
        minute: Math.floor(n / 13),
        // Only a full read sees Late Larry: his 30 goals are in the 30 oldest matches.
        scorers: n < 30 ? ["Late Larry"] : n >= 120 ? ["Early Ed", "Early Ed"] : [],
      });
    });

    const d = records.tournamentDetail(a.app, "t_old");

    expect(d.matches).toHaveLength(130);
    expect(ids(d.matches)).toEqual(a.ordered((r) => r.tournament === "t_old"));
    expect(new Set(ids(d.matches)).size).toBe(130);
    expect(a.calls["query:match_summaries"]).toBe(2);
    expect(Object.keys(d.rounds)).toEqual(["r16", "qf", "sf", "final", "other"]);
    expect(d.rounds.r16).toHaveLength(40);
    expect(d.rounds.qf).toHaveLength(30);
    expect(d.rounds.sf).toHaveLength(25);
    expect(d.rounds.final).toHaveLength(20);
    expect(d.rounds.other.map((m) => m.roundKey).sort()).toEqual([...Array(6).fill(""), ...Array(9).fill("r32")]);
    expect(d.bracket).toHaveLength(130);
    expect(d.topScorer).toEqual({ name: "Late Larry", goals: 30 });
  });

  it("sends no other round when every match has a known round", () => {
    const a = archive();
    a.summary("k1", { tournament: "t_k", round: "qf", minute: 1 });
    a.summary("k2", { tournament: "t_k", round: "final", minute: 2 });

    const d = records.tournamentDetail(a.app, "t_k");

    expect(Object.keys(d.rounds)).toEqual(["r16", "qf", "sf", "final"]);
    expect(ids(d.matches)).toEqual(["k2", "k1"]);
  });
});

describe("match archive", () => {
  function older() {
    const a = archive();
    for (let i = 0; i < 150; i++) a.summary(`new_${String(i).padStart(3, "0")}`, { minute: 10_000 + i });
    for (let i = 0; i < 20; i++) {
      a.summary(`old_${String(i).padStart(2, "0")}`, {
        tournament: "t_old",
        round: i % 4 === 0 ? "sf" : "qf",
        home: i % 2 ? "z_team" : "team_c",
        away: i % 2 ? "team_c" : "z_team",
        minute: i,
        so: i % 3 === 0 ? 1 : 0,
        et: i % 5 === 0 ? 1 : 0,
      });
    }
    return a;
  }

  it.each<[string, Filters, (r: { tournament: string; round: string; home: string; away: string; so: number; et: number }) => boolean]>([
    ["team", { teamId: "z_team" }, (r) => r.home === "z_team" || r.away === "z_team"],
    ["tournament", { tournamentId: "t_old" }, (r) => r.tournament === "t_old"],
    ["tournament and round", { tournamentId: "t_old", roundKey: "sf" }, (r) => r.tournament === "t_old" && r.round === "sf"],
    ["shootouts", { shootoutOnly: true }, (r) => r.so === 1],
    ["extra time", { etOnly: true }, (r) => r.et === 1],
  ])("filters by %s in SQL before the limit, finding matches older than the newest 100", (_name, filters, keep) => {
    const a = older();
    const expected = a.ordered(keep);
    expect(expected.length).toBeGreaterThan(0);

    const page = records.matchArchivePage(a.app, filters);

    expect(ids(page.matches)).toEqual(expected);
    expect(page).toMatchObject({ page: 1, perPage: 100, hasMore: false });
  });

  it("binds filter values instead of interpolating them", () => {
    const a = older();
    expect(records.matchArchivePage(a.app, { teamId: "x' OR 1=1 --" }).matches).toEqual([]);
    expect(records.matchArchivePage(a.app, { roundKey: "') OR ('1'='1" }).matches).toEqual([]);
  });

  it("walks every page once across equal completion times, with no duplicate or skip", () => {
    const a = archive();
    // 230 matches, ten per completion time, inserted in a scrambled id order.
    for (let i = 0; i < 230; i++) {
      const n = (i * 53) % 230;
      a.summary(`m_${String(n).padStart(3, "0")}`, { minute: Math.floor(n / 10) });
    }
    const walked: string[] = [];
    let pages = 0;
    for (let page = 1; ; page++) {
      const r = records.matchArchivePage(a.app, {}, String(page), "37");
      expect(r).toMatchObject({ page, perPage: 37 });
      walked.push(...ids(r.matches));
      pages++;
      if (!r.hasMore) break;
    }

    expect(pages).toBe(7);
    expect(walked).toEqual(a.ordered(() => true));
    const first = records.matchArchivePage(a.app, {});
    expect(first.matches).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(ids(records.listMatchArchive(a.app, {}))).toEqual(ids(first.matches));
  });
});

describe("team detail", () => {
  it("shows the team's latest 12 of all its matches and reads the squad's records in one query", () => {
    const a = archive();
    for (let i = 0; i < 120; i++) a.summary(`new_${String(i).padStart(3, "0")}`, { minute: 10_000 + i });
    for (let i = 0; i < 15; i++) {
      a.summary(`own_${String(i).padStart(2, "0")}`, { home: i % 2 ? "old_team" : "team_x", away: i % 2 ? "team_x" : "old_team", minute: i });
    }
    a.ins("proball_teams", { id: "old_team", name: "Old Team", sort_order: 1 });
    for (let p = 0; p < 20; p++) {
      a.ins("proball_players", { id: `p${p}`, team: "old_team", name: `Player ${p}`, role: "FW", sort_order: p });
      a.ins("global_player_records", { id: `g${p}`, player: `p${p}`, team: "old_team", role: "FW", appearances: p + 1, goals: p * 2 });
    }

    const t = records.teamDetail(a.app, "old_team");

    expect(ids(t.recentMatches)).toEqual(a.ordered((r) => r.home === "old_team" || r.away === "old_team").slice(0, 12));
    expect(t.recentForm).toHaveLength(5);
    expect(t.squad).toHaveLength(20);
    expect(t.squad.map((p) => p.goals)).toEqual(Array.from({ length: 20 }, (_, p) => p * 2));
    expect(t.squad[19].appearances).toBe(20);
    expect(a.calls["query:global_player_records"]).toBe(1);
    expect(a.calls["filter:global_player_records"]).toBeUndefined();
  });
});

describe("player records", () => {
  function squads() {
    const a = archive();
    for (let t = 0; t < 16; t++) a.ins("proball_teams", { id: `team_${String(t).padStart(2, "0")}`, name: `Team ${t}` });
    // 240 scorers across 15 teams, then 20 goalless players of team_15 below the top 200.
    for (let i = 0; i < 240; i++) {
      a.ins("global_player_records", {
        id: `r_${String(i).padStart(3, "0")}`,
        player: `p_${i}`,
        player_name: `Scorer ${i}`,
        team: `team_${String(i % 15).padStart(2, "0")}`,
        role: i % 4 === 0 ? "GK" : "FW",
        appearances: 10,
        goals: 1 + (i % 40),
      });
    }
    for (let i = 0; i < 20; i++) {
      a.ins("global_player_records", { id: `z_${String(i).padStart(2, "0")}`, player: `q_${i}`, player_name: `Keeper ${i}`, team: "team_15", role: "GK", appearances: 3, goals: 0 });
    }
    return a;
  }

  it("filters by team before the limit, finding players outside the top 200", () => {
    const a = squads();
    const r = records.playerRecordsPage(a.app, { teamId: "team_15" });
    expect(r.players).toHaveLength(20);
    expect(r.players.every((p) => p.teamId === "team_15" && p.teamName === "Team 15")).toBe(true);
    expect(r.hasMore).toBe(false);
  });

  it("pages past 200 in goals order with one team lookup per page", () => {
    const a = squads();
    const first = records.playerRecordsPage(a.app, {});
    const second = records.playerRecordsPage(a.app, {}, "2");

    expect(first).toMatchObject({ page: 1, perPage: 200, hasMore: true });
    expect(second).toMatchObject({ page: 2, perPage: 200, hasMore: false });
    const all = [...first.players, ...second.players];
    expect(new Set(ids(all)).size).toBe(260);
    const goals = all.map((p) => p.goals as number);
    expect(goals).toEqual([...goals].sort((x, y) => y - x));
    expect(all.every((p) => p.teamName === `Team ${Number(String(p.teamId).slice(5))}`)).toBe(true);
    expect(a.calls["query:proball_teams"]).toBe(2);
    expect(a.calls["byId:proball_teams"]).toBeUndefined();
  });

  it("keeps leaders to the top 25, filtered by role in SQL", () => {
    const a = squads();
    const leaders = records.listPlayerRecords(a.app, { leaders: true, role: "GK" });
    expect(leaders).toHaveLength(25);
    expect(leaders.every((p) => p.role === "GK")).toBe(true);
    expect(leaders.map((p) => p.goals)).toEqual(leaders.map((p) => p.goals).sort((x, y) => (y as number) - (x as number)));
    expect(leaders[0].goals).toBe(37);
  });
});

describe("tournament list", () => {
  it("pages past 50, newest first", () => {
    const a = archive();
    for (let n = 1; n <= 75; n++) a.ins("tournament_summaries", { id: `ts_${n}`, tournament_id: `t_${n}`, number: n });

    const first = records.tournamentsPage(a.app);
    const second = records.tournamentsPage(a.app, "2");

    expect(first).toMatchObject({ page: 1, perPage: 50, hasMore: true });
    expect(first.tournaments.map((t) => t.number)).toEqual(Array.from({ length: 50 }, (_, i) => 75 - i));
    expect(second).toMatchObject({ page: 2, perPage: 50, hasMore: false });
    expect(second.tournaments.map((t) => t.number)).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
    expect(records.listTournaments(a.app)).toHaveLength(50);
  });
});

describe("first pages and validation", () => {
  it("keeps today's first windows and item fields", () => {
    const a = archive();
    for (let i = 0; i < 120; i++) a.summary(`m_${String(i).padStart(3, "0")}`, { minute: i });
    for (let n = 1; n <= 60; n++) a.ins("tournament_summaries", { id: `ts_${n}`, number: n });
    for (let i = 0; i < 210; i++) a.ins("global_player_records", { id: `r_${String(i).padStart(3, "0")}`, goals: i });

    const m = records.matchArchivePage(a.app, {});
    const t = records.tournamentsPage(a.app);
    const p = records.playerRecordsPage(a.app, {});

    expect([m.matches.length, t.tournaments.length, p.players.length]).toEqual([100, 50, 200]);
    expect(Object.keys(m.matches[0])).toEqual([
      "id", "fixtureId", "tournamentId", "roundKey", "slot", "homeName", "awayName", "homeTeamId", "awayTeamId",
      "scoreHome", "scoreAway", "shootoutHome", "shootoutAway", "winnerTeamId", "wentExtraTime", "wentShootout",
      "goals", "cards", "shootoutKicks", "eventsPurged", "completedAt", "stats",
    ]);
    expect(Object.keys(t.tournaments[0])).toEqual([
      "id", "tournamentId", "number", "champion", "runnerUp", "totalGoals", "extraTimeMatches", "shootoutMatches",
      "bracket", "highlights", "completedAt",
    ]);
    expect(Object.keys(p.players[0])).toEqual([
      "id", "playerId", "name", "teamId", "teamName", "role", "appearances", "goals", "goalsPerApp", "fouls",
      "yellowCards", "redCards", "penaltiesTaken", "penaltiesScored", "penaltiesMissed", "shootoutTaken",
      "shootoutScored", "shootoutMissed", "championships",
    ]);
  });

  it.each(["0", "-1", "abc", "1.5", " 1", "10000000"])("rejects page %j", (page) => {
    const a = archive();
    for (const call of [
      () => records.matchArchivePage(a.app, {}, page),
      () => records.tournamentsPage(a.app, page),
      () => records.playerRecordsPage(a.app, {}, page),
    ]) {
      expect(call).toThrow(new BadRequest("Page must be a whole number from 1"));
    }
  });

  it.each(["0", "201", "x", "50.5"])("rejects page size %j", (perPage) => {
    const a = archive();
    for (const call of [
      () => records.matchArchivePage(a.app, {}, "", perPage),
      () => records.tournamentsPage(a.app, "", perPage),
      () => records.playerRecordsPage(a.app, {}, "", perPage),
    ]) {
      expect(call).toThrow(new BadRequest("Page size must be a whole number from 1 to 200"));
    }
  });

  it("accepts the largest page size and empty values as defaults", () => {
    const a = archive();
    expect(records.matchArchivePage(a.app, {}, "", "200").perPage).toBe(200);
    expect(records.tournamentsPage(a.app, "", "").perPage).toBe(50);
    expect(records.playerRecordsPage(a.app, {}, undefined, undefined)).toMatchObject({ page: 1, perPage: 200 });
  });
});
