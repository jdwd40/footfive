import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bets = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/bettingService.js")) as {
  myBets: (app: unknown, userId: string) => {
    credits: number;
    bets: Array<{ id: string; status: string; stake: number }>;
    settledStaked: number;
    settledReturned: number;
    net: number;
    pendingStaked: number;
  };
};

type Row = { id: string; collectionName: string; data: Record<string, unknown>; get(k: string): unknown; set(k: string, v: unknown): void };

class FakeRecord implements Row {
  id: string;
  collectionName: string;
  data: Record<string, unknown> = {};
  constructor(col: { name: string }) {
    this.collectionName = col.name;
    this.id = "";
  }
  get(k: string) {
    return this.data[k];
  }
  set(k: string, v: unknown) {
    this.data[k] = v;
  }
}

function fakeApp() {
  const store: Record<string, Row[]> = {};
  const filters: string[] = [];
  let saves = 0;
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
    filters,
    get saves() {
      return saves;
    },
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (name: string, id: string) => {
      const r = (store[name] || []).find((x) => x.id === id);
      if (!r) throw new Error("not found " + name + "/" + id);
      return r;
    },
    save: () => {
      saves += 1;
    },
    findRecordsByFilter: (name: string, filter: string, sort: string, limit: number, _offset: number, params: Record<string, string>) => {
      let rows = (store[name] || []).slice();
      filters.push(filter);
      if (/status = "open" \|\| status = "locked"/.test(filter)) rows = rows.filter((r) => r.get("status") === "open" || r.get("status") === "locked");
      if (/id > \{:last\}/.test(filter)) rows = rows.filter((r) => r.id > params.last);
      if (/user = \{:u\}/.test(filter)) rows = rows.filter((r) => r.get("user") === params.u);
      if (sort === "id") rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (sort === "-created") rows.sort((a, b) => Number(b.get("created")) - Number(a.get("created")));
      return rows.slice(0, limit);
    },
  };
  return app;
}

function id(n: number) {
  return "b" + String(n).padStart(14, "0");
}

function bet(n: number, data: Record<string, unknown>) {
  return { market: "winner", selection: "home", odds: 2, created: n, ...data };
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

describe("myBets pending stakes", () => {
  it("sums every open and locked stake past one page and leaves other users and settled bets out", () => {
    const app = fakeApp();
    app.add("users", "u1", { credits: 950 });
    for (let i = 0; i < 501; i++) app.add("shared_bets", id(i), bet(i, { user: "u1", stake: 1, status: "open" }));
    app.add("shared_bets", id(501), bet(501, { user: "u1", stake: 7, status: "locked" }));
    app.add("shared_bets", id(502), bet(502, { user: "u2", stake: 100, status: "open" }));
    app.add("shared_bets", id(503), bet(503, { user: "u1", stake: 40, status: "won", payout: 80 }));
    const before = JSON.stringify(app.store.shared_bets.map((r) => [r.id, r.get("status"), r.get("stake"), r.get("user")]));
    const mine = bets.myBets(app, "u1");
    expect(mine.pendingStaked).toBe(508);
    expect(mine.credits).toBe(950);
    expect(mine.settledStaked).toBe(40);
    expect(mine.settledReturned).toBe(80);
    expect(mine.net).toBe(40);
    expect(mine.bets.some((b) => b.id === id(0))).toBe(false);
    expect(app.filters.filter((f) => f.includes('status = "open" || status = "locked"') && f.includes("id > {:last}") && f.includes("user = {:u}")).length).toBeGreaterThan(1);
    expect(app.saves).toBe(0);
    expect(JSON.stringify(app.store.shared_bets.map((r) => [r.id, r.get("status"), r.get("stake"), r.get("user")]))).toBe(before);
  });

  it("keeps settled totals to the settled rows inside the latest 100", () => {
    const app = fakeApp();
    app.add("users", "u1", { credits: 950 });
    app.add("shared_bets", id(1), bet(1, { user: "u1", stake: 1000, status: "won", payout: 2000 }));
    for (let i = 0; i < 99; i++) app.add("shared_bets", id(10 + i), bet(10 + i, { user: "u1", stake: 2, status: "lost", payout: 0 }));
    app.add("shared_bets", id(10000), bet(10000, { user: "u1", stake: 50, status: "open" }));
    const mine = bets.myBets(app, "u1");
    expect(mine.bets).toHaveLength(100);
    expect(mine.bets.some((b) => b.id === id(1))).toBe(false);
    expect(mine.bets.some((b) => b.id === id(10000))).toBe(true);
    expect(mine.settledStaked).toBe(198);
    expect(mine.settledReturned).toBe(0);
    expect(mine.net).toBe(-198);
    expect(mine.pendingStaked).toBe(50);
    expect(app.saves).toBe(0);
  });

  it("returns zero pending and zero settled totals when the user has no bets", () => {
    const app = fakeApp();
    app.add("users", "u1", { credits: 1000 });
    const mine = bets.myBets(app, "u1");
    expect(mine.credits).toBe(1000);
    expect(mine.bets).toEqual([]);
    expect(mine.pendingStaked).toBe(0);
    expect(mine.settledStaked).toBe(0);
    expect(mine.settledReturned).toBe(0);
    expect(mine.net).toBe(0);
    expect(app.saves).toBe(0);
  });
});
