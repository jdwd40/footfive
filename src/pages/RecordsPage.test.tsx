import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi } from "../lib/pocketbase";
import RecordsPage from "./RecordsPage";

vi.mock("../lib/pocketbase", () => ({
  footfiveApi: { recordsOverview: vi.fn(), recordsMatches: vi.fn(), recordsPlayers: vi.fn(), recordsTournaments: vi.fn() },
}));
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

type Row = Record<string, unknown>;
const match = (id: string): Row => ({ id, homeName: `Home ${id}`, awayName: `Away ${id}`, scoreHome: 1, scoreAway: 0, roundKey: "qf" });
const matchText = (id: string) => `Home ${id} 1–0 Away ${id}`;
const page = <K extends string>(key: K, rows: Row[], n: number, hasMore: boolean) => ({ [key]: rows, page: n, perPage: 100, hasMore }) as Record<K, Row[]> & { page: number; perPage: number; hasMore: boolean };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openTab(name: string) {
  vi.mocked(footfiveApi.recordsOverview).mockResolvedValue({});
  if (!screen.queryByRole("button", { name })) render(<MemoryRouter><RecordsPage /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name }));
}

describe("History lists Load more", () => {
  it("Archive keeps today's first request, appends page 2 without repeating a row and stops when hasMore ends", async () => {
    vi.mocked(footfiveApi.recordsMatches)
      .mockResolvedValueOnce(page("matches", [match("a"), match("b")], 1, true))
      .mockResolvedValueOnce(page("matches", [match("b"), match("c")], 2, false));
    await openTab("Archive");

    expect(await screen.findByText(matchText("b"))).toBeInTheDocument();
    expect(footfiveApi.recordsMatches).toHaveBeenLastCalledWith("");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText(matchText("c"))).toBeInTheDocument();
    expect(footfiveApi.recordsMatches).toHaveBeenLastCalledWith("page=2");
    expect(screen.getAllByText(/^Home [abc] 1–0/).map((el) => el.textContent)).toEqual([matchText("a"), matchText("b"), matchText("c")]);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("Players keep all=1 on every page and Tournaments page with their own query", async () => {
    vi.mocked(footfiveApi.recordsPlayers)
      .mockResolvedValueOnce(page("players", [{ id: "p1", name: "First Player" }], 1, true))
      .mockResolvedValueOnce(page("players", [{ id: "p2", name: "Second Player" }], 2, false));
    await openTab("Players");
    await screen.findByText("First Player");
    expect(footfiveApi.recordsPlayers).toHaveBeenLastCalledWith("all=1");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second Player")).toBeInTheDocument();
    expect(footfiveApi.recordsPlayers).toHaveBeenLastCalledWith("all=1&page=2");

    vi.mocked(footfiveApi.recordsTournaments)
      .mockResolvedValueOnce(page("tournaments", [{ id: "t9", number: 9 }], 1, true))
      .mockResolvedValueOnce(page("tournaments", [{ id: "t8", number: 8 }], 2, true));
    await openTab("Tournaments");
    await screen.findByText("Tournament #9");
    expect(footfiveApi.recordsTournaments).toHaveBeenLastCalledWith("");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Tournament #8")).toBeInTheDocument();
    expect(footfiveApi.recordsTournaments).toHaveBeenLastCalledWith("page=2");
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
  });

  it("an older server without paging fields shows its list and no Load more", async () => {
    vi.mocked(footfiveApi.recordsMatches).mockResolvedValueOnce({ matches: [match("a")] });
    await openTab("Archive");
    expect(await screen.findByText(matchText("a"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("ignores a Load more page that lands after the tab reloads, and the reload starts again from page 1", async () => {
    const late = deferred<ReturnType<typeof page<"matches">>>();
    vi.mocked(footfiveApi.recordsMatches)
      .mockResolvedValueOnce(page("matches", [match("a")], 1, true))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(page("matches", [match("fresh")], 1, true))
      .mockResolvedValueOnce(page("matches", [match("next")], 2, false));
    vi.mocked(footfiveApi.recordsPlayers).mockResolvedValue({ players: [] });
    await openTab("Archive");
    await screen.findByText(matchText("a"));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    await openTab("Players");
    await openTab("Archive");
    expect(await screen.findByText(matchText("fresh"))).toBeInTheDocument();
    await act(async () => late.resolve(page("matches", [match("stale")], 2, true)));
    expect(screen.queryByText(matchText("stale"))).not.toBeInTheDocument();
    expect(screen.queryByText(matchText("a"))).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(matchText("next"))).toBeInTheDocument();
    expect(footfiveApi.recordsMatches).toHaveBeenLastCalledWith("page=2");
  });

  it("ignores a first page that fails after the user has moved to another tab", async () => {
    const late = deferred<never>();
    vi.mocked(footfiveApi.recordsMatches).mockReturnValueOnce(late.promise);
    vi.mocked(footfiveApi.recordsPlayers).mockResolvedValue({ players: [{ id: "p1", name: "Shown Player" }] });
    await openTab("Archive");
    await openTab("Players");
    await screen.findByText("Shown Player");
    await act(async () => late.reject(new Error("Old archive failure")));
    expect(screen.queryByText("Old archive failure")).not.toBeInTheDocument();
  });

  it("a failed Load more keeps the shown rows and retries the same page", async () => {
    vi.mocked(footfiveApi.recordsMatches)
      .mockResolvedValueOnce(page("matches", [match("a")], 1, true))
      .mockRejectedValueOnce(new Error("Archive unavailable"))
      .mockResolvedValueOnce(page("matches", [match("b")], 2, false));
    await openTab("Archive");
    await screen.findByText(matchText("a"));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Archive unavailable")).toBeInTheDocument();
    expect(screen.getByText(matchText("a"))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(matchText("b"))).toBeInTheDocument();
    expect(vi.mocked(footfiveApi.recordsMatches).mock.calls.slice(1)).toEqual([["page=2"], ["page=2"]]);
    expect(screen.queryByText("Archive unavailable")).not.toBeInTheDocument();
  });
});
