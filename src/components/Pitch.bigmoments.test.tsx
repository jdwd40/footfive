/** #206: big moments as drawn — the save/woodwork pulse only from the reveal, every card the engine publishes held up by the referee,
 * the scorer's celebration, and a replay that leaves the goal screen to the live goal. */
import { createRequire } from "node:module";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Pitch from "./Pitch";
import { sampleN, sceneFor, type Pt } from "../domain/scenes";
import { frameAt, reveal, type Frame, type Lineups } from "../domain/sim";
import type { MatchEvent, Side, TeamPublic } from "../lib/pocketbase";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + f));
const eng = lib("matchEngine.js");
const { TEAMS } = lib("teams.js");
const { defaultStarters } = lib("tournament.js");

const home = { id: "h", name: "Home Town", abbreviation: "HOM", primary_color: "#00f0ff" } as TeamPublic;
const away = { id: "a", name: "Away City", abbreviation: "AWY", primary_color: "#ff2d95" } as TeamPublic;
const frame = (f: Partial<Frame>): Frame => ({ ball: [50, 32], lift: 0, players: [], ref: [40, 46], caption: "", flash: null, type: "pass", seq: 1, p: 0.1, ms: 1500, ...f });
const emphasis = () => screen.queryByTestId("pitch-emphasis");

afterEach(cleanup);

describe("save and woodwork emphasis (#206)", () => {
  it.each([
    ["save", "save"], ["woodwork", "wood"], ["penalty_saved", "save"], ["penalty_woodwork", "wood"], ["shootout_kick", "save"],
  ] as const)("pulses for %s only once the result is revealed, as one overlay outside the drawing", (type, flash) => {
    const { container, rerender } = render(<Pitch frame={frame({ type, flash, p: 0.5 })} home={home} away={away} revealed={false} />);
    expect(emphasis()).toBeNull(); // no outcome cue before the reveal (#205's rule)
    const before = container.querySelectorAll("svg *").length;
    rerender(<Pitch frame={frame({ type, flash, p: 0.7 })} home={home} away={away} revealed />);
    expect(emphasis()!.getAttribute("data-kind")).toBe(flash);
    expect(container.querySelectorAll("svg *").length).toBe(before); // the camera and drawing are untouched (no zoom)
    expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("-4 -3 108 77");
  });

  it("does not pulse for other results, nor again when the badge lingers into the next scene", () => {
    const { rerender } = render(<Pitch frame={frame({ type: "miss", flash: "miss", p: 0.9 })} home={home} away={away} revealed />);
    expect(emphasis()).toBeNull();
    rerender(<Pitch frame={frame({ type: "goal", flash: "goal", p: 0.9, score: [1, 0] })} home={home} away={away} revealed />);
    expect(emphasis()).toBeNull();
    rerender(<Pitch frame={frame({ type: "restart", flash: "save", seq: 2, p: 0.2 })} home={home} away={away} revealed />); // SAVED! lingering
    expect(emphasis()).toBeNull();
  });
});

describe("goal celebration and replay (#206)", () => {
  const players: Frame["players"] = [
    { side: "home", name: "Jo Striker", no: 9, gk: false, x: 96, y: 4, hot: true },
    { side: "home", name: "Mo Mate", no: 7, gk: false, x: 92, y: 6, hot: true },
    { side: "home", name: "Bo Back", no: 3, gk: false, x: 40, y: 30, hot: false },
    { side: "away", name: "Al Keeper", no: 1, gk: true, x: 99, y: 32, hot: true },
  ];
  const pose = () => screen.getAllByTestId("player").map((n) => n.getAttribute("data-pose"));

  it("the scorer and the mates with him celebrate arms up once the ball is in, through the celebration", () => {
    const goal = frame({ type: "goal", flash: "goal", side: "home", who: "Jo Striker", score: [1, 0], players, p: 0.3 });
    const { rerender } = render(<Pitch frame={goal} home={home} away={away} revealed={false} />);
    expect(pose()).toEqual([null, null, null, null]);
    rerender(<Pitch frame={{ ...goal, p: 0.6 }} home={home} away={away} revealed />);
    expect(pose()).toEqual(["cheer", "cheer", null, null]);
    rerender(<Pitch frame={{ ...goal, type: "celebration", seq: 2, p: 0.5 }} home={home} away={away} revealed />);
    expect(pose()).toEqual(["cheer", "cheer", null, null]);
  });

  it("a replay of the goal shows the GOAL! chip, not a second goal screen, and the crowd does not cheer again", () => {
    render(<Pitch frame={frame({ type: "goal", flash: "goal", side: "home", who: "Jo Striker", score: [1, 0], players, p: 0.6 })} home={home} away={away} revealed replay />);
    expect(screen.queryByTestId("goal-banner")).toBeNull();
    expect(screen.getByText("GOAL!")).toBeTruthy();
    expect(screen.getByText("Replay")).toBeTruthy();
    expect(screen.getByTestId("home-crowd").classList.contains("cheer")).toBe(false);
  });

  it("once the goal's replay has run, its celebration shows the GOAL! chip: no second goal screen, no second cheer", () => {
    const cel = frame({ type: "celebration", flash: "goal", side: "home", who: "Jo Striker", score: [1, 0], players, p: 1 });
    render(<Pitch frame={cel} home={home} away={away} revealed replayed />);
    expect(screen.queryByTestId("goal-banner")).toBeNull();
    expect(screen.getByText("GOAL!")).toBeTruthy();
    expect(screen.queryByText("Replay")).toBeNull();
    expect(screen.getByTestId("home-crowd").classList.contains("cheer")).toBe(false);
  });

  it("the live goal screen carries the minute when known", () => {
    render(<Pitch frame={frame({ type: "goal", flash: "goal", side: "away", who: "Jo Striker", score: [1, 2], p: 0.7 })} home={home} away={away} revealed minute={67} />);
    expect(screen.getByTestId("banner-who")).toHaveTextContent("Jo Striker · 67′");
    expect(screen.getByTestId("banner-sub")).toHaveTextContent("HOM 1–2 AWY");
  });
});

describe("cards from real engine matches (#206)", () => {
  const team = (i: number) => ({ id: TEAMS[i].slug, name: TEAMS[i].name, abbr: TEAMS[i].abbreviation, grade: TEAMS[i].grade, players: defaultStarters(TEAMS[i].players) });

  it("every card event is held up by the referee, in its colour, with the decision and the player's name, before the next event", () => {
    let cards = 0;
    for (const seed of [5, 8, 13, 21, 34, 55]) {
      const st = eng.createMatch({ fixtureId: "c" + seed, seed, kickoffAt: 0, home: team(seed % 16), away: team((seed * 3 + 2) % 16), timing: eng.buildTiming(6000, 1) });
      const events: MatchEvent[] = eng.advanceTo(st, 1e12);
      const lineups = Object.fromEntries((["home", "away"] as Side[]).map((s) => [s, st.teams[s].players.map((p: { name: string; no: number; role: string; is_starter: boolean }) => ({ name: p.name, no: p.no, role: p.role, starter: p.is_starter }))])) as Lineups;
      let prev: Pt = [50, 32];
      let lift = 0;
      const { rerender } = render(<Pitch frame={null} home={home} away={away} revealed />);
      events.forEach((e, i) => {
        const s = sceneFor(e, prev, 6000, events[i + 1], lift);
        if (!s) return;
        prev = s.ball[s.ball.length - 1];
        lift = sampleN(s.ballHeight, 1);
        if (e.t !== "yellow_card" && e.t !== "red_card") return;
        cards++;
        // the live playhead stays on the card until the next event: the signal and the badge are both up well before that
        const until = (events[i + 1].at - e.at) / s.ms;
        expect(until).toBeGreaterThan(0.62);
        for (const t of [0.62, Math.min(1.4, until - 0.01)]) {
          const f = frameAt(s, t, lineups);
          rerender(<Pitch frame={f} home={home} away={away} revealed={reveal(s, Math.min(1, t), f.ball, false).revealed} />);
          const red = e.t === "red_card";
          expect(screen.getByTestId("ref").getAttribute("data-pose")).toBe(red ? "card-red" : "card-yellow");
          expect(screen.getByTestId("ref-card").getAttribute("fill")).toBe(red ? "#ff3344" : "#ffd400");
          const badge = screen.getByTestId("card-badge");
          expect(badge).toHaveTextContent(red ? "RED CARD" : "BOOKED");
          expect(badge).toHaveTextContent(e.p!.trim().split(/\s+/).at(-1)!.toUpperCase());
        }
      });
      cleanup();
    }
    expect(cards).toBeGreaterThan(3); // the run really met yellow (and usually red) cards
  });
});
