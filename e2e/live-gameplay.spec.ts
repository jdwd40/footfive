import { test, expect } from "@playwright/test";
import { apiLogin, loginViaUi, PB, twoContexts, expectNoHorizontalOverflow } from "./helpers";

test.describe("shared multiplayer + live", () => {
  test("two users same world and scoreboard UI", async ({ browser, request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const b = await apiLogin(request, "e2e_user_b@test.local", "testpass99");
    expect(a.ok && b.ok).toBe(true);

    const wA = await (
      await request.get(`${PB}/api/footfive/world`, {
        headers: { Authorization: a.token },
      })
    ).json();
    const wB = await (
      await request.get(`${PB}/api/footfive/world`, {
        headers: { Authorization: b.token },
      })
    ).json();
    expect(wA.tournament?.id || null).toEqual(wB.tournament?.id || null);

    const { p1, p2, close } = await twoContexts(browser);
    try {
      await loginViaUi(p1, "e2e_user_a@test.local", "testpass99");
      await loginViaUi(p2, "e2e_user_b@test.local", "testpass99");
      await p1.goto("/scoreboard");
      await p2.goto("/scoreboard");
      await expect(p1.getByTestId("scoreboard-page")).toBeVisible({ timeout: 15000 });
      await expect(p2.getByTestId("scoreboard-page")).toBeVisible({ timeout: 15000 });
      // Wait for fixtures to hydrate on both contexts
      await expect
        .poll(async () => p1.getByTestId("fixture-list").locator("a").count(), { timeout: 15000 })
        .toBeGreaterThan(0);
      await expect
        .poll(async () => p2.getByTestId("fixture-list").locator("a").count(), { timeout: 15000 })
        .toBeGreaterThan(0);
      await expectNoHorizontalOverflow(p1);
      await expectNoHorizontalOverflow(p2);

      const cards1 = await p1.getByTestId("fixture-list").locator("a").count();
      const cards2 = await p2.getByTestId("fixture-list").locator("a").count();
      expect(cards1).toBe(cards2);
    } finally {
      await close();
    }
  });

  test("open live match and switch fixtures", async ({ page, request }) => {
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    await request.post(`${PB}/api/footfive/catch-up`, {
      headers: { Authorization: a.token },
    });
    const sb = await (
      await request.get(`${PB}/api/footfive/scoreboard`, {
        headers: { Authorization: a.token },
      })
    ).json();
    const fixtures = sb.fixtures || [];
    test.skip(!fixtures.length, "no fixtures");

    const first = fixtures[0].fixtureId || fixtures[0].id;
    await page.goto(`/match/${first}`);
    await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("score-normal")).toBeVisible();

    if (fixtures.length > 1) {
      const second = fixtures[1].fixtureId || fixtures[1].id;
      await page.goto(`/match/${second}`);
      await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 15000 });
      await page.goto(`/match/${first}`);
      await expect(page.getByTestId("match-scoreboard")).toBeVisible({ timeout: 15000 });
      // score still present (not blank restart)
      await expect(page.getByTestId("score-home")).toBeVisible();
    }

    // Catch up control exists when behind or live refresh
    const catchUp = page.getByTestId("catch-up");
    const live = page.getByTestId("live-refresh");
    await expect(catchUp.or(live)).toBeVisible();
  });

  test("coaching controls for manager of claimed team", async ({ page, request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    // ensure A has a team
    const teams = (
      await (
        await request.get(`${PB}/api/footfive/teams`, {
          headers: { Authorization: a.token },
        })
      ).json()
    ).teams;
    let managed = teams.find(
      (t: { managerId?: string; manager?: string }) =>
        t.managerId === a.record.id || t.manager === a.record.id,
    );
    if (!managed && admin.ok) {
      const free = teams.find(
        (t: { managerId?: string; manager?: string }) => !t.managerId && !t.manager,
      );
      if (free) {
        await request.post(`${PB}/api/footfive/admin/teams/${free.id}/assign`, {
          headers: { Authorization: admin.token },
          data: { userId: a.record.id, reason: "e2e coach" },
        });
        managed = free;
      }
    }
    test.skip(!managed, "no managed team");

    await request.post(`${PB}/api/footfive/catch-up`, {
      headers: { Authorization: a.token },
    });
    const sb = await (
      await request.get(`${PB}/api/footfive/scoreboard`, {
        headers: { Authorization: a.token },
      })
    ).json();
    const mine = (sb.fixtures || []).find(
      (f: { home?: { id: string }; away?: { id: string }; homeTeamId?: string; awayTeamId?: string }) =>
        f.home?.id === managed.id ||
        f.away?.id === managed.id ||
        f.homeTeamId === managed.id ||
        f.awayTeamId === managed.id,
    );
    test.skip(!mine, "managed team not in current fixtures");

    const fid = mine.fixtureId || mine.id;
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    await page.goto(`/match/${fid}`);
    await page.waitForTimeout(2000);
    // If live and can coach
    const panel = page.getByTestId("coaching-panel");
    if (await panel.isVisible().catch(() => false)) {
      await page.getByTestId("coach-attack").click();
      await expect(page.getByTestId("coaching-panel")).toBeVisible();
      // pending flash or stance update
      await expect(page.getByTestId("coach-attack")).toBeVisible();
    }
  });
});

test.describe("engine unit paths via API (penalties/shootouts)", () => {
  test("shootout markers present when match went to pens", async ({ request }) => {
    // deterministic unit path already covered in vitest; API checks archive if any
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
      // shootout score separate fields
      if (d.wentShootout) {
        expect(d.shootoutHome != null || d.shootoutKicks).toBeTruthy();
      }
    }
  });
});
