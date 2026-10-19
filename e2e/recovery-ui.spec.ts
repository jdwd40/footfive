import { expect, test, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

const RECORD = {
  id: "ui26admin000001",
  email: "ui26@example.invalid",
  display_name: "Verification admin",
  role: "admin",
  must_change_password: false,
};

const TOKEN = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(
  JSON.stringify({ exp: 4102444800 }),
).toString("base64url")}.mock`;

const CATCH_UP = "/api/footfive/admin/world/catch-up";

function appBase(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("Playwright baseURL is not configured");
  // A trailing slash keeps "admin" and "assets/..." on CI root and on /footfive/.
  return baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
}

test.describe("recovery ui", () => {
  test("retained public badge svg is served", async ({ request, baseURL }) => {
    const assetUrl = new URL("assets/badges/doge_city.svg", appBase(baseURL)).href;
    const asset = await request.get(assetUrl);
    expect(asset.status()).toBe(200);
    expect(asset.headers()["content-type"]).toMatch(/image\/svg\+xml/);
    expect(await asset.text()).toMatch(/<svg\b/);
  });

  test("admin catch-up shows the failure, then success clears it", async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await injectAuth(page, TOKEN, RECORD);
    const { actions, unexpected, seen } = await installAdminRoutes(page);

    await page.goto(new URL("admin", appBase(baseURL)).href);
    await expect(page.getByTestId("admin-shell")).toBeVisible();

    await page.getByRole("button", { name: "Catch up", exact: true }).click();
    await expect(page.getByText("Catch-up verification failed.", { exact: true })).toBeVisible();
    await expect(page.getByText("Catch-up run", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Catch up", exact: true }).click();
    await expect(page.getByText("Catch-up run", { exact: true })).toBeVisible();
    await expect(page.getByText("Catch-up verification failed.", { exact: true })).toHaveCount(0);

    expect(actions).toEqual([
      { path: CATCH_UP, method: "POST" },
      { path: CATCH_UP, method: "POST" },
    ]);
    expect(unexpected).toEqual([]);
    expect(
      seen.filter(
        (path) => /catch-up|recovery/.test(path) && !path.startsWith("/api/footfive/admin/"),
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
});

async function installAdminRoutes(page: Page) {
  const unexpected: string[] = [];
  const seen: string[] = [];
  const actions: Array<{ path: string; method: string }> = [];
  let attempts = 0;

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    seen.push(path);
    let body: Record<string, unknown>;

    if (path === "/api/collections/users/auth-refresh") body = { token: TOKEN, record: RECORD };
    else if (path === "/api/footfive/me") body = { ...RECORD, credits: 1000 };
    else if (path === "/api/footfive/world") body = { managedTeam: null };
    else if (path === "/api/footfive/bets/mine") {
      body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    } else if (path === "/api/footfive/live") {
      body = {
        serverTimeMs: Date.now(),
        paused: false,
        mode: "waiting",
        timing: { minuteMs: 15000 },
        championship: null,
        round: null,
        fixtures: [],
        bracket: [],
        ticker: [],
        champion: null,
        nextChampionshipAt: null,
      };
    } else if (path === "/api/footfive/admin/overview") {
      body = {
        users: 1,
        managedTeams: 0,
        availableTeams: 16,
        liveFixtures: 0,
        matchStates: 0,
        retentionDays: 30,
        progressionPaused: true,
        betweenRoundMinutes: 1,
        matchMinuteRealSeconds: 8,
        championshipGapMinutes: 10,
        fixturesWindowMinutes: 5,
      };
    } else if (path === "/api/footfive/admin/users") {
      body = { users: [], page: 1, perPage: 200, totalItems: 0, hasMore: false };
    } else if (path === "/api/footfive/records/teams") body = { teams: [] };
    else if (path === "/api/footfive/admin/audit") body = { entries: [] };
    else if (path === "/api/footfive/admin/health") {
      body = { status: "healthy", liveFixtures: 0, stalledFixtures: 0 };
    } else if (
      path === "/api/footfive/admin/retention" ||
      path === "/api/footfive/admin/backfill/status" ||
      path === "/api/footfive/admin/recovery/status"
    ) {
      body = {};
    } else if (path === CATCH_UP) {
      expect(method).toBe("POST");
      actions.push({ path, method });
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 500,
          json: { message: "Catch-up verification failed." },
        });
        return;
      }
      body = { ok: true };
    } else {
      unexpected.push(path);
      await route.abort();
      return;
    }

    await route.fulfill({ json: body });
  });

  return { actions, unexpected, seen };
}
