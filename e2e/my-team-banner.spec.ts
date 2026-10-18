import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, injectAuth } from "./helpers";

// API-mocked My Team page. The success line must stay off the expanded squad after a real battery POST and reload.
const USER = {
  id: "ui131user000001",
  email: "ui131@example.invalid",
  display_name: "UI check",
  role: "user",
  must_change_password: false,
};
const TOKEN = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
const TEAM = {
  id: "t1",
  name: "Neon United",
  abbreviation: "NEO",
  grade: "B",
  primary_color: "#00f0ff",
  secondary_color: "#ff00cc",
  badge_key: "neo",
  mode: "manual",
  treasury: 500,
  battery_count: 2,
  default_stance: "balanced",
};
const SUCCESS = "Battery used on Player 0 (up to +40) \u2014 energy now 80%.";

function players(used: boolean) {
  return ["gk", "att", "mid", "def", "mid", "att", "def"].map((role, i) => ({
    id: `p${i}`,
    name: `Player ${i}`,
    role,
    attack: 70,
    defence: 70,
    energy: used && i === 0 ? 80 : 40,
    condition: 100,
    intensity: "balanced",
    is_starter: i < 5,
    effective_attack: 40,
    effective_defence: 40,
    sort_order: i,
    upgrade_cost: { attack: 259, defence: 259 },
  }));
}

test("battery success stays outside the expanded squad on mobile and desktop", async ({ page }) => {
  const errors: string[] = [];
  const unexpected: string[] = [];
  const actions: string[] = [];
  let used = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await injectAuth(page, TOKEN, USER);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let body: unknown;
    if (path === "/api/collections/users/auth-refresh") body = { token: TOKEN, record: USER };
    else if (path === "/api/footfive/me") body = { ...USER, credits: 1000 };
    else if (path === "/api/footfive/world") {
      body = {
        serverTimeMs: Date.now(),
        credits: 1000,
        startingCredits: 1000,
        managedTeam: TEAM,
        nextFixture: null,
        tournament: null,
        activeRound: null,
        timing: { betweenMinutes: 1, gapMinutes: 1, windowMinutes: 1, minuteSec: 15 },
        commandCharge: { points: 3, max: 5, nextPointInMs: 0 },
      };
    } else if (path === "/api/footfive/my-team") {
      body = {
        team: { ...TEAM, battery_count: used ? 1 : 2 },
        players: players(used),
        averages: { energy: 40, condition: 100 },
        managementOpen: true,
        effectNote: "Changes apply from your next kick-off",
        aiRules: [],
        batteryCost: 180,
        batteryRestore: 40,
        repairCostPerPoint: 12,
      };
    } else if (path === "/api/footfive/command-charge") body = { points: 3, max: 5, nextPointInMs: 0 };
    else if (path === "/api/footfive/my-team/finances") body = { treasury: 500, entries: [] };
    else if (path === "/api/footfive/my-team/tactical-scan" && method === "GET") body = { scans: [] };
    else if (path === "/api/footfive/players/p0/battery" && method === "POST") {
      actions.push(`${method} ${path}`);
      used = true;
      body = { ok: true };
    } else if (path === "/api/footfive/live") {
      body = {
        serverTimeMs: Date.now(),
        paused: false,
        mode: "between",
        timing: { minuteMs: 15000 },
        championship: null,
        round: null,
        fixtures: [],
        bracket: [],
        ticker: [],
        champion: null,
        nextChampionshipAt: null,
      };
    } else if (path === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else {
      unexpected.push(`${method} ${path}`);
      await route.abort();
      return;
    }
    await route.fulfill({ json: body });
  });

  await page.goto("/my-team");
  await page.getByText("Player 0", { exact: true }).click();
  const row = page.locator("li").filter({ has: page.getByText("Player 0", { exact: true }) });
  const battery = row.getByRole("button", { name: "Battery (up to +40)" });
  await expect(battery).toBeEnabled();
  await battery.click();

  const message = page.getByTestId("team-msg");
  await expect(message).toHaveText(SUCCESS);
  await expect(row).toContainText("Energy 80%");
  await expect(page.getByTestId("my-team")).toContainText(/Batteries\s*1/);
  await expect(battery).toBeVisible();
  await expect(row.getByRole("button", { name: "aggressive" })).toBeVisible();
  await row.scrollIntoViewIfNeeded();

  const geometry = await messageAndSquad(page);
  expect(geometry.sectionOverlap).toBe(0);
  expect(geometry.controlOverlap).toBe(0);
  expect(geometry.messageWidth).toBeGreaterThan(0);
  expect(geometry.controlWidth).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);
  expect(actions).toEqual(["POST /api/footfive/players/p0/battery"]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

/** Intersection area only. A non-covering corner notice can pass; a covering layer cannot. */
async function messageAndSquad(page: Page) {
  return page.evaluate(() => {
    const area = (a: DOMRect, b: DOMRect) => {
      const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return width * height;
    };
    const message = document.querySelector('[data-testid="team-msg"]');
    const row = [...document.querySelectorAll("li")].find((item) => item.textContent?.includes("Player 0"));
    const section = row?.closest("section");
    const control = [...(row?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Battery"));
    if (!message || !section || !control) return { sectionOverlap: -1, controlOverlap: -1, messageWidth: 0, controlWidth: 0 };
    const messageBox = message.getBoundingClientRect();
    const controlBox = control.getBoundingClientRect();
    return {
      sectionOverlap: area(messageBox, section.getBoundingClientRect()),
      controlOverlap: area(messageBox, controlBox),
      messageWidth: messageBox.width,
      controlWidth: controlBox.width,
    };
  });
}
