import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import type { Frame } from "../domain/sim";
import type { TeamPublic } from "../lib/pocketbase";

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const frame = (f: Partial<Frame>): Frame => ({ ball: [50, 32], lift: 0, players: [], caption: "", flash: null, type: "pass", seq: 1, p: 0.1, ...f });

describe("Pitch goal banner", () => {
  it("shows GOOOAL with scorer and score for the whole goal scene", () => {
    render(<Pitch frame={frame({ type: "goal", flash: "goal", side: "away", who: "Jo Striker", score: [1, 2] })} home={home} away={away} />);
    const b = screen.getByTestId("goal-banner");
    expect(b.textContent).toContain("GOOOAL!");
    expect(b.textContent).toContain("Jo Striker");
    expect(b.textContent).toContain("1–2");
  });

  it("stays up through the celebration", () => {
    render(<Pitch frame={frame({ type: "celebration", flash: "goal", side: "home", who: "Jo", score: [1, 0] })} home={home} away={away} />);
    expect(screen.getByTestId("goal-banner")).toBeTruthy();
  });

  it("is absent on a pass", () => {
    render(<Pitch frame={frame({})} home={home} away={away} />);
    expect(screen.queryByTestId("goal-banner")).toBeNull();
  });
});
