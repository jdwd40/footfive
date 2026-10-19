import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi } from "../lib/pocketbase";
import TeamDetailPage from "./TeamDetailPage";

vi.mock("../lib/pocketbase", () => ({ footfiveApi: { recordsTeamDetail: vi.fn() } }));
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTeam() {
  render(
    <MemoryRouter initialEntries={["/records/teams/doge"]}>
      <Routes>
        <Route path="/records/teams/:id" element={<TeamDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Team detail recent matches", () => {
  it("annotates shootouts in home-away order and leaves an ordinary score alone", async () => {
    vi.mocked(footfiveApi.recordsTeamDetail).mockResolvedValue({
      name: "Doge City",
      grade: "B",
      championships: 0,
      wins: 1,
      draws: 0,
      losses: 1,
      goals_for: 2,
      goals_against: 1,
      treasury: 0,
      recentMatches: [
        {
          id: "m1",
          homeName: "Tripper City",
          scoreHome: 0,
          scoreAway: 0,
          awayName: "Doge City",
          roundKey: "final",
          wentShootout: true,
          shootoutHome: 3,
          shootoutAway: 4,
        },
        {
          id: "m2",
          homeName: "Other Town",
          scoreHome: 2,
          scoreAway: 2,
          awayName: "Doge City",
          roundKey: "sf",
          wentShootout: true,
          shootoutHome: 5,
          shootoutAway: 6,
        },
        {
          id: "m3",
          homeName: "Doge City",
          scoreHome: 2,
          scoreAway: 1,
          awayName: "Plain United",
          roundKey: "qf",
          wentShootout: false,
        },
      ],
    });
    renderTeam();

    const level = await screen.findByRole("link", { name: /Tripper City 0–0 Doge City/ });
    expect(footfiveApi.recordsTeamDetail).toHaveBeenCalledWith("doge");
    expect(level).toHaveAttribute("href", "/records/matches/m1");
    expect(level).toHaveTextContent("pens 3–4");
    expect(level).toHaveTextContent("final");
    expect(level).not.toHaveTextContent("pens 4–3");
    expect(level).not.toHaveTextContent("Tripper City 3–4");

    const away = screen.getByRole("link", { name: /Other Town 2–2 Doge City/ });
    expect(away).toHaveAttribute("href", "/records/matches/m2");
    expect(away).toHaveTextContent("pens 5–6");
    expect(away).toHaveTextContent("sf");
    expect(away).not.toHaveTextContent("pens 6–5");
    expect(away).not.toHaveTextContent("Doge City 2–2 Other Town");

    const plain = screen.getByRole("link", { name: /Doge City 2–1 Plain United/ });
    expect(plain).toHaveAttribute("href", "/records/matches/m3");
    expect(plain).toHaveTextContent("qf");
    expect(plain).not.toHaveTextContent("pens");
  });
});