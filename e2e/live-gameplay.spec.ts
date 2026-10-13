import { test, expect } from "@playwright/test";
import { apiLogin, loginViaUi, PB, twoContexts, expectNoHorizontalOverflow } from "./helpers";

type Live = {
  mode: string;
  fixtures: Array<{ id: string; home: { id: string }; away: { id: string } }>;
  ticker?: Array<{ fixtureId: string }>;
};

async function live(request: import("@playwright/test").APIRequestContext, token: string): Promise<Live> {
  return (await request.get(`${PB}/api/footfive/live`, { headers: { Authorization: token } })).json();
}

test.describe("shared multiplayer + live", () => {
  test("two users see the same round on the live screen", async ({ browser, request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const b = await apiLogin(request, "e2e_user_b@test.local", "testpass99");
    expect(a.ok && b.ok).toBe(true);
    const [la, lb] = await Promise.all([live(request, a.token), live(request, b.token)]);
    expect(la.fixtures.map((f) => f.id)).toEqual(lb.fixtures.map((f) => f.id));

    const { p1, p2, close } = await twoContexts(browser);
    try {
      await loginViaUi(p1, "e2e_user_a@test.local", "testpass99");
      await loginViaUi(p2, "e2e_user_b@test.local", "testpass99");
      await expect(p1).toHaveURL(/\/live$/);
      await expect(p2).toHaveURL(/\/live$/);
      await expect(p1.getByTestId("round-title")).toBeVisible({ timeout: 15000 });
      await expect(p2.getByTestId("round-title")).toBeVisible({ timeout: 15000 });
      if (la.mode === "fixtures" || la.mode === "live") {
        await expect.poll(() => p1.getByTestId("fixture-card").count(), { timeout: 15000 }).toBe(la.fixtures.length);
        await expect.poll(() => p2.getByTestId("fixture-card").count(), { timeout: 15000 }).toBe(la.fixtures.length);
        const order = (p: typeof p1) => p.getByTestId("fixture-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-id")));
        expect(await order(p1)).toEqual(await order(p2));
        await expect(p1.getByTestId("ticker")).toBeVisible();
      }
      await expectNoHorizontalOverflow(p1);
      await expectNoHorizontalOverflow(p2);
    } finally {
      await close();
    }
  });

  test("open a match, switch fixtures and come back without changing the world", async ({ page, request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const l = await live(request, a.token);
    test.skip(!l.fixtures.length, "no fixtures announced yet");
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");

    const [first, second] = l.fixtures;
    await page.goto(`/match/${first.id}`);
    await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("commentary")).toBeVisible();
    if (l.mode === "live" && l.ticker?.some((i) => i.fixtureId !== first.id)) await expect(page.getByRole("region", { name: "Other matches", exact: true })).toBeVisible({ timeout: 15000 });
    if (second) {
      await page.goto(`/match/${second.id}`);
      await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 15000 });
      await page.goto(`/match/${first.id}`);
      await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 15000 });
    }
    const after = await live(request, a.token);
    expect(after.fixtures.map((f) => f.id)).toEqual(l.fixtures.map((f) => f.id));
    await expectNoHorizontalOverflow(page);
  });

  test("bet slip shows selection, odds and return before confirming", async ({ page, request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const l = await live(request, a.token);
    test.skip(!l.fixtures.length, "no fixtures announced yet");
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    await page.goto(`/match/${l.fixtures[l.fixtures.length - 1].id}`);
    const odds = page.locator('[data-testid^="odds-winner-"]:not([disabled])').first();
    const has = await odds.isVisible({ timeout: 10000 }).catch(() => false);
    test.skip(!has, "markets suspended or blocked right now");
    await odds.click();
    await expect(page.getByTestId("bet-slip")).toBeVisible();
    await expect(page.getByTestId("slip-odds")).toHaveText(/\d+\.\d\d/);
    await page.getByTestId("slip-stake").fill("5");
    await expect(page.getByTestId("bet-slip")).toContainText("Total return");
  });

  test("my team: claim screen or management screen renders", async ({ page }) => {
    await loginViaUi(page, "e2e_user_b@test.local", "testpass99");
    await page.goto("/my-team");
    await expect(page.getByTestId("team-list").or(page.getByTestId("my-team"))).toBeVisible({ timeout: 15000 });
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("engine unit paths via API (penalties/shootouts)", () => {
  test("shootout markers present when match went to pens", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const arch = await request.get(`${PB}/api/footfive/records/matches?shootout=1`, {
      headers: { Authorization: a.token },
    });
    expect(arch.ok()).toBe(true);
    const body = await arch.json();
    if ((body.matches || []).length) {
      const m = body.matches[0];
      const detail = await request.get(`${PB}/api/footfive/records/matches/${m.id}`, {
        headers: { Authorization: a.token },
      });
      expect(detail.ok()).toBe(true);
      const d = await detail.json();
      expect(d.scoreHome != null).toBe(true);
      if (d.wentShootout) expect(d.shootoutHome != null || d.shootoutKicks).toBeTruthy();
    }
  });
});
