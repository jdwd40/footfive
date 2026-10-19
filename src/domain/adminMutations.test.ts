// Issue #29 (review B19/D7/D8): admin mutations validate before writing, guard
// self/last-admin changes in one transaction with fresh reads, and page users.
// Exact SQL search, counts beyond the old caps and real races are covered by the
// real-PocketBase suite tests/integration/admin-mutations.mjs.
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f));

class FakeRecord {
  static seq = 0;
  id: string;
  collectionName: string;
  data: Record<string, unknown> = {};
  constructor(col?: { name: string }) {
    this.collectionName = col ? col.name : "";
    this.id = "r" + String(++FakeRecord.seq).padStart(14, "0");
  }
  get(k: string) {
    return this.data[k];
  }
  set(k: string, v: unknown) {
    this.data[k] = v;
  }
  refreshTokenKey() {
    this.data.tokenKey = "tk" + ++FakeRecord.seq;
  }
}

type Exp = { kind: "hash"; obj: Record<string, unknown> } | { kind: "sql"; sql: string; params: Record<string, string> };

class ApiErr extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const NO_ROWS = "sql: no rows in result set";

/**
 * In-memory $app with transaction rollback. Only the filters these paths use are
 * understood; anything else throws. Using the outer app inside a transaction
 * callback throws too (on real PocketBase it deadlocks).
 */
function fakeApp(opts: { failSave?: (r: FakeRecord) => boolean; failDelete?: (r: FakeRecord) => boolean } = {}) {
  const store: Record<string, FakeRecord[]> = {};
  let inTx = false;
  const queries: Array<{ name: string; where: Exp[]; order: string[]; limit?: number; offset?: number }> = [];
  const add = (name: string, id: string, data: Record<string, unknown>) => {
    const r = new FakeRecord({ name });
    r.id = id;
    r.data = { ...data };
    (store[name] ||= []).push(r);
    return r;
  };
  const rows = (name: string) => (store[name] ||= []);
  const matches = (r: FakeRecord, e: Exp) => {
    if (e.kind === "hash") {
      return Object.keys(e.obj).every((k) => (k === "id" ? r.id : r.get(k) ?? (k === "disabled" ? false : "")) === e.obj[k]);
    }
    if (e.sql === "manager = '' OR manager IS NULL") return !r.get("manager");
    const inList = /^manager IN \(/.test(e.sql);
    if (inList) return Object.values(e.params).includes(String(r.get("manager")));
    if (/ LIKE \{:p\} ESCAPE/.test(e.sql)) return true; // matching itself is the real-PB suite's job
    throw new Error("unsupported exp: " + e.sql);
  };
  const filterRows = (name: string, filter: string, p: Record<string, string>) => {
    const all = rows(name).slice();
    if (filter === "id = {:id}") return all.filter((r) => r.id === p.id);
    if (filter === "manager = {:u}") return all.filter((r) => r.get("manager") === p.u);
    if (filter === 'user = {:u} && status = "open"') return all.filter((r) => r.get("user") === p.u && r.get("status") === "open");
    if (filter === "key = 'main'") return all.filter((r) => r.get("key") === "main");
    if (filter === 'status = "active"') return all.filter((r) => r.get("status") === "active");
    if (filter === "id != ''") return all;
    throw new Error("unsupported filter: " + filter);
  };
  const ops = (tx: boolean) => {
    const guard = () => {
      if (inTx && !tx) throw new Error("outer $app used inside a transaction");
    };
    const api = {
      findCollectionByNameOrId: (name: string) => (guard(), { name }),
      findRecordById: (name: string, id: string) => {
        guard();
        const r = rows(name).find((x) => x.id === id);
        if (!r) throw new Error(NO_ROWS);
        return r;
      },
      findRecordsByFilter: (name: string, filter: string, _s: string, limit: number, offset: number, p: Record<string, string> = {}) => {
        guard();
        const out = filterRows(name, filter, p);
        return limit > 0 ? out.slice(offset || 0, (offset || 0) + limit) : out;
      },
      findAuthRecordByEmail: (name: string, email: string) => {
        guard();
        const r = rows(name).find((x) => x.get("email") === email);
        if (!r) throw new Error(NO_ROWS);
        return r;
      },
      countRecords: (name: string, ...exps: Exp[]) => {
        guard();
        return rows(name).filter((r) => exps.every((e) => matches(r, e))).length;
      },
      recordQuery: (name: string) => {
        guard();
        const q = { name, where: [] as Exp[], order: [] as string[], limit: undefined as number | undefined, offset: undefined as number | undefined };
        queries.push(q);
        const b = {
          andWhere: (e: Exp) => (q.where.push(e), b),
          orderBy: (...o: string[]) => ((q.order = o), b),
          limit: (n: number) => ((q.limit = n), b),
          offset: (n: number) => ((q.offset = n), b),
          all: (out: FakeRecord[]) => {
            let rs = rows(name).filter((r) => q.where.every((e) => matches(r, e)));
            if (q.order.join() === "created DESC,id ASC") {
              rs.sort((a, c) => (a.get("created") === c.get("created") ? (a.id < c.id ? -1 : 1) : String(a.get("created")) < String(c.get("created")) ? 1 : -1));
            }
            rs = rs.slice(q.offset || 0, q.limit ? (q.offset || 0) + q.limit : undefined);
            out.push(...rs);
          },
        };
        return b;
      },
      save: (r: FakeRecord) => {
        guard();
        if (opts.failSave && opts.failSave(r)) throw new Error("injected save failure: " + r.collectionName);
        if (!rows(r.collectionName).includes(r)) rows(r.collectionName).push(r);
      },
      delete: (r: FakeRecord) => {
        guard();
        if (opts.failDelete && opts.failDelete(r)) throw new Error("injected delete failure");
        store[r.collectionName] = rows(r.collectionName).filter((x) => x !== r);
      },
      runInTransaction: (fn: (tx: unknown) => void) => {
        guard();
        const snap = Object.keys(store).map((k) => [k, store[k].map((r) => [r, { ...r.data }] as const)] as const);
        inTx = true;
        try {
          fn(txApp);
        } catch (err) {
          for (const k of Object.keys(store)) delete store[k];
          for (const [k, list] of snap) {
            store[k] = list.map(([r, d]) => ((r.data = d), r));
          }
          throw err;
        } finally {
          inTx = false;
        }
      },
    };
    return api;
  };
  const txApp = ops(true);
  return { ...ops(false), store, add, queries };
}

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.Record = FakeRecord;
  g.arrayOf = () => [];
  g.$dbx = {
    exp: (sql: string, params: Record<string, string> = {}) => ({ kind: "sql", sql, params }),
    hashExp: (obj: Record<string, unknown>) => ({ kind: "hash", obj }),
  };
  g.BadRequestError = class extends ApiErr {
    constructor(m: string) {
      super(400, m);
    }
  };
  g.ForbiddenError = class extends ApiErr {
    constructor(m: string) {
      super(403, m);
    }
  };
});
afterEach(() => {
  for (const k of ["Record", "arrayOf", "$dbx", "BadRequestError", "ForbiddenError"]) delete g[k];
});

const adm = () => lib("adminService.js");
const BALANCE = lib("balance.js").BALANCE;

function world() {
  const app = fakeApp();
  app.add("users", "admin1", { role: "admin", disabled: false, email: "a1@t.local" });
  app.add("users", "admin2", { role: "admin", disabled: false, email: "a2@t.local" });
  app.add("users", "user1", { role: "user", disabled: false, email: "u1@t.local" });
  app.add("proball_teams", "T1", { name: "Team One", manager: "user1", manager_mode: "full_ai" });
  app.add("proball_teams", "T2", { name: "Team Two", manager: "", manager_mode: "full_ai" });
  return app;
}
const audits = (app: ReturnType<typeof fakeApp>) => app.store.admin_audit_logs || [];

describe("createUser validates before any write", () => {
  const ok = { email: "new@t.local", password: "longpass1" };
  const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ["missing email", { password: "longpass1" }, /^Valid email required$/],
    ["non-string email", { ...ok, email: 5 }, /^Valid email required$/],
    ["blank email", { ...ok, email: "   " }, /^Valid email required$/],
    ["email without @", { ...ok, email: "new.t.local" }, /^Valid email required$/],
    ["email without domain dot", { ...ok, email: "new@local" }, /^Valid email required$/],
    ["email with space", { ...ok, email: "n ew@t.local" }, /^Valid email required$/],
    ["over-long email", { ...ok, email: "a".repeat(245) + "@t.local.x" }, /^Valid email required$/],
    ["missing password", { email: "new@t.local" }, /^Password must be at least 8 characters$/],
    ["short password", { ...ok, password: "seven77" }, /^Password must be at least 8 characters$/],
    ["numeric password", { ...ok, password: 12345678 }, /^Password must be at least 8 characters$/],
    ["unknown role", { ...ok, role: "superuser" }, /^Role must be user or admin$/],
    ["empty role", { ...ok, role: "" }, /^Role must be user or admin$/],
    ["long display name", { ...ok, display_name: "x".repeat(41) }, /^Display name must be 1 to 40 characters$/],
    ["41 emoji display name", { ...ok, display_name: "⚽".repeat(1) + "😀".repeat(40) }, /^Display name must be 1 to 40 characters$/],
    ["non-string display name", { ...ok, display_name: 7 }, /^Display name must be 1 to 40 characters$/],
    ["null credits", { ...ok, credits: null }, /^Credits must be a whole number of 0 or more$/],
    ["string credits", { ...ok, credits: "100" }, /^Credits must be a whole number of 0 or more$/],
    ["NaN credits", { ...ok, credits: NaN }, /^Credits must be a whole number of 0 or more$/],
    ["infinite credits", { ...ok, credits: Infinity }, /^Credits must be a whole number of 0 or more$/],
    ["decimal credits", { ...ok, credits: 1.5 }, /^Credits must be a whole number of 0 or more$/],
    ["negative credits", { ...ok, credits: -1 }, /^Credits must be a whole number of 0 or more$/],
    ["unsafe credits", { ...ok, credits: 2 ** 53 }, /^Credits must be a whole number of 0 or more$/],
  ];
  it.each(rejects)("rejects %s with no user or audit row", (_n, body, msg) => {
    const app = world();
    expect(() => adm().createUser(app, "admin1", body)).toThrow(msg);
    expect(app.store.users).toHaveLength(3);
    expect(audits(app)).toHaveLength(0);
  });

  it("applies the existing defaults when fields are omitted", () => {
    const app = world();
    const out = adm().createUser(app, "admin1", { email: "  Fresh.Name@t.local ", password: "longpass1", display_name: "" });
    const u = app.store.users.find((r) => r.id === out.id)!;
    expect(out).toEqual({ id: u.id, email: "Fresh.Name@t.local" });
    expect(u.data).toMatchObject({ email: "Fresh.Name@t.local", display_name: "Fresh.Name", role: "user", credits: BALANCE.startingCredits, disabled: false });
    expect(audits(app)).toHaveLength(1);
    expect(JSON.stringify(audits(app)[0].data)).not.toContain("longpass1");
  });

  it("accepts null role, zero credits, an admin role and a 40-emoji name", () => {
    const app = world();
    const a = adm().createUser(app, "admin1", { email: "z@t.local", password: "longpass1", role: null, credits: 0 });
    expect(app.store.users.find((r) => r.id === a.id)!.data).toMatchObject({ role: "user", credits: 0 });
    const b = adm().createUser(app, "admin1", { email: "y@t.local", password: "longpass1", role: "admin", display_name: "😀".repeat(40) });
    expect(app.store.users.find((r) => r.id === b.id)!.data).toMatchObject({ role: "admin", display_name: "😀".repeat(40) });
  });

  it("cuts the email fallback name to the 40-character field limit", () => {
    const app = world();
    const out = adm().createUser(app, "admin1", { email: "a".repeat(50) + "@t.local", password: "longpass1" });
    expect(app.store.users.find((r) => r.id === out.id)!.get("display_name")).toBe("a".repeat(40));
  });

  it("rejects a duplicate email with a stable message", () => {
    const app = world();
    expect(() => adm().createUser(app, "admin1", { email: " u1@t.local", password: "longpass1" })).toThrow(/^Email already in use$/);
    expect(app.store.users).toHaveLength(3);
  });

  it("does not report an unrelated lookup fault as a duplicate", () => {
    const app = world();
    const broken = { ...app, runInTransaction: (fn: (tx: unknown) => void) => app.runInTransaction((tx) => fn({ ...(tx as object), findAuthRecordByEmail: () => { throw new Error("disk I/O error"); } })) };
    expect(() => adm().createUser(broken, "admin1", { email: "n@t.local", password: "longpass1" })).toThrow(/disk I\/O error/);
    expect(app.store.users).toHaveLength(3);
  });

  it("rolls the user back when its save fails", () => {
    const app = fakeApp({ failSave: (r) => r.collectionName === "users" });
    app.add("users", "admin1", { role: "admin", email: "a1@t.local" });
    expect(() => adm().createUser(app, "admin1", { email: "n@t.local", password: "longpass1" })).toThrow(/injected/);
    expect(app.store.users).toHaveLength(1);
    expect(audits(app)).toHaveLength(0);
  });
});

describe("disable and enable", () => {
  it("disables another user, rotating the token key, and audits after commit", () => {
    const app = world();
    expect(adm().setUserDisabled(app, "admin1", "user1", true, "r")).toEqual({ ok: true, disabled: true });
    const u = app.store.users.find((r) => r.id === "user1")!;
    expect(u.get("disabled")).toBe(true);
    expect(u.get("tokenKey")).toBeTruthy();
    expect(audits(app)[0].data).toMatchObject({ action: "user_disable", target_id: "user1" });
  });

  it("refuses self-disable", () => {
    const app = world();
    expect(() => adm().setUserDisabled(app, "admin1", "admin1", true, "r")).toThrow(/^You cannot disable your own account$/);
    expect(app.store.users[0].data).toMatchObject({ disabled: false });
    expect(app.store.users[0].get("tokenKey")).toBeUndefined();
    expect(audits(app)).toHaveLength(0);
  });

  it("serialised mutual disable: the second admin is no longer allowed to act", () => {
    const app = world();
    adm().setUserDisabled(app, "admin1", "admin2", true, "race");
    const err = (() => {
      try {
        adm().setUserDisabled(app, "admin2", "admin1", true, "race");
      } catch (e) {
        return e as ApiErr;
      }
    })();
    expect(err).toMatchObject({ status: 403, message: "Account disabled" });
    expect(app.store.users.find((r) => r.id === "admin1")!.get("disabled")).toBe(false);
  });

  it("a demoted or deleted actor cannot act", () => {
    const app = world();
    app.store.users.find((r) => r.id === "admin2")!.set("role", "user");
    expect(() => adm().setUserDisabled(app, "admin2", "user1", true, "r")).toThrow(/^Admin only$/);
    expect(() => adm().setUserDisabled(app, "ghost", "user1", true, "r")).toThrow(/^Admin only$/);
    expect(app.store.users.find((r) => r.id === "user1")!.get("disabled")).toBe(false);
  });

  it("refuses to disable the last active admin (count read inside the transaction)", () => {
    const app = world();
    const lone = { ...app, runInTransaction: (fn: (tx: unknown) => void) => app.runInTransaction((tx) => fn({ ...(tx as object), countRecords: () => 1 })) };
    expect(() => adm().setUserDisabled(lone, "admin1", "admin2", true, "r")).toThrow(/^Cannot disable the last active admin$/);
    expect(app.store.users.find((r) => r.id === "admin2")!.get("disabled")).toBe(false);
  });

  it("an unknown user still surfaces the no-rows lookup (route keeps its 404)", () => {
    const app = world();
    expect(() => adm().setUserDisabled(app, "admin1", "nobody", true, "r")).toThrow(NO_ROWS);
  });

  it("enables a disabled user and rolls back a failed save", () => {
    const app = world();
    app.store.users.find((r) => r.id === "user1")!.set("disabled", true);
    expect(adm().setUserDisabled(app, "admin1", "user1", false, "r")).toEqual({ ok: true, disabled: false });
    const failing = fakeApp({ failSave: (r) => r.id === "user1" });
    failing.add("users", "admin1", { role: "admin", disabled: false });
    failing.add("users", "user1", { role: "user", disabled: false });
    expect(() => adm().setUserDisabled(failing, "admin1", "user1", true, "r")).toThrow(/injected/);
    expect(failing.store.users[1].data).toEqual({ role: "user", disabled: false });
    expect(audits(failing)).toHaveLength(0);
  });
});

describe("delete", () => {
  it("releases the team and deletes in one transaction, then audits", () => {
    const app = world();
    expect(adm().deleteUser(app, "admin1", "user1", "r")).toEqual({ ok: true });
    expect(app.store.users.map((r) => r.id)).toEqual(["admin1", "admin2"]);
    expect(app.store.proball_teams[0].get("manager")).toBe("");
    expect(audits(app)[0].data).toMatchObject({ action: "user_delete", target_id: "user1", meta: { before: { email: "u1@t.local" } } });
  });

  it("refuses self-delete and a stale actor", () => {
    const app = world();
    expect(() => adm().deleteUser(app, "admin1", "admin1", "r")).toThrow(/^You cannot delete your own account$/);
    app.store.users.find((r) => r.id === "admin2")!.set("disabled", true);
    expect(() => adm().deleteUser(app, "admin2", "user1", "r")).toThrow(/^Account disabled$/);
    expect(app.store.users).toHaveLength(3);
  });

  it("refuses to delete the last active admin", () => {
    const app = world();
    const lone = { ...app, runInTransaction: (fn: (tx: unknown) => void) => app.runInTransaction((tx) => fn({ ...(tx as object), countRecords: () => 1 })) };
    expect(() => adm().deleteUser(lone, "admin1", "admin2", "r")).toThrow(/^Cannot delete the last active admin$/);
    expect(app.store.users).toHaveLength(3);
  });

  it.each([
    ["admin_audit_logs", { admin: "user1", action: "team_claim" }],
    ["coaching_commands", { user: "user1" }],
  ])("a user referenced by %s keeps the team and account", (col, data) => {
    const app = world();
    app.add(col, "ref1", data);
    expect(() => adm().deleteUser(app, "admin1", "user1", "r")).toThrow(/^User has audit or coaching history; disable the account instead$/);
    expect(app.store.users).toHaveLength(3);
    expect(app.store.proball_teams[0].get("manager")).toBe("user1");
    expect(audits(app).filter((a) => a.get("action") === "user_delete")).toHaveLength(0);
  });

  it("a late delete failure rolls the team release back", () => {
    const app = fakeApp({ failDelete: () => true });
    app.add("users", "admin1", { role: "admin", disabled: false });
    app.add("users", "user1", { role: "user", disabled: false, email: "u1@t.local" });
    app.add("proball_teams", "T1", { manager: "user1" });
    expect(() => adm().deleteUser(app, "admin1", "user1", "r")).toThrow(/injected delete failure/);
    expect(app.store.users).toHaveLength(2);
    expect(app.store.proball_teams[0].get("manager")).toBe("user1");
    expect(audits(app)).toHaveLength(0);
  });
});

describe("assign and release", () => {
  it.each([[undefined], [null], [""], ["   "], [42]])("assign with userId %p is rejected, never a release", (userId) => {
    const app = world();
    expect(() => adm().assignTeam(app, "admin1", "T1", userId, "r")).toThrow(/^User ID required$/);
    expect(app.store.proball_teams[0].get("manager")).toBe("user1");
    expect(audits(app)).toHaveLength(0);
  });

  it("requires an existing, enabled user", () => {
    const app = world();
    expect(() => adm().assignTeam(app, "admin1", "T2", "nobody", "r")).toThrow(/^User not found$/);
    app.add("users", "off", { role: "user", disabled: true });
    expect(() => adm().assignTeam(app, "admin1", "T2", "off", "r")).toThrow(/^Cannot assign a disabled user$/);
    expect(app.store.proball_teams[1].get("manager")).toBe("");
  });

  it("keeps the existing conflict messages", () => {
    const app = world();
    app.add("users", "user2", { role: "user", disabled: false });
    expect(() => adm().assignTeam(app, "admin1", "T2", "user1", "r")).toThrow(/^User already manages a team$/);
    expect(() => adm().assignTeam(app, "admin1", "T1", "user2", "r")).toThrow(/^Team already has a manager — release first$/);
  });

  it("a new manager starts in manual mode; re-assigning the same user keeps the mode", () => {
    const app = world();
    app.add("users", "user2", { role: "user", disabled: false });
    expect(adm().assignTeam(app, "admin1", "T2", "user2", "r")).toEqual({ ok: true });
    expect(app.store.proball_teams[1].data).toMatchObject({ manager: "user2", manager_mode: "manual" });
    expect(adm().assignTeam(app, "admin1", "T1", "user1", "r")).toEqual({ ok: true });
    expect(app.store.proball_teams[0].data).toMatchObject({ manager: "user1", manager_mode: "full_ai" });
    expect(audits(app).map((a) => a.data.action)).toEqual(["team_assign", "team_assign"]);
  });

  it("releaseTeam clears the manager and audits a release", () => {
    const app = world();
    expect(adm().releaseTeam(app, "admin1", "T1", "release")).toEqual({ ok: true });
    expect(app.store.proball_teams[0].get("manager")).toBe("");
    expect(audits(app)[0].data).toMatchObject({ action: "team_release", target_id: "T1", meta: { after: { manager: null }, reason: "release" } });
  });
});

describe("listUsers", () => {
  function many(n: number) {
    const app = fakeApp();
    for (let i = 0; i < n; i++) {
      app.add("users", "u" + String(i).padStart(4, "0"), { email: `p${i}@t.local`, created: "2026-01-01 00:00:00.000Z" });
    }
    app.add("proball_teams", "T1", { name: "One", manager: "u0001" });
    app.add("proball_teams", "T2", { name: "Two", manager: "u0009" });
    return app;
  }

  it.each([
    ["0", undefined, /^Page must be a whole number from 1$/],
    ["-1", undefined, /^Page must be a whole number from 1$/],
    ["1.5", undefined, /^Page must be a whole number from 1$/],
    ["abc", undefined, /^Page must be a whole number from 1$/],
    ["1000000", undefined, /^Page must be a whole number from 1$/],
    [undefined, "0", /^Page size must be a whole number from 1 to 200$/],
    [undefined, "201", /^Page size must be a whole number from 1 to 200$/],
    [undefined, "2e1", /^Page size must be a whole number from 1 to 200$/],
  ])("rejects page %p perPage %p", (page, perPage, msg) => {
    expect(() => adm().listUsers(many(1), "", page, perPage)).toThrow(msg);
  });

  it("rejects a search longer than any searchable field", () => {
    expect(() => adm().listUsers(many(1), "x".repeat(255))).toThrow(/^Search query is too long$/);
    expect(adm().listUsers(many(1), " " + "x".repeat(254) + " ").users).toHaveLength(1);
  });

  it("pages in a stable order, with one team lookup per page and an unchanged item shape", () => {
    const app = many(5);
    const first = adm().listUsers(app, "", "1", "2");
    expect(first).toMatchObject({ page: 1, perPage: 2, totalItems: 5, hasMore: true });
    expect(first.users.map((u: { id: string }) => u.id)).toEqual(["u0000", "u0001"]);
    expect(Object.keys(first.users[1]).sort()).toEqual(["admin_note", "created", "credits", "disabled", "display_name", "email", "id", "role", "team"]);
    expect(first.users[1].team).toEqual({ id: "T1", name: "One" });
    expect(first.users[0].team).toBeNull();
    const userQ = app.queries[0];
    expect(userQ).toMatchObject({ name: "users", where: [], order: ["created DESC", "id ASC"], limit: 3, offset: 0 });
    expect(app.queries.filter((q) => q.name === "proball_teams")).toHaveLength(1);
    const last = adm().listUsers(app, "", 3, 2);
    expect(last).toMatchObject({ page: 3, hasMore: false });
    expect(last.users.map((u: { id: string }) => u.id)).toEqual(["u0004"]);
    expect(adm().listUsers(app, "", 4, 2)).toMatchObject({ users: [], hasMore: false, totalItems: 5 });
  });

  it("defaults to the first 200 users", () => {
    const app = many(201);
    const out = adm().listUsers(app, "", "", "");
    expect(out).toMatchObject({ page: 1, perPage: 200, totalItems: 201, hasMore: true });
    expect(out.users).toHaveLength(200);
  });

  it("binds the search as an escaped literal and counts with the same predicate", () => {
    const app = many(3);
    const counted: Exp[][] = [];
    const spy = { ...app, countRecords: (name: string, ...e: Exp[]) => (counted.push(e), app.countRecords(name, ...e)) };
    adm().listUsers(spy, "  100%_a\\b'  ");
    const where = app.queries[0].where;
    expect(where).toHaveLength(1);
    const e = where[0] as Extract<Exp, { kind: "sql" }>;
    expect(e.params).toEqual({ p: "%100\\%\\_a\\\\b'%" });
    expect(e.sql.match(/LIKE \{:p\} ESCAPE '\\'/g)).toHaveLength(3);
    expect(e.sql).not.toContain("100");
    expect(counted).toEqual([[e]]);
  });
});

describe("overview counts", () => {
  it("counts beyond the old caps and reports the actual unmanaged teams", () => {
    const app = fakeApp();
    for (let i = 0; i < 650; i++) app.add("users", "u" + i, {});
    for (let i = 0; i < 520; i++) app.add("match_states", "m" + i, {});
    for (let i = 0; i < 60; i++) app.add("shared_fixtures", "f" + i, { status: i < 55 ? "live" : "final" });
    for (let i = 0; i < 18; i++) app.add("proball_teams", "t" + i, { manager: i < 3 ? "u" + i : "" });
    const o = adm().overview(app);
    expect(o).toMatchObject({ users: 650, managedTeams: 3, availableTeams: 15, spectators: 647, liveFixtures: 55, matchStates: 520 });
  });
});

describe("claim audit uses the shared serializer", () => {
  it("records action, target and before/after/reason/success after commit", () => {
    const ws = lib("worldService.js");
    const app = world();
    ws.claimTeam(app, "admin2", "T2");
    const a = audits(app);
    expect(a).toHaveLength(1);
    expect(a[0].data).toEqual({
      admin: "admin2",
      action: "team_claim",
      target_type: "proball_teams",
      target_id: "T2",
      meta: { before: { manager: null }, after: { manager: "admin2" }, reason: "claim", success: true },
    });
    expect(app.store.proball_teams[1].data).toMatchObject({ manager: "admin2", manager_mode: "manual" });
  });
});
