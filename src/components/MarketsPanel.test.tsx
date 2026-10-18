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

  it("shows the bare error only when nothing has loaded", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockRejectedValue(new Error("Markets down"));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="A v B" />);
    expect(await screen.findByText("Markets down")).toBeInTheDocument();
    expect(screen.queryByTestId("markets")).toBeNull();
  });
});
