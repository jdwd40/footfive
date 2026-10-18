import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureCard as Fx, LiveView, Market, MyBets, TeamPublic, WideMarkets } from "../lib/pocketbase";
import { NO_CURRENT_PRICE, NOT_OFFERED, UNOFFERED_HINT } from "../lib/priceLabel";

const h = vi.hoisted(() => ({ setPick: vi.fn(), live: null as LiveView | null }));

vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../components/BetSlip", () => ({ useSlip: () => ({ pick: null, setPick: h.setPick, placed: 0, setBalance: () => {}, balance: 0 }) }));
vi.mock("../lib/live", async (orig) => ({
  ...(await orig<typeof import("../lib/live")>()),
  useLive: () => ({ live: h.live, now: 0, stale: false }),
}));
vi.mock("../lib/polling", () => ({ startPolling: () => () => {} }));
vi.mock("../lib/pocketbase", async (orig) => {
  const m = await orig<typeof import("../lib/pocketbase")>();
  return { ...m, footfiveApi: { ...m.footfiveApi, myBets: vi.fn(), wideMarkets: vi.fn(), topUp: vi.fn() } };
});

import BettingPage from "./BettingPage";
import { footfiveApi } from "../lib/pocketbase";

const SUSPENDED = "Suspended \u2014 incident in progress";

const EMPTY_BETS: MyBets = {
  credits: 1000,
  bets: [],
  settledStaked: 0,
  settledReturned: 0,
  net: 0,
  topUp: { amount: 500, floor: 100, available: false, nextAt: null, rule: "Fictional test credits." },
};

function team(id: string, name: string, abbreviation: string): TeamPublic {
  return { id, name, abbreviation, grade: "B", primary_color: "#123456", secondary_color: "#abcdef", badge_key: id };
}

function card(over: Partial<Fx> = {}): Fx {
  const base: Fx = {
    id: "fx1",
    slot: "qf1",
    index: 0,
    home: team("home", "Home City", "HOM"),
    away: team("away", "Orlando", "ORL"),
    status: "live",
    kickoffAt: 0,
    minuteMs: 60_000,
    st: {
      sc: [3, 0],
      so: null,
      ph: "second_half",
      clk: { s: 4800, run: 1 },
      pos: 40,
      x: [[], []],
      d: 0,
      win: null,
      by: null,
    },
    at: 0,
    seq: 1,
    last: null,
    odds: { home: 1.01, away: null, closed: null },
  };
  return { ...base, ...over, st: over.st === undefined ? base.st : over.st };
}

function liveWith(fixtures: Fx[]): LiveView {
  return {
    serverTimeMs: 1,
    paused: false,
    timing: { betweenMs: 0, gapMs: 0, windowMs: 0, minuteMs: 60_000, betweenMinutes: 0, gapMinutes: 0, windowMinutes: 0, minuteSec: 60 },
    mode: "live",
    championship: null,
    round: { id: "r", key: "qf", label: "Quarter-final", status: "live", scheduledAt: 0, finishedAt: null },
    fixtures,
    bracket: [],
    ticker: [],
    champion: null,
    nextChampionshipAt: null,
  };
}

function wide(markets: Market[]): WideMarkets {
  return { serverTimeMs: 1, blocked: null, markets };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BettingPage />
    </MemoryRouter>,
  );
}

describe("BettingPage prices", () => {
  beforeEach(() => {
    h.setPick.mockReset();
    h.live = liveWith([]);
    vi.mocked(footfiveApi.myBets).mockReset().mockResolvedValue(EMPTY_BETS);
    vi.mocked(footfiveApi.wideMarkets).mockReset().mockResolvedValue(wide([]));
    vi.mocked(footfiveApi.topUp).mockReset();
  });

  afterEach(() => cleanup());

  it("labels fixture and wide nulls the same way and still prices the other side", async () => {
    h.live = liveWith([card()]);
    vi.mocked(footfiveApi.wideMarkets).mockResolvedValue(
      wide([
        {
          key: "champion",
          title: "Champion",
          rules: "The team that lifts the trophy.",
          sel: [
            { id: "csc", label: "Cascade", short: "CSC", odds: null },
            { id: "hom", label: "Home City", short: "HOM", odds: 2.5 },
          ],
        },
      ]),
    );
    renderPage();
    expect(await screen.findByText("1.01")).toBeInTheDocument();
    expect(screen.getAllByText(NOT_OFFERED)).toHaveLength(2);
    const hints = screen.getAllByTestId("unoffered-hint");
    expect(hints).toHaveLength(2);
    expect(hints[0].id).not.toBe(hints[1].id);
    expect(hints.every((el) => el.textContent === UNOFFERED_HINT)).toBe(true);

    const away = screen.getByRole("button", { name: "Orlando, Not offered" });
    const outsider = screen.getByRole("button", { name: "Cascade, Not offered" });
    expect(away).toBeDisabled();
    expect(outsider).toBeDisabled();
    expect(document.getElementById(away.getAttribute("aria-describedby") || "")).toHaveTextContent(UNOFFERED_HINT);
    expect(document.getElementById(outsider.getAttribute("aria-describedby") || "")).toHaveTextContent(UNOFFERED_HINT);
    expect(away.getAttribute("aria-describedby")).not.toBe(outsider.getAttribute("aria-describedby"));
    fireEvent.click(away);
    fireEvent.click(outsider);
    expect(h.setPick).not.toHaveBeenCalled();
    expect(screen.queryByText(/Suspended/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^HOM\s*1\.01$/ }));
    expect(h.setPick).toHaveBeenCalledWith(
      expect.objectContaining({ market: "winner", selection: "home", odds: 1.01, fixtureId: "fx1", label: "Home City" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^HOM\s*2\.50$/ }));
    expect(h.setPick).toHaveBeenCalledWith(
      expect.objectContaining({ market: "champion", selection: "hom", odds: 2.5, label: "Home City" }),
    );
    expect(await screen.findByTestId("topup")).toBeDisabled();
  });

  it("keeps a closed fixture on its reason and disables the priced side", async () => {
    h.live = liveWith([card({ odds: { home: 1.5, away: null, closed: SUSPENDED } })]);
    renderPage();
    const reason = await screen.findByText(SUSPENDED);
    const row = reason.parentElement as HTMLElement;
    const priced = within(row).getByRole("button", { name: /1\.50/ });
    expect(priced).toBeDisabled();
    expect(within(row).getByText(NO_CURRENT_PRICE)).toBeInTheDocument();
    expect(within(row).queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(UNOFFERED_HINT)).toBeNull();
    expect(screen.queryByTestId("unoffered-hint")).toBeNull();
    fireEvent.click(priced);
    fireEvent.click(within(row).getByRole("button", { name: /No current price/ }));
    expect(h.setPick).not.toHaveBeenCalled();
  });

  it("closes a wide market that still has a price and a null selection", async () => {
    vi.mocked(footfiveApi.wideMarkets).mockResolvedValue(
      wide([
        {
          key: "champion",
          title: "Champion",
          rules: "The team that lifts the trophy.",
          closed: SUSPENDED,
          sel: [
            { id: "csc", label: "Cascade", short: "CSC", odds: null },
            { id: "hom", label: "Home City", short: "HOM", odds: 2.5 },
          ],
        },
      ]),
    );
    renderPage();
    const reason = await screen.findByText(SUSPENDED);
    const block = reason.parentElement as HTMLElement;
    const priced = within(block).getByRole("button", { name: /2\.50/ });
    const missing = within(block).getByRole("button", { name: /No current price/ });
    expect(priced).toBeDisabled();
    expect(priced).toHaveTextContent("2.50");
    expect(missing).toBeDisabled();
    expect(missing).toHaveTextContent(NO_CURRENT_PRICE);
    expect(within(block).queryByText(NOT_OFFERED)).toBeNull();
    expect(within(block).queryByText(UNOFFERED_HINT)).toBeNull();
    expect(screen.queryByTestId("unoffered-hint")).toBeNull();
    expect(screen.queryByTestId("semis-add")).toBeNull();
    fireEvent.click(priced);
    fireEvent.click(missing);
    expect(h.setPick).not.toHaveBeenCalled();
  });

  it("keeps the semi-finalist price formula", async () => {
    vi.mocked(footfiveApi.wideMarkets).mockResolvedValue(
      wide([
        {
          key: "semis",
          title: "Semi-finalists",
          rules: "One team from each quarter.",
          quarters: [
            [{ id: "a", label: "Alpha", short: "ALP", p: 0.5 }],
            [{ id: "b", label: "Beta", short: "BET", p: 0.5 }],
            [{ id: "c", label: "Gamma", short: "GAM", p: 0.5 }],
            [{ id: "d", label: "Delta", short: "DEL", p: 0.5 }],
          ],
        },
      ]),
    );
    renderPage();
    const add = await screen.findByTestId("semis-add");
    expect(add).toBeDisabled();
    const boxes = screen.getAllByRole("combobox");
    for (const [i, id] of ["a", "b", "c", "d"].entries()) await userEvent.selectOptions(boxes[i], id);
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(h.setPick).toHaveBeenCalledTimes(1);
    expect(h.setPick).toHaveBeenCalledWith(
      expect.objectContaining({ market: "semis", odds: 15.04, selection: "a,b,c,d", label: "ALP, BET, GAM, DEL" }),
    );
    expect(add).toHaveTextContent("15.04");
  });
});
