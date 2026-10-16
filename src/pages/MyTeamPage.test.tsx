import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi, type WorldSnapshot } from "../lib/pocketbase";
import MyTeamPage from "./MyTeamPage";

vi.mock("../lib/pocketbase", () => ({
  footfiveApi: { world: vi.fn(), myTeam: vi.fn(), commandCharge: vi.fn(), teamFinances: vi.fn(), saveMyLineup: vi.fn() },
}));
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

type Squad = Awaited<ReturnType<typeof footfiveApi.myTeam>>;

const team = { id: "t1", name: "Neon United", abbreviation: "NEO", grade: "B", primary_color: "#00f0ff", secondary_color: "#ff00cc", badge_key: "neo", mode: "manual" as const };
// Roster order: two goalkeepers (g1, g2) and five outfield players.
const ROSTER = [["g1", "gk"], ["o1", "fwd"], ["o2", "mid"], ["o3", "def"], ["o4", "mid"], ["g2", "gk"], ["o5", "fwd"]] as const;

function squad(starters: string[]): Squad {
  return {
    team: { ...team, treasury: 500, battery_count: 0, default_stance: "balanced" },
    players: ROSTER.map(([id, role], i) => ({
      id, name: `Player ${id.toUpperCase()}`, role, attack: 50, defence: 50, energy: 100, condition: 100, intensity: "balanced",
      is_starter: starters.includes(id), effective_attack: 50, effective_defence: 50, sort_order: i, upgrade_cost: { attack: 10, defence: 10 },
    })),
    averages: { energy: 100, condition: 100 },
    managementOpen: true,
    effectNote: "Changes apply from your next kick-off",
    aiRules: [],
    batteryCost: 50,
    repairCostPerPoint: 2,
  };
}

async function mount(saved: string[], afterSave = saved) {
  vi.mocked(footfiveApi.world).mockResolvedValue({ managedTeam: team, nextFixture: null } as unknown as WorldSnapshot);
  vi.mocked(footfiveApi.myTeam).mockResolvedValueOnce(squad(saved)).mockResolvedValue(squad(afterSave));
  vi.mocked(footfiveApi.commandCharge).mockResolvedValue({ points: 0, max: 5, nextPointInMs: 0 });
  vi.mocked(footfiveApi.teamFinances).mockResolvedValue({ treasury: 500, entries: [] });
  vi.mocked(footfiveApi.saveMyLineup).mockResolvedValue({ ok: true });
  render(<MemoryRouter><MyTeamPage /></MemoryRouter>);
  await screen.findByText("Player G1");
}

/** The Starter/Reserve chip on a player's row, as a manager taps it. */
const chip = (id: string) => within(screen.getByText(`Player ${id.toUpperCase()}`).closest("li")!).getByTitle(/tap to (rest|start)/);
const tap = async (...ids: string[]) => {
  for (const id of ids) await userEvent.click(chip(id));
};
const save = () => screen.getByTestId("save-lineup");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("My Team line-up starts exactly one goalkeeper", () => {
  it.each([
    ["no goalkeepers", ["o1", "o2", "o3", "o4", "o5"], "Your saved line-up has no goalkeepers"],
    ["two goalkeepers", ["g1", "o1", "o2", "o3", "g2"], "Your saved line-up has 2 goalkeepers"],
  ])("warns about an already-saved line-up with %s before any edit", async (_name, saved, text) => {
    await mount(saved);

    expect(screen.getByTestId("lineup-gk-warning")).toHaveTextContent(`${text}, but the five must start exactly one.`);
    expect(screen.queryByTestId("save-lineup")).not.toBeInTheDocument();
  });

  it("shows no warning for a saved line-up with one goalkeeper", async () => {
    await mount(["g1", "o1", "o2", "o3", "o4"]);

    expect(screen.queryByTestId("lineup-gk-warning")).not.toBeInTheDocument();
    expect(screen.queryByText(/goalkeeper can start|Include a goalkeeper/)).not.toBeInTheDocument();
  });

  it("blocks saving a draft with two or no goalkeepers, then saves the corrected one-goalkeeper five", async () => {
    await mount(["g1", "o1", "o2", "o3", "o4"]);

    await tap("o4", "g2"); // g1 + g2
    expect(save()).toHaveTextContent("Save line-up (5/5)");
    expect(save()).toBeDisabled();
    expect(screen.getByText("Only one goalkeeper can start — you have 2 in your five.")).toBeInTheDocument();
    await userEvent.click(save());

    await tap("g1", "g2", "o4", "o5"); // outfield only
    expect(save()).toHaveTextContent("Save line-up (5/5)");
    expect(save()).toBeDisabled();
    expect(screen.getByText("Include a goalkeeper.")).toBeInTheDocument();
    expect(screen.queryByText(/goalkeeper can start/)).not.toBeInTheDocument();
    await userEvent.click(save());
    expect(footfiveApi.saveMyLineup).not.toHaveBeenCalled();

    await tap("o5", "g2"); // g2 alone
    expect(save()).toBeEnabled();
    expect(screen.queryByText(/goalkeeper can start|Include a goalkeeper/)).not.toBeInTheDocument();
    await userEvent.click(save());

    expect(footfiveApi.saveMyLineup).toHaveBeenCalledTimes(1);
    expect(footfiveApi.saveMyLineup).toHaveBeenCalledWith(["o1", "o2", "o3", "o4", "g2"], ["g1", "o5"]);
  });

  it("lets the manager correct an already-saved two-goalkeeper line-up and save it", async () => {
    await mount(["g1", "o1", "o2", "o3", "g2"], ["g1", "o1", "o2", "o3", "o4"]);
    expect(screen.getByTestId("lineup-gk-warning")).toBeInTheDocument();

    await tap("g2");
    expect(screen.queryByTestId("lineup-gk-warning")).not.toBeInTheDocument();
    expect(save()).toHaveTextContent("Save line-up (4/5)");
    expect(save()).toBeDisabled();
    await tap("o4");
    expect(save()).toBeEnabled();
    await userEvent.click(save());

    expect(footfiveApi.saveMyLineup).toHaveBeenCalledTimes(1);
    expect(footfiveApi.saveMyLineup).toHaveBeenCalledWith(["g1", "o1", "o2", "o3", "o4"], ["g2", "o5"]);
    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Line-up saved — applies from your next kick-off.");
    expect(screen.queryByTestId("save-lineup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lineup-gk-warning")).not.toBeInTheDocument();
  });

  it("keeps a rejected save's error and the warning for the unchanged saved line-up", async () => {
    await mount(["g1", "o1", "o2", "o3", "g2"]);
    vi.mocked(footfiveApi.saveMyLineup).mockRejectedValue(new Error("Starting five must include exactly one goalkeeper"));

    await tap("g2", "o4");
    await userEvent.click(save());

    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Starting five must include exactly one goalkeeper");
    // As before, a failed save closes the draft; the unchanged saved five is still flagged.
    expect(screen.queryByTestId("save-lineup")).not.toBeInTheDocument();
    expect(screen.getByTestId("lineup-gk-warning")).toHaveTextContent("Your saved line-up has 2 goalkeepers");
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(1);
  });
});
