import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi } from "../lib/pocketbase";
import RecordsPage from "./RecordsPage";

vi.mock("../lib/pocketbase", () => ({ footfiveApi: { recordsOverview: vi.fn() } }));
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("History Overview display", () => {
  it.each([
    ["r16", "Round of 16"],
    ["qf", "Quarter-finals"],
    ["sf", "Semi-finals"],
    ["final", "Final"],
  ])("shows the readable %s stage and full completed total", async (round, roundLabel) => {
    vi.mocked(footfiveApi.recordsOverview).mockResolvedValue({
      currentTournament: { id: "active", number: 538, round, roundLabel },
      completedTournaments: 537,
      recentChampions: [{ number: 537, champion: "Previous champion" }],
    });
    render(<MemoryRouter><RecordsPage /></MemoryRouter>);

    expect(await screen.findByText(`Tournament #538 · ${roundLabel}`)).toBeInTheDocument();
    expect(screen.getByText("Completed: 537")).toBeInTheDocument();
    expect(screen.getByText("Previous champion")).toBeInTheDocument();
    expect(screen.queryByText(`Tournament #538 · ${round}`)).not.toBeInTheDocument();
  });

  it("shows an empty history without inventing an active stage", async () => {
    vi.mocked(footfiveApi.recordsOverview).mockResolvedValue({
      currentTournament: null, completedTournaments: 0, recentChampions: [],
    });
    render(<MemoryRouter><RecordsPage /></MemoryRouter>);

    expect(await screen.findByText("Tournament #— · —")).toBeInTheDocument();
    expect(screen.getByText("Completed: 0")).toBeInTheDocument();
    expect(screen.getByText("No completed tournaments yet")).toBeInTheDocument();
  });
});
