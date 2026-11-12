/** #206: a goal elsewhere that arrives in the already-polled ticker flashes it once; history and other items do not. */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import Ticker from "./Ticker";
import type { TickerItem } from "../lib/pocketbase";

const item = (id: string, t: string): TickerItem => ({ id, fixtureId: "fx2", seq: 1, at: 0, t, side: "home", text: `${t} ${id}`, min: 10 });
const draw = (items: TickerItem[], flashGoals = true) => <MemoryRouter><Ticker items={items} flashGoals={flashGoals} /></MemoryRouter>;

afterEach(cleanup);

describe("Ticker goal flash (#206)", () => {
  it("flashes for a goal that arrives while watching, not for one already there on arrival", () => {
    render(draw([item("old", "goal")]));
    expect(screen.getByTestId("ticker-current")).toHaveTextContent("goal old");
    expect(screen.queryByTestId("ticker-flash")).toBeNull();
    cleanup();
    const view = render(draw([]));
    view.rerender(draw([item("new", "goal")]));
    expect(screen.getByTestId("ticker-current")).toHaveTextContent("goal new");
    expect(screen.getByTestId("ticker-flash")).toBeTruthy();
  });

  it("flashes for a goal that is just in when the ticker first appears (the match page mounts it with its first item)", () => {
    render(draw([{ ...item("just", "goal"), at: Date.now() - 2000 }]));
    expect(screen.getByTestId("ticker-flash")).toBeTruthy();
  });

  it("does not flash for other news, or where the flash is not asked for", () => {
    const a = render(draw([]));
    a.rerender(draw([item("r", "red_card")]));
    expect(screen.getByTestId("ticker-current")).toHaveTextContent("red_card r");
    expect(screen.queryByTestId("ticker-flash")).toBeNull();
    cleanup();
    const b = render(draw([], false));
    b.rerender(draw([item("g", "penalty_goal")], false));
    expect(screen.getByTestId("ticker-current")).toBeTruthy();
    expect(screen.queryByTestId("ticker-flash")).toBeNull();
  });
});
