import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Pitch from "./Pitch";
import type { Frame } from "../domain/sim";
import type { TeamPublic } from "../lib/pocketbase";

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const frame = (f: Partial<Frame>): Frame => ({ ball: [50, 32], lift: 0, players: [], ref: [40, 46], caption: "", flash: null, type: "pass", seq: 1, p: 0.1, ms: 1500, ...f });

describe("Pitch penalty camera and shootout reveal", () => {
  it("never zooms: a penalty, a penalty goal and the shootout all draw the whole pitch; the box keeps the full-pitch aspect ratio (#203)", () => {
    const { container, rerender } = render(<Pitch frame={frame({ type: "penalty_awarded", flash: "pen", side: "home", p: 0.5 })} home={home} away={away} revealed />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("-4 -3 108 77");
    rerender(<Pitch frame={frame({ type: "penalty_goal", flash: "goal", side: "away", phase: "second_half", p: 0.9, score: [0, 1] })} home={home} away={away} revealed />);
    expect(svg.getAttribute("viewBox")).toBe("-4 -3 108 77");
    rerender(<Pitch frame={frame({ type: "shootout_kick", flash: "save", side: "away", phase: "shootout", p: 0.8 })} home={home} away={away} revealed />);
    expect(svg.getAttribute("viewBox")).toBe("-4 -3 108 77");
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
  it("shows a number on every shirt; only the actual carrier gets the ring and his surname (#204)", () => {
    const { container, rerender } = render(<Pitch frame={frame({ players, ball: [30, 30], carrier: "home:7" })} home={home} away={away} revealed />);
    const nodes = screen.getAllByTestId("player");
    expect(nodes.map((n) => n.textContent)).toEqual(["7", "1", "9"]);
    expect(nodes[0].querySelector("[data-ring]")).toBeTruthy();
    expect(nodes[2].querySelector("[data-ring]")).toBeNull();
    expect(screen.getByTestId("carrier-name").textContent).toBe("ABLE"); // surname only, drawn outside the player node
    expect(container.textContent).not.toMatch(/Ann|Gus|Glove|Bo|Bell/);
    // A candidate who is not in drawn contact (ball away / airborne) has neither the ring nor the name.
    rerender(<Pitch frame={frame({ players, ball: [40, 30], carrier: "home:7" })} home={home} away={away} revealed />);
    expect(screen.queryByTestId("carrier-name")).toBeNull();
    rerender(<Pitch frame={frame({ players, ball: [30, 30], lift: 0.4, carrier: "home:7" })} home={home} away={away} revealed />);
    expect(screen.queryByTestId("carrier-name")).toBeNull();
    expect(container.querySelector("[data-ring]")).toBeNull();
  });
  it("keeps the carrier's name inside the pitch at the touchline and on the drawn (projected) side", () => {
    const wide = [{ side: "away" as const, name: "Cy de la Touchline", no: 11, gk: false, x: 99, y: 60, hot: true }];
    render(<Pitch frame={frame({ players: wide, ball: [99, 60], carrier: "away:11", phase: "second_half" })} home={home} away={away} revealed />);
    const label = screen.getByTestId("carrier-name");
    expect(label.textContent).toBe("TOUCHLINE");
    // second half projects x → 100 − x = 1, and the label is clamped in from the touchline
    expect(label.parentElement!.getAttribute("transform")).toBe("translate(7 60)");
  });
  it("draws every player as the same shirt shape, larger than the old 1.45 disc; the referee keeps his own figure", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    const bodies = screen.getAllByTestId("player").map((n) => n.querySelector("[data-kit]")!);
    expect(new Set(bodies.map((b) => b.tagName.toLowerCase()))).toEqual(new Set(["path"]));
    expect(new Set(bodies.map((b) => b.getAttribute("d"))).size).toBe(1);
    expect(screen.getByTestId("ref").querySelector("[data-ref-body]")!.getAttribute("r")).toBe("1.45");
    expect(Number(screen.getByTestId("ball").getAttribute("r"))).toBeGreaterThan(0.85);
  });
  it("home wears the team colour; away wears the house white with team-colour sleeves and collar; keepers are distinct (#204)", () => {
    render(<Pitch frame={frame({ players: [...players, { side: "away", name: "Al Keeper", no: 1, gk: true, x: 96, y: 32, hot: false }] })} home={home} away={away} revealed />);
    const node = (i: number) => screen.getAllByTestId("player")[i];
    const part = (i: number, sel: string) => node(i).querySelector(sel)!;
    expect(part(0, "[data-kit]").getAttribute("fill")).toBe("#00f0ff");
    expect(part(2, "[data-kit]").getAttribute("fill")).toBe("#f4f7ff");
    expect(part(2, "[data-sleeves]").getAttribute("fill")).toBe("#ff2d95");
    expect(part(2, "[data-trim]").getAttribute("stroke")).toBe("#ff2d95");
    expect(node(0).getAttribute("data-side")).toBe("home");
    expect(node(2).getAttribute("data-side")).toBe("away");
    // keepers: own shirt colours (lime, then the next clear colour for the other keeper), long sleeves and gloves
    const outfield = [part(0, "[data-kit]").getAttribute("fill"), part(2, "[data-kit]").getAttribute("fill")];
    const keepers = [1, 3].map((i) => part(i, "[data-kit]").getAttribute("fill"));
    expect(keepers[0]).toBe("#c6ff00");
    expect(new Set([...outfield, ...keepers]).size).toBe(4);
    for (const i of [1, 3]) {
      expect(node(i).hasAttribute("data-gk")).toBe(true);
      expect(node(i).querySelector("[data-gloves]")).toBeTruthy();
      expect(part(i, "[data-sleeves]").getAttribute("d")).not.toBe(part(0, "[data-sleeves]").getAttribute("d"));
    }
    expect(node(0).hasAttribute("data-gk")).toBe(false);
    expect(node(0).querySelector("[data-gloves]")).toBeNull();
    expect(part(3, "[data-trim]").getAttribute("stroke")).toBe("#ff2d95"); // the keeper's collar names his team
  });
  it("number text is dark on light kits and white on dark ones", () => {
    const numFill = (i: number) => screen.getAllByTestId("player")[i].querySelector("text")!.getAttribute("fill");
    const { unmount } = render(<Pitch frame={frame({ players })} home={{ ...home, primary_color: "#ffffff" }} away={away} revealed />);
    expect(numFill(0)).toBe("#0b1404"); // Virgin white home kit → dark number
    expect(numFill(1)).toBe("#0b1404"); // keeper lime stays dark
    expect(numFill(2)).toBe("#fff"); // #204 clash rule: white would clash with the white home kit, so the away side wears its pink
    unmount();
    render(<Pitch frame={frame({ players })} home={{ ...home, primary_color: "#0a84ff" }} away={away} revealed />);
    expect(numFill(0)).toBe("#fff"); // dark blue home kit → white number
    expect(numFill(2)).toBe("#0b1404"); // away white stays dark
  });
  it("draws the referee as a figure with a head, boots and an equal-sized yellow shirt", () => {
    render(<Pitch frame={frame({ players, ref: [40, 20] })} home={home} away={away} revealed />);
    const ref = screen.getByTestId("ref");
    expect(ref.tagName.toLowerCase()).toBe("g");
    expect(ref.getAttribute("transform")).toBe("translate(40 20)");
    expect(ref.getAttribute("data-pose")).toBe("run");
    expect(ref.querySelectorAll("circle")).toHaveLength(2);
    expect(ref.querySelector("path")).toBeTruthy();
    expect(ref.querySelector("[data-ref-body]")!.getAttribute("r")).toBe("1.45");
    expect(ref.querySelector("[data-ref-body]")!.getAttribute("stroke")).toBe("#000");
  });
  it("has no kit colour swatches by the score/clock: team colours live on the scoreboard (#99)", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed />);
    expect(screen.queryByTestId("kit-legend")).toBeNull();
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
  it.each([false, true])("never shows WON IT for a challenge or turnover, including alongside a result (replay=%s)", (replay) => {
    const { rerender } = render(<Pitch frame={null} home={home} away={away} revealed replay={replay} />);
    for (const type of ["tackle", "interception", "pass", "build_up"]) {
      for (const side of ["home", "away"] as const) {
        for (const flash of [null, "save", "wood", "block"] as const) {
          rerender(<Pitch frame={frame({ type, side, won: side, flash })} home={home} away={away} revealed replay={replay} />);
          expect(screen.queryByTestId("won-badge")).toBeNull();
          expect(screen.queryByText("WON IT")).toBeNull();
          if (flash) expect(screen.getByText({ save: "SAVED!", wood: "WOODWORK", block: "BLOCKED" }[flash])).toBeTruthy();
        }
      }
    }
  });
  it("pins the HUD to the pitch's top-left corner and keeps the replay chip out of its way", () => {
    render(<Pitch frame={frame({ players })} home={home} away={away} revealed replay hud={<span>HOM 1–0 AWY</span>} />);
    const hud = screen.getByTestId("pitch-hud");
    expect(hud.textContent).toBe("HOM 1–0 AWY");
    expect(hud.className).toContain("left-2");
    expect(screen.getByText("Replay").className).toContain("right-2");
  });
});

describe("Pitch referee signals", () => {
  it.each([
    ["yellow_card", "card-yellow", "#ffd400", "BOOKED"],
    ["red_card", "card-red", "#ff3344", "RED CARD"],
  ] as const)("draws the correct raised %s card and retains the result chip, live and replay", (type, refPose, colour, chip) => {
    const { rerender } = render(<Pitch frame={null} home={home} away={away} revealed />);
    for (const replay of [false, true]) {
      rerender(<Pitch frame={frame({ type, refPose, refAim: [45, 32], flash: "card", p: 1 })} home={home} away={away} revealed replay={replay} />);
      expect(screen.getByTestId("ref").getAttribute("data-pose")).toBe(refPose);
      const card = screen.getByTestId("ref-card");
      expect(card.getAttribute("fill")).toBe(colour);
      expect(Number(card.getAttribute("y"))).toBeLessThan(-3);
      expect(screen.getByText(chip)).toBeTruthy();
      expect(screen.queryByTestId("won-badge")).toBeNull();
    }
  });

  it("shows a whistle, then points toward the target; both the referee and his arm reflect at the change of ends", () => {
    const f = frame({ type: "foul", ref: [40, 20], refPose: "whistle", refAim: [0, 20] });
    const { rerender } = render(<Pitch frame={f} home={home} away={away} revealed />);
    expect(screen.getByTestId("ref-whistle")).toBeTruthy();
    for (const phase of ["first_half", "second_half"]) {
      rerender(<Pitch frame={{ ...f, phase, refPose: "point", p: 1 }} home={home} away={away} revealed />);
      const ref = screen.getByTestId("ref");
      expect(screen.queryByTestId("ref-whistle")).toBeNull();
      expect(ref.getAttribute("transform")).toBe(`translate(${phase === "first_half" ? 40 : 60} 20)`);
      expect(Math.sign(Number(ref.querySelector("[data-ref-arm]")!.getAttribute("x2")))).toBe(phase === "first_half" ? -1 : 1);
      expect(screen.queryByTestId("ref-card")).toBeNull();
    }
  });

  it("points down toward the penalty spot on a final, static frame without adding animation", () => {
    render(<Pitch frame={frame({ type: "penalty_awarded", ref: [86, 19], refAim: [89, 32], refPose: "point", p: 1, flash: "pen" })} home={home} away={away} revealed />);
    const ref = screen.getByTestId("ref");
    const arm = ref.querySelector("[data-ref-arm]")!;
    expect(Number(arm.getAttribute("x2"))).toBeGreaterThan(0);
    expect(Number(arm.getAttribute("y2"))).toBeGreaterThan(0);
    expect(ref.querySelector("animate, animateTransform, [style]")).toBeNull();
    expect(screen.getByText("PENALTY")).toBeTruthy();
  });
});

describe("Pitch stadium crowd", () => {
  const stand = (side: "home" | "away") => screen.getByTestId(`${side}-crowd`);
  const cheers = (side: "home" | "away") => stand(side).classList.contains("cheer");

  it("uses two empty patterned sections in the team colours, keeping the pitch's existing width cap", () => {
    render(<Pitch frame={frame({})} home={home} away={away} revealed />);
    const stadium = screen.getByTestId("stadium");
    expect(stadium.style.getPropertyValue("--home")).toBe(home.primary_color);
    expect(stadium.style.getPropertyValue("--away")).toBe(away.primary_color);
    expect(stadium.querySelectorAll(".stadium-stand")).toHaveLength(2);
    for (const side of ["home", "away"] as const) {
      expect(stand(side).childElementCount).toBe(0); // dot patterns and flags use pseudo-elements, never per-fan DOM
      expect(stand(side).getAttribute("aria-hidden")).toBe("true");
      expect(cheers(side)).toBe(false);
    }
    expect(stadium.style.maxWidth).toBe(screen.getByTestId("pitch").style.maxWidth);
  });

  it.each(["goal", "penalty_goal"])("cheers the scoring side of a %s exactly when its GOOOAL banner is revealed", (type) => {
    const { rerender } = render(<Pitch frame={null} home={home} away={away} revealed={false} />);
    for (const side of ["home", "away"] as const) {
      const f = frame({ type, side, flash: "goal", score: [1, 1], p: 0.8 });
      rerender(<Pitch frame={f} home={home} away={away} revealed={false} />);
      expect(screen.queryByTestId("goal-banner")).toBeNull();
      expect(cheers("home") || cheers("away")).toBe(false);
      rerender(<Pitch frame={f} home={home} away={away} revealed />);
      expect(screen.getByTestId("goal-banner")).toBeTruthy();
      expect(cheers(side)).toBe(true);
      expect(cheers(side === "home" ? "away" : "home")).toBe(false);
    }
  });

  it("keeps a goal's cheer through its celebration and ordinary ticks, but restarts it for the next goal", () => {
    const f = frame({ type: "goal", side: "home", flash: "goal", score: [1, 0] });
    const { rerender } = render(<Pitch frame={f} home={home} away={away} revealed />);
    const first = stand("home");
    const awayStand = stand("away");
    rerender(<Pitch frame={{ ...f, p: 0.95 }} home={home} away={away} revealed />);
    expect(stand("home")).toBe(first);
    rerender(<Pitch frame={{ ...f, type: "celebration", seq: 2 }} home={home} away={away} revealed={false} />);
    expect(stand("home")).toBe(first); // the banner already persists through this celebration
    expect(cheers("home")).toBe(true);
    rerender(<Pitch frame={{ ...f, seq: 3, score: [2, 0] }} home={home} away={away} revealed />);
    expect(stand("home")).not.toBe(first);
    expect(stand("away")).toBe(awayStand);
    expect(cheers("home")).toBe(true);
    rerender(<Pitch frame={frame({ seq: 4 })} home={home} away={away} revealed />);
    expect(cheers("home") || cheers("away")).toBe(false);
  });

  it.each(["normal", "aet", "pens"] as const)("cheers the full-time winner (%s)", (by) => {
    render(<Pitch frame={frame({ type: "match_end", side: "away", by })} home={home} away={away} revealed />);
    expect(screen.getByTestId("ft-banner")).toBeTruthy();
    expect(cheers("away")).toBe(true);
    expect(cheers("home")).toBe(false);
  });

  it("cheers a shootout winner once through the following full-time announcement", () => {
    const f = frame({ type: "shootout_end", side: "home", pens: [5, 4] });
    const { rerender } = render(<Pitch frame={f} home={home} away={away} revealed />);
    const winner = stand("home");
    expect(cheers("home")).toBe(true);
    expect(cheers("away")).toBe(false);
    rerender(<Pitch frame={{ ...f, type: "match_end", seq: 2, by: "pens" }} home={home} away={away} revealed />);
    expect(stand("home")).toBe(winner);
  });

  it.each([
    ["save", "save"], ["miss", "miss"], ["block", "block"], ["woodwork", "wood"],
    ["penalty_saved", "save"], ["penalty_missed", "miss"], ["penalty_woodwork", "wood"],
    ["shootout_kick", "save"], ["shootout_kick", "miss"], ["shootout_kick", "wood"], ["shootout_kick", "goal"],
  ] as const)("keeps both crowds calm for %s / %s", (type, flash) => {
    render(<Pitch frame={frame({ type, flash, side: "home" })} home={home} away={away} revealed />);
    expect(cheers("home") || cheers("away")).toBe(false);
  });

  it("retains the calm crowd nodes across ordinary frames and updates colours without adding fan nodes", () => {
    const { rerender } = render(<Pitch frame={frame({})} home={home} away={away} revealed />);
    const h = stand("home");
    const a = stand("away");
    rerender(<Pitch frame={frame({ seq: 99, p: 0.7 })} home={{ ...home, primary_color: "#ffffff" }} away={away} revealed />);
    expect(stand("home")).toBe(h);
    expect(stand("away")).toBe(a);
    expect(screen.getByTestId("stadium").style.getPropertyValue("--home")).toBe("#ffffff");
    expect(h.childElementCount + a.childElementCount).toBe(0);
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
    // #203: as large as GOOOAL (the same 60 px cap), but sized to the pitch width so it never runs off the edges.
    expect(b.querySelector<HTMLElement>('[data-testid="banner-title"]')!.style.fontSize).toMatch(/^min\(3\.75rem, [\d.]+cqw\)$/);
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

describe("Pitch ball trail (#204)", () => {
  afterEach(() => vi.restoreAllMocks());
  const trail = () => screen.getByTestId("ball-trail");
  const shown = () => trail().getAttribute("display") !== "none";
  /** Tail of the wedge: the trail's far end. */
  const tail = () => {
    const m = trail().querySelector("path")!.getAttribute("d")!.match(/L ([-\d.e]+) ([-\d.e]+)/)!;
    return [Number(m[1]), Number(m[2])];
  };
  const clockAt = (t: { now: number }) => vi.spyOn(performance, "now").mockImplementation(() => t.now);

  it("follows a moving ball with a fixed handful of nodes, never longer than 7 units, and hides at rest", () => {
    const t = { now: 1000 };
    clockAt(t);
    const { rerender } = render(<Pitch frame={frame({ ball: [20, 32] })} home={home} away={away} revealed />);
    expect(shown()).toBe(false); // nothing to trail on the first tick
    const counts = new Set<number>();
    for (let i = 1; i <= 120; i++) {
      t.now += 16;
      const bx = 20 + i * 0.6; // ~37 units/s, a driven pass
      rerender(<Pitch frame={frame({ ball: [bx, 32] })} home={home} away={away} revealed />);
      counts.add(trail().querySelectorAll("*").length);
      expect(shown()).toBe(true);
      const [tx, ty] = tail();
      expect(tx).toBeLessThan(bx);
      expect(Math.hypot(bx - tx, 32 - ty)).toBeLessThanOrEqual(7 + 1e-9);
    }
    expect([...counts]).toEqual([3]); // the same three nodes every tick: no per-sample DOM
    for (let i = 0; i < 12; i++) {
      t.now += 16;
      rerender(<Pitch frame={frame({ ball: [92, 32] })} home={home} away={away} revealed />);
    }
    expect(shown()).toBe(false);
  });

  it("is a cut, not motion, when the drawn ball jumps (change of ends or a scene snap)", () => {
    const t = { now: 1000 };
    clockAt(t);
    const { rerender } = render(<Pitch frame={frame({ ball: [30, 32] })} home={home} away={away} revealed />);
    t.now += 16;
    rerender(<Pitch frame={frame({ ball: [31, 32] })} home={home} away={away} revealed />);
    expect(shown()).toBe(true);
    t.now += 16;
    rerender(<Pitch frame={frame({ ball: [31, 32], phase: "second_half" })} home={home} away={away} revealed />); // drawn at 69
    expect(shown()).toBe(false);
  });

  it("follows the ball's drawn height, and is withdrawn under reduced motion by CSS", () => {
    const t = { now: 1000 };
    clockAt(t);
    const { rerender } = render(<Pitch frame={frame({ ball: [50, 32], lift: 0 })} home={home} away={away} revealed />);
    t.now += 16;
    rerender(<Pitch frame={frame({ ball: [50, 32], lift: 1 })} home={home} away={away} revealed />);
    expect(shown()).toBe(true);
    expect(tail()[1]).toBeCloseTo(32);
    expect(trail().classList.contains("ball-trail")).toBe(true);
  });
});

describe("Pitch stadium frame (#204)", () => {
  it("draws grass, full markings and floodlights inside the fixed viewBox, and the two crowd stands outside the pitch box", () => {
    const { container } = render(<Pitch frame={frame({})} home={home} away={away} revealed />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("-4 -3 108 77");
    expect(screen.getByTestId("floodlights").querySelectorAll("circle")).toHaveLength(4);
    expect(screen.getByTestId("markings").querySelectorAll("path")).toHaveLength(2); // penalty arcs, corner arcs
    const stadium = screen.getByTestId("stadium");
    expect([...stadium.children].map((c) => c.getAttribute("data-testid"))).toEqual(["home-crowd", "away-crowd", "pitch"]);
  });

  it("does not re-render the static field on ordinary ticks", () => {
    const { container, rerender } = render(<Pitch frame={frame({ ball: [40, 32] })} home={home} away={away} revealed />);
    const lights = screen.getByTestId("floodlights");
    for (let i = 0; i < 5; i++) rerender(<Pitch frame={frame({ ball: [40 + i, 32], seq: i })} home={home} away={away} revealed />);
    expect(screen.getByTestId("floodlights")).toBe(lights);
    // bounded drawing: 10 players at ≤ 6 nodes each, plus the field, referee, trail, ball and label stay well under 200 nodes
    const ten = Array.from({ length: 10 }, (_, i) => ({ side: (i < 5 ? "home" : "away") as "home" | "away", name: `P ${i}`, no: (i % 5) + 1, gk: i % 5 === 0, x: 10 + i * 8, y: 32, hot: false }));
    rerender(<Pitch frame={frame({ players: ten, ball: [18, 32], carrier: "home:2" })} home={home} away={away} revealed />);
    expect(container.querySelectorAll("svg *").length).toBeLessThan(200);
  });
});

describe("Pitch break summary and pre-match overlay (#208)", () => {
  const summary = <div data-testid="the-summary">summary</div>;
  it("docks the half-time banner at the top of the pitch, its text unchanged, with the summary under it inside the pitch box", () => {
    render(<Pitch frame={frame({ type: "half_time", score: [1, 0], ms: 30000, p: 8000 / 30000 })} home={home} away={away} revealed summary={summary} />);
    const banner = screen.getByTestId("period-banner");
    expect(banner.textContent).toBe("HALF-TIME · HOM 1–0 AWY");
    expect(banner.hasAttribute("data-docked")).toBe(true);
    const overlay = screen.getByTestId("break-overlay");
    expect(screen.getByTestId("pitch").contains(overlay)).toBe(true);
    expect(overlay.className).toContain("absolute");
    expect(overlay.contains(screen.getByTestId("the-summary"))).toBe(true);
    expect(overlay.style.opacity).toBe(""); // the summary is never dimmed with the break banner
  });
  it("full time keeps the winner on the docked banner", () => {
    render(<Pitch frame={frame({ type: "match_end", side: "away", by: "aet", score: [1, 2], p: 1 })} home={home} away={away} revealed summary={summary} />);
    expect(screen.getByTestId("ft-banner").textContent).toBe("FULL-TIMEAway City go through! · after extra time");
    expect(screen.getByTestId("the-summary")).toBeTruthy();
  });
  it("past the scene's life (reduced motion holds p at 1) the break's title still heads the summary", () => {
    render(<Pitch frame={frame({ type: "half_time", score: [0, 0], ms: 30000, p: 1 })} home={home} away={away} revealed summary={summary} />);
    expect(screen.getByTestId("period-banner").textContent).toBe("HALF-TIME · HOM 0–0 AWY");
    cleanup();
    render(<Pitch frame={frame({ type: "half_time", score: [0, 0], ms: 30000, p: 1 })} home={home} away={away} revealed />);
    expect(screen.queryByTestId("period-banner")).toBeNull(); // unchanged without a summary
  });
  it("never docks the goal screen, and draws no summary over it", () => {
    render(<Pitch frame={frame({ type: "celebration", flash: "goal", side: "home", score: [1, 0], p: 0.5 })} home={home} away={away} revealed summary={summary} />);
    expect(screen.getByTestId("goal-banner").hasAttribute("data-docked")).toBe(false);
    expect(screen.queryByTestId("the-summary")).toBeNull();
  });
  it("draws the pre-match overlay inside the pitch box", () => {
    render(<Pitch frame={null} home={home} away={away} revealed overlay={<div data-testid="the-overlay" />} />);
    expect(screen.getByTestId("pitch").contains(screen.getByTestId("the-overlay"))).toBe(true);
  });
});
