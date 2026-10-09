import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent, MatchView } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const world = require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/worldService.js")) as {
  matchView: (app: unknown, id: string, since: number, userId: string, throughMs?: number) => MatchView;
  publishedEvents: (app: unknown, id: string, now: number, since: number, limit: number) => MatchEvent[];
};

const NOW = 100000;
const state = { ph: "first_half", sc: [0, 0], pos: 50, x: [[0], [0]] } as MatchEvent["st"];
const event = (seq: number, at = 1000 + Math.floor(seq / 2)): MatchEvent => ({
  seq, at, t: ["kickoff", "goal", "shot", "save", "coaching"][seq % 5], min: seq, text: `Event ${seq}`, st: state,
});
const row = (id: string, data: Record<string, unknown>) => ({ id, get: (key: string) => data[key] });

/** Honour the actual filters, ordering, offset and limit, including lookahead. No writes allowed. */
function appFor(events: MatchEvent[], status = "live") {
  const teams = Array.from({ length: 16 }, (_, i) => row(`team${i}`, { slug: `test${i}`, abbreviation: `T${i}` }));
  const fx = row("fx1", { round: "r1", status, home_team: "team0", away_team: "team1", scheduled_at: new Date(0).toISOString() });
  const round = row("r1", { round_key: "r16", status: "live" });
  const rows = events.map((e) => row(`e${e.seq}`, { fixture: "fx1", seq: e.seq, at: e.at, type: e.t, data: JSON.stringify(e) }));
  rows.push(row("other", { fixture: "fx2", seq: 1, at: 0, type: "goal", data: JSON.stringify(event(1, 0)) }));
  return {
    findCollectionByNameOrId: (name: string) => ({ name }),
    findRecordById: (name: string, id: string) => {
      if (name === "shared_fixtures" && id === fx.id) return fx;
      if (name === "shared_rounds" && id === round.id) return round;
      throw new Error(`Unexpected lookup ${name}/${id}`);
    },
    findRecordsByFilter: vi.fn((name: string, filter: string, sort: string, limit: number, offset: number, params: Record<string, number | string> = {}) => {
      if (name === "world") return [row("world", {})];
      if (name === "proball_teams") return filter.includes("manager") ? [] : teams;
      if (name === "global_team_records") return teams;
      if (name === "match_states") return [];
      if (name !== "match_events") throw new Error(`Unexpected query ${name}`);
      let found = rows.filter((r) => r.get("fixture") === params.f && Number(r.get("at")) <= Number(params.n));
      if (filter.includes("seq >")) found = found.filter((r) => Number(r.get("seq")) > Number(params.s));
      if (filter.includes('type = "red_card"')) found = found.filter((r) => r.get("type") === "red_card");
      found.sort((a, b) => (Number(a.get("seq")) - Number(b.get("seq"))) * (sort === "-seq" ? -1 : 1));
      return found.slice(offset, offset + limit);
    }),
    save: () => { throw new Error("Match GET must not write"); },
  };
}

afterEach(() => vi.useRealTimers());

describe("retained match history cursor", () => {
  it.each([0, 1, 60, 300, 301, 600, 901])("backfills %i public rows in ascending pages, exactly once", (count) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const retained = Array.from({ length: count }, (_, i) => event(i + 1));
    const app = appFor([...retained, event(count + 1, NOW + 1)]);
    let cursor = 0;
    let through: number | undefined;
    const fetched: MatchEvent[] = [];
    let pages = 0;
    for (;;) {
      const v = world.matchView(app, "fx1", cursor, "user", through);
      expect(v.events.length).toBeLessThanOrEqual(300);
      expect(v.eventsPage).toMatchObject({ throughMs: NOW, nextSeq: v.events.at(-1)?.seq ?? cursor });
      expect(v.eventsPage.hasMore).toBe(cursor + v.events.length < count);
      fetched.push(...v.events);
      cursor = v.eventsPage.nextSeq;
      through = v.eventsPage.throughMs;
      if (!v.eventsPage.hasMore) break;
      expect(++pages).toBeLessThan(10);
      vi.setSystemTime(NOW + 1000); // future event becomes public while pages drain
    }
    expect(fetched).toEqual(retained);
    const end = world.matchView(app, "fx1", cursor, "user", through);
    expect(end.events).toEqual([]);
    expect(end.eventsPage).toEqual({ nextSeq: count, hasMore: false, throughMs: NOW });
  });

  it("drains a missed backlog larger than a page, then picks up newly public events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const app = appFor(Array.from({ length: 705 }, (_, i) => event(i + 1, i === 704 ? NOW + 1 : 1000)));
    const first = world.matchView(app, "fx1", 50, "user");
    expect(first.events.map((e) => e.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 51));
    const next = world.matchView(app, "fx1", first.eventsPage.nextSeq, "user", first.eventsPage.throughMs);
    const last = world.matchView(app, "fx1", next.eventsPage.nextSeq, "user", next.eventsPage.throughMs);
    expect([...first.events, ...next.events, ...last.events].map((e) => e.seq)).toEqual(Array.from({ length: 654 }, (_, i) => i + 51));
    expect(last.eventsPage.hasMore).toBe(false);
    vi.setSystemTime(NOW + 1);
    expect(world.matchView(app, "fx1", 704, "user").events.map((e) => e.seq)).toEqual([705]);
  });

  it("clamps a future publication cutoff to server time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const v = world.matchView(appFor([event(1), event(2, NOW + 1)]), "fx1", 0, "user", NOW + 1000);
    expect(v.events.map((e) => e.seq)).toEqual([1]);
    expect(v.eventsPage.throughMs).toBe(NOW);
  });

  it("keeps the card and seeded dismissals at the history cutoff while later pages load", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW + 1000);
    const red = { ...event(2, NOW + 1), t: "red_card", side: "home", p: "Player" };
    const v = world.matchView(appFor([event(1), red] as MatchEvent[]), "fx1", 0, "user", NOW);
    expect(v.fixture.seq).toBe(1);
    expect(v.sentOff).toEqual([]);
    expect(v.events.map((e) => e.seq)).toEqual([1]);
  });

  it("terminates an empty finished/purged history without synthesising events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const v = world.matchView(appFor([], "finished"), "fx1", 0, "user");
    expect(v.events).toEqual([]);
    expect(v.eventsPage).toEqual({ nextSeq: 0, hasMore: false, throughMs: NOW });
  });

  it("preserves the settlement helper's latest tail and final stats beyond 2000 rows", () => {
    const events = Array.from({ length: 2205 }, (_, i) => ({ ...event(i + 1), st: { ...state, pos: i + 1, x: [[i + 1], [0]] } }));
    const tail = world.publishedEvents(appFor(events), "fx1", NOW, 0, 2000);
    expect(tail).toEqual(events.slice(-2000));
    expect(tail.at(-1)?.st).toMatchObject({ pos: 2205, x: [[2205], [0]] });
  });
});
