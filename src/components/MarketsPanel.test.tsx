import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixtureMarkets, Market } from "../lib/pocketbase";
import { NO_CURRENT_PRICE, NOT_OFFERED, UNOFFERED_HINT } from "../lib/priceLabel";

const setPick = vi.hoisted(() => vi.fn());
vi.mock("./BetSlip", () => ({ useSlip: () => ({ pick: null, setPick }) }));
vi.mock("../lib/pocketbase", async (orig) => ({
  ...(await orig<typeof import("../lib/pocketbase")>()),
  footfiveApi: { fixtureMarkets: vi.fn() },
}));

const markets = {
  state: { closed: "" },
  markets: [{ key: "winner", title: "Match winner", rules: "90 mins", sel: [{ id: "home", label: "Home", short: "H", odds: 2.1 }] }],
} as unknown as FixtureMarkets;

const SUSPENDED = "Suspended \u2014 incident in progress";

function openRepro(closed: string | null = null): FixtureMarkets {
  const winner: Market = {
    key: "winner",
    title: "To qualify",
    rules: "Team that goes through, including extra time and penalties.",
    closed: null,
    sel: [
      { id: "home", label: "Home", short: "HOM", odds: 1.01 },
      { id: "away", label: "Orl", short: "ORL", odds: null },
    ],
  };
  const exact: Market = {
    key: "exact",
    title: "Exact score (after ET)",
    rules: "Final football score including extra time. Shootout goals do not count.",
    closed: null,
    sel: [{ id: "3-0", label: "HOM 3\u20130 ORL", short: "3\u20130", odds: 1.2 }],
  };
  return {
    serverTimeMs: 1,
    fixtureId: "fx1",
    seq: 80,
    state: { phase: "second_half", closed },
    blocked: null,
    markets: [winner, exact],
  };
}

describe("MarketsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps the last good markets when a refresh fails", async () => {
    vi.useFakeTimers();
    const { footfiveApi } = await import("../lib/pocketbase");
    const fetch = vi.mocked(footfiveApi.fixtureMarkets);
    fetch.mockReset().mockResolvedValueOnce(markets).mockRejectedValue(Object.assign(new Error("Too many requests — retry in a moment."), { status: 429 }));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="A v B" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId("odds-winner-home")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("odds-winner-home")).toBeInTheDocument();
    expect(screen.getByTestId("markets-stale")).toHaveTextContent("Couldn't refresh");
    expect(screen.queryByText(/Too many requests/)).toBeNull();
  });

  it("shows an open null as not offered and still accepts the priced exact score", async () => {
    setPick.mockClear();
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockResolvedValue(openRepro());
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="HOM v ORL" />);
    const away = await screen.findByTestId("odds-winner-away");
    const exact = screen.getByTestId("odds-exact-3-0");
    const home = screen.getByTestId("odds-winner-home");
    expect(away).toHaveTextContent(NOT_OFFERED);
    expect(away.textContent).not.toContain("\u2013");
    expect(away).toBeDisabled();
    expect(away).toHaveAccessibleName("Orl, Not offered");
    const hint = screen.getByTestId("unoffered-hint");
    expect(hint).toHaveTextContent(UNOFFERED_HINT);
    expect(away).toHaveAttribute("aria-describedby", hint.id);
    expect(home).not.toHaveAttribute("aria-describedby");
    expect(exact).not.toHaveAttribute("aria-describedby");
    fireEvent.click(away);
    expect(setPick).not.toHaveBeenCalled();
    expect(screen.queryByTestId("markets-suspended")).toBeNull();
    expect(screen.queryByText(/Suspended/)).toBeNull();
    expect(home).toBeEnabled();
    expect(home).toHaveTextContent("1.01");
    expect(exact).toBeEnabled();
    expect(exact).toHaveTextContent("1.20");
    expect(screen.getByText("Team that goes through, including extra time and penalties.")).toBeInTheDocument();
    expect(screen.getByText("Final football score including extra time. Shootout goals do not count.")).toBeInTheDocument();
    fireEvent.click(exact);
    expect(setPick).toHaveBeenCalledTimes(1);
    expect(setPick).toHaveBeenCalledWith(
      expect.objectContaining({
        market: "exact",
        marketTitle: "Exact score (after ET)",
        rules: "Final football score including extra time. Shootout goals do not count.",
        fixtureId: "fx1",
        fixtureLabel: "HOM v ORL",
        selection: "3-0",
        label: "HOM 3\u20130 ORL",
        odds: 1.2,
      }),
    );
  });

  it("keeps a suspended market on its reason and does not call a null below the floor", async () => {
    setPick.mockClear();
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockResolvedValue(openRepro(SUSPENDED));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="HOM v ORL" />);
    expect(await screen.findByTestId("markets-suspended")).toHaveTextContent(SUSPENDED);
    const away = screen.getByTestId("odds-winner-away");
    const exact = screen.getByTestId("odds-exact-3-0");
    const home = screen.getByTestId("odds-winner-home");
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(UNOFFERED_HINT)).toBeNull();
    expect(screen.queryByTestId("unoffered-hint")).toBeNull();
    expect(away).toHaveTextContent(NO_CURRENT_PRICE);
    expect(away).toBeDisabled();
    expect(away).not.toHaveAttribute("aria-label");
    expect(home).toHaveTextContent("1.01");
    expect(home).toBeDisabled();
    expect(exact).toHaveTextContent("1.20");
    expect(exact).toBeDisabled();
    fireEvent.click(exact);
    fireEvent.click(home);
    fireEvent.click(away);
    expect(setPick).not.toHaveBeenCalled();
  });

  it("a selection withdrawn on a refresh turns unavailable in place: same button, not offered, cannot be picked (#203)", async () => {
    vi.useFakeTimers();
    setPick.mockClear();
    const priced = openRepro();
    const withdrawn = openRepro();
    const [home, away] = priced.markets[0].sel!;
    priced.markets[0] = { ...priced.markets[0], sel: [home, { ...away, odds: 1.06 }] };
    withdrawn.markets[0] = { ...withdrawn.markets[0], sel: [home, { ...away, odds: null }] };
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockResolvedValueOnce(priced).mockResolvedValue(withdrawn);
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="HOM v ORL" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const before = screen.getByTestId("odds-winner-away");
    expect(before).toHaveTextContent("1.06");
    expect(before).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const after = screen.getByTestId("odds-winner-away");
    expect(after).toBe(before); // the same node: nothing is removed or re-laid out around it
    expect(after).toBeDisabled();
    expect(after).toHaveTextContent(NOT_OFFERED);
    expect(after).toHaveAccessibleName("Orl, Not offered");
    // #207 (deferred #203 finding): the explanation is visible to sighted touch users too, inside the panel's reserved status
    // area, which already existed before the withdrawal (so the line costs no layout).
    const hint = screen.getByTestId("unoffered-hint");
    expect(hint).not.toHaveClass("sr-only");
    expect(hint).toHaveTextContent(UNOFFERED_HINT);
    expect(screen.getByTestId("markets-status").contains(hint)).toBe(true);
    expect(screen.getByTestId("markets-status")).toHaveClass("h-11");
    expect(after).toHaveAttribute("aria-describedby", hint.id);
    fireEvent.click(after);
    expect(setPick).not.toHaveBeenCalled();
  });

  it("holds the exact-score grid when a score is dropped in play: its cell stays as unavailable and no other price moves (#207)", async () => {
    vi.useFakeTimers();
    setPick.mockClear();
    const ids = ["0-3", "0-4", "0-5", "1-3", "1-4", "1-5", "2-3", "2-4"];
    const exact = (drop: string | null): FixtureMarkets => {
      const m = openRepro();
      m.markets[1] = { ...m.markets[1], sel: ids.filter((id) => id !== drop).map((id, i) => ({ id, label: `HOM ${id} ORL`, short: id.replace("-", "\u2013"), odds: 2 + i })) };
      return m;
    };
    const { footfiveApi } = await import("../lib/pocketbase");
    // markets.js drops a near-certain exact score from the list in play (it is not sent as a null).
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockResolvedValueOnce(exact(null)).mockResolvedValue(exact("0-3"));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="HOM v ORL" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const grid = screen.getByTestId("exact-grid");
    const cellIds = () => [...grid.children].map((c) => c.getAttribute("data-testid"));
    expect(grid.children).toHaveLength(36); // 6×6 from the lowest listed score: home 0–5 down, away 3–8 across
    const before = cellIds();
    expect(before.slice(0, 6)).toEqual(["odds-exact-0-3", "odds-exact-0-4", "odds-exact-0-5", "exact-reserved", "exact-reserved", "exact-reserved"]);
    const kept = screen.getByTestId("odds-exact-2-4");
    const keptIndex = [...grid.children].indexOf(kept);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByTestId("odds-exact-0-3")).toBeNull();
    expect(grid.children).toHaveLength(36);
    expect(cellIds()).toEqual(["exact-reserved", ...before.slice(1)]);
    expect(screen.getByTestId("odds-exact-2-4")).toBe(kept);
    expect([...grid.children].indexOf(kept)).toBe(keptIndex);
    const hole = grid.children[0] as HTMLElement;
    expect(hole).toHaveAttribute("aria-hidden");
    expect(hole.tagName).toBe("DIV"); // not a button: it can never be picked
    expect(hole.title).toBe(`0\u20133: ${NOT_OFFERED}`);
    expect(screen.getByTestId("unoffered-hint")).toHaveTextContent(UNOFFERED_HINT);
    fireEvent.click(hole);
    expect(setPick).not.toHaveBeenCalled();
    fireEvent.click(kept);
    expect(setPick).toHaveBeenCalledWith(expect.objectContaining({ market: "exact", selection: "2-4", fixtureId: "fx1" }));
  });

  it("reports the suspension to its host and keeps it in the reserved status area (#207)", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockResolvedValue(openRepro(SUSPENDED));
    const onClosed = vi.fn();
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="HOM v ORL" onClosed={onClosed} />);
    const chip = await screen.findByTestId("markets-suspended");
    expect(chip).toHaveTextContent(SUSPENDED);
    expect(screen.getByTestId("markets-status").contains(chip)).toBe(true);
    expect(onClosed).toHaveBeenLastCalledWith(SUSPENDED);
  });

  it("shows the bare error only when nothing has loaded", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockRejectedValue(new Error("Markets down"));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="A v B" />);
    expect(await screen.findByText("Markets down")).toBeInTheDocument();
    expect(screen.queryByTestId("markets")).toBeNull();
  });
});
