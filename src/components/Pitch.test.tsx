import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import type { Frame } from "../domain/sim";
import type { TeamPublic } from "../lib/pocketbase";

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const frame = (f: Partial<Frame>): Frame => ({ ball: [50, 32], lift: 0, players: [], ref: [40, 46], caption: "", flash: null, type: "pass", seq: 1, p: 0.1, ms: 1500, cam: [-4, -3, 108, 77], ...f });

describe("Pitch penalty camera and shootout reveal", () => {
  it("viewBox follows the frame camera; the element's aspect ratio is fixed to the full pitch so a zoom never reflows the page", () => {
    const { container } = render(<Pitch frame={frame({ cam: [63, 16, 50, 32] })} home={home} away={away} revealed />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("63 16 50 32");
    const box = screen.getByTestId("pitch") as HTMLElement;
    expect(box.style.aspectRatio.replace(/\s/g, "")).toBe("108/77"); // the box carries the ratio (and a viewport height cap); the svg fills it
    expect(box.style.maxWidth).toContain("100vh - var(--pitch-chrome, 360px)");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(svg.className.baseVal).toContain("h-full");
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
  it("shows shirt numbers, never names; only the actual carrier gets the ring", () => {
    const { container } = render(<Pitch frame={frame({ players, ball: [30, 30], carrier: "home:7" })} home={home} away={away} revealed />);
    const nodes = screen.getAllByTestId("player");
    expect(nodes.map((n) => n.textContent)).toEqual(["7", "1", "9"]);
    expect(container.textContent).not.toContain("Ann");
    expect(nodes[0].querySelector("[data-ring]")).toBeTruthy();
    expect(nodes[2].querySelector("[data-ring]")).toBeNull();
  });
  it("every actor has the same radius and stroke — carrier, both keepers, away players and referee included", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    const actors = [...screen.getAllByTestId("player").map(n => n.querySelector("[data-kit]")!), screen.getByTestId("ref")];
    expect(actors.map(n => n.getAttribute("r"))).toEqual(actors.map(() => "1.45"));
    expect(actors.map(n => n.getAttribute("stroke-width"))).toEqual(actors.map(() => "0.3"));
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
  it("number text is dark on light kits and white on dark ones", () => {
    const numFill = (i: number) => screen.getAllByTestId("player")[i].querySelector("text")!.getAttribute("fill");
    const { unmount } = render(<Pitch frame={frame({ players })} home={{ ...home, primary_color: "#ffffff" }} away={away} revealed />);
    expect(numFill(0)).toBe("#0b1404"); // Virgin white home kit → dark number
    expect(numFill(1)).toBe("#0b1404"); // keeper lime stays dark
    expect(numFill(2)).toBe("#0b1404"); // away white stays dark
    unmount();
    render(<Pitch frame={frame({ players })} home={{ ...home, primary_color: "#0a84ff" }} away={away} revealed />);
    expect(numFill(0)).toBe("#fff"); // dark blue home kit → white number
  });
  it("always draws the referee as an equal-sized yellow circle with a black stroke", () => {
    render(<Pitch frame={frame({ players, ref: [40, 20] })} home={home} away={away} revealed />);
    const ref = screen.getByTestId("ref");
    expect(ref.getAttribute("cx")).toBe("40");
    expect(ref.getAttribute("cy")).toBe("20");
    expect(ref.getAttribute("r")).toBe("1.45");
    expect(ref.getAttribute("stroke")).toBe("#000");
  });
  it("has a kit legend with both abbreviations", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    expect(screen.getByTestId("kit-legend").textContent).toMatch(/HOM.*AWY/);
  });
  it("result badges say what happened — WIDE, OVER, BLOCKED, SAVED!, WOODWORK — never a generic NO GOAL; gated by `revealed`", () => {
    const badge = (flash: Frame["flash"], revealed = true) => {
      cleanup();
      render(<Pitch frame={frame({ type: "miss", flash, p: 0.9 })} home={home} away={away} revealed={revealed} />);
      return screen.getByTestId("pitch").querySelector("span.event-enter")?.textContent ?? null;
    };
    expect(badge("miss")).toBe("WIDE");
    expect(badge("over")).toBe("OVER");
    expect(badge("block")).toBe("BLOCKED");
    expect(badge("save")).toBe("SAVED!");
    expect(badge("wood")).toBe("WOODWORK");
    expect(badge("miss", false)).toBeNull();
    expect(document.body.textContent).not.toContain("NO GOAL");
  });
  it("WON IT shows while the frame carries the winner, in his side's colour, and stays clear of a result badge", () => {
    const { rerender } = render(<Pitch frame={frame({ type: "tackle", side: "home", won: "home" })} home={home} away={away} revealed />);
    const badge = screen.getByTestId("won-badge");
    expect(badge.textContent).toBe("WON IT");
    expect(badge.style.background).toBe("rgb(0, 240, 255)");
    rerender(<Pitch frame={frame({ type: "interception", side: "away", won: "away" })} home={home} away={away} revealed />);
    expect(screen.getByTestId("won-badge").style.background).toBe("rgb(255, 45, 149)");
    rerender(<Pitch frame={frame({ type: "pass", side: "away", won: "away", flash: "save" })} home={home} away={away} revealed />);
    expect(screen.getByText("SAVED!")).toBeTruthy(); // a lingering result keeps its slot; WON IT sits under it
    expect(screen.getByTestId("won-badge").parentElement!.className).toContain("top-[4.25rem]");
    rerender(<Pitch frame={frame({ type: "tackle", side: "home", won: null })} home={home} away={away} revealed />);
    expect(screen.queryByTestId("won-badge")).toBeNull();
  });
  it("pins the HUD to the pitch's top-left corner and keeps the replay chip out of its way", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed replay hud={<span>HOM 1–0 AWY</span>} />);
    const hud = screen.getByTestId("pitch-hud");
    expect(hud.textContent).toBe("HOM 1–0 AWY");
    expect(hud.className).toContain("left-2");
    expect(screen.getByText("Replay").className).toContain("right-2");
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

describe("Pitch period banners", () => {
  const period = (f: Partial<Frame>) => {
    render(<Pitch frame={frame({ score: [1, 0], p: 0.3, ...f })} home={home} away={away} revealed />);
    return screen.queryByTestId("period-banner")?.textContent;
  };
  it("half-time with the score", () => expect(period({ type: "half_time" })).toBe("HALF-TIME · HOM 1–0 AWY"));
  it("extra-time half-time with the score", () => expect(period({ type: "et_half_time", score: [2, 2] })).toBe("ET HALF-TIME · HOM 2–2 AWY"));
  it("is GOOOAL-sized, and dims to 85 % after 4 s so the pitch shows through the break", () => {
    period({ type: "half_time", ms: 30000, p: 3000 / 30000 });
    const b = screen.getByTestId("period-banner");
    expect(b.querySelector(".font-black")!.className).toContain("text-6xl");
    expect(b.style.opacity).toBe("");
    cleanup();
    period({ type: "half_time", ms: 30000, p: 5000 / 30000 });
    expect(screen.getByTestId("period-banner").style.opacity).toBe("0.85");
  });
  it("second half", () => expect(period({ type: "second_half" })).toBe("SECOND HALF — KICK-OFF"));
  it("end of normal time with the score", () => expect(period({ type: "end_of_normal_time", score: [1, 1] })).toBe("FULL-TIME · 1–1 · EXTRA TIME"));
  it("extra time", () => expect(period({ type: "extra_time" })).toBe("EXTRA TIME — KICK-OFF"));
  it("second period of extra time", () => expect(period({ type: "et_second_half" })).toBe("ET SECOND HALF"));
  it("shootout start", () => expect(period({ type: "shootout_start" })).toBe("PENALTY SHOOTOUT"));
  it("goes once the scene is over, and never shows confetti", () => {
    expect(period({ type: "half_time", p: 1 })).toBeUndefined();
    cleanup();
    render(<Pitch frame={frame({ type: "half_time", p: 0.5 })} home={home} away={away} revealed />);
    expect(document.querySelectorAll(".confetti")).toHaveLength(0);
  });
  it("nothing on a pass", () => expect(period({})).toBeUndefined());
});

describe("Pitch full-time banner", () => {
  const ft = (f: Partial<Frame>) => {
    render(<Pitch frame={frame({ type: "match_end", side: "home", score: [2, 1], p: 1, ...f })} home={home} away={away} revealed />);
    return screen.queryByTestId("ft-banner")?.textContent;
  };
  it("names the winner, and holds after the scene", () => expect(ft({ by: "normal" })).toBe("FULL-TIMEHome Town go through!"));
  it("after extra time", () => expect(ft({ side: "away", by: "aet" })).toBe("FULL-TIMEAway City go through!after extra time"));
  it("on penalties with the shootout score", () => expect(ft({ by: "pens", pens: [3, 4], side: "away" })).toBe("FULL-TIMEAway City go through!on penalties 4–3"));
  it("nothing without a winner", () => expect(ft({ side: null })).toBeUndefined());
});
