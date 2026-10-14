import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue #20: a coaching command is only queued while the match state is caught up with the
// clock (its next minute starts after the command), otherwise it is rejected unchanged
// after exactly one catch-up retry. No other rejection is retried.
// The real-PocketBase counterpart is tests/integration/coaching-atomicity.mjs.
const require = createRequire(import.meta.url);
const world = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/worldService.js")) as {
  setCoaching: (app: unknown, userId: string, fixtureId: string, stance: string) => { fromMinute: number; used: number };
};

type Fields = Record<string, unknown>;
type Store = Record<string, Record<string, Fields>>;
const record = (collection: string, id: string, fields: Fields) => {
  const f = { ...fields };
  return {
    id,
    collection,
    fields: f,
    get: (k: string) => f[k],
    getString: (k: string) => (typeof f[k] === "string" ? f[k] : JSON.stringify(f[k])),
    set: (k: string, v: unknown) => void (f[k] = v),
  };
};
type Rec = ReturnType<typeof record>;

class FakeRecord {
  static n = 0;
  id = `cmd${++FakeRecord.n}`;
  collection: string;
  fields: Fields = {};
  constructor(col: { name: string }) {
    this.collection = col.name;
  }
  get(k: string) {
    return this.fields[k];
  }
  set(k: string, v: unknown) {
    this.fields[k] = v;
  }
}

/**
 * In-memory PocketBase stand-in: reads return copies, a throwing transaction rolls back,
 * and the world is paused so tick() resolves nothing (the match stays as stored).
 */
function fakeApp(state: Fields, opts: { user?: Fields; published?: string; simVersion?: number; afterRollback?: (s: Store) => void } = {}) {
  const now = Date.now();
  let store: Store = {
    world: { w: { key: "main", progression_paused: true, match_minute_real_seconds: 8 } },
    proball_teams: { t1: { manager: "u1", manager_mode: "manual", ...opts.user }, t2: { manager: "" } },
    shared_fixtures: { fx: { home_team: "t1", away_team: "t2" } },
    match_states: { ms: { fixture: "fx", sim_version: opts.simVersion ?? 2, state_json: JSON.stringify(state) } },
    match_events: { e1: { fixture: "fx", seq: 7, at: now - 100, data: JSON.stringify({ seq: 7, st: { ph: opts.published ?? "first_half" } }) } },
    coaching_commands: {},
  };
  const rows = (c: string) => Object.entries(store[c] || {}).map(([id, f]) => record(c, id, f));
  const app = {
    attempts: 0,
    snapshot: () => structuredClone(store),
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (c: string, id: string) => record(c, id, store[c][id]),
    findRecordsByFilter: (c: string, filter: string, _sort: string, limit: number, offset: number, p: Record<string, unknown> = {}) => {
      if (c === "proball_teams" && filter === "id != ''") return Array.from({ length: 16 }, (_, i) => record(c, `x${i}`, { slug: "none" }));
      if (c === "global_team_records") return Array.from({ length: 16 }, (_, i) => record(c, `g${i}`, {}));
      if (c === "proball_teams") return rows(c).filter((r) => r.get("manager") === p.u);
      if (c === "match_states") return rows(c).filter((r) => r.get("fixture") === p.f);
      if (c === "match_events") {
        const evs = rows(c).filter((r) => r.get("fixture") === p.f && (r.get("at") as number) <= (p.n as number));
        return evs.sort((a, b) => (b.get("seq") as number) - (a.get("seq") as number)).slice(offset, offset + limit);
      }
      return rows(c);
    },
    save: (r: Rec | FakeRecord) => void ((store[r.collection] ||= {})[r.id] = { ...r.fields }),
    runInTransaction: (fn: (tx: unknown) => void) => {
      app.attempts++;
      const before = structuredClone(store);
      try {
        fn(app);
      } catch (err) {
        store = before;
        opts.afterRollback?.(store);
        throw err;
      }
    },
    state: () => {
      const raw = store.match_states.ms.state_json;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
    commands: () => Object.values(store.coaching_commands),
  };
  return app;
}

const live = (nextAt: unknown, extra: Fields = {}) => ({
  phase: "first_half",
  minute: 10,
  nextAt,
  teams: { home: { stance: "balanced" }, away: { stance: "balanced" } },
  pending: {},
  coach: {},
  ...extra,
});

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  g.Record = FakeRecord;
  g.BadRequestError = class BadRequestError extends Error {};
  g.ForbiddenError = class ForbiddenError extends Error {};
});
afterEach(() => {
  delete g.Record;
  delete g.BadRequestError;
  delete g.ForbiddenError;
});

describe("live coaching never applies to elapsed play", () => {
  for (const nextAt of [-1000, 0, null]) {
    it(`rejects an overdue match unchanged after one catch-up retry (nextAt ${nextAt === null ? "null" : `now${nextAt}`})`, () => {
      const app = fakeApp(live(nextAt === null ? null : Date.now() + nextAt));
      const before = app.snapshot();
      expect(() => world.setCoaching(app, "u1", "fx", "attack")).toThrow("Match is catching up — try again in a moment");
      expect(app.attempts).toBe(2);
      expect(app.snapshot()).toEqual(before);
    });
  }

  it("queues the command once the match has caught up for the retry", () => {
    const app = fakeApp(live(Date.now() - 1000), {
      // Another worker's advance commits between the two attempts.
      afterRollback: (s) => {
        const st = JSON.parse(s.match_states.ms.state_json as string);
        s.match_states.ms.state_json = JSON.stringify({ ...st, minute: 12, nextAt: Date.now() + 5000 });
      },
    });
    const result = world.setCoaching(app, "u1", "fx", "attack");
    expect(app.attempts).toBe(2);
    expect(result).toMatchObject({ ok: true, stance: "attack", fromMinute: 13, used: 1 });
    expect(app.state().pending).toEqual({ home: "attack" });
    expect(app.commands()).toMatchObject([{ fixture: "fx", team: "t1", stance: "attack", effective_from_minute: 13 }]);
  });

  it("queues a caught-up command for the next minute in one attempt", () => {
    const app = fakeApp(live(Date.now() + 5000));
    expect(world.setCoaching(app, "u1", "fx", "defend")).toMatchObject({ fromMinute: 11, used: 1 });
    expect(app.attempts).toBe(1);
    expect(app.state()).toMatchObject({ minute: 10, pending: { home: "defend" }, teams: { home: { stance: "balanced" } } });
  });

  const soon = () => Date.now() + 5000;
  const cases: [string, () => ReturnType<typeof fakeApp>, string, RegExp][] = [
    ["not the manager", () => fakeApp(live(soon())), "u9", /do not manage a team in this match/],
    ["Full AI", () => fakeApp(live(soon()), { user: { manager_mode: "ai" } }), "u1", /Full AI/],
    ["not kicked off", () => fakeApp(live(soon()), { simVersion: 1 }), "u1", /not kicked off/],
    ["not being played", () => fakeApp(live(Date.now() - 1000), { published: "pre" }), "u1", /available while the match is being played/],
    ["finished", () => fakeApp(live(null, { phase: "finished" })), "u1", /closed/],
    ["shootout", () => fakeApp(live(Date.now() - 1000, { phase: "shootout" })), "u1", /closed/],
    ["no commands left", () => fakeApp(live(soon(), { coach: { home: { n: 4, last: 0 } } })), "u1", /No coaching commands left/],
    ["recharging", () => fakeApp(live(soon(), { coach: { home: { n: 1, last: Date.now() - 1000 } } })), "u1", /recharging/],
    ["already set", () => fakeApp(live(soon())), "u1", /Already set to balanced/],
  ];
  for (const [name, make, user, message] of cases) {
    it(`does not retry when ${name}`, () => {
      const app = make();
      const before = app.snapshot();
      expect(() => world.setCoaching(app, user, "fx", name === "already set" ? "balanced" : "attack")).toThrow(message);
      expect(app.attempts).toBe(1);
      expect(app.snapshot()).toEqual(before);
    });
  }
});
