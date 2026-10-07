// Issue #15 (review B4/D6): settlement pages through every bet, and ledger
// failures propagate out of the money paths instead of being swallowed.
// The real-PocketBase counterpart (transactions, injected DB failures, retry)
// is tests/integration/settlement-recovery.mjs.
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f));

type Row = { id: string; collectionName: string; data: Record<string, unknown>; get(k: string): unknown; set(k: string, v: unknown): void };

class FakeRecord implements Row {
  static seq = 0;
  id: string;
  collectionName: string;
  data: Record<string, unknown> = {};
  constructor(col: { name: string }) {
    this.collectionName = col.name;
    this.id = "r" + String(++FakeRecord.seq).padStart(14, "0");
  }
  get(k: string) {
    return this.data[k];
  }
  set(k: string, v: unknown) {
    this.data[k] = v;
  }
}

/** Minimal in-memory $app: understands only the filters the settlement paths use. */
function fakeApp(failSave?: (r: Row) => boolean) {
  const store: Record<string, Row[]> = {};
  const add = (name: string, id: string, data: Record<string, unknown>) => {
    const r = new FakeRecord({ name });
    r.id = id;
    r.data = { ...data };
    (store[name] ||= []).push(r);
    return r;
  };
  const app = {
    store,
    add,
    pageReads: 0,
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (name: string, id: string) => {
      const r = (store[name] || []).find((x) => x.id === id);
      if (!r) throw new Error("not found " + name + "/" + id);
      return r;
    },
    save: (r: Row) => {
      if (failSave && failSave(r)) throw new Error("injected save failure: " + r.collectionName);
      const rows = (store[r.collectionName] ||= []);
      if (!rows.includes(r)) rows.push(r);
    },
    runInTransaction: (fn: (tx: unknown) => void) => fn(app),
    findRecordsByFilter: (name: string, filter: string, sort: string, limit: number, _o: number, p: Record<string, string>) => {
      let rows = (store[name] || []).slice();
      if (/idempotency_key = \{:k\}/.test(filter)) rows = rows.filter((r) => r.get("idempotency_key") === p.k);
      if (/settlement_key = \{:k\}/.test(filter)) rows = rows.filter((r) => r.get("settlement_key") === p.k);
      if (/status = "open" \|\| status = "locked"/.test(filter)) rows = rows.filter((r) => r.get("status") === "open" || r.get("status") === "locked");
      if (/id > \{:last\}/.test(filter)) rows = rows.filter((r) => r.id > p.last);
      if (/fixture = \{:f\}/.test(filter)) rows = rows.filter((r) => r.get("fixture") === p.f);
      if (/^id = \{:id\}/.test(filter)) rows = rows.filter((r) => r.id === p.id);
      if (/team = \{:t\}/.test(filter)) rows = rows.filter((r) => r.get("team") === p.t);
      if (/name = \{:n\}/.test(filter)) rows = rows.filter((r) => r.get("name") === p.n);
      if (/player = \{:p\}/.test(filter)) rows = rows.filter((r) => r.get("player") === p.p);
      if (name === "shared_bets") app.pageReads++;
      if (sort === "id") rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      return rows.slice(0, limit);
    },
  };
  return app;
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.Record = FakeRecord;
  g.BadRequestError = class extends Error {};
});
afterEach(() => {
  delete g.Record;
  delete g.BadRequestError;
});

describe("fixture bet settlement", () => {
  it("settles every bet past the page size (1201 bets, one payout each)", () => {
    const bets = lib("bettingService.js");
    const app = fakeApp();
    app.add("users", "u1", { credits: 0 });
    app.add("shared_fixtures", "fx1", { home_team: "H", away_team: "A" });
    const N = 1201;
    for (let i = 0; i < N; i++) {
      app.add("shared_bets", "b" + String(i).padStart(14, "0"), {
        user: "u1",
        fixture: "fx1",
        market: "winner",
        selection: i % 2 ? "home" : "away",
        stake: 10,
        odds: 2,
        status: i % 3 ? "open" : "locked",
      });
    }
    const fx = app.findRecordById("shared_fixtures", "fx1");
    const n = bets.settleFixtureBets(app, fx, { sh: 2, sa: 1, soh: 0, soa: 0, winner: "home", winnerId: "H", by: "normal" }, Date.now());
    expect(n).toBe(N);
    const all = app.store.shared_bets;
    expect(all.filter((b) => b.get("status") === "open" || b.get("status") === "locked")).toHaveLength(0);
    expect(app.pageReads).toBeGreaterThan(2); // really paged, not one capped read
    const won = all.filter((b) => b.get("status") === "won");
    const ledger = app.store.credit_ledger || [];
    expect(won).toHaveLength(600);
    expect(ledger).toHaveLength(600);
    expect(new Set(ledger.map((l) => l.get("idempotency_key"))).size).toBe(600);
    expect(app.findRecordById("users", "u1").get("credits")).toBe(600 * 20);
    // Re-running is a no-op: nothing left open, no second payout.
    expect(bets.settleFixtureBets(app, fx, { sh: 2, sa: 1, soh: 0, soa: 0, winner: "home", winnerId: "H", by: "normal" }, Date.now())).toBe(0);
    expect(app.store.credit_ledger).toHaveLength(600);
  });
});

describe("ledger failures propagate", () => {
  function teams(app: ReturnType<typeof fakeApp>) {
    app.add("proball_teams", "H", { treasury: 1000, grade: "B" });
    app.add("proball_teams", "A", { treasury: 1000, grade: "B" });
    return { get: (k: string) => ({ home_team: "H", away_team: "A" })[k], id: "fx1" };
  }
  const ms = { get: (k: string) => ({ winner_team: "H", score_home: 2, score_away: 1 })[k] };

  it("a failed reward ledger write throws out of rewardFixture (so the fixture transaction rolls back)", () => {
    const mgmt = lib("managementService.js");
    const app = fakeApp((r) => r.collectionName === "team_finance_ledger");
    const fx = teams(app);
    expect(() => mgmt.rewardFixture(app, fx, ms, "t1", "r16")).toThrow(/injected/);
    expect(app.store.reward_settlements || []).toHaveLength(0);
  });

  it("a failed reward settlement marker throws too", () => {
    const mgmt = lib("managementService.js");
    const app = fakeApp((r) => r.collectionName === "reward_settlements");
    const fx = teams(app);
    expect(() => mgmt.rewardFixture(app, fx, ms, "t1", "r16")).toThrow(/injected/);
  });

  it("rewards stay idempotent per settlement key", () => {
    const mgmt = lib("managementService.js");
    const app = fakeApp();
    const fx = teams(app);
    mgmt.rewardFixture(app, fx, ms, "t1", "r16");
    const after = app.findRecordById("proball_teams", "H").get("treasury");
    const rows = app.store.team_finance_ledger.length;
    mgmt.rewardFixture(app, fx, ms, "t1", "r16");
    expect(app.findRecordById("proball_teams", "H").get("treasury")).toBe(after);
    expect(app.store.team_finance_ledger).toHaveLength(rows);
  });

  it("admin credit and treasury adjustments propagate ledger failures", () => {
    const adm = lib("adminService.js");
    const app = fakeApp((r) => r.collectionName === "credit_ledger" || r.collectionName === "team_finance_ledger");
    app.add("users", "u1", { credits: 100 });
    app.add("proball_teams", "H", { treasury: 1000 });
    expect(() => adm.adjustCredits(app, "admin", "u1", "add", 50, "test")).toThrow(/injected/);
    expect(() => adm.adjustTreasury(app, "admin", "H", "add", 50, "test")).toThrow(/injected/);
  });

  it("admin adjustments write one ledger row with balance_after", () => {
    const adm = lib("adminService.js");
    const app = fakeApp();
    app.add("users", "u1", { credits: 100 });
    app.add("proball_teams", "H", { treasury: 1000 });
    expect(adm.adjustCredits(app, "admin", "u1", "set", 70, "test")).toMatchObject({ before: 100, after: 70 });
    expect(adm.adjustTreasury(app, "admin", "H", "remove", 300, "test")).toMatchObject({ before: 1000, after: 700 });
    const cl = app.store.credit_ledger;
    expect(cl).toHaveLength(1);
    expect(cl[0].data).toMatchObject({ type: "admin_adjust", amount: -30, balance_after: 70 });
    const tl = app.store.team_finance_ledger;
    expect(tl).toHaveLength(1);
    expect(tl[0].data).toMatchObject({ type: "admin_adjust", amount: -300, balance_after: 700 });
  });
});

describe("player record failures propagate (review R2)", () => {
  const fx = { get: (k: string) => ({ home_team: "H", away_team: "A" })[k], id: "fx1" };
  const extra = (home: Array<Record<string, unknown>>) => ({ players: { home, away: [] }, events: [{ type: "goal", player: "Ann" }] });

  it("a failed player-record save throws out of settlePlayerRecordsFromMatch (fixture transaction rolls back)", () => {
    const rec = lib("recordsService.js");
    const app = fakeApp((r) => r.collectionName === "global_player_records");
    app.add("proball_players", "p1", { team: "H", name: "Ann", role: "FW" });
    expect(() => rec.settlePlayerRecordsFromMatch(app, fx, null, extra([{ id: "p1", name: "Ann" }]))).toThrow(/injected/);
  });

  it("an unresolvable player is still skipped, not an error", () => {
    const rec = lib("recordsService.js");
    const app = fakeApp();
    app.add("proball_players", "p1", { team: "H", name: "Ann", role: "FW" });
    rec.settlePlayerRecordsFromMatch(app, fx, null, extra([{ id: "gone", name: "Nobody" }, { id: "gone2", name: "Ann" }]));
    const rows = app.store.global_player_records;
    expect(rows).toHaveLength(1); // Ann resolved by team + name; Nobody skipped
    expect(rows[0].data).toMatchObject({ player: "p1", goals: 1, appearances: 1 });
  });

  it("a failed championship award throws out of awardChampionshipPlayers (completion rolls back)", () => {
    const rec = lib("recordsService.js");
    const app = fakeApp((r) => r.collectionName === "global_player_records");
    app.add("global_player_records", "g1", { team: "H", championships: 0 });
    expect(() => rec.awardChampionshipPlayers(app, "H")).toThrow(/injected/);
  });

  it("championship award increments each of the team's player records once", () => {
    const rec = lib("recordsService.js");
    const app = fakeApp();
    app.add("global_player_records", "g1", { team: "H", championships: 2 });
    app.add("global_player_records", "g2", { team: "A", championships: 0 });
    rec.awardChampionshipPlayers(app, "H");
    expect(app.findRecordById("global_player_records", "g1").get("championships")).toBe(3);
    expect(app.findRecordById("global_player_records", "g2").get("championships")).toBe(0);
  });
});
