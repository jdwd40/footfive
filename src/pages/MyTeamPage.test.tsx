import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi, type WorldSnapshot } from "../lib/pocketbase";
import MyTeamPage from "./MyTeamPage";

vi.mock("../lib/pocketbase", () => ({
  footfiveApi: { world: vi.fn(), myTeam: vi.fn(), commandCharge: vi.fn(), teamFinances: vi.fn(), saveMyLineup: vi.fn(), useBattery: vi.fn() },
}));
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

type Squad = Awaited<ReturnType<typeof footfiveApi.myTeam>>;

const team = { id: "t1", name: "Neon United", abbreviation: "NEO", grade: "B", primary_color: "#00f0ff", secondary_color: "#ff00cc", badge_key: "neo", mode: "manual" as const };
// Roster order: two goalkeepers (g1, g2) and five outfield players.
const ROSTER = [["g1", "gk"], ["o1", "fwd"], ["o2", "mid"], ["o3", "def"], ["o4", "mid"], ["g2", "gk"], ["o5", "fwd"]] as const;

/** The /my-team payload; `restore: null` is an older server without `batteryRestore`. */
function squad(starters: string[], { energy = {} as Record<string, number>, batteries = 0, restore = 40 as number | null } = {}): Squad {
  return {
    team: { ...team, treasury: 500, battery_count: batteries, default_stance: "balanced" },
    players: ROSTER.map(([id, role], i) => ({
      id, name: `Player ${id.toUpperCase()}`, role, attack: 50, defence: 50, energy: energy[id] ?? 100, condition: 100, intensity: "balanced",
      is_starter: starters.includes(id), effective_attack: 50, effective_defence: 50, sort_order: i, upgrade_cost: { attack: 10, defence: 10 },
    })),
    averages: { energy: 100, condition: 100 },
    managementOpen: true,
    effectNote: "Changes apply from your next kick-off",
    aiRules: [],
    batteryCost: 50,
    ...(restore === null ? {} : { batteryRestore: restore }),
    repairCostPerPoint: 2,
  };
}

async function mount(saved: string[], afterSave = saved) {
  await mountSquads(squad(saved), squad(afterSave));
}

/** First /my-team load, then what every reload after an action returns. */
async function mountSquads(first: Squad, reloaded: Squad) {
  vi.mocked(footfiveApi.world).mockResolvedValue({ managedTeam: team, nextFixture: null } as unknown as WorldSnapshot);
  vi.mocked(footfiveApi.myTeam).mockResolvedValueOnce(first).mockResolvedValue(reloaded);
  vi.mocked(footfiveApi.commandCharge).mockResolvedValue({ points: 0, max: 5, nextPointInMs: 0 });
  vi.mocked(footfiveApi.teamFinances).mockResolvedValue({ treasury: 500, entries: [] });
  vi.mocked(footfiveApi.saveMyLineup).mockResolvedValue({ ok: true });
  vi.mocked(footfiveApi.useBattery).mockResolvedValue({ ok: true });
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

describe("My Team battery copy follows the server's restore amount and inventory", () => {
  const FIVE = ["g1", "o1", "o2", "o3", "o4"];
  /** Expand a player's row, as a manager taps their name. */
  const openRow = async (id: string) => {
    const li = screen.getByText(`Player ${id.toUpperCase()}`).closest("li")!;
    await userEvent.click(within(li).getByRole("button", { name: new RegExp(`Player ${id.toUpperCase()}`) }));
    return li;
  };

  it.each([
    ["the live 40", 40, 60],
    ["any other configured amount", 25, 45],
  ])("partial: a battery on a 20%%-energy player uses %s and reports the reloaded energy", async (_name, restore, after) => {
    await mountSquads(squad(FIVE, { energy: { o1: 20 }, batteries: 2, restore }), squad(FIVE, { energy: { o1: after }, batteries: 1, restore }));
    expect(screen.getByTestId("battery-note")).toHaveTextContent(`Each battery adds up to ${restore} energy to one player, capped at 100%.`);
    const li = await openRow("o1");
    expect(within(li).getByTestId("effective-hint")).toHaveTextContent("Effective ATK/DEF is the base stat adjusted for role, intensity, energy and condition");
    expect(within(li).getByRole("button", { name: "ATK +1 (10)" })).toBeEnabled();

    await userEvent.click(within(li).getByRole("button", { name: `Battery (up to +${restore})` }));

    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
    expect(footfiveApi.useBattery).toHaveBeenCalledWith("o1");
    expect(await screen.findByTestId("team-msg")).toHaveTextContent(`Battery used on Player O1 (up to +${restore}) — energy now ${after}%.`);
    expect(within(li).getByText(new RegExp(`^Energy ${after}% · condition 100%`))).toBeInTheDocument();
    expect(screen.getByText(/Batteries/)).toHaveTextContent("Batteries 1");
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(2);
  });

  it("cap: a battery on a 90%-energy player reports the server's 100%, then disables for the full player", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 90 }, batteries: 2 }), squad(FIVE, { energy: { o1: 100 }, batteries: 1 }));
    const li = await openRow("o1");

    await userEvent.click(within(li).getByRole("button", { name: "Battery (up to +40)" }));

    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Battery used on Player O1 (up to +40) — energy now 100%.");
    expect(within(li).getByText(/^Energy 100% · condition 100%/)).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: "Battery (up to +40)" })).toBeDisabled();
  });

  it.each([
    ["is disabled with an empty inventory", 0, 50, false],
    ["is disabled for a full player", 3, 100, false],
    ["stays enabled for a tired player with batteries in stock", 3, 50, true],
  ])("Use battery %s", async (_name, batteries, energy, enabled) => {
    await mountSquads(squad(FIVE, { energy: { o1: energy }, batteries }), squad(FIVE, { energy: { o1: energy }, batteries }));
    const li = await openRow("o1");
    const button = within(li).getByRole("button", { name: "Battery (up to +40)" });

    if (enabled) expect(button).toBeEnabled();
    else {
      expect(button).toBeDisabled();
      await userEvent.click(button);
      expect(footfiveApi.useBattery).not.toHaveBeenCalled();
    }
  });

  it("older server without batteryRestore: generic partial copy with no number, then the reloaded energy", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 20 }, batteries: 1, restore: null }), squad(FIVE, { energy: { o1: 60 }, batteries: 0, restore: null }));
    const garage = screen.getByTestId("battery-note").closest("section")!;
    expect(screen.getByTestId("battery-note")).toHaveTextContent("Each battery adds some energy to one player, capped at 100%.");
    const li = await openRow("o1");

    await userEvent.click(within(li).getByRole("button", { name: "Use battery" }));

    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Battery used on Player O1 — energy now 60%.");
    for (const el of [garage, li, screen.getByTestId("team-msg")]) expect(el.textContent).not.toMatch(/undefined|NaN|null|up to|\+\d+\)|full/i);
    expect(within(li).getByRole("button", { name: "Use battery" })).toBeDisabled(); // inventory now 0
  });
});

describe("My Team battery availability reason", () => {
  const FIVE = ["g1", "o1", "o2", "o3", "o4"];
  const NO_INVENTORY = "No batteries in stock — buy one in the Garage.";
  const FULL = "Energy is full — no battery needed.";
  const BUSY = "Wait for the current action to finish.";
  const openRow = async (id: string) => {
    const li = screen.getByText(`Player ${id.toUpperCase()}`).closest("li")!;
    await userEvent.click(within(li).getByRole("button", { name: new RegExp(`Player ${id.toUpperCase()}`) }));
    return li;
  };
  const batteryButton = (li: HTMLElement) => within(li).getByRole("button", { name: "Battery (up to +40)" });
  /** The visible node the button names with aria-describedby. Not a layout or class check. */
  function disableReason(button: HTMLElement) {
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const reason = document.getElementById(id!);
    expect(reason).toBeVisible();
    expect(reason).toHaveAttribute("data-testid", "battery-reason");
    return reason!;
  }

  it("enables Use battery when the team owns one and the player is at 50% energy", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 50 }, batteries: 1 }), squad(FIVE, { energy: { o1: 50 }, batteries: 1 }));
    const button = batteryButton(await openRow("o1"));

    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(footfiveApi.useBattery).not.toHaveBeenCalled();
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(1);
  });

  it("uses the last battery, reloads a still-tired player, then disables with the no-inventory reason", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 50 }, batteries: 1 }), squad(FIVE, { energy: { o1: 90 }, batteries: 0 }));
    const li = await openRow("o1");

    await userEvent.click(batteryButton(li));

    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
    expect(footfiveApi.useBattery).toHaveBeenCalledWith("o1");
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(2);
    expect(footfiveApi.world).toHaveBeenCalledTimes(1);
    expect(footfiveApi.saveMyLineup).not.toHaveBeenCalled();
    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Battery used on Player O1 (up to +40) — energy now 90%.");
    expect(within(li).getByText(/^Energy 90% · condition 100%/)).toBeInTheDocument();
    expect(screen.getByText(/Batteries/)).toHaveTextContent("Batteries 0");
    const button = batteryButton(li);
    expect(button).toBeDisabled();
    expect(disableReason(button)).toHaveTextContent(NO_INVENTORY);
    await userEvent.click(button);
    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
  });

  it("disables a full player who owns one battery and associates the full reason", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 100 }, batteries: 1 }), squad(FIVE, { energy: { o1: 100 }, batteries: 1 }));
    const button = batteryButton(await openRow("o1"));

    expect(button).toBeDisabled();
    expect(disableReason(button)).toHaveTextContent(FULL);
    await userEvent.click(button);
    expect(footfiveApi.useBattery).not.toHaveBeenCalled();
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(1);
  });

  it("disables a tired player with an empty inventory and shows that reason", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 50 }, batteries: 0 }), squad(FIVE, { energy: { o1: 50 }, batteries: 0 }));
    const button = batteryButton(await openRow("o1"));

    expect(button).toBeDisabled();
    expect(disableReason(button)).toHaveTextContent(NO_INVENTORY);
    expect(disableReason(button)).not.toHaveTextContent(FULL);
    await userEvent.click(button);
    expect(footfiveApi.useBattery).not.toHaveBeenCalled();
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(1);
  });

  it("disables Use battery while the action is in flight, then enables it again", async () => {
    await mountSquads(squad(FIVE, { energy: { o1: 50 }, batteries: 2 }), squad(FIVE, { energy: { o1: 90 }, batteries: 1 }));
    let release!: (value: { ok: boolean }) => void;
    vi.mocked(footfiveApi.useBattery).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const li = await openRow("o1");
    const button = batteryButton(li);
    const clicked = userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(disableReason(button)).toHaveTextContent(BUSY);
    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await clicked;

    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Battery used on Player O1 (up to +40) — energy now 90%.");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
    expect(footfiveApi.myTeam).toHaveBeenCalledTimes(2);
    expect(footfiveApi.world).toHaveBeenCalledTimes(1);
  });
});
