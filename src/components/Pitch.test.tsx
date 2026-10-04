import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import type { Frame } from "../domain/sim";
import type { TeamPublic } from "../lib/pocketbase";

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const frame = (f: Partial<Frame>): Frame => ({ ball: [50, 32], lift: 0, players: [], caption: "", flash: null, type: "pass", seq: 1, p: 0.1, cam: [-4, -3, 108, 70], ...f });

describe("Pitch penalty camera and shootout reveal", () => {
  it("viewBox follows the frame camera", () => {
    const { container } = render(<Pitch frame={frame({ cam: [63, 16, 50, 32] })} home={home} away={away} revealed />);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("63 16 50 32");
  });
  it("tension strip names the kick and taker; GOAL reveals the pens score, SAVED! on a save, both gated by `revealed`", () => {
    const { rerender } = render(<Pitch frame={frame({ type: "shootout_setup", flash: "pen", side: "away", who: "Jo Striker", kick: { no: 3, sd: 0 }, pens: [2, 1] })} home={home} away={away} revealed />);
    expect(screen.getByTestId("pen-strip").textContent).toBe("Kick 3 · AWY · Jo Striker");
    rerender(<Pitch frame={frame({ type: "shootout_kick", flash: "goal", side: "away", pens: [2, 2], p: 0.7, flashAt: 0.75 })} home={home} away={away} revealed={false} />);
    expect(screen.queryByText(/GOAL/)).toBeNull();
    rerender(<Pitch frame={frame({ type: "shootout_kick", flash: "goal", side: "away", pens: [2, 2], p: 0.8, flashAt: 0.75 })} home={home} away={away} revealed />);
    expect(screen.getByText(/GOAL/).textContent).toBe("GOAL! 2–2");
    expect(screen.queryByTestId("goal-banner")).toBeNull();
    rerender(<Pitch frame={frame({ type: "shootout_kick", flash: "save", side: "away", pens: [2, 1], p: 0.8, flashAt: 0.75 })} home={home} away={away} revealed />);
    expect(screen.getByText("SAVED!")).toBeTruthy();
  });
});

describe("Pitch kits and numbers", () => {
  const players: Frame["players"] = [
    { side: "home", name: "Ann Able", no: 7, gk: false, x: 30, y: 30, hot: true },
    { side: "home", name: "Gus Glove", no: 1, gk: true, x: 4, y: 32, hot: false },
    { side: "away", name: "Bo Bell", no: 9, gk: false, x: 70, y: 30, hot: false },
  ];
  it("shows shirt numbers, never names; hot players get the ring", () => {
    const { container } = render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    const nodes = screen.getAllByTestId("player");
    expect(nodes.map((n) => n.textContent)).toEqual(["7", "1", "9"]);
    expect(container.textContent).not.toContain("Ann");
    expect(nodes[0].querySelector("[data-ring]")).toBeTruthy();
    expect(nodes[2].querySelector("[data-ring]")).toBeNull();
  });
  it("home is filled in the team colour, away is white with a team-colour ring, keeper keeps lime plus the ring", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    const kit = (i: number) => screen.getAllByTestId("player")[i].querySelector("[data-kit]")!;
    expect(kit(0).getAttribute("fill")).toBe("#00f0ff");
    expect(kit(2).getAttribute("fill")).toBe("#f4f7ff");
    expect(kit(2).getAttribute("stroke")).toBe("#ff2d95");
    expect(kit(1).getAttribute("fill")).toBe("#c6ff00");
    expect(kit(1).getAttribute("stroke")).toBe("#00f0ff");
  });
  it("has a kit legend with both abbreviations", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    expect(screen.getByTestId("kit-legend").textContent).toMatch(/HOM.*AWY/);
  });
});

describe("Pitch goal banner", () => {
  it("shows GOOOAL with scorer and score once the ball is in", () => {
    const { rerender } = render(<Pitch frame={frame({ type: "goal", flash: "goal", side: "away", who: "Jo Striker", score: [1, 2], p: 0.3 })} home={home} away={away} revealed={false} />);
    expect(screen.queryByTestId("goal-banner")).toBeNull(); // shot still travelling
    rerender(<Pitch frame={frame({ type: "goal", flash: "goal", side: "away", who: "Jo Striker", score: [1, 2], p: 0.7 })} home={home} away={away} revealed />);
    const b = screen.getByTestId("goal-banner");
    expect(b.textContent).toContain("GOOOAL!");
    expect(b.textContent).toContain("Jo Striker");
    expect(b.textContent).toContain("HOM 1–2 AWY");
    expect(b.querySelectorAll(".confetti > i")).toHaveLength(24);
  });

  it("stays up through the celebration, whatever the gate says", () => {
    render(<Pitch frame={frame({ type: "celebration", flash: "goal", side: "home", who: "Jo", score: [1, 0] })} home={home} away={away} revealed={false} />);
    expect(screen.getByTestId("goal-banner")).toBeTruthy();
  });

  it("is absent on a pass", () => {
    render(<Pitch frame={frame({})} home={home} away={away} revealed />);
    expect(screen.queryByTestId("goal-banner")).toBeNull();
  });
});

describe("Pitch shootout banners", () => {
  const pen = (f: Partial<Frame>) => {
    render(<Pitch frame={frame({ type: "shootout_setup", flash: "pen", side: "home", ...f })} home={home} away={away} revealed />);
    return screen.queryByTestId("pen-banner")?.textContent;
  };
  it("SUDDEN DEATH on the first sudden-death kick", () => expect(pen({ kick: { no: 6, sd: 1 } })).toBe("SUDDEN DEATH"));
  it("score to go through", () => expect(pen({ kick: { no: 5, sd: 0, win: 1 } })).toBe("HOM score this and they're through!"));
  it("must score to stay in", () => expect(pen({ side: "away", kick: { no: 4, sd: 0, must: 1 } })).toBe("AWY must score to stay in"));
  it("winner through at shootout end", () => expect(pen({ type: "shootout_end", flash: null, side: "away" })).toBe("Away City are through!"));
  it("nothing on an ordinary kick", () => expect(pen({ kick: { no: 2, sd: 0 } })).toBeUndefined());
});
