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
