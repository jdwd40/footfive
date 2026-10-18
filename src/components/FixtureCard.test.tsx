import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixtureCard as Fx, TeamPublic } from "../lib/pocketbase";
import { NO_CURRENT_PRICE, NOT_OFFERED, UNOFFERED_HINT } from "../lib/priceLabel";
import FixtureCard from "./FixtureCard";

const SUSPENDED = "Suspended \u2014 incident in progress";

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
    last: { t: "pass", text: "Kept in the corner", side: "home" },
    odds: { home: 1.01, away: null, closed: null },
  };
  return { ...base, ...over, st: over.st === undefined ? base.st : over.st };
}

function renderCards(nodes: React.ReactNode) {
  return render(<MemoryRouter>{nodes}</MemoryRouter>);
}

describe("FixtureCard prices", () => {
  afterEach(() => cleanup());

  it("opens betting from a partial null without offering the missing side", () => {
    const onBet = vi.fn();
    const first = card({ id: "fx1" });
    const second = card({ id: "fx2" });
    renderCards(
      <>
        <FixtureCard fx={first} now={0} stale={false} onBet={onBet} />
        <FixtureCard fx={second} now={0} stale={false} onBet={onBet} />
      </>,
    );
    const cards = screen.getAllByTestId("fixture-card");
    const hints = screen.getAllByTestId("unoffered-hint");
    expect(hints).toHaveLength(2);
    expect(hints[0].id).not.toBe(hints[1].id);
    for (const el of cards) {
      const btn = within(el).getByTestId("bet-fixture");
      const hint = within(el).getByTestId("unoffered-hint");
      expect(btn).toBeEnabled();
      expect(btn).toHaveTextContent("1.01");
      expect(btn).toHaveTextContent(NOT_OFFERED);
      expect(btn.textContent).not.toContain("\u2013");
      expect(btn).toHaveAttribute("aria-describedby", hint.id);
      expect(hint).toHaveTextContent(UNOFFERED_HINT);
      expect(hint.className).toContain("sr-only");
      expect(within(el).queryByText("Suspended")).toBeNull();
    }
    fireEvent.click(within(cards[0]).getByTestId("bet-fixture"));
    expect(onBet).toHaveBeenCalledTimes(1);
    expect(onBet).toHaveBeenCalledWith(first);
  });

  it("keeps a closed card suspended", async () => {
    const onBet = vi.fn();
    renderCards(<FixtureCard fx={card({ odds: { home: 1.4, away: 2.1, closed: SUSPENDED } })} now={0} stale={false} onBet={onBet} />);
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Suspended");
    expect(btn).toHaveAttribute("title", SUSPENDED);
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(UNOFFERED_HINT)).toBeNull();
    try {
      await userEvent.click(btn);
    } catch (err) {
      expect(String(err)).toMatch(/disabled|pointer-events/i);
    }
    expect(onBet).not.toHaveBeenCalled();
  });

  it("labels a missing odds payload as no current price", () => {
    const onBet = vi.fn();
    renderCards(<FixtureCard fx={card({ odds: null })} now={0} stale={false} onBet={onBet} />);
    expect(screen.queryByTestId("bet-fixture")).toBeNull();
    expect(screen.getByTestId("odds-missing")).toHaveTextContent(NO_CURRENT_PRICE);
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(UNOFFERED_HINT)).toBeNull();
    expect(onBet).not.toHaveBeenCalled();
  });

  it("does not invent price copy when the card has no bet action", () => {
    renderCards(<FixtureCard fx={card({ odds: null })} now={0} stale={false} />);
    expect(screen.queryByTestId("bet-fixture")).toBeNull();
    expect(screen.queryByTestId("odds-missing")).toBeNull();
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(NO_CURRENT_PRICE)).toBeNull();
  });

  it("keeps a blocked side on Your match", () => {
    renderCards(<FixtureCard fx={card()} now={0} stale={false} onBet={vi.fn()} blocked />);
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Your match");
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
    expect(screen.queryByText(UNOFFERED_HINT)).toBeNull();
  });
});

describe("FixtureCard shootout offer", () => {
  afterEach(() => cleanup());

  const prices = { home: 2.51, away: 1.5, closed: null };
  const pens = { sc: [1, 1] as [number, number], so: null, ph: "shootout", clk: { s: 0, run: 0 as const }, pos: 50, x: [[], []] as [number[], number[]], d: 0 as const, win: null, by: null };

  it("hides prices through a shootout when the published market is not closed", () => {
    const onBet = vi.fn();
    renderCards(<FixtureCard fx={card({ odds: prices, st: pens })} now={0} stale={false} onBet={onBet} />);
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Penalties");
    expect(btn).toHaveAttribute("title", "Prices hidden during penalties");
    expect(btn.textContent).not.toContain("2.51");
    expect(btn.textContent).not.toContain("1.50");
    expect(screen.queryByTestId("unoffered-hint")).toBeNull();
    expect(screen.getByText("PENS")).toBeTruthy();
    expect(screen.getByTestId("score-home").textContent).toBe("1");
    expect(screen.getByTestId("watch-match")).toHaveTextContent("Watch live");
    fireEvent.click(btn);
    expect(onBet).not.toHaveBeenCalled();
    cleanup();
    renderCards(<FixtureCard fx={card({ odds: { home: 2.51, away: null, closed: null }, st: pens })} now={0} stale={false} onBet={onBet} />);
    expect(screen.getByTestId("bet-fixture")).toHaveTextContent("Penalties");
    expect(screen.queryByTestId("unoffered-hint")).toBeNull();
    expect(screen.queryByText(NOT_OFFERED)).toBeNull();
  });

  it("keeps an actual closed reason as Suspended during a shootout", () => {
    const onBet = vi.fn();
    const reason = "Penalty kick in progress";
    renderCards(
      <FixtureCard
        fx={card({ odds: { home: 2.51, away: 1.5, closed: reason }, st: { ...pens, d: 1 as const } })}
        now={0}
        stale={false}
        onBet={onBet}
      />,
    );
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Suspended");
    expect(btn).toHaveAttribute("title", reason);
    expect(btn.textContent).not.toContain("2.51");
    expect(btn.textContent).not.toContain("Penalties");
    fireEvent.click(btn);
    expect(onBet).not.toHaveBeenCalled();
  });

  it("keeps Your match ahead of the shootout label", () => {
    renderCards(<FixtureCard fx={card({ odds: prices, st: pens })} now={0} stale={false} onBet={vi.fn()} blocked />);
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Your match");
    expect(btn).toHaveAttribute("title", "You manage a team in this fixture");
    expect(btn.textContent).not.toContain("2.51");
    expect(screen.queryByText("Penalties", { selector: "button" })).toBeNull();
  });

  it("still opens an extra-time price and calls back", () => {
    const onBet = vi.fn();
    const fx = card({ odds: { home: 1.88, away: 1.88, closed: null }, st: { ...pens, ph: "extra_time_2", d: 0 as const, clk: { s: 6300, run: 1 as const } } });
    renderCards(<FixtureCard fx={fx} now={0} stale={false} onBet={onBet} />);
    const btn = screen.getByTestId("bet-fixture");
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent("1.88");
    fireEvent.click(btn);
    expect(onBet).toHaveBeenCalledTimes(1);
    expect(onBet).toHaveBeenCalledWith(fx);
  });

  it("still omits the bet control after full time", () => {
    const fx = card({ status: "finished", odds: prices, st: { ...pens, ph: "finished", d: 0 as const } });
    renderCards(<FixtureCard fx={fx} now={0} stale={false} onBet={vi.fn()} />);
    expect(screen.queryByTestId("bet-fixture")).toBeNull();
    expect(screen.queryByText("2.51")).toBeNull();
  });

  it("keeps a missing odds payload on its existing copy during a shootout", () => {
    renderCards(<FixtureCard fx={card({ odds: null, st: pens })} now={0} stale={false} onBet={vi.fn()} />);
    expect(screen.queryByTestId("bet-fixture")).toBeNull();
    expect(screen.getByTestId("odds-missing")).toHaveTextContent(NO_CURRENT_PRICE);
    expect(screen.getByText("PENS")).toBeTruthy();
  });
});
