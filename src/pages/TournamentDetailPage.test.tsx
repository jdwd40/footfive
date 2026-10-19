import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi } from "../lib/pocketbase";
import TournamentDetailPage from "./TournamentDetailPage";

vi.mock("../lib/pocketbase", () => ({ footfiveApi: { recordsTournamentDetail: vi.fn() } }));
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Row = Record<string, unknown>;
const matches = (prefix: string, n: number, roundKey: (i: number) => string): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    homeName: `${prefix} home ${i}`,
    awayName: `${prefix} away ${i}`,
    scoreHome: 2,
    scoreAway: 1,
    roundKey: roundKey(i),
  }));

function renderTournament() {
  render(
    <MemoryRouter initialEntries={["/records/tournaments/t7"]}>
      <Routes>
        <Route path="/records/tournaments/:id" element={<TournamentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Tournament detail rounds", () => {
  it("renders every provided match, more than one archive page, with other rounds after the standard ones", async () => {
    // 120 rows: more than the 100-row archive page; the server sends them all and the page must not truncate.
    const rounds = {
      r16: matches("r16-", 48, () => "r16"),
      qf: matches("qf-", 24, () => "qf"),
      sf: matches("sf-", 12, () => "sf"),
      final: matches("final-", 6, () => "final"),
      other: matches("other-", 30, (i) => (i % 2 ? "r32" : "")),
    };
    vi.mocked(footfiveApi.recordsTournamentDetail).mockResolvedValue({
      number: 7,
      champion: "Champion City",
      runnerUp: "Runner Town",
      totalGoals: 360,
      extraTimeMatches: 0,
      shootoutMatches: 0,
      topScorer: { name: "Top Striker", goals: 9 },
      rounds,
      matches: Object.values(rounds).flat(),
    });
    renderTournament();

    expect(await screen.findByRole("heading", { name: "Tournament #7" })).toBeInTheDocument();
    expect(footfiveApi.recordsTournamentDetail).toHaveBeenCalledWith("t7");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Round of 16",
      "Quarter-finals",
      "Semi-finals",
      "Final",
      "Other rounds",
    ]);
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/records/matches/"));
    expect(links).toHaveLength(120);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(Object.values(rounds).flat().map((m) => `/records/matches/${String(m.id)}`));
    expect(screen.getByRole("link", { name: "Records" })).toHaveAttribute("href", "/records");
    expect(screen.getByText("Top scorer: Top Striker (9)")).toBeInTheDocument();

    const other = screen.getByRole("heading", { name: "Other rounds" }).closest("section")!;
    expect(within(other).getAllByRole("link")).toHaveLength(30);
    // A legacy round key stays visible on its card; a missing key adds nothing.
    expect(within(other).getAllByText("r32")).toHaveLength(15);
    expect(within(links[90]).queryByText("r32")).not.toBeInTheDocument();
    expect(within(links[91]).getByText("r32")).toBeInTheDocument();
    expect(within(links[0]).queryByText("r16")).not.toBeInTheDocument();
  });

  it("an API without other rounds shows only the standard rounds that have matches", async () => {
    vi.mocked(footfiveApi.recordsTournamentDetail).mockResolvedValue({
      number: 3,
      rounds: { r16: [], qf: [], sf: matches("sf-", 2, () => "sf"), final: matches("final-", 1, () => "final") },
    });
    renderTournament();

    expect(await screen.findByRole("heading", { name: "Tournament #3" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Semi-finals", "Final"]);
    expect(screen.queryByText("Other rounds")).not.toBeInTheDocument();
  });
});
