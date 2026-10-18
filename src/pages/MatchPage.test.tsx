import { render, screen, act, cleanup, fireEvent, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minuteLabel } from "../lib/live";
import type { MatchEvent, MatchView } from "../lib/pocketbase";

/** Mirrors MatchPage MATCH_POLL_MS (the page is imported dynamically after mocks). */
const MATCH_POLL_MS = 2500;

const team = (n: string) => ({ id: n, slug: n, name: n, abbreviation: n.slice(0, 3).toUpperCase(), primary_color: "#fff" }) as unknown as MatchView["fixture"]["home"];
const names = (p: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${p} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const st = { ph: "first_half", sc: [0, 0], pos: 50, x: [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] } as unknown as MatchView["fixture"]["st"];
const ev = (seq: number, at: number, text: string): MatchEvent => ({ seq, at, t: "pass", min: 1, side: "home", p: "Home P3", p2: "Home P4", from: [40, 30], ball: [55, 35], text, st: st! });

function view(events: MatchEvent[], lineups: MatchView["lineups"], serverTimeMs: number): MatchView {
  return {
    serverTimeMs,
    round: { id: "r", key: "r1", label: "Round 1", status: "live" },
    fixture: { id: "fx1", slot: "a", index: 0, home: team("Home"), away: team("Away"), status: "live", kickoffAt: 0, st, seq: 1 } as unknown as MatchView["fixture"],
    events,
    eventsPage: { nextSeq: events.at(-1)?.seq ?? 0, hasMore: false, throughMs: serverTimeMs },
    lineups,
    sentOff: [],
    managedSide: null,
    coach: null,
  };
}

const h = vi.hoisted(() => ({ live: null as unknown }));
vi.mock("../lib/live", async (orig) => ({ ...(await orig<typeof import("../lib/live")>()), useLive: () => ({ live: h.live }), useNow: () => Date.now() }));
// jsdom's opaque origin has no localStorage.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../components/MarketsPanel", () => ({ default: () => null }));
vi.mock("../lib/pocketbase", async (orig) => {
  const m = await orig<typeof import("../lib/pocketbase")>();
  return { ...m, footfiveApi: { ...m.footfiveApi, match: vi.fn() } };
});

async function mount(v?: MatchView) {
  const { footfiveApi } = await import("../lib/pocketbase");
  if (v) vi.mocked(footfiveApi.match).mockResolvedValue(v);
  const { default: MatchPage } = await import("./MatchPage");
  let out!: ReturnType<typeof render>;
  await act(async () => {
    out = render(
      <MemoryRouter initialEntries={["/match/fx1"]}>
        <Routes>
          <Route path="/match/:fixtureId" element={<MatchPage />} />
          <Route path="/live" element={<p>ROUND SCREEN</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return out;
}

describe("MatchPage timeline player", () => {
  afterEach(() => vi.useRealTimers()); // a failed fake-Date test must not leak into the next
  it("pins a HUD on the pitch with the shown score and clock; in a shootout also the normal score, the pens score and who kicks next — shootout goals never touch the score", async () => {
    const now = Date.now();
    const so = { h: 2, a: 1, th: 3, ta: 2, first: "home", next: "away", sd: false, k: [] } as unknown as NonNullable<MatchView["fixture"]["st"]>["so"];
    const pens = { ...st!, ph: "shootout", sc: [1, 1] as [number, number], so } as NonNullable<MatchView["fixture"]["st"]>;
    const kick: MatchEvent = { ...ev(1, now - 30000, "Steps up"), t: "shootout_setup", side: "away" as const, kick: { no: 3, sd: 0 }, st: pens };
    await mount(view([kick], { home: names("Home"), away: names("Away") }, now));
    const hud = screen.getByTestId("pitch-hud");
    expect(screen.getByTestId("pitch").contains(hud)).toBe(true);
    expect(screen.getByTestId("hud-score").textContent).toBe("HOM 1–1 AWA");
    expect(screen.getByTestId("hud-pens").textContent).toBe("PENS 2–1");
    expect(screen.getByTestId("hud-kicker").textContent).toBe("AWA to kick");
    expect(screen.getByTestId("match-score").textContent).toBe("1–1");
    expect(hud.textContent).toContain("PENS");
  });
  it("renders 10 players and the commentary of the event under the playhead", async () => {
    const now = Date.now();
    const events = [ev(1, now - 30000, "Older pass"), ev(2, now - 3000, "Current pass"), ev(3, now + 60000, "Future pass")];
    await mount(view(events, { home: names("Home"), away: names("Away") }, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
    expect(screen.getByTestId("commentary").textContent).toBe("Current pass");
  });

  it("retires one event's caption during dwell, then shows the next event even with the same words", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const realNow = performance.now.bind(performance);
    let extra = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + extra);
    try {
      const now = Date.now();
      const words = "Same words";
      const events = [ev(1, now - 4000, words), ev(2, now + 30000, words)];
      const { footfiveApi } = await import("../lib/pocketbase");
      vi.mocked(footfiveApi.match).mockResolvedValue(view(events, null, now));
      await mount(view(events, null, now));
      const line = () => screen.getByTestId("commentary").textContent;
      expect(line()).toBe(words);
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
      extra += 3000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(line()).toBe(words); // still inside the short lifetime
      extra += 3000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(line()).toBe("…"); // baseline: the old page kept this line for the whole dwell
      await act(() => new Promise((r) => setTimeout(r, MATCH_POLL_MS + 80)));
      expect(line()).toBe("…"); // same seq polled again does not restart it
      vi.setSystemTime(now + 30000 + 2000);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(line()).toBe(words); // new seq, same words, shown promptly
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
      extra += 6000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(line()).toBe("…");
      vi.setSystemTime(now);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(line()).toBe("…"); // rewind onto the first seq does not announce it again
    } finally {
      spy.mockRestore();
    }
  }, 15000);

  it("keeps an expired shot neutral until the goal is revealed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const realNow = performance.now.bind(performance);
    let extra = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + extra);
    try {
      const now = Date.now();
      const scored = { ...st!, sc: [1, 0] as [number, number] };
      const shot = { ...ev(1, now - 30000, "Shoots!"), t: "shot", ball: [85, 32] as [number, number] };
      const goal = { ...ev(2, now + 20000, "GOAL!"), t: "goal", target: [100, 32] as [number, number], st: scored };
      await mount(view([shot, goal], null, now));
      expect(screen.getByTestId("commentary").textContent).toBe("Shoots!");
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
      extra += 6000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByTestId("commentary").textContent).toBe("…");
      vi.setSystemTime(now + 20000 + 1500 + 0.15 * 3800);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByTestId("commentary").textContent).toBe("…");
      expect(screen.getByTestId("commentary").textContent).not.toContain("GOAL");
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
      vi.setSystemTime(now + 20000 + 1500 + 0.35 * 3800);
      await act(() => new Promise((r) => setTimeout(r, 400)));
      expect(screen.getByTestId("commentary").textContent).toBe("GOAL!");
      expect(screen.getByTestId("match-score").textContent).toBe("1–0");
    } finally {
      spy.mockRestore();
    }
  });

  it("replays a line without restarting the live caption, and a new fixture may show that seq again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const realNow = performance.now.bind(performance);
    let extra = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + extra);
    try {
      const now = Date.now();
      const goal = { ...ev(1, now - 60000, "GOAL ONE"), t: "goal", target: [100, 32] as [number, number] };
      const { footfiveApi } = await import("../lib/pocketbase");
      const { default: MatchPage } = await import("./MatchPage");
      vi.mocked(footfiveApi.match).mockImplementation(async (id: string) => {
        const v = view(id === "fx1" ? [goal, ev(2, now - 3000, "Live line")] : [ev(1, now - 3000, "Live line")], null, now);
        v.fixture = { ...v.fixture, id };
        return v;
      });
      await act(async () => {
        render(
          <MemoryRouter initialEntries={["/match/fx1"]}>
            <Link to="/match/fx2">Switch fixture</Link>
            <Routes>
              <Route path="/match/:fixtureId" element={<MatchPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      expect(screen.getByTestId("commentary").textContent).toBe("Live line");
      extra += 6000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByTestId("commentary").textContent).toBe("…");
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Replay: GOAL ONE"));
      });
      expect(screen.getByTestId("commentary").textContent).toBe("GOAL ONE");
      extra += 20000;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByTestId("commentary").textContent).toBe("…");
      await act(async () => {
        fireEvent.click(screen.getByText("Switch fixture"));
      });
      expect(screen.getByTestId("commentary").textContent).toBe("Live line");
    } finally {
      spy.mockRestore();
    }
  });

  it("scoreboard shows the score of the event under the playhead, not the newest", async () => {
    const now = Date.now();
    const scored = { ...st!, sc: [1, 0] as [number, number] };
    const events = [ev(1, now - 30000, "Pass"), { ...ev(2, now - 500, "GOAL!"), t: "goal", st: scored }];
    const v = view(events, null, now);
    v.fixture = { ...v.fixture, st: scored };
    await mount(v);
    expect(screen.getByTestId("match-score").textContent).toBe("0–0");
    expect(screen.getByTestId("stats")).toBeTruthy();
  });

  it("score, stats and the feed hold the previous event's state until the goal is revealed", async () => {
    const run = async (elapsed: number) => {
      const now = Date.now();
      const scored = { ...st!, sc: [1, 0] as [number, number], x: [[3, 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] } as typeof st;
      const before = { ...st!, x: [[2, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] } as typeof st;
      const shot = { ...ev(1, now - 30000, "Shoots!"), t: "shot", ball: [85, 32] as [number, number], st: before! };
      const goal = { ...ev(2, now - 1500 - elapsed, "GOAL!"), t: "goal", target: [100, 32] as [number, number], st: scored! };
      await mount(view([shot, goal], null, now));
      return { score: screen.getByTestId("match-score").textContent, shots: screen.getByTestId("stats").textContent, feed: screen.getByTestId("event-feed").textContent };
    };
    const early = await run(0.15 * 3800);
    expect(early.score).toBe("0–0");
    expect(early.shots).toContain("2Shots");
    expect(early.feed).toContain("Shoots!");
    expect(early.feed).not.toContain("GOAL!");
    cleanup();
    const late = await run(0.35 * 3800); // the ball crossed the line at p = 0.25: no hold (#98)
    expect(late.score).toBe("1–0");
    expect(late.shots).toContain("3Shots");
    expect(late.feed).toContain("GOAL!");
  });

  it("holds the shot's commentary until the ball is in, then shows GOAL!", async () => {
    // LAG_MS = 1500; goal scene ms = 3800 → p = (now − 1500 − at) / 3800
    const run = async (elapsed: number) => {
      const now = Date.now();
      const shot = { ...ev(1, now - 30000, "Shoots!"), t: "shot", ball: [85, 32] as [number, number] };
      const goal = { ...ev(2, now - 1500 - elapsed, "GOAL!"), t: "goal", target: [100, 32] as [number, number] };
      await mount(view([shot, goal], null, now));
      return screen.getByTestId("commentary").textContent;
    };
    expect(await run(0.15 * 3800)).toBe("Shoots!");
    cleanup();
    expect(await run(0.35 * 3800)).toBe("GOAL!"); // straight after the ball crosses the line (p = 0.25), #98
    expect(screen.getByTestId("goal-banner")).toBeTruthy(); // big GOOOAL over the pitch at the same moment
  });

  it("the result waits for the drawn ball, not just the clock: a lagging ball keeps the shot's caption a few frames longer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // real rAF, frozen clock we move by hand
    const now = Date.now();
    const shot = { ...ev(1, now - 30000, "Shoots!"), t: "shot", ball: [85, 32] as [number, number] };
    const goal = { ...ev(2, now + 1000, "GOAL!"), t: "goal", target: [100, 32] as [number, number] };
    await mount(view([shot, goal], null, now));
    expect(screen.getByTestId("commentary").textContent).toBe("Shoots!");
    // Jump straight to p = 0.8 of the goal: the target ball is in the net, the drawn one is still chasing it.
    vi.setSystemTime(now + 1000 + 1500 + 0.8 * 3800);
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(screen.getByTestId("commentary").textContent).toBe("Shoots!");
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(screen.getByTestId("commentary").textContent).toBe("GOAL!");
    vi.useRealTimers();
  });

  it("a resumed tab that skipped events snaps the pitch to the current scene instead of chasing across the gap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const e1 = ev(1, now - 30000, "Pass");
    const e2 = ev(2, now + 1000, "Pass two");
    const e3 = { ...ev(3, now + 1100, "Pass three"), from: [10, 10] as [number, number], ball: [10, 10] as [number, number] };
    const { container } = await mount(view([e1, e2, e3], { home: names("Home"), away: names("Away") }, now));
    const ball = () => Number(container.querySelector('svg circle[stroke="#111"]')!.getAttribute("cx"));
    expect(Math.abs(ball() - 10)).toBeGreaterThan(5); // still dwelling on from the centre, nowhere near e3's spot
    // The clock leaps straight from e1 to 90 % through e3: a chase from the old ball would still be mid-pitch frames later.
    vi.setSystemTime(now + 1100 + 1500 + 0.9 * 1500);
    await act(() => new Promise((r) => setTimeout(r, 40)));
    expect(ball()).toBeCloseTo(10, 1);
    vi.useRealTimers();
  });

  it("replaying an old goal never rolls the live scoreboard or feed back", async () => {
    const now = Date.now();
    const one = { ...st!, sc: [1, 0] as [number, number] } as typeof st;
    const two = { ...st!, sc: [2, 0] as [number, number] } as typeof st;
    const goal1 = { ...ev(1, now - 60000, "GOAL ONE"), t: "goal", target: [100, 32] as [number, number], st: one!, major: 1 };
    const pass = { ...ev(2, now - 30000, "Pass"), st: one! };
    const goal2 = { ...ev(3, now - 1500 - 0.9 * 3800, "GOAL TWO"), t: "goal", target: [100, 32] as [number, number], st: two!, major: 1 };
    await mount(view([goal1, pass, goal2], null, now));
    const local = within(screen.getByRole("region", { name: "Match events" }));
    fireEvent.click(local.getByTestId("ticker-toggle"));
    expect(screen.getByTestId("match-score").textContent).toBe("2–0");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Replay: GOAL ONE"));
    });
    // Replay at p ≈ 0: its own result is hidden on the pitch, but the live score and feed stand.
    expect(screen.getByText("Replay")).toBeTruthy();
    expect(screen.getByTestId("match-score").textContent).toBe("2–0");
    expect(screen.getByTestId("event-feed").textContent).toContain("GOAL TWO");
    expect(local.getByTestId("ticker-feed")).toHaveTextContent("GOAL TWO");
  });

  it("ignores a late poll response for the previous fixture after switching", async () => {
    const now = Date.now();
    const { footfiveApi } = await import("../lib/pocketbase");
    const { default: MatchPage } = await import("./MatchPage");
    let resolveA!: (v: MatchView) => void;
    const vA = view([ev(1, now - 3000, "A pass")], null, now);
    const vB = view([ev(1, now - 3000, "B pass")], null, now);
    vB.fixture = { ...vB.fixture, id: "fx2" };
    vi.mocked(footfiveApi.match).mockImplementation((id: string) => (id === "fx1" ? new Promise<MatchView>((r) => (resolveA = r)) : Promise.resolve(vB)));
    await act(async () => {
      render(
        <MemoryRouter initialEntries={["/match/fx1"]}>
          <Link to="/match/fx2">go B</Link>
          <Routes>
            <Route path="/match/:fixtureId" element={<MatchPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(screen.getByTestId("match-loading")).toBeTruthy();
    // Navigate to B: the first fx2 poll must not be blocked by A's in-flight request.
    await act(async () => {
      fireEvent.click(screen.getByText("go B"));
    });
    await act(async () => resolveA(vA));
    expect(screen.queryByText("A pass")).toBeNull();
    expect(screen.getByTestId("commentary").textContent).toBe("B pass");
  });

  it("a red card leaves the pitch (and the line-ups strike-through) only once its scene is revealed, whatever the server already knows", async () => {
    // red_card scene ms = 2200, flashAt 0.62 → p = (now − 1500 − at) / 2200
    const run = async (elapsed: number) => {
      const now = Date.now();
      const red = { ...ev(2, now - 1500 - elapsed, "Red card!"), t: "red_card", p: "Home P3", p2: undefined };
      const v = view([ev(1, now - 30000, "Pass"), red], { home: names("Home"), away: names("Away") }, now);
      v.sentOff = [{ side: "home", p: "Home P3" }];
      const { container } = await mount(v);
      await act(() => new Promise((r) => setTimeout(r, 60))); // a couple of animation frames: the gate's verdict applies next tick
      return { players: screen.getAllByTestId("player").length, struck: container.querySelectorAll(".line-through").length };
    };
    expect(await run(0.2 * 2200)).toEqual({ players: 10, struck: 0 });
    cleanup();
    expect(await run(0.9 * 2200)).toEqual({ players: 9, struck: 1 });
  });

  it("a red card older than the events buffer still keeps its player off the pitch (seeded from the server's list)", async () => {
    const now = Date.now();
    const v = view([ev(40, now - 30000, "Pass"), ev(41, now - 3000, "Another pass")], { home: names("Home"), away: names("Away") }, now);
    v.sentOff = [{ side: "home", p: "Home P3" }];
    await mount(v);
    expect(screen.getAllByTestId("player")).toHaveLength(9);
  });

  it("replaying an event from before a red card restores the player on the pitch, but the line-ups keep striking him through", async () => {
    const now = Date.now();
    const goal = { ...ev(1, now - 60000, "GOAL ONE"), t: "goal", target: [100, 32] as [number, number] };
    const red = { ...ev(2, now - 40000, "Red card!"), t: "red_card", p: "Home P3", p2: undefined };
    const { container } = await mount(view([goal, red, ev(3, now - 3000, "Pass")], { home: names("Home"), away: names("Away") }, now));
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(screen.getAllByTestId("player")).toHaveLength(9);
    expect(container.querySelectorAll(".line-through")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Replay: GOAL ONE"));
    });
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(screen.getByText("Replay")).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10); // the replay shows the match as it was
    expect(container.querySelectorAll(".line-through")).toHaveLength(1); // the line-ups follow the live match
  });

  it("renders the pitch with ball only when lineups are missing", async () => {
    const now = Date.now();
    await mount(view([ev(1, now - 3000, "Pass")], null, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.queryAllByTestId("player")).toHaveLength(0);
  });

  it("shows the other-match ticker without this match's events", async () => {
    const now = Date.now();
    const item = (id: string, fixtureId: string, text: string) => ({ id, fixtureId, seq: 1, at: now, t: "goal", side: "home", text, min: 3 });
    h.live = { fixtures: [], ticker: [item("t1", "fx1", "Our goal"), item("t2", "fx2", "Goal elsewhere")] };
    await mount(view([ev(1, now - 3000, "Pass")], null, now));
    const other = within(screen.getByRole("region", { name: "Other matches" }));
    expect(other.getByTestId("ticker-current").textContent).toContain("Goal elsewhere");
    expect(other.queryByText("Our goal")).toBeNull();
    h.live = null;
  });
});

describe("MatchPage retained history and fixture ticker", () => {
  afterEach(async () => {
    vi.useRealTimers();
    h.live = null;
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
  });

  const ticker = () => within(screen.getByRole("region", { name: "Match events" }));
  const history = (count: number, now: number) => Array.from({ length: count }, (_, i) => ({
    ...ev(i + 1, now - 60000 + i, `History ${i + 1}`),
    t: i === 0 ? "kickoff" : i === 1 ? "goal" : i % 10 === 0 ? "save" : "pass",
    major: i === 1 ? 1 : 0,
    tick: i === 1 ? "Historical goal ticker" : undefined,
  }));
  const page = (events: MatchEvent[], now: number, hasMore = false, since = 0) => ({
    ...view(events, null, now),
    eventsPage: { nextSeq: events.at(-1)?.seq ?? since, hasMore, throughMs: now },
  });

  it.each(["live", "finished"] as const)("backfills and reloads all retained %s log entries beyond both old client caps", async (status) => {
    vi.useFakeTimers();
    const now = Date.now();
    const events = history(651, now);
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockImplementation(async (_id, since = 0, through) => {
      const fresh = events.filter((e) => e.seq > since);
      const v = page(fresh.slice(0, 300), through ?? Date.now(), fresh.length > 300, since);
      v.fixture = { ...v.fixture, status, st: status === "finished" ? { ...st!, ph: "finished" } : st };
      return v;
    });
    await mount();
    const eligible = events.filter((e) => e.t !== "pass");
    expect(screen.getByTestId("event-feed").querySelectorAll("li")).toHaveLength(eligible.length);
    expect(screen.getByTestId("event-feed")).toHaveTextContent("History 1");
    expect(screen.getByTestId("event-feed")).toHaveTextContent("History 2");
    expect(match.mock.calls.slice(0, 3)).toEqual([["fx1", 0, undefined], ["fx1", 300, now], ["fx1", 600, now]]);
    expect(ticker().getByTestId("ticker-current")).toHaveTextContent("Historical goal ticker");
    fireEvent.click(ticker().getByTestId("ticker-toggle"));
    expect(ticker().getByTestId("ticker-feed")).toHaveTextContent("Historical goal ticker");
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(match.mock.calls.at(-1)).toEqual(["fx1", 651, undefined]);
    expect(screen.getByTestId("event-feed").querySelectorAll("li")).toHaveLength(eligible.length);
    cleanup();
    match.mockClear();
    await mount();
    expect(match.mock.calls[0]).toEqual(["fx1", 0, undefined]);
    expect(screen.getByTestId("event-feed").querySelectorAll("li")).toHaveLength(eligible.length);
    expect(ticker().getByTestId("ticker-current")).toHaveTextContent("Historical goal ticker");
  });

  it("publishes a bootstrap only after every page loads and retries a failed page without losing the prefix", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const events = history(601, now);
    let finish!: (v: MatchView) => void;
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(page(events.slice(0, 300), now, true));
    match.mockRejectedValueOnce(new Error("Temporary page failure"));
    match.mockResolvedValueOnce(page(events.slice(0, 300), now, true));
    match.mockResolvedValueOnce(page(events.slice(300, 600), now, true));
    match.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(screen.queryByTestId("match-score")).toBeNull();
    expect(screen.queryByTestId("event-feed")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Temporary page failure");
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(screen.queryByTestId("match-score")).toBeNull();
    expect(screen.queryByTestId("event-feed")).toBeNull();
    expect(match.mock.calls.map((args) => args[1])).toEqual([0, 300, 0, 300, 600]);
    await act(async () => finish(page(events.slice(600), now)));
    expect(screen.getByTestId("event-feed")).toHaveTextContent("History 1");
    expect(screen.getByTestId("commentary")).toHaveTextContent("History 601");
  });

  it("a late batch from a stale server is fast-forwarded through, not snapped over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // real rAF and poll interval, frozen server clock
    const now = Date.now();
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(page([ev(1, now - 30000, "Old pass")], now));
    // Published late: all three are already in the past when they arrive.
    match.mockResolvedValue(page([ev(2, now - 8000, "Late one"), ev(3, now - 6000, "Late two"), ev(4, now - 4000, "Late three")], now));
    await mount();
    expect(screen.getByTestId("commentary")).toHaveTextContent("Old pass");
    await act(() => new Promise((resolve) => setTimeout(resolve, MATCH_POLL_MS + 100)));
    expect(screen.getByTestId("commentary")).toHaveTextContent("Late one"); // not straight to the newest
    await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
    expect(screen.getByTestId("commentary")).toHaveTextContent("Late three"); // caught up within a few seconds
    vi.useRealTimers();
  }, 10000);

  it("keeps the current timeline during a multi-page missed backlog and commits no partial cursor on failure", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const events = history(605, now);
    let resolvePage!: (v: MatchView) => void;
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(page(events.slice(0, 2), now));
    match.mockResolvedValueOnce(page(events.slice(2, 302), now, true));
    match.mockRejectedValueOnce(new Error("Lost connection"));
    match.mockResolvedValueOnce(page(events.slice(2, 302), now, true));
    match.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    match.mockResolvedValueOnce(page(events.slice(602), now));
    await mount();
    expect(screen.getByTestId("commentary")).toHaveTextContent("History 2");
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(screen.getByTestId("commentary")).toHaveTextContent("History 2");
    expect(screen.getByTestId("event-feed").querySelectorAll("li")).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(screen.getByTestId("commentary").textContent).not.toContain("History 605");
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(screen.getByTestId("commentary").textContent).toBe("…");
    expect(match).toHaveBeenCalledTimes(5); // slow drain is single-flight
    await act(async () => resolvePage(page(events.slice(302, 602), now, true)));
    expect(match.mock.calls.map((args) => args[1])).toEqual([0, 2, 302, 2, 302, 602]);
    expect(screen.getByTestId("commentary")).toHaveTextContent("History 605");
    expect(screen.getByTestId("event-feed").querySelectorAll("li")).toHaveLength(events.filter((e) => e.t !== "pass").length);
  });

  it("has a local feed even when the round ticker contains only this fixture's unrevealed goal", async () => {
    const now = Date.now();
    h.live = { fixtures: [], ticker: [{ id: "fx1:2", fixtureId: "fx1", seq: 2, at: now - 500, t: "goal", side: "home", text: "Server spoiler", min: 3 }] };
    const goal = { ...ev(2, now - 500, "Goal after lag"), t: "goal", major: 1 };
    await mount(view([ev(1, now - 30000, "Pass"), goal], null, now));
    expect(ticker().queryByTestId("ticker-current")).toBeNull();
    fireEvent.click(ticker().getByTestId("ticker-toggle"));
    expect(ticker().getByTestId("ticker-feed")).toHaveTextContent("Nothing yet");
    expect(screen.queryByText("Server spoiler")).toBeNull();
    expect(screen.queryByRole("region", { name: "Other matches" })).toBeNull();
  });

  it("shows no local history before the first event reaches the lagged playhead", async () => {
    const now = Date.now();
    const kickoff = { ...ev(1, now - 500, "Early kickoff"), t: "kickoff", major: 1 };
    await mount(view([kickoff], null, now));
    expect(screen.queryByTestId("event-feed")).toBeNull();
    expect(ticker().queryByTestId("ticker-current")).toBeNull();
  });

  it.each(["goal", "penalty_goal", "shootout_kick", "red_card"])("gates %s in the local current and Recent feed until live reveal", async (type) => {
    const run = async (elapsed: number) => {
      const now = Date.now();
      const previous = { ...ev(1, now - 30000, "Before result"), t: "shot" };
      const result = {
        ...ev(2, now - 1500 - elapsed, "Revealed result"), t: type, target: [100, 32] as [number, number], major: 1,
        pen: type === "shootout_kick" || type === "penalty_goal" ? { col: 0, height: 0, dive: 0, post: null, run: 0, outcome: "goal" } : undefined,
      };
      await mount(view([previous, result], null, now));
      fireEvent.click(ticker().getByTestId("ticker-toggle"));
      return {
        current: ticker().queryByTestId("ticker-current")?.textContent ?? "",
        recent: ticker().getByTestId("ticker-feed").textContent,
        log: screen.getByTestId("event-feed").textContent,
      };
    };
    const early = await run(10);
    expect(early.current).not.toContain("Revealed result");
    expect(early.recent).not.toContain("Revealed result");
    expect(early.log).not.toContain("Revealed result");
    cleanup();
    const late = await run(30000);
    expect(late.current).toContain("Revealed result");
    expect(late.recent).toContain("Revealed result");
    expect(late.log).toContain("Revealed result");
  });

  it("holds both local ticker surfaces while a goal's drawn ball catches up, then retains them during replay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const goal = { ...ev(2, now + 1000, "New goal"), t: "goal", target: [100, 32] as [number, number], major: 1 };
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(page([{ ...ev(1, now - 30000, "Shoots"), t: "shot", ball: [85, 32] }], now));
    match.mockResolvedValue(page([goal], now));
    await mount();
    fireEvent.click(ticker().getByTestId("ticker-toggle"));
    // A normal incremental poll delivers the result; publication is ahead of the drawn pitch.
    await act(() => new Promise((resolve) => setTimeout(resolve, MATCH_POLL_MS + 50)));
    vi.setSystemTime(now + 1000 + 1500 + 0.8 * 3800);
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(ticker().queryByTestId("ticker-current")).toBeNull();
    expect(ticker().getByTestId("ticker-feed")).not.toHaveTextContent("New goal");
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(ticker().getByTestId("ticker-current")).toHaveTextContent("New goal");
    expect(ticker().getByTestId("ticker-feed")).toHaveTextContent("New goal");
    fireEvent.click(screen.getByLabelText("Replay: New goal"));
    expect(ticker().getByTestId("ticker-feed")).toHaveTextContent("New goal");
  });

  it("resets history and the local ticker's shown/queue/Recent state on fixture navigation", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { footfiveApi } = await import("../lib/pocketbase");
    const { default: MatchPage } = await import("./MatchPage");
    const goal = { ...ev(1, now - 30000, "Fixture A goal"), t: "goal", major: 1 };
    const vB = view([{ ...goal, text: "Fixture B goal" }], null, now);
    vB.fixture.id = "fx2";
    vi.mocked(footfiveApi.match).mockImplementation(async (id) => id === "fx1" ? view([goal], null, now) : vB);
    await act(async () => {
      render(<MemoryRouter initialEntries={["/match/fx1"]}><Link to="/match/fx2">Switch fixture</Link><Routes><Route path="/match/:fixtureId" element={<MatchPage />} /></Routes></MemoryRouter>);
    });
    fireEvent.click(ticker().getByTestId("ticker-toggle"));
    expect(ticker().getByTestId("ticker-feed")).toHaveTextContent("Fixture A goal");
    await act(async () => fireEvent.click(screen.getByText("Switch fixture")));
    expect(ticker().getByTestId("ticker-current")).toHaveTextContent("Fixture B goal");
    expect(ticker().queryByTestId("ticker-feed")).toBeNull();
    expect(screen.getByTestId("event-feed")).not.toHaveTextContent("Fixture A goal");
    await act(async () => { await vi.advanceTimersByTimeAsync(5500); });
    expect(ticker().getByTestId("ticker-current")).not.toHaveTextContent("Fixture A goal");
  });

  it("polls empty/purged history once per interval without a pagination loop", async () => {
    vi.useFakeTimers();
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset().mockResolvedValue(page([], Date.now()));
    await mount();
    expect(match).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("event-feed")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(match).toHaveBeenCalledTimes(2);
  });

  it("refreshes incrementally after a successful coaching command", async () => {
    const now = Date.now();
    const v = page([ev(1, now - 30000, "Pass")], now);
    v.managedSide = "home";
    v.coach = { stance: "balanced", pending: false, ai: false, used: 0, max: 3, cooldownUntil: 0 };
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset().mockResolvedValue(v);
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 2, used: 1, max: 3 });
    try {
      await mount();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "attack" })));
      expect(coaching).toHaveBeenCalledWith("fx1", "attack");
      expect(match.mock.calls).toEqual([["fx1", 0, undefined], ["fx1", 1, undefined]]);
    } finally {
      coaching.mockRestore();
    }
  });

  it("discards an old continuation even after returning to the same fixture, without releasing the new visit's poll lock", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { footfiveApi } = await import("../lib/pocketbase");
    const { default: MatchPage } = await import("./MatchPage");
    const match = vi.mocked(footfiveApi.match).mockReset();
    let oldPage!: (v: MatchView) => void;
    let newVisit!: (v: MatchView) => void;
    match.mockResolvedValueOnce(page([{ ...ev(1, now - 60000, "Old prefix"), t: "kickoff" }], now, true));
    match.mockImplementationOnce(() => new Promise((resolve) => { oldPage = resolve; }));
    const vB = page([], now);
    vB.fixture.id = "fx2";
    match.mockResolvedValueOnce(vB);
    match.mockImplementationOnce(() => new Promise((resolve) => { newVisit = resolve; }));
    await act(async () => {
      render(<MemoryRouter initialEntries={["/match/fx1"]}><Link to="/match/fx2">Go B</Link><Link to="/match/fx1">Go A</Link><Routes><Route path="/match/:fixtureId" element={<MatchPage />} /></Routes></MemoryRouter>);
    });
    await act(async () => fireEvent.click(screen.getByText("Go B")));
    await act(async () => fireEvent.click(screen.getByText("Go A")));
    await act(async () => oldPage(page([{ ...ev(2, now - 30000, "Old continuation goal"), t: "goal", major: 1 }], now)));
    expect(screen.getByTestId("match-loading")).toBeTruthy();
    expect(screen.queryByText("Old continuation goal")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
    expect(match).toHaveBeenCalledTimes(4);
    await act(async () => newVisit(page([{ ...ev(1, now - 30000, "New visit goal"), t: "goal", major: 1 }], now)));
    expect(ticker().getByTestId("ticker-current")).toHaveTextContent("New visit goal");
    expect(screen.getByTestId("event-feed")).not.toHaveTextContent("Old prefix");
  });
});

describe("MatchPage animation loop", () => {
  afterEach(() => vi.useRealTimers());

  it("draws a frame on mount and advances it on the next animation frame", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { container } = await mount(view([ev(1, now - 2000, "Pass")], { home: names("Home"), away: names("Away") }, now));
    const ball = () => container.querySelector('svg circle[stroke="#111"]')!.getAttribute("cx");
    const first = ball();
    expect(first).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
    await act(async () => void vi.advanceTimersToNextFrame());
    expect(ball()).not.toBe(first);
  });
});

describe("MatchPage auto-return after full time", () => {
  const finished = () => {
    const v = view([], null, Date.now());
    v.fixture = { ...v.fixture, status: "finished", st: { ...st!, ph: "finished", win: "home", by: "normal" } };
    return v;
  };
  afterEach(() => vi.useRealTimers());

  it("goes back to the round 20 s after the final whistle", async () => {
    vi.useFakeTimers();
    await mount(finished());
    expect(screen.getByTestId("auto-return").textContent).toContain("tap to stay");
    await act(() => vi.advanceTimersByTimeAsync(19000));
    expect(screen.queryByText("ROUND SCREEN")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByText("ROUND SCREEN")).toBeTruthy();
  });

  it("stays when the user interacts after full time", async () => {
    vi.useFakeTimers();
    await mount(finished());
    fireEvent.pointerDown(window);
    await act(() => vi.advanceTimersByTimeAsync(25000));
    expect(screen.queryByText("ROUND SCREEN")).toBeNull();
    expect(screen.queryByTestId("auto-return")).toBeNull();
  });
});

describe("MatchPage labels and timing (#78)", () => {
  afterEach(() => {
    h.live = null;
  });
  it("this match's ticker and the other matches' ticker carry distinct visible labels, neither 'Live feed'", async () => {
    const now = Date.now();
    h.live = { mode: "live", fixtures: [], ticker: [{ id: "t1", fixtureId: "fx2", t: "goal", text: "Elsewhere: GOAL" }] };
    await mount(view([ev(1, now - 30000, "Pass")], null, now));
    const badges = screen.getAllByTestId("ticker-badge").map((b) => b.textContent);
    expect(badges).toEqual(["This match", "Around the grounds"]);
    expect(screen.queryByText("Live feed")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Other matches" })).getByTestId("ticker-badge")).toHaveTextContent("Around the grounds");
  });
  it("event labels use the canonical minute and keep the elapsed clock on the time", async () => {
    const now = Date.now();
    const at = (s: number) => ({ ...st!, clk: { s, run: 1 as const } });
    await mount(view([{ ...ev(1, now - 30000, "Early"), t: "shot", min: 13, st: at(754.6) }], null, now));
    const time = screen.getByTestId("event-time");
    expect(time.textContent).toBe("13′");
    expect(time.getAttribute("title")).toBe("12:34");
    expect(screen.getByText("Match minutes")).toBeTruthy();
  });
  it("minute 59, coaching 59 and a 60:05 card share the engine minute with the raw ticker", async () => {
    const now = Date.now();
    const at = (s: number) => ({ ...st!, clk: { s, run: 1 as const } });
    const tick = "HOM 0–0 AWA — Red card: Poe (HOM), 61′.";
    const events: MatchEvent[] = [
      { ...ev(1, now - 80000, "Kick-off"), t: "kickoff", min: 0, st: at(0) },
      { ...ev(2, now - 70000, "Shot in minute 59"), t: "shot", min: 59, st: at(58 * 60 + 20) },
      { ...ev(3, now - 60000, "Red card"), t: "red_card", min: 61, major: 1, tick, st: at(3605) },
      { ...ev(4, now - 50000, "Half-time"), t: "half_time", min: 45, st: at(2700) },
      { ...ev(5, now - 40000, "Ninety up"), t: "end_of_normal_time", min: 90, st: at(5400) },
      { ...ev(6, now - 30000, "ET half-time"), t: "et_half_time", min: 105, st: at(6300) },
      { ...ev(7, now - 20000, "After extra time"), t: "match_end", min: 120, st: at(7200) },
      { ...ev(8, now - 10000, "Spot kick"), t: "shootout_kick", min: 120, st: at(7200) },
    ];
    const v = view(events, null, now);
    v.managedSide = "home";
    v.coach = { stance: "balanced", pending: false, ai: false, used: 0, max: 3, cooldownUntil: 0 };
    const { footfiveApi } = await import("../lib/pocketbase");
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 });
    const row = (fragment: string) => within(within(screen.getByTestId("event-feed")).getByText(fragment).closest("li")!).getByTestId("event-time");
    try {
      await mount(v);
      expect(row("Shot in minute 59").textContent).toBe(minuteLabel(59));
      expect(row("Shot in minute 59").getAttribute("title")).toBe("58:20");
      expect(row("Red card").textContent).toBe("61′");
      expect(row("Red card").getAttribute("title")).toBe("60:05");
      expect(screen.getByTestId("ticker-current").textContent).toContain(tick);
      expect(screen.getByTestId("ticker-current").textContent).not.toContain("60:05");
      expect(row("Kick-off").textContent).toBe("0′");
      expect(row("Kick-off").getAttribute("title")).toBe("00:00");
      expect(row("Half-time").textContent).toBe("45′");
      expect(row("Half-time").getAttribute("title")).toBe("45:00");
      expect(row("Ninety up").textContent).toBe("90′");
      expect(row("Ninety up").getAttribute("title")).toBe("90:00");
      expect(row("ET half-time").textContent).toBe("105′");
      expect(row("ET half-time").getAttribute("title")).toBe("105:00");
      expect(row("After extra time").textContent).toBe("120′");
      expect(row("After extra time").getAttribute("title")).toBe("120:00");
      expect(row("Spot kick").textContent).toBe("P");
      expect(row("Spot kick").getAttribute("title")).toBe("120:00");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "attack" })));
      expect(screen.getByText(`Attack accepted from ${minuteLabel(59)}.`)).toBeTruthy();
    } finally {
      coaching.mockRestore();
    }
  });
  it("before kick-off Match events explains what will appear", async () => {
    const now = Date.now();
    const v = view([], null, now);
    v.fixture = { ...v.fixture, status: "scheduled", st: null } as unknown as MatchView["fixture"];
    await mount(v);
    expect(screen.queryByText("The match hasn't started.")).toBeNull();
    expect(screen.getByText(/Not kicked off yet/)).toBeTruthy();
  });
});

describe("MatchPage coaching feedback", () => {
  afterEach(async () => {
    vi.useRealTimers();
    cleanup();
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
  });

  function withCoach(patch: Partial<NonNullable<MatchView["coach"]>> & { fixtureId?: string } = {}): MatchView {
    const { fixtureId = "fx1", ...coach } = patch;
    const v = view([ev(1, Date.now() - 30000, "Pass")], null, Date.now());
    v.fixture = { ...v.fixture, id: fixtureId };
    v.managedSide = "home";
    v.coach = { stance: "balanced", pending: false, ai: false, used: 0, max: 3, cooldownUntil: 0, ...coach };
    return v;
  }

  const touchline = () => within(screen.getByTestId("coaching"));

  it("shows the accepted acknowledgement and 2/3 left before refresh resolves", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    let refresh: ((v: MatchView) => void) | null = null;
    match.mockResolvedValueOnce(withCoach());
    match.mockImplementationOnce(() => new Promise((resolve) => { refresh = resolve; }));
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 });
    try {
      await mount();
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Balanced.");
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(match).toHaveBeenCalledTimes(2);
      expect(touchline().getByText("2/3 commands left")).toBeTruthy();
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
      expect(touchline().getByTestId("coaching-state").textContent).toContain(`Queued: Attack from ${minuteLabel(59)}.`);
      expect(touchline().getByRole("button", { name: "attack" })).toHaveAttribute("aria-pressed", "false");
      expect(touchline().getByRole("button", { name: "balanced" })).toHaveAttribute("aria-pressed", "false");
      expect(refresh).toBeTypeOf("function");
    } finally {
      if (refresh) await act(async () => refresh!(withCoach()));
      coaching.mockRestore();
    }
  });

  it("follows active, queued, then active once fresh snapshots catch up", async () => {
    vi.useFakeTimers();
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    const queuedSnap = withCoach({ stance: "attack", pending: true, used: 1, max: 3 });
    const activeSnap = withCoach({ stance: "attack", pending: false, used: 1, max: 3 });
    match.mockResolvedValueOnce(withCoach());
    match.mockResolvedValueOnce(queuedSnap);
    match.mockResolvedValue(activeSnap);
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 });
    try {
      await mount();
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Balanced.");
      expect(touchline().getByRole("button", { name: "balanced" })).toHaveAttribute("aria-pressed", "true");
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByText("2/3 commands left")).toBeTruthy();
      expect(touchline().getByTestId("coaching-state").textContent).toContain(`Queued: Attack from ${minuteLabel(59)}.`);
      expect(touchline().getByRole("button", { name: "attack" })).toHaveAttribute("aria-pressed", "false");
      expect(touchline().getByRole("button", { name: "attack" }).className).not.toMatch(/bg-cyan/);
      expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Attack.");
      expect(touchline().getByTestId("coaching-state").textContent).not.toContain("Queued:");
      expect(touchline().getByRole("button", { name: "attack" })).toHaveAttribute("aria-pressed", "true");
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
    } finally {
      coaching.mockRestore();
    }
  });

  it("does not reuse an earlier fromMinute when a fresher snapshot queues the same stance", async () => {
    vi.useFakeTimers();
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(withCoach());
    match.mockResolvedValueOnce(withCoach({ stance: "attack", pending: true, used: 1, max: 3 }));
    match.mockResolvedValue(withCoach({ stance: "attack", pending: true, used: 3, max: 3 }));
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 });
    try {
      await mount();
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByTestId("coaching-state").textContent).toContain(`Queued: Attack from ${minuteLabel(59)}.`);
      await act(async () => { await vi.advanceTimersByTimeAsync(MATCH_POLL_MS); });
      const state = touchline().getByTestId("coaching-state").textContent ?? "";
      expect(state).toContain("Queued: Attack. ");
      expect(state).not.toContain("from ");
      expect(state).not.toContain(minuteLabel(59));
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
    } finally {
      coaching.mockRestore();
    }
  });

  it("keeps the accepted acknowledgement and count when refresh fails or a stale snapshot arrives", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    const accepted = { ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 };
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue(accepted);
    try {
      const failed = vi.mocked(footfiveApi.match).mockReset();
      failed.mockResolvedValueOnce(withCoach());
      failed.mockRejectedValueOnce(new Error("Match unavailable"));
      await mount();
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
      expect(touchline().getByText("2/3 commands left")).toBeTruthy();
      expect(touchline().getByTestId("coaching-state").textContent).toContain(`Queued: Attack from ${minuteLabel(59)}.`);
      expect(screen.queryByText("Match unavailable")).toBeNull();
      cleanup();

      const staleMatch = vi.mocked(footfiveApi.match).mockReset();
      let refresh: ((v: MatchView) => void) | null = null;
      staleMatch.mockResolvedValueOnce(withCoach());
      staleMatch.mockImplementationOnce(() => new Promise((resolve) => { refresh = resolve; }));
      await mount();
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      await act(async () => refresh!(withCoach({ stance: "balanced", pending: false, used: 0, max: 3 })));
      expect(touchline().getByText("2/3 commands left")).toBeTruthy();
      expect(touchline().queryByText("3/3 commands left")).toBeNull();
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
      expect(touchline().getByTestId("coaching-state").textContent).toContain(`Queued: Attack from ${minuteLabel(59)}.`);
      expect(touchline().getByTestId("coaching-state").textContent).not.toContain("Active:");
      expect(touchline().getByRole("button", { name: "balanced" })).toHaveAttribute("aria-pressed", "false");
      expect(touchline().getByRole("button", { name: "balanced" })).toBeEnabled();
    } finally {
      coaching.mockRestore();
    }
  });

  it("shows an error and does not spend a command when the server rejects it", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset().mockResolvedValue(withCoach());
    const coaching = vi.spyOn(footfiveApi, "coaching").mockRejectedValueOnce(new Error("Command recharging — available in 4s"));
    try {
      await mount();
      expect(touchline().getByText("3/3 commands left")).toBeTruthy();
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByRole("alert").textContent).toBe("Command recharging — available in 4s");
      expect(touchline().queryByRole("status")).toBeNull();
      expect(touchline().getByText("3/3 commands left")).toBeTruthy();
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Balanced.");
      expect(touchline().getByTestId("coaching-state").textContent).not.toContain("Queued:");
      expect(coaching).toHaveBeenCalledTimes(1);
    } finally {
      coaching.mockRestore();
    }
  });

  it("labels a pending server stance as queued and does not present it as the active one", async () => {
    await mount(withCoach({ stance: "attack", pending: true, used: 1, max: 3 }));
    const state = touchline().getByTestId("coaching-state").textContent ?? "";
    expect(state).toContain("Queued: Attack.");
    expect(state).not.toContain("Active:");
    expect(state).not.toContain("from ");
    expect(state).toContain("Commands affect future play only.");
    const attack = touchline().getByRole("button", { name: "attack" });
    expect(attack).toHaveAttribute("aria-pressed", "false");
    expect(attack.className).not.toMatch(/bg-cyan/);
    expect(attack).toBeDisabled();
    expect(touchline().getByRole("button", { name: "balanced" })).toHaveAttribute("aria-pressed", "false");
    expect(touchline().getByRole("button", { name: "balanced" })).toBeEnabled();
    expect(touchline().getByText("2/3 commands left")).toBeTruthy();
    expect(touchline().queryByRole("status")).toBeNull();
  });

  it("keeps Full AI, command limit, cooldown, and closed-phase guards", async () => {
    await mount(withCoach({ ai: true }));
    expect(touchline().getByText(/Full AI/)).toBeTruthy();
    expect(touchline().queryByRole("button", { name: "attack" })).toBeNull();
    cleanup();

    await mount(withCoach({ used: 3, max: 3 }));
    expect(touchline().getByText("0/3 commands left")).toBeTruthy();
    expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
    expect(touchline().getByRole("button", { name: "defend" })).toBeDisabled();
    expect(touchline().getByRole("button", { name: "balanced" })).toBeDisabled();
    cleanup();

    await mount(withCoach({ cooldownUntil: Date.now() + 60_000 }));
    expect(touchline().getByTestId("coaching-state").textContent).toMatch(/Recharging:/);
    expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
    expect(touchline().getByText(/Commands affect future play only/)).toBeTruthy();
    cleanup();

    const shootout = withCoach();
    shootout.fixture = { ...shootout.fixture, st: { ...st!, ph: "shootout" } };
    await mount(shootout);
    expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
    cleanup();

    const finished = withCoach();
    finished.fixture = { ...finished.fixture, status: "finished", st: { ...st!, ph: "finished" } };
    await mount(finished);
    expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
  });

  it("does not leak an accepted command onto the next fixture", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    const { default: MatchPage } = await import("./MatchPage");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockImplementation((id: string) => Promise.resolve(id === "fx2" ? withCoach({ fixtureId: "fx2", stance: "defend", pending: false, used: 0 }) : withCoach()));
    const coaching = vi.spyOn(footfiveApi, "coaching").mockResolvedValue({ ok: true, stance: "attack", fromMinute: 59, used: 1, max: 3 });
    try {
      await act(async () => {
        render(
          <MemoryRouter initialEntries={["/match/fx1"]}>
            <Link to="/match/fx2">Switch fixture</Link>
            <Routes>
              <Route path="/match/:fixtureId" element={<MatchPage />} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByRole("status").textContent).toBe(`Attack accepted from ${minuteLabel(59)}.`);
      expect(touchline().getByText("2/3 commands left")).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByText("Switch fixture")));
      expect(touchline().queryByRole("status")).toBeNull();
      expect(touchline().queryByText(/Attack accepted/)).toBeNull();
      expect(touchline().queryByText(/Queued:/)).toBeNull();
      expect(touchline().getByText("3/3 commands left")).toBeTruthy();
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Defend.");
    } finally {
      coaching.mockRestore();
    }
  });
});
