import { render, screen, act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minuteLabel } from "../lib/live";
import type { MatchEvent, MatchView } from "../lib/pocketbase";

/** Mirrors MatchPage MATCH_POLL_MS (the page is imported dynamically after mocks). */
const MATCH_POLL_MS = 2500;
/** Same tail as sim LINGER_MS. Local so these cases load against a sim from before that export. */
const BADGE_TAIL_MS = 2500;

function reducedMotionList(query: string): MediaQueryList {
  return {
    matches: query.includes("reduce"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  };
}

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

// #189: pass-through spies, so a test can see which player starts each drawn target got and which frame it was chased from.
vi.mock("../domain/sim", async (orig) => {
  const m = await orig<typeof import("../domain/sim")>();
  return { ...m, frameAt: vi.fn(m.frameAt), smooth: vi.fn(m.smooth) };
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
  it("shows the score once, on the scoreboard: in a shootout also the pens score and who kicks next — shootout goals never touch the score, and the pitch carries no score strip (#207)", async () => {
    const now = Date.now();
    const so = { h: 2, a: 1, th: 3, ta: 2, first: "home", next: "away", sd: false, k: [] } as unknown as NonNullable<MatchView["fixture"]["st"]>["so"];
    const pens = { ...st!, ph: "shootout", sc: [1, 1] as [number, number], so } as NonNullable<MatchView["fixture"]["st"]>;
    const kick: MatchEvent = { ...ev(1, now - 30000, "Steps up"), t: "shootout_setup", side: "away" as const, kick: { no: 3, sd: 0 }, st: pens };
    await mount(view([kick], { home: names("Home"), away: names("Away") }, now));
    // #207: the score appeared three times (scoreboard, a HUD strip on the pitch, the ticker); now only the scoreboard has it.
    expect(screen.queryByTestId("pitch-hud")).toBeNull();
    expect(screen.queryByTestId("hud-score")).toBeNull();
    expect(screen.getAllByTestId("match-score")).toHaveLength(1);
    expect(screen.getByTestId("match-score").textContent).toBe("1–1");
    expect(screen.getByTestId("match-shootout-score").textContent).toBe("PENS 2–1");
    expect(screen.getByTestId("match-kicker").textContent).toBe("AWA to kick");
    const board = screen.getByTestId("match-scoreboard");
    expect(board.contains(screen.getByTestId("match-shootout-score"))).toBe(true);
    expect(board.contains(screen.getByTestId("match-kicker"))).toBe(true);
    expect(screen.getByTestId("pitch").textContent).not.toContain("1–1");
  });
  it("renders 10 players and the commentary of the event under the playhead", async () => {
    const now = Date.now();
    const events = [ev(1, now - 30000, "Older pass"), ev(2, now - 3000, "Current pass"), ev(3, now + 60000, "Future pass")];
    await mount(view(events, { home: names("Home"), away: names("Away") }, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
    expect(screen.getByTestId("commentary").textContent).toBe("Current pass");
  });

  it("commentary counts only shots the playhead has reached (#84)", async () => {
    const now = Date.now();
    const at = (s: number) => ({ ...st!, clk: { s, run: 1 as const } });
    const shot = (seq: number, ms: number, s: number): MatchEvent => ({ ...ev(seq, ms, `Shot ${seq}`), t: "shot", chain: seq, ball: [80, 32], from: null, st: at(s) });
    // Published but still ahead of the lagged playhead: the 4th shot must not raise the 3rd's count.
    await mount(view([shot(1, now - 90000, 60), shot(2, now - 60000, 90), shot(3, now - 3000, 120), shot(4, now - 500, 121)], { home: names("Home"), away: names("Away") }, now));
    const line = screen.getByTestId("commentary").textContent;
    expect(line).toContain("3rd");
    expect(line).toContain("HOM");
    expect(line).toContain("Shot 3");
  });

  it("holds the displayed clock across a lower snapshot and a server step back, then advances", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Whole-second fixtures: ignore the smoothed global offset. The browser proof covers the real offset.
    const live = await import("../lib/live");
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
    try {
      const now = Date.now();
      const timed = (s: number, ph = "first_half") => ({ ...st!, ph, clk: { s, run: 1 as const } });
      const pace = (v: MatchView) => {
        v.fixture = { ...v.fixture, minuteMs: 60000 };
        return v;
      };
      // The scoreboard follows the lagged pitch clock. LAG_MS (1.5 s) is 1.5 match seconds at this pace.
      const clock = () => screen.getByLabelText("Match clock").textContent;
      const { footfiveApi } = await import("../lib/pocketbase");
      vi.mocked(footfiveApi.match).mockReset();
      const first = { ...ev(1, now - 10000, "Opening"), st: timed(20) };
      await mount(pace(view([first], null, now)));
      expect(clock()).toBe("00:28");
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
      const lower = { ...ev(2, now - 6000, "Next"), st: timed(20) };
      vi.mocked(footfiveApi.match).mockResolvedValue(pace(view([first, lower], null, now)));
      await act(() => new Promise((r) => setTimeout(r, MATCH_POLL_MS + 80)));
      expect(clock()).toBe("00:28");
      vi.setSystemTime(now - 2000);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(clock()).toBe("00:28");
      vi.setSystemTime(now + 6000);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(clock()).toBe("00:30");
    } finally {
      serverClock.mockRestore();
    }
  }, 10000);

  it("keeps the display floor through a playhead rewind and a gap in the scoreboard clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const live = await import("../lib/live");
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
    try {
      const now = Date.now();
      const timed = (s: number) => ({ ...st!, clk: { s, run: 1 as const } });
      const pace = (v: MatchView) => {
        v.fixture = { ...v.fixture, minuteMs: 60000 };
        return v;
      };
      const clock = () => screen.getByLabelText("Match clock").textContent;
      const old = { ...ev(1, now - 30000, "Old pass"), st: timed(10) };
      const { footfiveApi } = await import("../lib/pocketbase");
      const match = vi.mocked(footfiveApi.match);
      match.mockReset();
      match.mockResolvedValueOnce(pace(view([old], null, now)));
      match.mockResolvedValueOnce(pace(view([old, { ...ev(2, now - 8000, "Late one"), st: timed(10) }, { ...ev(3, now - 4000, "Late three"), st: timed(10) }], null, now)));
      await mount();
      expect(clock()).toBe("00:38");
      expect(screen.getByTestId("commentary").textContent).toBe("Old pass");
      await act(() => new Promise((r) => setTimeout(r, MATCH_POLL_MS + 100)));
      expect(screen.getByTestId("commentary").textContent).toBe("Late one");
      expect(clock()).toBe("00:38");
      vi.setSystemTime(now - 40000);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.queryByLabelText("Match clock")).toBeNull();
      vi.setSystemTime(now - 15000);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(clock()).toBe("00:38");
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
    } finally {
      serverClock.mockRestore();
    }
  }, 15000);

  it("lets a new fixture start on a lower clock and does not turn a missing clock into 00:00", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const live = await import("../lib/live");
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
    try {
      const now = Date.now();
      const timed = (s: number) => ({ ...st!, clk: { s, run: 1 as const } });
      const { footfiveApi } = await import("../lib/pocketbase");
      const { default: MatchPage } = await import("./MatchPage");
      vi.mocked(footfiveApi.match).mockReset();
      vi.mocked(footfiveApi.match).mockImplementation(async (id: string) => {
        const at = id === "fx1" ? now - 20000 : now - 5000;
        const s = id === "fx1" ? 10 : 5;
        const v = view([{ ...ev(1, at, id === "fx1" ? "First" : "Second"), st: timed(s) }], null, now);
        v.fixture = { ...v.fixture, id, minuteMs: 60000 };
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
      expect(screen.getByLabelText("Match clock").textContent).toBe("00:28");
      await act(async () => {
        fireEvent.click(screen.getByText("Switch fixture"));
      });
      expect(screen.getByLabelText("Match clock").textContent).toBe("00:08");
      cleanup();
      const blank = view([ev(1, now - 3000, "No clock")], null, now);
      blank.fixture = { ...blank.fixture, minuteMs: 60000 };
      await mount(blank);
      expect(screen.getByLabelText("Match clock").textContent).toBe("");
    } finally {
      serverClock.mockRestore();
    }
  });

  it("seeds the visit floor from the synced clock, not the loading frame", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const live = await import("../lib/live");
    let skew = 30000;
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now() + skew);
    try {
      const { footfiveApi } = await import("../lib/pocketbase");
      vi.mocked(footfiveApi.match).mockReset();
      let release!: (v: MatchView) => void;
      vi.mocked(footfiveApi.match).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      await mount();
      expect(screen.getByTestId("match-loading")).toBeTruthy();
      await act(() => new Promise((r) => setTimeout(r, 40)));
      const now = Date.now();
      const opening = { ...ev(1, now - 10000, "Opening"), st: { ...st!, clk: { s: 20, run: 1 as const } } };
      const v = view([opening], null, now);
      v.fixture = { ...v.fixture, minuteMs: 60000 };
      skew = 0;
      await act(async () => { release(v); });
      expect(screen.getByLabelText("Match clock").textContent).toBe("00:28");
      vi.setSystemTime(now + 1000);
      // A step under a second is played through by the pitch clock, which the scoreboard follows.
      await act(() => new Promise((r) => setTimeout(r, 500)));
      expect(screen.getByLabelText("Match clock").textContent).toBe("00:29");
    } finally {
      serverClock.mockRestore();
    }
  }, 10000);

  describe("period restarts (#182)", () => {
    // The engine publishes a restart running, then holds the kick-off (walk-on, kickoffHoldMs) before the first play.
    // Timings are the reported semi-final's seq 184–188, relative to half-time; minuteMs 5000 is 12 match seconds a real second.
    const LAG = 1500;
    const HT = Date.now() - 600000;
    const R = HT + 30000;
    const at = (ms: number, s: number, t: string, ph: string, run: 0 | 1 = 1, text = t): MatchEvent => ({
      ...ev(0, R + ms, text), t, side: undefined, st: { ...st!, ph, clk: { s, run } } as NonNullable<MatchView["fixture"]["st"]>,
    });
    const secondHalf = () =>
      [
        at(-30000, 2700, "half_time", "half_time", 0, "Half-time: VIR 0–0 TRI"),
        at(0, 2700, "second_half", "second_half", 1, "Second half under way"),
        at(4866, 2710, "pass", "second_half", 1, "N. Flux knocks it to Q. Delhomme"),
        at(5966, 2723, "pass", "second_half", 1, "Q. Delhomme knocks it to R. Babineaux"),
        at(7066, 2736, "pass", "second_half", 1, "W. Arc collects from R. Babineaux"),
      ].map((e, i) => ({ ...e, seq: 184 + i }));
    const paced = (events: MatchEvent[]) => {
      const v = view(events, null, R);
      v.fixture = { ...v.fixture, minuteMs: 5000 };
      return v;
    };
    const clock = () => (screen.getByLabelText("Match clock").textContent ?? "").replace("ET", "");
    /** Puts the lagged pitch playhead at R + ms (a jump over 1 s snaps the pitch clock) and reads the scoreboard clock. */
    const sampleAt = async (ms: number) => {
      vi.setSystemTime(R + ms + LAG);
      await act(() => new Promise((r) => setTimeout(r, 40)));
      return clock();
    };
    const withClock = async (body: () => Promise<void>) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const live = await import("../lib/live");
      const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
      const { footfiveApi } = await import("../lib/pocketbase");
      vi.mocked(footfiveApi.match).mockReset();
      try {
        await body();
      } finally {
        serverClock.mockRestore();
        vi.mocked(footfiveApi.match).mockReset();
      }
    };

    it("holds 45:00 through the second-half walk-on, then runs at normal pace from the first play without overshoot or freeze", async () => {
      await withClock(async () => {
        vi.setSystemTime(R - 500 + LAG);
        await mount(paced(secondHalf()));
        const samples = [await sampleAt(-500)];
        for (const ms of [200, 1400, 2600, 3800, 4900, 6100, 7300]) samples.push(await sampleAt(ms));
        expect(samples).toEqual(["45:00", "45:00", "45:00", "45:00", "45:00", "45:10", "45:24", "45:38"]);
        expect(screen.getByTestId("commentary")).toHaveTextContent("W. Arc collects from R. Babineaux");
      });
    }, 10000);

    it("keeps 45:00 while the first play is late, then fast-forwards the late batch without going back or freezing", async () => {
      await withClock(async () => {
        const events = secondHalf();
        const { footfiveApi } = await import("../lib/pocketbase");
        vi.mocked(footfiveApi.match).mockResolvedValueOnce(paced(events.slice(0, 2))).mockResolvedValue(paced(events));
        vi.setSystemTime(R + 1000 + LAG);
        await mount();
        expect(clock()).toBe("45:00");
        // The poll with the first plays arrives after they are due: the pitch rewinds to them and plays them through fast.
        expect(await sampleAt(7300)).toBe("45:00");
        const seen: string[] = [];
        for (let i = 0; i < 40 && seen.at(-1) !== "45:38"; i++) {
          await act(() => new Promise((r) => setTimeout(r, 100)));
          seen.push(clock());
        }
        expect(seen.at(-1)).toBe("45:38");
        expect(seen.every((c, i) => c >= "45:00" && (i === 0 || c >= seen[i - 1]))).toBe(true);
        expect(seen.some((c) => c > "45:00" && c < "45:38")).toBe(true);
      });
    }, 15000);

    it.each([
      ["kickoff", "first_half", 0, 4200, 2, "00:00", "00:02"],
      ["extra_time", "extra_time_1", 5400, 4724, 5408, "90:00", "90:08"],
      ["et_second_half", "extra_time_2", 6300, 4770, 6309, "105:00", "105:09"],
    ] as const)("holds the %s restart on its own time until the first play", async (t, ph, s0, gap, s1, held, first) => {
      await withClock(async () => {
        const events = [at(0, s0, t, ph), at(gap, s1, "pass", ph)].map((e, i) => ({ ...e, seq: i + 1 }));
        vi.setSystemTime(R + 200 + LAG);
        await mount(paced(events));
        expect([clock(), await sampleAt(gap - 1200), await sampleAt(gap + 50)]).toEqual([held, held, first]);
      });
    }, 10000);
  });

  it("drops SAVED once the save is over and does not resurrect it on a later pass", async () => {
    const { sceneFor } = await import("../domain/scenes");
    const now = Date.now();
    const save = { ...ev(1, now, "Keeper save"), t: "save", side: "away" as const, target: [0, 32] as [number, number] };
    const ms = sceneFor(save, [40, 30], 15000)!.ms;
    const clock = now - 1500;
    await mount(view([{ ...save, at: clock - ms - 400 }], null, now));
    expect(screen.getByText("SAVED!")).toBeTruthy();
    cleanup();
    await mount(view([{ ...save, at: clock - ms - BADGE_TAIL_MS - 500 }], null, now));
    expect(screen.queryByText("SAVED!")).toBeNull();
    cleanup();
    await mount(view([{ ...save, at: now - 25000 }, ev(2, now - 2000, "Later pass")], null, now));
    expect(screen.queryByText("SAVED!")).toBeNull();
    expect(screen.getByTestId("commentary").textContent).toBe("Later pass");
    expect(screen.getByTestId("match-score").textContent).toBe("0–0");
    const realNow = performance.now.bind(performance);
    let extra = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + extra);
    try {
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Replay: Keeper save"));
      });
      extra = ms + 100;
      await act(() => new Promise((r) => setTimeout(r, 40)));
      expect(screen.getByText("SAVED!")).toBeTruthy();
      expect(screen.getByTestId("match-score").textContent).toBe("0–0");
    } finally {
      spy.mockRestore();
    }
    cleanup();
    await mount(view([{ ...save, at: clock - ms - 200 }, ev(2, clock - 80, "Tail pass")], null, now));
    expect(screen.getByText("SAVED!")).toBeTruthy();
    expect(screen.getByTestId("commentary").textContent).toBe("Tail pass");
    expect(screen.getByTestId("match-score").textContent).toBe("0–0");
  });

  it("uses elapsed time when reduced motion holds the scene at its final frame", async () => {
    const { sceneFor } = await import("../domain/scenes");
    const now = Date.now();
    const save = { ...ev(1, now, "Keeper save"), t: "save", side: "away" as const, target: [0, 32] as [number, number] };
    const ms = sceneFor(save, [40, 30], 15000)!.ms;
    const prev = window.matchMedia;
    window.matchMedia = reducedMotionList;
    try {
      await mount(view([{ ...save, at: now - 1500 - ms - 400 }], null, now));
      expect(screen.getByText("SAVED!")).toBeTruthy();
      cleanup();
      await mount(view([{ ...save, at: now - 1500 - ms - BADGE_TAIL_MS - 500 }], null, now));
      expect(screen.queryByText("SAVED!")).toBeNull();
    } finally {
      window.matchMedia = prev;
    }
  });

  it("keeps the large goal, half-time and full-time banners after their scenes would have expired a result chip", async () => {
    const now = Date.now();
    const scored = { ...st!, sc: [1, 0] as [number, number] };
    const goal = { ...ev(1, now - 30000, "GOAL!"), t: "goal", target: [100, 32] as [number, number], st: scored };
    await mount(view([goal], { home: names("Home"), away: names("Away") }, now));
    expect(screen.getByTestId("goal-banner")).toBeTruthy();
    expect(screen.getByTestId("match-score").textContent).toBe("1–0");
    cleanup();
    const ht = { ...ev(1, now - 5000, "Half time"), t: "half_time" };
    await mount(view([ht], null, now));
    expect(screen.getByTestId("period-banner")).toBeTruthy();
    cleanup();
    const ft = { ...ev(1, now - 30000, "Full time"), t: "match_end", side: "home" as const };
    await mount(view([ft], null, now));
    expect(screen.getByTestId("ft-banner")).toBeTruthy();
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
    const local = within(screen.getByRole("region", { name: "Live events" }));
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

  it("one ticker row carries the other matches' news, without this match's server items (#207)", async () => {
    const now = Date.now();
    const item = (id: string, fixtureId: string, text: string) => ({ id, fixtureId, seq: 1, at: now, t: "goal", side: "home", text, min: 3 });
    h.live = { fixtures: [], ticker: [item("t1", "fx1", "Our goal"), item("t2", "fx2", "Goal elsewhere")] };
    await mount(view([ev(1, now - 3000, "Pass")], null, now));
    expect(screen.getAllByTestId("ticker")).toHaveLength(1);
    const row = within(screen.getByRole("region", { name: "Live events" }));
    expect(row.getByTestId("ticker-current").textContent).toContain("Goal elsewhere");
    expect(row.getByTestId("ticker-badge")).toHaveTextContent("Elsewhere");
    expect(row.queryByText("Our goal")).toBeNull();
    h.live = null;
  });

  it("merges this match's revealed events and the other matches' news into one row, newest first, and flashes only a goal elsewhere (#207, #206)", async () => {
    const now = Date.now();
    const ours = { ...ev(1, now - 30000, "Our goal"), t: "goal", major: 1, tick: "GOAL! HOM 1–0 AWA" };
    const elsewhere = { id: "fx2:4", fixtureId: "fx2", seq: 4, at: now - 20000, t: "goal", side: "home" as const, text: "GOAL! MET 1–0 ORL", min: 30 };
    h.live = { fixtures: [], ticker: [elsewhere] };
    await mount(view([ours, ev(2, now - 10000, "Pass")], null, now));
    const row = within(screen.getByRole("region", { name: "Live events" }));
    expect(screen.getAllByTestId("ticker")).toHaveLength(1);
    // History (more than 8 s old on arrival) does not flash.
    expect(row.getByTestId("ticker-current")).toBeTruthy();
    expect(row.queryByTestId("ticker-flash")).toBeNull();
    fireEvent.click(row.getByTestId("ticker-toggle"));
    const items = [...row.getByTestId("ticker-feed").querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("Elsewhere");
    expect(items[0]).toContain("GOAL! MET 1–0 ORL");
    expect(items[1]).toContain("This match");
    expect(items[1]).toContain("GOAL! HOM 1–0 AWA");
    // A goal elsewhere that arrives while watching flashes the row; one of ours never does (the pitch has its own goal screen).
    h.live = { fixtures: [], ticker: [{ ...elsewhere, id: "fx2:9", seq: 9, at: Date.now(), text: "GOAL! MET 2–0 ORL" }, elsewhere] };
    await waitFor(() => expect(row.getByTestId("ticker-current")).toHaveTextContent("GOAL! MET 2–0 ORL"), { timeout: 12000 });
    expect(row.getByTestId("ticker-flash")).toBeTruthy();
    h.live = null;
  }, 20000);

  it("holds one ticker row from kick-off through a late fixture list, an item arriving and clearing, as a direct child of the top row (#183, #207)", async () => {
    const now = Date.now();
    const card = (id: string) => ({ id, home: team(id === "fx1" ? "Virgin" : "Metro"), away: team(id === "fx1" ? "Tripper" : "Orleans"), st: null });
    const goal = { id: "fx2:12", fixtureId: "fx2", seq: 12, at: now, t: "goal", side: "home", text: "GOAL! MET 1–0 ORL", min: 50 };
    const frame = () => act(() => new Promise((r) => setTimeout(r, 60))); // the animation loop re-renders with the new live state
    try {
      h.live = { fixtures: [], ticker: [] };
      await mount(view([ev(1, now - 3000, "Pass")], null, now));
      const page = document.querySelector(".match-page")!;
      const top = screen.getByTestId("match-top");
      const order = () => [...page.children].slice(0, 2).map((c) => c.getAttribute("data-testid"));
      const row = () => [...top.children].map((c) => c.getAttribute("data-testid") || c.getAttribute("aria-label"));
      expect(order()).toEqual(["match-top", "match-scoreboard"]);
      expect(row()).toEqual(["Other matches", "ticker"]);
      const shown = () => within(screen.getByRole("region", { name: "Live events" }));
      expect(shown().queryByTestId("ticker-current")).toBeNull();

      h.live = { fixtures: [card("fx1"), card("fx2")], ticker: [goal] };
      await frame();
      expect(row()).toEqual(["Other matches", "ticker"]);
      expect(shown().getByTestId("ticker-current")).toHaveTextContent("GOAL! MET 1–0 ORL");
      expect(screen.getAllByTestId("ticker")).toHaveLength(1);

      h.live = { fixtures: [card("fx1"), card("fx2")], ticker: [] };
      await frame();
      expect(row()).toEqual(["Other matches", "ticker"]);
      expect(order()).toEqual(["match-top", "match-scoreboard"]);
    } finally {
      h.live = null;
    }
  });
});

describe("MatchPage retained history and fixture ticker", () => {
  afterEach(async () => {
    vi.useRealTimers();
    h.live = null;
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
  });

  const ticker = () => within(screen.getByRole("region", { name: "Live events" }));
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

  it("keeps every counted shot listed through a quiet spell of routine play while the clock and statistics run on", async () => {
    // Shape of the reported semi-final (#181): shots up to 58′, then only passes, tackles and a foul until the next shot at 72′.
    const now = Date.now();
    const rows: Array<[string, "home" | "away" | null, number, string]> = [
      ["kickoff", null, 0, "Kick-off"],
      ["shot", "home", 6, "Guidry shoots!"], ["save", "away", 6, "Cormier saves from Guidry"],
      ["shot", "home", 13, "Guidry lets fly!"], ["miss", "home", 13, "Guidry drags it wide"],
      ["shot", "home", 22, "Robichaux goes for goal"], ["block", "away", 22, "Cormier blocks Robichaux's shot"],
      ["shot", "home", 36, "Leger shoots from range!"], ["woodwork", "home", 36, "Off the crossbar! Leger so close"],
      ["shot", "home", 44, "Guidry shoots again!"], ["goal", "home", 44, "GOAL! Guidry scores"],
      ["half_time", null, 45, "Half-time"], ["second_half", null, 45, "Second half under way"],
      ["penalty_awarded", "home", 48, "PENALTY to Home!"], ["penalty_missed", "home", 48, "Leger misses the penalty"],
      ["foul", "home", 52, "Robichaux fouls Delhomme"],
      ["shot", "away", 58, "Delhomme lets fly!"], ["save", "home", 58, "Brilliant stop by Leblanc!"],
      ["pass", "away", 60, "Delhomme finds Martin"], ["tackle", "home", 63, "Robichaux wins it back"],
      ["foul", "home", 66, "Robichaux trips Martin"], ["pass", "home", 71, "Guidry finds Leger"],
      ["shot", "away", 72, "Delhomme shoots!"],
    ];
    const sc = [0, 0];
    const x = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]];
    const events: MatchEvent[] = rows.map(([t, side, min, text], i) => {
      const k = side === "away" ? 1 : 0;
      if (t === "shot" || t === "penalty_missed") x[k][0] += 1;
      if (t === "foul") x[k][4] += 1;
      if (t === "goal") sc[k] += 1;
      const snap = { ...st!, ph: min > 45 ? "second_half" : "first_half", sc: [sc[0], sc[1]], clk: { s: min * 60, run: 1 }, x: x.map((r) => [...r]) };
      // The routine pass at 71′ is under the playhead; the 72′ shot is not published to it yet.
      const at = i === rows.length - 1 ? now + 60000 : i === rows.length - 2 ? now - 3000 : now - 60000 + i * 1000;
      return { ...ev(i + 1, at, text), t, side, min, major: t === "goal" ? 1 : 0, st: snap } as MatchEvent;
    });
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    // Small history pages: the feed is drained across several of them.
    match.mockImplementation(async (_id, since = 0, through) => {
      const fresh = events.filter((e) => e.seq > since && e.at <= now);
      const v = page(fresh.slice(0, 5), through ?? now, fresh.length > 5, since);
      v.fixture = { ...v.fixture, minuteMs: 15000 };
      return v;
    });
    await mount();

    expect(match.mock.calls.map((args) => args[1])).toEqual([0, 5, 10, 15, 20]);
    expect(screen.getByTestId("commentary")).toHaveTextContent("Guidry finds Leger");
    expect(screen.getByLabelText("Match clock").textContent).toMatch(/^71:/);
    // Statistics are match totals, including the foul the feed leaves out.
    expect(screen.getByTestId("stats")).toHaveTextContent("6Shots1");
    expect(screen.getByTestId("stats")).toHaveTextContent("2Fouls0");
    expect(screen.getByTestId("feed-note")).toHaveTextContent("every shot and its result");

    const feed = screen.getByTestId("event-feed");
    const listed = [...feed.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(listed[0]).toContain("Brilliant stop by Leblanc!");
    const keyMoments = events.filter((e) => !["pass", "tackle", "foul"].includes(e.t) && e.at <= now);
    // #203: one row per attack. Each of the six published shots shares its row with its result, the penalty award with its kick.
    expect(listed).toHaveLength(keyMoments.length - 7);
    for (const e of keyMoments) expect(feed).toHaveTextContent(e.text);
    for (const [i, e] of events.entries()) {
      if (e.t !== "shot" && e.t !== "penalty_awarded") continue;
      if (e.at > now) continue;
      expect(listed.filter((l) => l.includes(e.text) && l.includes(events[i + 1].text)), e.text).toHaveLength(1);
    }
    for (const t of ["shot", "save", "miss", "block", "woodwork", "goal", "penalty_missed"]) expect(keyMoments.some((e) => e.t === t)).toBe(true);
    // Every counted shot (open play and penalty, both sides: 6 + 1) has its own entry.
    expect(keyMoments.filter((e) => e.t === "shot" || e.t === "penalty_missed")).toHaveLength(7);
    for (const routine of ["Delhomme finds Martin", "Robichaux wins it back", "Robichaux trips Martin", "Robichaux fouls Delhomme", "Delhomme shoots!"]) {
      expect(feed).not.toHaveTextContent(routine);
    }
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
    expect(screen.getAllByTestId("ticker")).toHaveLength(1);
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
  it("the one ticker labels each item as this match or elsewhere, never 'Live feed' (#207)", async () => {
    const now = Date.now();
    h.live = { mode: "live", fixtures: [], ticker: [{ id: "t1", fixtureId: "fx2", at: now - 60000, t: "goal", text: "Elsewhere: GOAL" }] };
    await mount(view([{ ...ev(1, now - 30000, "Our card"), t: "yellow_card", major: 1 }], null, now));
    const row = within(screen.getByRole("region", { name: "Live events" }));
    expect(screen.getAllByTestId("ticker-badge")).toHaveLength(1);
    expect(row.getByTestId("ticker-badge")).toHaveTextContent(/This match|Elsewhere/);
    expect(screen.queryByText("Live feed")).toBeNull();
    fireEvent.click(row.getByTestId("ticker-toggle"));
    const rows = [...row.getByTestId("ticker-feed").querySelectorAll("li")];
    expect(rows.map((li) => li.textContent)).toEqual([expect.stringMatching(/^.?This match/u), expect.stringMatching(/^.?Elsewhere/u)]);
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
      expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
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
      expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
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
      expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
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
      expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
      expect(touchline().queryByText("3/3 coaching commands left this match")).toBeNull();
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
      expect(touchline().getByText("3/3 coaching commands left this match")).toBeTruthy();
      await act(async () => fireEvent.click(touchline().getByRole("button", { name: "attack" })));
      expect(touchline().getByRole("alert").textContent).toBe("Command recharging — available in 4s");
      expect(touchline().queryByRole("status")).toBeNull();
      expect(touchline().getByText("3/3 coaching commands left this match")).toBeTruthy();
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
    expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
    expect(touchline().queryByRole("status")).toBeNull();
  });

  it("keeps Full AI, command limit, cooldown, and closed-phase guards", async () => {
    await mount(withCoach({ ai: true }));
    expect(touchline().getByText(/Full AI/)).toBeTruthy();
    expect(touchline().queryByRole("button", { name: "attack" })).toBeNull();
    cleanup();

    await mount(withCoach({ used: 3, max: 3 }));
    expect(touchline().getByRole("heading", { name: "Live coaching" })).toBeTruthy();
    expect(touchline().getByText("0/3 coaching commands left this match")).toBeTruthy();
    expect(touchline().getByText(/separate from Command Charge on My Team/)).toBeTruthy();
    expect(touchline().getByRole("button", { name: "attack" })).toBeDisabled();
    expect(touchline().getByRole("button", { name: "defend" })).toBeDisabled();
    expect(touchline().getByRole("button", { name: "balanced" })).toBeDisabled();
    cleanup();

    await mount(withCoach({ cooldownUntil: Date.now() + 60_000 }));
    expect(touchline().getByTestId("coaching-state").textContent).toMatch(/Coaching cooldown:/);
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
      expect(touchline().getByText("2/3 coaching commands left this match")).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByText("Switch fixture")));
      expect(touchline().queryByRole("status")).toBeNull();
      expect(touchline().queryByText(/Attack accepted/)).toBeNull();
      expect(touchline().queryByText(/Queued:/)).toBeNull();
      expect(touchline().getByText("3/3 coaching commands left this match")).toBeTruthy();
      expect(touchline().getByTestId("coaching-state").textContent).toContain("Active: Defend.");
    } finally {
      coaching.mockRestore();
    }
  });
});

describe("MatchPage early possession", () => {
  const row = (pos: number, clk: { s: number; run: 0 | 1 } | null, ph = "first_half") =>
    ({ ...st!, ph, pos, clk, x: [[1, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] }) as NonNullable<typeof st>;

  async function show(pub: NonNullable<typeof st>) {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
    const now = Date.now();
    const v = view([{ ...ev(1, now - 30000, "Early pass"), st: pub }], null, now);
    v.fixture = { ...v.fixture, st: pub };
    await mount(v);
    return screen.getByTestId("stats").textContent ?? "";
  }

  it("holds a neutral first-minute placeholder at a published clock of 9s", async () => {
    const text = await show(row(100, { s: 9, run: 1 }));
    expect(text).toContain("First minute");
    expect(text).not.toContain("%");
    expect(text).toContain("1Shots");
    cleanup();
    const pre = await show(row(100, { s: 0, run: 1 }, "pre"));
    expect(pre).toContain("First minute");
    expect(pre).not.toContain("%");
  });

  it("shows the published percentage from clock 60", async () => {
    const text = await show(row(100, { s: 60, run: 1 }));
    expect(text).toMatch(/100%0%/);
    expect(text).not.toContain("First minute");
    expect(text).toContain("1Shots");
  });

  it("shows a later real 0 and a later real 100", async () => {
    const zero = await show(row(0, { s: 90, run: 1 }));
    expect(zero).toMatch(/0%100%/);
    expect(zero).not.toContain("First minute");
    expect(zero).toContain("1Shots");
    cleanup();
    const full = await show(row(100, { s: 120, run: 1 }));
    expect(full).toMatch(/100%0%/);
    expect(full).not.toContain("First minute");
  });

  it("keeps the published percentage when the clock is missing or not numeric", async () => {
    const missing = await show(row(100, null));
    expect(missing).toMatch(/100%0%/);
    expect(missing).not.toContain("First minute");
    cleanup();
    const bad = await show(row(0, { s: Number.NaN, run: 1 }));
    expect(bad).toMatch(/0%100%/);
    expect(bad).not.toContain("First minute");
  });
});

describe("MatchPage drawn player starts (#189)", () => {
  afterEach(() => vi.useRealTimers());
  const lineups = () => ({ home: names("Home"), away: names("Away") });
  const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
  async function spies() {
    const sim = await import("../domain/sim");
    const frameAt = vi.mocked(sim.frameAt);
    const smooth = vi.mocked(sim.smooth);
    frameAt.mockClear();
    smooth.mockClear();
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
    /** Every drawn target from call `from` on: its scene and the ninth argument (player starts). */
    const targets = (from = 0) => frameAt.mock.calls.slice(from).map((c) => ({ seq: c[0].seq, scene: c[0], starts: c[8] }));
    return { frameAt, smooth, targets };
  }

  it("a contiguous new scene starts from the frame actually drawn, not its authored spots, and holds that one snapshot through the scene and a poll rebuild", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { frameAt, smooth, targets } = await spies();
    const now = Date.now();
    const e1 = ev(1, now - 30000, "Pass");
    const e2 = { ...ev(2, now + 1000, "Next pass"), from: [60, 20] as [number, number], ball: [75, 15] as [number, number] };
    const { footfiveApi } = await import("../lib/pocketbase");
    await mount(view([e1, e2], lineups(), now));
    expect(targets().length).toBeGreaterThan(0);
    expect(targets().every((c) => c.seq === 1 && c.starts === undefined)).toBe(true); // joined mid-dwell: nothing drawn before it
    vi.setSystemTime(now + 1000 + 1500 + 20);
    await wait(60);
    const i = frameAt.mock.calls.findIndex((c) => c[0].seq === 2);
    expect(i).toBeGreaterThan(0);
    const snap = frameAt.mock.calls[i][8]!;
    // The same tick chases from the committed drawn frame: the snapshot is exactly its players, keyed side:no, frozen.
    const j = smooth.mock.invocationCallOrder.findIndex((o) => o > frameAt.mock.invocationCallOrder[i]);
    const drawn = smooth.mock.calls[j][0]!;
    expect(drawn.seq).toBe(1);
    expect(snap).toEqual(Object.fromEntries(drawn.players.map((q) => [`${q.side}:${q.no}`, [q.x, q.y]])));
    expect(Object.keys(snap)).toHaveLength(10);
    expect(Object.isFrozen(snap)).toBe(true);
    // Not the new scene's authored starts: the receiver (Home P4, home:5) is drawn well away from his authored first spot.
    const real = await vi.importActual<typeof import("../domain/sim")>("../domain/sim");
    const authored = real.frameAt(frameAt.mock.calls[i][0], 0, lineups()).players.find((q) => q.side === "home" && q.no === 5)!;
    expect(Math.hypot(authored.x - snap["home:5"][0], authored.y - snap["home:5"][1])).toBeGreaterThan(1);
    // Held, the same object, for every later frame of that scene, also once a poll rebuilds the scenes.
    const firstScene = frameAt.mock.calls[i][0];
    vi.mocked(footfiveApi.match).mockResolvedValue(view([e1, e2, ev(3, now + 60000, "Future pass")], lineups(), Date.now())); // server time as the faked clock: no offset step
    const before = frameAt.mock.calls.length;
    await wait(MATCH_POLL_MS + 120);
    const later = targets(i);
    expect(later.length).toBeGreaterThan(3);
    expect(later.every((c) => c.seq === 2 && c.starts === snap)).toBe(true);
    expect(targets(before).some((c) => c.scene !== firstScene)).toBe(true); // the rebuild really happened
  }, 10000);

  it("gets no drawn starts after a skip, under reduced motion, or for a new fixture's first scene", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let { targets } = await spies();
    let now = Date.now();
    const e1 = ev(1, now - 30000, "Pass");
    // Skip: the playhead leaps from 1 to 3 (resumed tab).
    await mount(view([e1, ev(2, now + 1000, "Two"), ev(3, now + 1100, "Three")], lineups(), now));
    vi.setSystemTime(now + 1100 + 1500 + 300);
    await wait(60);
    expect(targets().some((c) => c.seq === 3)).toBe(true);
    expect(targets().filter((c) => c.seq === 3).every((c) => c.starts === undefined)).toBe(true);
    cleanup();

    // Reduced motion: a contiguous 1 → 2 still gets none.
    const prev = window.matchMedia;
    window.matchMedia = reducedMotionList;
    try {
      ({ targets } = await spies());
      now = Date.now();
      await mount(view([ev(1, now - 30000, "Pass"), ev(2, now + 1000, "Two")], lineups(), now));
      vi.setSystemTime(now + 1000 + 1500 + 20);
      await wait(60);
      expect(targets().some((c) => c.seq === 2)).toBe(true);
      expect(targets().every((c) => c.starts === undefined)).toBe(true);
    } finally {
      window.matchMedia = prev;
    }
    cleanup();

    // Fixture switch: fx1 drawn on seq 1, fx2 opens on seq 2 — contiguous numbers, different match.
    ({ targets } = await spies());
    now = Date.now();
    const { footfiveApi } = await import("../lib/pocketbase");
    const { default: MatchPage } = await import("./MatchPage");
    vi.mocked(footfiveApi.match).mockImplementation(async (id: string) => {
      const v = view(id === "fx1" ? [ev(1, now - 3000, "One")] : [ev(1, now - 60000, "Old"), ev(2, now - 2000, "Two")], lineups(), now);
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
    await wait(40);
    const switchedAt = targets().length;
    await act(async () => {
      fireEvent.click(screen.getByText("Switch fixture"));
    });
    await wait(60);
    expect(screen.getByTestId("commentary").textContent).toBe("Two");
    const fx2 = targets(switchedAt).filter((c) => c.seq === 2);
    expect(fx2.length).toBeGreaterThan(0);
    expect(fx2.every((c) => c.starts === undefined)).toBe(true);
  }, 10000);

  it("a replay never inherits live starts — same seq, a second replay, or back to live", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const realNow = performance.now.bind(performance);
    let extra = 0;
    const perf = vi.spyOn(performance, "now").mockImplementation(() => realNow() + extra);
    try {
      const { targets } = await spies();
      const { sceneFor } = await import("../domain/scenes");
      const now = Date.now();
      const one = { ...st!, sc: [1, 0] as [number, number] };
      const two = { ...st!, sc: [2, 0] as [number, number] };
      const g1 = { ...ev(1, now - 60000, "GOAL ONE"), t: "goal", target: [100, 32] as [number, number], st: one };
      const g2 = { ...ev(2, now + 1000, "GOAL TWO"), t: "goal", target: [100, 32] as [number, number], st: two };
      const ms = sceneFor(g2, [55, 35], 15000)!.ms;
      await mount(view([g1, g2], lineups(), now));
      // Live 1 → 2 is contiguous: the live scene gets its drawn starts (control).
      vi.setSystemTime(now + 1000 + 1500 + 20);
      await wait(60);
      const live = targets().filter((c) => c.seq === 2);
      expect(live.length).toBeGreaterThan(0);
      expect(live.every((c) => c.starts !== undefined && c.starts === live[0].starts)).toBe(true);
      vi.setSystemTime(now + 1000 + 1500 + ms + 500);
      await wait(60);
      // Replay the very scene on the pitch (same seq): none.
      let from = targets().length;
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Replay: GOAL TWO"));
      });
      expect(screen.getByText("Replay")).toBeTruthy();
      extra += 200;
      await wait(60);
      expect(targets(from).length).toBeGreaterThan(0);
      expect(targets(from).every((c) => c.seq === 2 && c.starts === undefined)).toBe(true);
      // A second replay straight after (seq 1, contiguous number): none.
      from = targets().length;
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Replay: GOAL ONE"));
      });
      extra += 200;
      await wait(60);
      expect(targets(from).length).toBeGreaterThan(0);
      expect(targets(from).every((c) => c.seq === 1 && c.starts === undefined)).toBe(true);
      // Replay over: the live scene is picked up again without starts.
      from = targets().length;
      extra += 60000;
      await wait(80);
      expect(screen.queryByText("Replay")).toBeNull();
      const back = targets(from).filter((c) => c.seq === 2);
      expect(back.length).toBeGreaterThan(0);
      expect(back.every((c) => c.starts === undefined)).toBe(true);
    } finally {
      perf.mockRestore();
    }
  }, 10000);
});

describe("MatchPage big moments (#206)", () => {
  const LAG = 1500;
  afterEach(async () => {
    vi.useRealTimers();
    h.live = null;
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
  });
  /** A goal's run of events as the engine publishes it (goal, celebration 3.15 s on, restart 9 s on), the clock running for readability. */
  const goalRun = (G: number) => {
    const timed = (s: number, sc: [number, number]) => ({ ...st!, sc, clk: { s, run: 1 as const } }) as NonNullable<MatchView["fixture"]["st"]>;
    return [
      { ...ev(1, G - 2000, "Build-up"), t: "pass", chain: 1, st: timed(600, [0, 0]) },
      { ...ev(2, G - 480, "Shoots!"), t: "shot", chain: 1, ball: [85, 32] as [number, number], from: null, st: timed(602, [0, 0]) },
      { ...ev(3, G, "GOAL! Home P3 scores"), t: "goal", chain: 1, min: 11, p: "Home P3", target: [100, 32] as [number, number], major: 1, st: timed(602, [1, 0]) },
      { ...ev(4, G + 3150, "Home P3 wheels away"), t: "celebration", chain: 1, p: "Home P3", st: timed(605, [1, 0]) },
      { ...ev(5, G + 9000, "Away restart from the centre"), t: "restart", side: "away" as const, ball: [50, 32] as [number, number], st: timed(611, [1, 0]) },
    ] as MatchEvent[];
  };
  const paced = (events: MatchEvent[], now: number) => {
    const v = view(events, { home: names("Home"), away: names("Away") }, now);
    v.fixture = { ...v.fixture, minuteMs: 60000 }; // one match second per real second
    return v;
  };
  const withClock = async (body: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const live = await import("../lib/live");
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
    try {
      await body();
    } finally {
      serverClock.mockRestore();
    }
  };
  /** Jump the lagged playhead to `t` (over a second: the pitch clock snaps, as for a resumed tab, so this is never a catch-up). */
  const playheadAt = async (t: number) => {
    vi.setSystemTime(t + LAG);
    await act(() => new Promise((r) => setTimeout(r, 40)));
  };
  const clock = () => screen.getByLabelText("Match clock").textContent;

  it("shows the goal screen with scorer, minute and score on the reveal tick, with or without a replay to follow", async () => {
    await withClock(async () => {
      const G = Date.now() - LAG - 0.35 * 3800; // just past the ball crossing the line (p = 0.25 of the 3.8 s goal at this pace)
      await mount(paced(goalRun(G), Date.now()));
      const banner = screen.getByTestId("goal-banner");
      expect(banner).toHaveTextContent("GOOOAL!");
      expect(screen.getByTestId("banner-sub")).toHaveTextContent("HOM 1–0 AWA");
      expect(screen.getByTestId("banner-who")).toHaveTextContent("Home P3 · 11′");
      expect(screen.queryByText("Replay")).toBeNull(); // nothing delays or replaces it
      expect(screen.getByTestId("match-score").textContent).toBe("1–0");
    });
  });

  it("replays the move during the pause after the goal; the clock and playhead run on at real pace and the restart ends it", async () => {
    await withClock(async () => {
      const G = Date.now() - 60000;
      vi.setSystemTime(G + 3150 + 600 + 400 + LAG);
      await mount(paced(goalRun(G), Date.now()));
      // the celebration has had its moment: the replay of the move is on, captioned with the goal, the big screen gives way to it
      expect(screen.getByText("Replay")).toBeTruthy();
      expect(screen.getByTestId("commentary")).toHaveTextContent("GOAL! Home P3 scores");
      expect(screen.queryByTestId("goal-banner")).toBeNull();
      expect(screen.getByTestId("match-score").textContent).toBe("1–0");
      const c0 = clock();
      expect(c0).toBe("10:06"); // 605 s at the celebration + 1 s of play: the live clock, not the replay's
      await playheadAt(G + 3150 + 600 + 2400);
      expect(screen.getByText("Replay")).toBeTruthy();
      expect(clock()).toBe("10:08");
      // the restart is due: the replay is cut, live play resumes on its own time
      await playheadAt(G + 9000 + 200);
      expect(screen.queryByText("Replay")).toBeNull();
      expect(screen.getByTestId("commentary")).toHaveTextContent("Away restart from the centre");
      expect(clock()).toBe("10:11");
    });
  }, 10000);

  it("a restart later than the replay's hold brings back no second goal screen and no second cheer", async () => {
    await withClock(async () => {
      const G = Date.now() - 60000;
      const late = goalRun(G).map((e) => (e.t === "restart" ? { ...e, at: G + 3150 + 20000 } : e)); // published long after the replay
      vi.setSystemTime(G + 3150 + 300 + LAG);
      await mount(paced(late, Date.now()));
      expect(screen.getByTestId("goal-banner")).toBeTruthy(); // the celebration's own moment
      await playheadAt(G + 3150 + 600 + 1000);
      expect(screen.getByText("Replay")).toBeTruthy();
      const stand = screen.getByTestId("home-crowd");
      expect(stand.classList.contains("cheer")).toBe(false);
      // past the replay and its hold (no next event known when it was planned), still on the celebration
      for (const t of [G + 3150 + 600 + 5000 + 1500 + 200, G + 3150 + 12000]) {
        await playheadAt(t);
        expect(screen.queryByText("Replay")).toBeNull();
        expect(screen.queryByTestId("goal-banner")).toBeNull();
        expect(screen.getByText("GOAL!")).toBeTruthy(); // the chip, as during the replay
        expect(screen.getByTestId("home-crowd")).toBe(stand); // the Crowd cue is unchanged: no restarted cheer
        expect(stand.classList.contains("cheer")).toBe(false);
      }
      expect(screen.getByTestId("match-score").textContent).toBe("1–0");
    });
  }, 10000);

  it("skips the replay when the restart is due too soon, and under reduced motion", async () => {
    await withClock(async () => {
      const G = Date.now() - 60000;
      const soon = goalRun(G).map((e) => (e.t === "restart" ? { ...e, at: G + 3150 + 600 + 1200 } : e));
      vi.setSystemTime(G + 3150 + 600 + 300 + LAG);
      await mount(paced(soon, Date.now()));
      expect(screen.queryByText("Replay")).toBeNull();
      expect(screen.getByTestId("commentary")).toHaveTextContent("Home P3 wheels away");
    });
    cleanup();
    const prev = window.matchMedia;
    window.matchMedia = reducedMotionList;
    try {
      const G = Date.now() - 1500 - 3150 - 1000;
      await mount(paced(goalRun(G), Date.now()));
      expect(screen.queryByText("Replay")).toBeNull();
    } finally {
      window.matchMedia = prev;
    }
  });

  it("skips the replay of a goal that arrives in a late batch and is fast-forwarded", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // real rAF and poll interval, frozen server clock
    const now = Date.now();
    const target = now - LAG;
    const run = goalRun(target - 3150 - 800); // caught up, the playhead sits 200 ms into the replay window
    const { footfiveApi } = await import("../lib/pocketbase");
    const match = vi.mocked(footfiveApi.match).mockReset();
    match.mockResolvedValueOnce(view([ev(1, now - 30000, "Old pass")], null, now));
    match.mockResolvedValue(view(run.slice(1), null, now)); // shot, goal, celebration, restart: published late
    await mount();
    await act(() => new Promise((r) => setTimeout(r, MATCH_POLL_MS + 100)));
    expect(screen.getByTestId("commentary")).toHaveTextContent("Shoots!"); // rewound to the first unshown event
    let replayed = false;
    for (let i = 0; i < 30; i++) {
      await act(() => new Promise((r) => setTimeout(r, 50)));
      replayed ||= !!screen.queryByText("Replay");
    }
    expect(screen.getByTestId("commentary")).toHaveTextContent("Home P3 wheels away"); // caught up, inside the window
    expect(replayed).toBe(false);
  }, 10000);

  it("flashes another match's score chip when it scores, from the round data already polled (no extra request)", async () => {
    const now = Date.now();
    const other = (sc: [number, number]) => ({ id: "fx2", home: team("North"), away: team("South"), st: { ...st!, sc } });
    h.live = { mode: "live", fixtures: [other([0, 0])], ticker: [] };
    await mount(view([ev(1, now - 30000, "Pass")], null, now));
    const { footfiveApi } = await import("../lib/pocketbase");
    const calls = vi.mocked(footfiveApi.match).mock.calls.length;
    expect(screen.getByTestId("other-score").textContent).toBe("0–0");
    expect(screen.getByTestId("other-score").hasAttribute("data-flash")).toBe(false);
    h.live = { mode: "live", fixtures: [other([1, 0])], ticker: [] };
    await act(() => new Promise((r) => setTimeout(r, 40))); // the next animation frame re-reads the round snapshot
    expect(screen.getByTestId("other-score").textContent).toBe("1–0");
    expect(screen.getByTestId("other-score").className).toContain("goal-flash");
    expect(vi.mocked(footfiveApi.match).mock.calls.length).toBe(calls);
  });

  it("marks a card on the match's timeline with the card itself", async () => {
    const now = Date.now();
    await mount(view([{ ...ev(1, now - 30000, "Yellow card — Away P2 (AWA)"), t: "yellow_card", side: "away" }, { ...ev(2, now - 20000, "Red card! Home P1 is sent off"), t: "red_card", major: 1 }], null, now));
    expect(screen.getAllByTestId("feed-card").map((c) => c.getAttribute("data-card"))).toEqual(["red", "yellow"]);
  });
});

describe("MatchPage scoreboard timeline (#207)", () => {
  afterEach(() => {
    h.live = null;
  });
  const at = (ph: string, sc: [number, number], s: number) => ({ ...st!, ph, sc, clk: { s, run: 1 as const } }) as NonNullable<MatchView["fixture"]["st"]>;
  const marks = () => screen.queryAllByTestId("timeline-mark").map((m) => [m.dataset.kind, m.dataset.side, Number(m.dataset.min), m.style.left]);

  it("marks each goal and card the pitch has shown at its minute, home above and away below, and none still ahead of the playhead", async () => {
    const now = Date.now();
    const events: MatchEvent[] = [
      { ...ev(1, now - 60000, "Yellow"), t: "yellow_card", side: "home", min: 9, st: at("first_half", [0, 0], 540) },
      { ...ev(2, now - 50000, "Goal"), t: "goal", side: "away", min: 18, st: at("first_half", [0, 1], 1080) },
      { ...ev(3, now - 40000, "Pen"), t: "penalty_goal", side: "home", min: 45, st: at("first_half", [1, 1], 2700) },
      { ...ev(4, now - 30000, "Red"), t: "red_card", side: "away", min: 72, st: at("second_half", [1, 1], 4320) },
      { ...ev(5, now - 20000, "Pass"), st: at("second_half", [1, 1], 4380) },
      { ...ev(6, now + 60000, "Future goal"), t: "goal", side: "home", min: 80, st: at("second_half", [2, 1], 4800) },
    ];
    await mount(view(events, null, now));
    const tl = screen.getByTestId("timeline");
    expect(screen.getByTestId("match-scoreboard").contains(tl)).toBe(true);
    expect(tl.dataset.total).toBe("90");
    expect(marks()).toEqual([
      ["yellow", "home", 9, "10%"],
      ["goal", "away", 18, "20%"],
      ["goal", "home", 45, "50%"],
      ["red", "away", 72, "80%"],
    ]);
    const [yellow, goal] = screen.getAllByTestId("timeline-mark");
    expect(yellow.className).toContain("top-0");
    expect(goal.className).toContain("bottom-0");
    expect(screen.queryByTestId("timeline-et")).toBeNull();
    // The current minute: the fill and its head follow the shown clock (73:00 → 73′), by transform only.
    const progress = screen.getByTestId("timeline-progress");
    expect(Number(progress.dataset.minute)).toBeGreaterThanOrEqual(73);
    expect(progress.style.transform).toMatch(/^scaleX\(0\.8[12]/);
    expect(tl.getAttribute("aria-label")).toContain("Red card AWA 72′");
    expect(tl.getAttribute("aria-label")).not.toContain("80′");
  });

  it("runs to 120 minutes once extra time is reached, keeps every marker, and fills to the end in a shootout", async () => {
    const now = Date.now();
    const events: MatchEvent[] = [
      { ...ev(1, now - 60000, "Goal"), t: "goal", side: "home", min: 30, st: at("first_half", [1, 0], 1800) },
      { ...ev(2, now - 50000, "Goal"), t: "goal", side: "away", min: 88, st: at("second_half", [1, 1], 5280) },
      { ...ev(3, now - 40000, "ET goal"), t: "goal", side: "home", min: 105, st: at("extra_time_1", [2, 1], 6300) },
      { ...ev(4, now - 30000, "ET goal"), t: "goal", side: "away", min: 118, st: at("extra_time_2", [2, 2], 7080) },
      { ...ev(5, now - 20000, "Shootout"), t: "shootout_start", side: undefined, min: 120, st: { ...at("shootout", [2, 2], 7200), so: null } },
    ];
    await mount(view(events, null, now));
    const tl = screen.getByTestId("timeline");
    expect(tl.dataset.total).toBe("120");
    expect(screen.getByTestId("timeline-et")).toBeTruthy();
    expect(marks()).toEqual([
      ["goal", "home", 30, "25%"],
      ["goal", "away", 88, `${(88 / 120) * 100}%`],
      ["goal", "home", 105, "87.5%"],
      ["goal", "away", 118, `${(118 / 120) * 100}%`],
    ]);
    expect(screen.getByTestId("timeline-progress").style.transform).toBe("scaleX(1.0000)");
    expect(screen.getByTestId("match-shootout-score").textContent).toBe("PENS");
    expect(screen.queryByLabelText("Match clock")).toBeNull();
  });

  it("the big clock is on the scoreboard, the only score display on the page, with no team colour beside score or clock", async () => {
    const now = Date.now();
    await mount(view([{ ...ev(1, now - 3000, "Pass"), st: at("second_half", [2, 1], 3000) }], { home: names("Home"), away: names("Away") }, now));
    const board = screen.getByTestId("match-scoreboard");
    expect(board.contains(screen.getByLabelText("Match clock"))).toBe(true);
    expect(screen.getByLabelText("Match clock").className).toContain("text-[28px]");
    expect(screen.getAllByTestId("match-score")).toHaveLength(1);
    expect(screen.queryByTestId("hud-score")).toBeNull();
    // Crests sit on the outer edges: the score's and the clock's neighbours are the divider and each other, never a badge.
    const score = screen.getByTestId("match-score");
    const clock = screen.getByTestId("match-clock");
    expect(score.parentElement!.querySelector("abbr")).toBeNull();
    expect(clock.querySelector("abbr")).toBeNull();
    for (const side of ["home", "away"]) {
      const team = screen.getByTestId(`score-team-${side}`);
      expect(team.firstElementChild!.querySelector("abbr")).toBeTruthy(); // DOM-first = outer edge (away is row-reversed)
    }
  });
});

describe("MatchPage dead time: break summaries and the pre-match walkout (#208)", () => {
  const LAG = 1500;
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.live = null;
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.match).mockReset();
  });
  type St = NonNullable<MatchView["fixture"]["st"]>;
  const stat = (ph: string, sc: [number, number], s: number, x: [number[], number[]], run: 0 | 1 = 1) => ({ ...st!, ph, sc, pos: 47, x, clk: { s, run } }) as St;
  const X = (h: number[], a: number[]): [number[], number[]] => [[...h, 0, 0, 0, 0, 0, 0, 0].slice(0, 8), [...a, 0, 0, 0, 0, 0, 0, 0].slice(0, 8)];
  /** A first half as the engine publishes it (a saved shot, a goal, a booking), the 30 s break, and a second half that is already
   * published but still ahead of the lagged pitch. */
  const match = (HT: number) => {
    const fh = (s: number, sc: [number, number], x: [number[], number[]]) => stat("first_half", sc, s, x);
    return [
      { ...ev(1, HT - 60000, "Kick-off!"), t: "kickoff", st: fh(0, [0, 0], X([], [])) },
      { ...ev(2, HT - 50000, "Home P3 shoots!"), t: "shot", chain: 2, p: "Home P3", ball: [84, 30], from: null, min: 10, st: fh(600, [0, 0], X([1], [])) },
      { ...ev(3, HT - 49520, "Saved by Away P0"), t: "save", side: "away", chain: 2, p: "Away P0", p2: "Home P3", ball: [96, 31], min: 10, st: fh(600, [0, 0], X([1, 1], [0, 0, 1])) },
      { ...ev(4, HT - 40000, "Away P4 shoots!"), t: "shot", side: "away", chain: 4, p: "Away P4", ball: [18, 36], from: null, min: 20, st: fh(1200, [0, 0], X([1, 1], [1, 0, 1])) },
      { ...ev(5, HT - 39520, "GOAL! Away P4 scores"), t: "goal", side: "away", chain: 4, p: "Away P4", p2: "Home P0", target: [0, 32], ball: [0, 32], major: 1, min: 20, st: fh(1200, [0, 1], X([1, 1], [1, 1, 1])) },
      { ...ev(6, HT - 36000, "Away P4 wheels away"), t: "celebration", side: "away", chain: 4, p: "Away P4", min: 20, st: fh(1203, [0, 1], X([1, 1], [1, 1, 1])) },
      { ...ev(7, HT - 30000, "Home restart"), t: "restart", ball: [50, 32], min: 21, st: fh(1260, [0, 1], X([1, 1], [1, 1, 1])) },
      { ...ev(8, HT - 20000, "Booked: Home P2"), t: "yellow_card", p: "Home P2", min: 40, st: fh(2400, [0, 1], X([1, 1, 0, 0, 1, 1], [1, 1, 1])) },
      { ...ev(9, HT, "Half-time: HOM 0–1 AWA"), t: "half_time", side: undefined, min: 45, st: stat("half_time", [0, 1], 2700, X([1, 1, 0, 0, 1, 1], [1, 1, 1]), 0) },
      { ...ev(10, HT + 30000, "Second half under way"), t: "second_half", side: "away", ball: [50, 32], min: 45, st: stat("second_half", [0, 1], 2700, X([1, 1, 0, 0, 1, 1], [1, 1, 1])) },
      { ...ev(11, HT + 40000, "Home P4 shoots!"), t: "shot", chain: 11, p: "Home P4", ball: [86, 34], from: null, min: 50, st: stat("second_half", [0, 1], 3000, X([2, 1, 0, 0, 1, 1], [1, 1, 1])) },
      { ...ev(12, HT + 40480, "GOAL! Home P4 scores"), t: "goal", chain: 11, p: "Home P4", p2: "Away P0", target: [100, 32], ball: [100, 32], major: 1, min: 50, st: stat("second_half", [1, 1], 3000, X([2, 2, 0, 0, 1, 1], [1, 1, 1])) },
    ] as MatchEvent[];
  };
  const paced = (events: MatchEvent[], now: number, fixture: Partial<MatchView["fixture"]> = {}) => {
    const v = view(events, { home: names("Home"), away: names("Away") }, now);
    v.fixture = { ...v.fixture, minuteMs: 6000, ...fixture };
    return v;
  };
  const withClock = async (body: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const live = await import("../lib/live");
    const serverClock = vi.spyOn(live, "serverNow").mockImplementation(() => Date.now());
    try {
      await body();
    } finally {
      serverClock.mockRestore();
    }
  };
  /** Jump the lagged playhead to `t` (over a second: the pitch clock snaps, as for a resumed tab, so this is never a catch-up). */
  const playheadAt = async (t: number) => {
    vi.setSystemTime(t + LAG);
    await act(() => new Promise((r) => setTimeout(r, 40)));
  };
  const shownCard = () => screen.getAllByTestId("break-card").filter((c) => c.hasAttribute("data-n")).map((c) => c.dataset.card);
  const wideCards = () => screen.getAllByTestId("break-card").filter((c) => c.hasAttribute("data-w")).map((c) => c.dataset.card);

  it("keeps the large half-time banner to itself for 5 s, then docks it over a summary of the half that runs through its four cards", async () => {
    await withClock(async () => {
      const HT = Date.now() - 60000;
      vi.setSystemTime(HT + 3000 + LAG);
      await mount(paced(match(HT), Date.now()));
      const banner = screen.getByTestId("period-banner");
      expect(banner).toHaveTextContent("HALF-TIME · HOM 0–1 AWA");
      expect(banner.hasAttribute("data-docked")).toBe(false);
      expect(screen.queryByTestId("break-summary")).toBeNull();
      await playheadAt(HT + 5500);
      const summary = screen.getByTestId("break-summary");
      expect(summary.dataset.kind).toBe("ht");
      expect(screen.getByTestId("pitch").contains(summary)).toBe(true);
      expect(screen.getByTestId("period-banner")).toHaveTextContent("HALF-TIME · HOM 0–1 AWA");
      expect(screen.getByTestId("period-banner").hasAttribute("data-docked")).toBe(true);
      expect(shownCard()).toEqual(["stats"]);
      expect(wideCards()).toEqual(["stats", "shots"]);
      // The half-time snapshot's statistics, as the scoreboard and the Statistics panel show them.
      const row = (name: string) => within(screen.getByTestId("break-stats")).getAllByTestId("break-stat").find((r) => r.dataset.stat === name)!.textContent;
      expect(row("Shots")).toBe("1Shots1");
      expect(row("Saves")).toBe("0Saves1");
      expect(row("Yellow cards")).toBe("1Yellow cards0");
      expect(screen.getByTestId("break-stats")).toHaveTextContent("47%");
      await playheadAt(HT + 11500);
      expect(shownCard()).toEqual(["shots"]);
      expect(screen.getAllByTestId("shot-dot").map((d) => [d.dataset.side, d.dataset.result])).toEqual([["home", "save"], ["away", "goal"]]);
      await playheadAt(HT + 17500);
      expect(shownCard()).toEqual(["goals"]);
      expect(wideCards()).toEqual(["goals", "players"]);
      expect(screen.getAllByTestId("break-goal").map((g) => g.textContent)).toEqual(["20′AWAAway P40–1"]);
      await playheadAt(HT + 23500);
      expect(shownCard()).toEqual(["players"]);
      expect(screen.getAllByTestId("break-top-player")[0]).toHaveTextContent("Away P4");
      // The restart ends it: the second half's banner is on the pitch.
      await playheadAt(HT + 30500);
      expect(screen.queryByTestId("break-summary")).toBeNull();
      expect(screen.getByTestId("period-banner")).toHaveTextContent("SECOND HALF");
    });
  }, 15000);

  it("never shows what the pitch has not reached: a second-half goal already published stays out of the half-time summary", async () => {
    await withClock(async () => {
      const HT = Date.now() - 60000;
      vi.setSystemTime(HT + 20000 + LAG);
      await mount(paced(match(HT), Date.now()));
      expect(screen.getAllByTestId("break-goal")).toHaveLength(1);
      expect(screen.getByTestId("break-summary")).not.toHaveTextContent("Home P4");
      expect(screen.getAllByTestId("shot-dot")).toHaveLength(2);
      expect(screen.getByTestId("match-score").textContent).toBe("0–1");
    });
  });

  it("joining in the middle of the break lands on the card for that moment straight away; a dot picks a card by hand", async () => {
    await withClock(async () => {
      const HT = Date.now() - 60000;
      vi.setSystemTime(HT + 18000 + LAG);
      await mount(paced(match(HT), Date.now()));
      expect(shownCard()).toEqual(["goals"]);
      fireEvent.click(screen.getByRole("button", { name: "Show shot map" }));
      expect(shownCard()).toEqual(["shots"]);
      await playheadAt(HT + 25000);
      expect(shownCard()).toEqual(["shots"]); // held for the rest of this break
    });
  });

  it("makes no request of its own: the cards turn over without a fetch or an extra match poll", async () => {
    await withClock(async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const HT = Date.now() - 60000;
      vi.setSystemTime(HT + 5500 + LAG);
      await mount(paced(match(HT), Date.now()));
      const { footfiveApi } = await import("../lib/pocketbase");
      const calls = vi.mocked(footfiveApi.match).mock.calls.length;
      for (const t of [11500, 17500, 23500]) await playheadAt(HT + t);
      expect(vi.mocked(footfiveApi.match).mock.calls.length).toBe(calls);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("full time: the FULL-TIME banner first, then the summary under it, with the auto-return still counting down", async () => {
    await withClock(async () => {
      const HT = Date.now() - 200000;
      const FT = HT + 60000;
      const end = { ...ev(13, FT, "Full-time: HOM 1–1 AWA"), t: "match_end", side: "home" as const, min: 90, st: { ...stat("finished", [2, 1], 5400, X([2, 2], [1, 1, 1]), 0), win: "home", by: "normal" } as St };
      const events = [...match(HT).slice(0, 10), end];
      vi.setSystemTime(FT + 3000 + LAG);
      await mount(paced(events, Date.now(), { status: "finished", st: end.st }));
      expect(screen.getByTestId("ft-banner").hasAttribute("data-docked")).toBe(false);
      expect(screen.queryByTestId("break-summary")).toBeNull();
      expect(screen.getByTestId("auto-return")).toBeTruthy();
      await playheadAt(FT + 6000);
      expect(screen.getByTestId("break-summary").dataset.kind).toBe("ft");
      expect(screen.getByTestId("ft-banner")).toHaveTextContent("FULL-TIME");
      expect(screen.getByTestId("ft-banner").hasAttribute("data-docked")).toBe(true);
      expect(screen.getByTestId("auto-return")).toHaveTextContent("tap to stay");
      // Full time holds: the cards go round again.
      await playheadAt(FT + 5000 + 4 * 6000 + 500);
      expect(shownCard()).toEqual(["stats"]);
    });
  });

  it("extra time: the break after 90 minutes gets a summary; the extra-time half-time and the shootout keep just their banners", async () => {
    await withClock(async () => {
      const E = Date.now() - 100000;
      const level = stat("et_break", [1, 1], 5400, X([3, 2], [2, 1]), 0);
      const events = [
        { ...ev(1, E - 10000, "Goal"), t: "goal", min: 80, p: "Home P4", st: stat("second_half", [1, 1], 4800, X([3, 2], [2, 1])) },
        { ...ev(2, E, "90 minutes up"), t: "end_of_normal_time", side: undefined, min: 90, st: level },
        { ...ev(3, E + 20000, "Extra time"), t: "extra_time", min: 90, st: stat("extra_time_1", [1, 1], 5400, X([3, 2], [2, 1])) },
        { ...ev(4, E + 40000, "ET half-time"), t: "et_half_time", side: undefined, min: 105, st: stat("et_half_time", [1, 1], 6300, X([3, 2], [2, 1]), 0) },
        { ...ev(5, E + 50000, "ET second half"), t: "et_second_half", min: 105, st: stat("extra_time_2", [1, 1], 6300, X([3, 2], [2, 1])) },
      ] as MatchEvent[];
      vi.setSystemTime(E + 8000 + LAG);
      await mount(paced(events, Date.now()));
      expect(screen.getByTestId("break-summary").dataset.kind).toBe("et");
      expect(screen.getByTestId("period-banner")).toHaveTextContent("FULL-TIME · 1–1 · EXTRA TIME");
      await playheadAt(E + 19500);
      expect(screen.getByTestId("break-summary")).toBeTruthy();
      await playheadAt(E + 40000 + 8000);
      expect(screen.queryByTestId("break-summary")).toBeNull();
      expect(screen.getByTestId("period-banner")).toHaveTextContent("ET HALF-TIME");
    });
  });

  it("under reduced motion the summary still comes, headed by the half-time title", async () => {
    const prev = window.matchMedia;
    window.matchMedia = reducedMotionList;
    try {
      await withClock(async () => {
        const HT = Date.now() - 60000;
        vi.setSystemTime(HT + 8000 + LAG);
        await mount(paced(match(HT), Date.now()));
        expect(screen.getByTestId("break-summary")).toBeTruthy();
        expect(screen.getByTestId("period-banner")).toHaveTextContent("HALF-TIME · HOM 0–1 AWA");
      });
    } finally {
      window.matchMedia = prev;
    }
  });

  it("a late batch fast-forwarded through half-time shows no summary until the pitch has caught up, then the right card", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // real rAF and poll interval, frozen server clock
    const now = Date.now();
    const target = now - LAG;
    const HT = target - 20000; // caught up, the playhead is 20 s into the break
    const run = match(HT);
    // The booking 4 s before the break: 24 s behind, inside the fast-forward range (CATCHUP_MAX_MS), so it is played through.
    const all = [...run.slice(0, 7), { ...run[7], at: HT - 4000 }, run[8]];
    const { footfiveApi } = await import("../lib/pocketbase");
    const m = vi.mocked(footfiveApi.match).mockReset();
    m.mockResolvedValueOnce(paced(all.slice(0, 7), now)); // up to the restart
    m.mockResolvedValue(paced(all, now)); // the booking and half-time: published late
    await mount();
    await act(() => new Promise((r) => setTimeout(r, MATCH_POLL_MS + 100)));
    expect(screen.queryByTestId("period-banner")).toBeNull(); // rewound to the booking, not snapped to the break
    // Unchecked, the summary would be up once the fast-forwarded clock is 5 s into the break (about 2.4 s from here); the catch-up
    // itself takes about 7 s.
    let early = false;
    for (let i = 0; i < 80; i++) {
      await act(() => new Promise((r) => setTimeout(r, 50)));
      early ||= !!screen.queryByTestId("break-summary");
    }
    expect(early, "no summary while the late batch is fast-forwarded").toBe(false);
    await waitFor(() => expect(screen.getByTestId("break-summary")).toBeTruthy(), { timeout: 10000 });
    expect(shownCard()).toEqual(["goals"]);
  }, 25000);

  it("before kick-off the line-ups walk out onto the pitch, and stay until the kick-off is on the (lagged) pitch", async () => {
    const now = Date.now();
    const pre = paced([], now, { status: "scheduled", st: null, kickoffAt: now + 60000 } as Partial<MatchView["fixture"]>);
    await mount(pre);
    const over = screen.getByTestId("prematch");
    expect(screen.getByTestId("pitch").contains(over)).toBe(true);
    expect(screen.getAllByTestId("prematch-player")).toHaveLength(10);
    expect(screen.getAllByTestId("prematch-player").filter((p) => p.dataset.side === "home")).toHaveLength(5);
    expect(screen.getByTestId("prematch-title")).toHaveTextContent("LINE-UPS · HOM v AWA");
    expect(over).toHaveTextContent("P0"); // names, last word (as on the pitch)
    expect(screen.queryAllByTestId("player")).toHaveLength(0);
    cleanup();
    // Kick-off published but still inside the pitch's lag: the walkout stays.
    const kick = { ...ev(1, now - 500, "Kick-off!"), t: "kickoff" } as MatchEvent;
    await mount(paced([kick], now));
    expect(screen.getByTestId("prematch")).toBeTruthy();
    cleanup();
    // On the pitch: the walkout is gone and the match's own players are drawn.
    await mount(paced([{ ...kick, at: now - 3000 }], now));
    expect(screen.queryByTestId("prematch")).toBeNull();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
  });

  it("no walkout without line-ups, with highlights off, or after the match", async () => {
    const now = Date.now();
    const pre = paced([], now, { status: "scheduled", st: null } as Partial<MatchView["fixture"]>);
    await mount({ ...pre, lineups: null });
    expect(screen.queryByTestId("prematch")).toBeNull();
    cleanup();
    mem.set("ff_highlights", "off");
    try {
      await mount(pre);
      expect(screen.queryByTestId("prematch")).toBeNull();
    } finally {
      mem.delete("ff_highlights");
    }
    cleanup();
    await mount(paced([], now, { status: "finished", st: { ...st!, ph: "finished", win: "home", by: "normal" } as St }));
    expect(screen.queryByTestId("prematch")).toBeNull();
  });
});
