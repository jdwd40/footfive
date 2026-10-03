import { test, expect } from "@playwright/test";
import { loginViaUi, expectNoHorizontalOverflow } from "./helpers";

const routes = ["/live", "/betting", "/my-team", "/history"];

test.describe("viewport overflow", () => {
  for (const route of routes) {
    test(`${route} no horizontal overflow`, async ({ page }) => {
      await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
      await page.goto(route);
      await page.waitForTimeout(1000);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("admin and records fit", async ({ page }) => {
    await loginViaUi(page, "e2e_admin@test.local", "adminpass99");
    await page.goto("/history");
    await page.waitForTimeout(800);
    await expectNoHorizontalOverflow(page);
    await page.goto("/admin");
    await page.waitForTimeout(800);
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId("admin-health")).toBeVisible({ timeout: 10000 });
  });
});
