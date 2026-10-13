import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixtureMarkets } from "../lib/pocketbase";

vi.mock("./BetSlip", () => ({ useSlip: () => ({ pick: null, setPick: () => {} }) }));
vi.mock("../lib/pocketbase", async (orig) => ({
  ...(await orig<typeof import("../lib/pocketbase")>()),
  footfiveApi: { fixtureMarkets: vi.fn() },
}));

const markets = {
  state: { closed: "" },
  markets: [{ key: "winner", title: "Match winner", rules: "90 mins", sel: [{ id: "home", label: "Home", short: "H", odds: 2.1 }] }],
} as unknown as FixtureMarkets;

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

  it("shows the bare error only when nothing has loaded", async () => {
    const { footfiveApi } = await import("../lib/pocketbase");
    vi.mocked(footfiveApi.fixtureMarkets).mockReset().mockRejectedValue(new Error("Markets down"));
    const { default: MarketsPanel } = await import("./MarketsPanel");
    render(<MarketsPanel fixtureId="fx1" seq={1} fixtureLabel="A v B" />);
    expect(await screen.findByText("Markets down")).toBeInTheDocument();
    expect(screen.queryByTestId("markets")).toBeNull();
  });
});
