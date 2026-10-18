import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footfiveApi, type TacticalScan, type TacticalScanReport, type WorldSnapshot } from "../lib/pocketbase";
import MyTeamPage from "./MyTeamPage";

vi.mock("../lib/pocketbase", () => ({
  footfiveApi: { world: vi.fn(), myTeam: vi.fn(), commandCharge: vi.fn(), teamFinances: vi.fn(), saveMyLineup: vi.fn(), useBattery: vi.fn(), spendCommandCharge: vi.fn(), tacticalScans: vi.fn() },
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

/** First /my-team load, then what every reload after an action returns. Saved scans stay off this load. */
async function mountSquads(
  first: Squad,
  reloaded: Squad,
  charge = { points: 0, max: 5, nextPointInMs: 0 },
  scans: () => Promise<{ scans: TacticalScan[] }> = async () => ({ scans: [] }),
) {
  vi.mocked(footfiveApi.world).mockResolvedValue({ managedTeam: team, nextFixture: null } as unknown as WorldSnapshot);
  vi.mocked(footfiveApi.myTeam).mockResolvedValueOnce(first).mockResolvedValue(reloaded);
  vi.mocked(footfiveApi.commandCharge).mockResolvedValue(charge);
  vi.mocked(footfiveApi.teamFinances).mockResolvedValue({ treasury: 500, entries: [] });
  vi.mocked(footfiveApi.saveMyLineup).mockResolvedValue({ ok: true });
  vi.mocked(footfiveApi.useBattery).mockResolvedValue({ ok: true });
  vi.mocked(footfiveApi.tacticalScans).mockImplementation(scans);
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

describe("My Team management help", () => {
  const FIVE = ["g1", "o1", "o2", "o3", "o4"];
  const openRow = async (id: string) => {
    const li = screen.getByText(`Player ${id.toUpperCase()}`).closest("li")!;
    await userEvent.click(within(li).getByRole("button", { name: new RegExp(`Player ${id.toUpperCase()}`) }));
    return li;
  };

  it("explains energy, condition and the actions from an older payload, and keeps the 1 and 2 costs", async () => {
    await mountSquads(squad(FIVE), squad(FIVE), { points: 1, max: 5, nextPointInMs: 0 });
    const scan = screen.getByRole("button", { name: "Tactical scan (1)" });
    const overclock = screen.getByRole("button", { name: "Overclock (2)" });
    expect(scan).toBeEnabled();
    expect(overclock).toBeDisabled();
    await userEvent.click(screen.getByText("What do these do?"));
    expect(screen.getByTestId("scan-help").textContent).toMatch(/Tactical scan \(1 Charge\)/);
    expect(screen.getByTestId("scan-help").textContent).toMatch(/no boost/);
    expect(screen.getByTestId("overclock-help").textContent).toMatch(/five who actually start/);
    expect(screen.getByTestId("overclock-help").textContent).toMatch(/an energy cost/);
    expect(screen.queryByText(/approxAttack|Team strength about/)).toBeNull();
    const li = await openRow("o1");
    await userEvent.click(within(li).getByText("Why these numbers?"));
    expect(within(li).queryByTestId("stat-breakdown")).toBeNull();
    expect(within(li).getByTestId("energy-help").textContent).toMatch(/recovers automatically/);
    expect(within(li).getByTestId("condition-help").textContent).toMatch(/Repair restores it/);
    expect(within(li).getByTestId("estimate-help").textContent).toMatch(/chance tempo/);
    expect(within(li).getByTestId("estimate-help").textContent).toMatch(/individual ATK\/DEF/);
    expect(within(li).getByTestId("stat-help").textContent).not.toMatch(/NaN|undefined/);
    expect(screen.getByTestId("charge-help").textContent).not.toMatch(/NaN|undefined/);
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });

  it("shows the server factors and uses the server Charge costs for the labels and the disable checks", async () => {
    const base = squad(FIVE, { energy: { o1: 64 } });
    const explained = {
      ...base,
      managementHelp: { overclockBonus: 1.2, overclockEnergyCost: 9, overclockChargeCost: 3, tacticalScanChargeCost: 2 },
      players: base.players.map((p) => p.id === "o1"
        ? {
          ...p,
          condition: 23,
          effective_attack: 31.2,
          effective_defence: 28.4,
          effective_modifiers: {
            base: { attack: 50, defence: 50 },
            role: { attack: 0.85, defence: 0.85 },
            intensity: { attack: 1, defence: 1 },
            energy: 0.874,
            condition: 0.7305,
            overclock: 1.12,
          },
        }
        : p),
    };
    await mountSquads(explained, explained, { points: 2, max: 5, nextPointInMs: 0 });
    expect(screen.getByRole("button", { name: "Tactical scan (2)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Overclock (3)" })).toBeDisabled();
    await userEvent.click(screen.getByText("What do these do?"));
    expect(screen.getByTestId("overclock-help").textContent).toContain("×1.2 (+20%)");
    expect(screen.getByTestId("overclock-help").textContent).toContain("9 energy");
    expect(screen.getByTestId("scan-help").textContent).toContain("(2 Charge)");
    expect(screen.queryByText(/Team strength about/)).toBeNull();
    const li = await openRow("o1");
    await userEvent.click(within(li).getByText("Why these numbers?"));
    const table = within(li).getByTestId("stat-breakdown");
    expect(table.textContent).toContain("Role (FWD)");
    expect(table.textContent).toContain("×0.85");
    expect(table.textContent).toContain("Energy 64%");
    expect(table.textContent).toContain("Condition 23%");
    expect(table.textContent).toContain("Overclock (armed)");
    expect(table.textContent).toContain("×1.12");
    expect(table.textContent).toContain("31.2");
    expect(table.textContent).toContain("28.4");
    expect(table.textContent).not.toMatch(/tactics/i);
    expect(within(li).getByTestId("overclock-preview-help").textContent).toMatch(/kick-off by the five who actually start/);
    expect(within(li).getByTestId("estimate-help").textContent).toMatch(/individual ATK\/DEF/);
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });
});

describe("My Team tactical scan reports", () => {
  const FIVE = ["g1", "o1", "o2", "o3", "o4"];
  const CHARGE = { points: 5, max: 5, nextPointInMs: 0 };

  function report(teamName: string, approxAttack: number, extra: Partial<TacticalScanReport> = {}): TacticalScanReport {
    return {
      teamName,
      grade: "A",
      approxAttack,
      approxDefence: 48,
      energyRange: [40, 80],
      conditionRange: [30, 31],
      confidence: "medium",
      ...extra,
    };
  }
  function row(id: string, teamName: string, approxAttack: number, created: string, fixtureId = `fx-${id}`, extra: Partial<TacticalScanReport> = {}): TacticalScan {
    return { id, fixtureId, created, report: report(teamName, approxAttack, extra) };
  }

  it("shows a saved report without spending, in server order, and keeps a reversed range unavailable", async () => {
    const scans = [
      row("s1", "First Side", 61, "2026-10-18 15:04:00.000Z"),
      row("s2", "Second Side", 62, "2026-10-17 15:04:00.000Z"),
      row("s3", "Third Side", 63, "2026-10-19 15:04:00.000Z"),
      row("s4", "Fourth Side", 64, "2026-10-16 15:04:00.000Z", "fx-s4", { energyRange: "bad" as unknown as TacticalScanReport["energyRange"] }),
      row("s5", "Fifth Side", 65, "2026-10-15 15:04:00.000Z", "fx-s5", { energyRange: [80, 20] }),
    ];
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE, async () => ({ scans }));

    const list = screen.getByTestId("scan-list");
    const labels = within(list).getAllByRole("button").map((b) => b.textContent || "");
    expect(labels.map((label) => label.slice(0, 6))).toEqual(["First ", "Second", "Third ", "Fourth", "Fifth "]);
    expect(list.textContent).toContain("18 Oct 2026, 15:04 UTC");
    expect(list.textContent).not.toContain("fx-s1");
    await userEvent.click(within(list).getByRole("button", { name: /Fifth Side/ }));
    const panel = screen.getByTestId("scan-report");
    expect(panel).toHaveTextContent("Fifth Side");
    expect(panel).toHaveTextContent("Grade A");
    expect(panel).toHaveTextContent("Approx attack 65");
    expect(panel).toHaveTextContent("Approx defence 48");
    expect(panel).toHaveTextContent("Energy unavailable");
    expect(panel).toHaveTextContent("Condition 30–31%");
    expect(panel).toHaveTextContent("Reports are snapshots taken at purchase and do not update live.");
    expect(screen.getByTestId("scan-reports")).toHaveTextContent("Tactical scans");
    expect(panel).toHaveTextContent("Confidence medium");
    expect(panel.textContent).not.toMatch(/80\s*[–-]\s*20|20\s*[–-]\s*80/);
    expect(panel.textContent).not.toContain("fx-s5");
    await userEvent.click(within(list).getByRole("button", { name: /Fourth Side/ }));
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Energy unavailable");
    expect(screen.getByTestId("scan-report").textContent).not.toContain("bad");
    expect(document.body.textContent).not.toContain("fx-s5");
    await userEvent.click(within(list).getByRole("button", { name: /First Side/ }));
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Energy 40–80%");
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Condition 30–31%");
    await userEvent.click(within(screen.getByTestId("scan-report")).getByRole("button", { name: "Hide report" }));
    expect(screen.queryByTestId("scan-report")).not.toBeInTheDocument();
    expect(screen.getByTestId("scan-list").textContent).toContain("Fifth Side");
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });

  it("switches the displayed snapshot only when a saved row is chosen", async () => {
    const alpha = row("a", "Alpha", 21, "2026-10-18 10:00:00.000Z");
    const bravo = row("b", "Bravo", 22, "2026-10-18 11:00:00.000Z");
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE, async () => ({ scans: [alpha, bravo] }));
    await userEvent.click(screen.getByRole("button", { name: /Bravo/ }));
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Approx attack 22");
    await userEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Approx attack 21");
    expect(screen.getByTestId("scan-report")).not.toHaveTextContent("Approx attack 22");
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });

  it("shows the purchased snapshot when the squad reload fails, and does not buy it again", async () => {
    const bought = report("Just Bought", 77);
    vi.mocked(footfiveApi.spendCommandCharge).mockResolvedValue({ ok: true, action: "tactical_scan", fixtureId: "hidden-fixture", report: bought });
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE);
    vi.mocked(footfiveApi.myTeam).mockRejectedValueOnce(new Error("reload down"));
    await userEvent.click(screen.getByRole("button", { name: "Tactical scan (1)" }));
    const panel = await screen.findByTestId("scan-report");
    expect(panel).toHaveTextContent("Just Bought");
    expect(panel).toHaveTextContent("Approx attack 77");
    expect(panel.textContent).not.toContain("hidden-fixture");
    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Saved the scan, but the squad could not refresh.");
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledWith("tactical_scan");
    expect(screen.getByTestId("scan-reports").textContent?.match(/Approx attack 77/g)).toHaveLength(1);
  });

  it("keeps the purchased snapshot when an older or different saved list arrives", async () => {
    let releaseOld!: (value: { scans: TacticalScan[] }) => void;
    const oldList = new Promise<{ scans: TacticalScan[] }>((resolve) => { releaseOld = resolve; });
    let calls = 0;
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE, () => {
      calls += 1;
      if (calls === 1) return oldList;
      return Promise.resolve({
        scans: [row("new", "Just Bought", 99, "2026-10-18 16:00:00.000Z", "hidden-fixture"), row("old", "Old Side", 11, "2026-10-17 16:00:00.000Z")],
      });
    });
    vi.mocked(footfiveApi.spendCommandCharge).mockResolvedValue({
      ok: true,
      action: "tactical_scan",
      fixtureId: "hidden-fixture",
      report: report("Just Bought", 77),
    });
    await userEvent.click(screen.getByRole("button", { name: "Tactical scan (1)" }));
    const attackField = (node: HTMLElement) => node.textContent?.match(/Approx attack \d+/)?.[0];
    const panel = await screen.findByTestId("scan-report");
    expect(attackField(panel)).toBe("Approx attack 77");
    const oldRow = await screen.findByRole("button", { name: /Old Side/ });
    await userEvent.click(oldRow);
    expect(attackField(screen.getByTestId("scan-report"))).toBe("Approx attack 11");
    await act(async () => {
      releaseOld({ scans: [row("old", "Old Side", 1, "2026-10-17 16:00:00.000Z")] });
      await Promise.resolve();
    });
    expect(footfiveApi.tacticalScans).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Old Side");
    expect(attackField(screen.getByTestId("scan-report"))).toBe("Approx attack 11");
    expect(screen.getByTestId("scan-list").textContent?.indexOf("Just Bought")).toBeLessThan(screen.getByTestId("scan-list").textContent?.indexOf("Old Side") ?? -1);
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("hidden-fixture");
  });

  it("shows a scan-list error with retry and still lets a battery action finish", async () => {
    let calls = 0;
    await mountSquads(
      squad(FIVE, { energy: { o1: 50 }, batteries: 2 }),
      squad(FIVE, { energy: { o1: 90 }, batteries: 1 }),
      CHARGE,
      () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("list down"));
        return Promise.resolve({ scans: [] });
      },
    );
    expect(await screen.findByTestId("scan-error")).toHaveTextContent("list down");
    expect(screen.queryByTestId("team-msg")).not.toBeInTheDocument();
    const li = screen.getByText("Player O1").closest("li")!;
    await userEvent.click(within(li).getByRole("button", { name: /Player O1/ }));
    await userEvent.click(within(li).getByRole("button", { name: "Battery (up to +40)" }));
    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Battery used on Player O1 (up to +40) — energy now 90%.");
    expect(footfiveApi.useBattery).toHaveBeenCalledTimes(1);
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("scan-error")).not.toBeInTheDocument());
    expect(screen.getByTestId("scan-empty")).toHaveTextContent("No saved tactical scans.");
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
    expect(footfiveApi.tacticalScans).toHaveBeenCalledTimes(2);
  });

  it("keeps the purchased snapshot when the saved-list request fails, and retry does not buy again", async () => {
    let calls = 0;
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE, () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ scans: [] });
      if (calls === 2) return Promise.reject(new Error("list down"));
      return Promise.resolve({ scans: [row("new", "Just Bought", 77, "2026-10-18 16:00:00.000Z", "hidden-fixture")] });
    });
    vi.mocked(footfiveApi.spendCommandCharge).mockResolvedValue({
      ok: true,
      action: "tactical_scan",
      fixtureId: "hidden-fixture",
      report: report("Just Bought", 77),
    });
    await userEvent.click(screen.getByRole("button", { name: "Tactical scan (1)" }));
    expect(await screen.findByTestId("scan-report")).toHaveTextContent("Approx attack 77");
    expect(await screen.findByTestId("scan-error")).toHaveTextContent("list down");
    expect(screen.getByTestId("team-msg")).toHaveTextContent("Tactical scan ready.");
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("scan-error")).not.toBeInTheDocument());
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Approx attack 77");
    expect(screen.getByTestId("scan-reports").textContent?.match(/Approx attack 77/g)).toHaveLength(1);
    expect(screen.getByTestId("scan-report")).toHaveTextContent("18 Oct 2026, 16:00 UTC");
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("hidden-fixture");
  });

  it("shows the purchased report and leaves management actions enabled while the saved-report refresh is pending", async () => {
    let releaseSaved!: (value: { scans: TacticalScan[] }) => void;
    const pending = new Promise<{ scans: TacticalScan[] }>((resolve) => { releaseSaved = resolve; });
    let calls = 0;
    const tired = squad(FIVE, { energy: { o1: 50 }, batteries: 1 });
    await mountSquads(tired, tired, CHARGE, () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ scans: [] });
      return pending;
    });
    vi.mocked(footfiveApi.spendCommandCharge).mockResolvedValue({
      ok: true,
      action: "tactical_scan",
      fixtureId: "hidden-fixture",
      report: report("Just Bought", 77),
    });
    await userEvent.click(screen.getByRole("button", { name: "Tactical scan (1)" }));
    expect(await screen.findByTestId("scan-report")).toHaveTextContent("Approx attack 77");
    expect(await screen.findByTestId("team-msg")).toHaveTextContent("Tactical scan ready.");
    expect(footfiveApi.tacticalScans).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Overclock (2)" })).toBeEnabled();
    const starters = screen.getAllByTitle("In the five — tap to rest");
    expect(starters).toHaveLength(5);
    for (const chip of starters) expect(chip).toBeEnabled();
    const row = screen.getByText("Player O1").closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: /Player O1/ }));
    expect(within(row).getByRole("button", { name: "Battery (up to +40)" })).toBeEnabled();
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("scan-error")).not.toBeInTheDocument();
    await act(async () => {
      releaseSaved({ scans: [] });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeEnabled();
    expect(footfiveApi.spendCommandCharge).toHaveBeenCalledTimes(1);
  });
});

describe("My Team action availability", () => {
  const FIVE = ["g1", "o1", "o2", "o3", "o4"];
  const CHARGE = { points: 5, max: 5, nextPointInMs: 0 };
  const NO_KICKOFF = "No upcoming fixture: Overclock is available when your team has another kick-off.";
  const NO_FIXTURE = "No upcoming fixture to scan.";

  it("keeps both actions available when an older squad omits blockers, even with no next fixture", async () => {
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE);
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Overclock (2)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refresh availability" })).toBeEnabled();
    expect(screen.queryByTestId("scan-blocker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overclock-blocker")).not.toBeInTheDocument();
    expect(footfiveApi.world).toHaveBeenCalledTimes(1);
  });

  it("disables a blocked scan and Overclock with the server reason, and still offers refresh", async () => {
    const blocked = {
      ...squad(FIVE),
      actionBlockers: {
        overclock: { code: "no_kickoff" as const, message: NO_KICKOFF },
        tactical_scan: { code: "no_fixture" as const, message: NO_FIXTURE },
      },
    };
    await mountSquads(blocked, blocked, CHARGE);
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overclock (2)" })).toBeDisabled();
    expect(screen.getByTestId("scan-blocker")).toHaveTextContent(NO_FIXTURE);
    expect(screen.getByTestId("overclock-blocker")).toHaveTextContent(NO_KICKOFF);
    expect(screen.getByRole("button", { name: "Refresh availability" })).toBeEnabled();
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });

  it("uses the existing armed sentence instead of a second Overclock reason", async () => {
    const armed = {
      ...squad(FIVE),
      actionBlockers: {
        overclock: { code: "armed" as const, message: "Overclock is already armed for your next kick-off." },
        tactical_scan: null,
      },
    };
    await mountSquads(armed, armed, CHARGE);
    expect(screen.getByRole("button", { name: "Overclock (2)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeEnabled();
    expect(screen.getByText("Overclock armed for your next kick-off.")).toBeInTheDocument();
    expect(screen.queryByText("Overclock is already armed for your next kick-off.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh availability" })).toBeEnabled();
  });

  it("still disables actions that the Charge balance cannot pay when no blocker is set", async () => {
    const open = {
      ...squad(FIVE),
      actionBlockers: { overclock: null, tactical_scan: null },
    };
    await mountSquads(open, open, { points: 0, max: 5, nextPointInMs: 0 });
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overclock (2)" })).toBeDisabled();
    expect(screen.queryByTestId("scan-blocker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overclock-blocker")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh availability" })).toBeEnabled();
  });

  it("reloads the squad without a world poll, and keeps the line-up draft and selected scan", async () => {
    const saved = {
      id: "s1",
      fixtureId: "hidden-fixture",
      created: "2026-10-18 15:04:00.000Z",
      report: {
        teamName: "Wave City",
        grade: "A",
        approxAttack: 77,
        approxDefence: 48,
        energyRange: [40, 80] as [number, number],
        conditionRange: [30, 31] as [number, number],
        confidence: "medium",
      },
    };
    await mountSquads(squad(FIVE), squad(FIVE), CHARGE, async () => ({ scans: [saved] }));
    await userEvent.click(screen.getByRole("button", { name: /Wave City/ }));
    const g1 = screen.getByText("Player G1").closest("li")!;
    await userEvent.click(within(g1).getByTitle("In the five — tap to rest"));
    expect(screen.getByTestId("save-lineup")).toHaveTextContent("Save line-up (4/5)");
    await userEvent.click(screen.getByRole("button", { name: "Refresh availability" }));
    await waitFor(() => expect(footfiveApi.myTeam).toHaveBeenCalledTimes(2));
    expect(footfiveApi.world).toHaveBeenCalledTimes(1);
    expect(footfiveApi.tacticalScans).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("save-lineup")).toHaveTextContent("Save line-up (4/5)");
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Approx attack 77");
    expect(screen.getByTestId("scan-report")).toHaveTextContent("Wave City");
    expect(document.body.textContent).not.toContain("hidden-fixture");
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
    expect(footfiveApi.saveMyLineup).not.toHaveBeenCalled();
  });

  it("shows a local error when refresh fails and leaves the blocked actions and draft in place", async () => {
    const blocked = {
      ...squad(FIVE),
      actionBlockers: {
        overclock: null,
        tactical_scan: { code: "no_fixture" as const, message: NO_FIXTURE },
      },
    };
    await mountSquads(blocked, blocked, CHARGE);
    const g1 = screen.getByText("Player G1").closest("li")!;
    await userEvent.click(within(g1).getByTitle("In the five — tap to rest"));
    vi.mocked(footfiveApi.myTeam).mockRejectedValueOnce(new Error("availability down"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh availability" }));
    expect(await screen.findByTestId("availability-error")).toHaveTextContent("availability down");
    expect(screen.queryByTestId("team-msg")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh availability" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tactical scan (1)" })).toBeDisabled();
    expect(screen.getByTestId("save-lineup")).toHaveTextContent("Save line-up (4/5)");
    expect(footfiveApi.world).toHaveBeenCalledTimes(1);
    expect(footfiveApi.spendCommandCharge).not.toHaveBeenCalled();
  });
});
