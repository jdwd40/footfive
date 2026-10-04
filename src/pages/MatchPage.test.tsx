import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchEvent, MatchView } from "../lib/pocketbase";

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

async function mount(v: MatchView) {
  const { footfiveApi } = await import("../lib/pocketbase");
  vi.mocked(footfiveApi.match).mockResolvedValue(v);
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
  it("renders 10 players and the commentary of the event under the playhead", async () => {
    const now = Date.now();
    const events = [ev(1, now - 30000, "Older pass"), ev(2, now - 3000, "Current pass"), ev(3, now + 60000, "Future pass")];
    await mount(view(events, { home: names("Home"), away: names("Away") }, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
    expect(screen.getByTestId("commentary").textContent).toBe("Current pass");
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
    const early = await run(0.3 * 3800);
    expect(early.score).toBe("0–0");
    expect(early.shots).toContain("2Shots");
    expect(early.feed).toContain("Shoots!");
    expect(early.feed).not.toContain("GOAL!");
    cleanup();
    const late = await run(0.8 * 3800);
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
    expect(await run(0.3 * 3800)).toBe("Shoots!");
    cleanup();
    expect(await run(0.8 * 3800)).toBe("GOAL!");
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
    expect(ball()).toBeGreaterThan(40);
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
    const goal1 = { ...ev(1, now - 60000, "GOAL ONE"), t: "goal", target: [100, 32] as [number, number], st: one! };
    const pass = { ...ev(2, now - 30000, "Pass"), st: one! };
    const goal2 = { ...ev(3, now - 1500 - 0.9 * 3800, "GOAL TWO"), t: "goal", target: [100, 32] as [number, number], st: two! };
    await mount(view([goal1, pass, goal2], null, now));
    expect(screen.getByTestId("match-score").textContent).toBe("2–0");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Replay: GOAL ONE"));
    });
    // Replay at p ≈ 0: its own result is hidden on the pitch, but the live score and feed stand.
    expect(screen.getByText("Replay")).toBeTruthy();
    expect(screen.getByTestId("match-score").textContent).toBe("2–0");
    expect(screen.getByTestId("event-feed").textContent).toContain("GOAL TWO");
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
    expect(screen.getByTestId("ticker")).toBeTruthy();
    expect(screen.getByTestId("ticker-current").textContent).toContain("Goal elsewhere");
    h.live = null;
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
