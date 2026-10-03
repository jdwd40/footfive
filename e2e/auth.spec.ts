import { test, expect } from "@playwright/test";
import { loginViaUi, registerViaUi, expectNoHorizontalOverflow, apiLogin, PB } from "./helpers";

test.describe("auth", () => {
  test("login valid user and session survives refresh", async ({ page }) => {
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    await expect(page).not.toHaveURL(/\/login$/, { timeout: 20000 });
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await expect(page).not.toHaveURL(/\/login$/);
  });

  test("reject invalid login", async ({ page }) => {
    await loginViaUi(page, "e2e_user_a@test.local", "wrong-password-xx");
    await expect(page.getByTestId("login-error")).toBeVisible({ timeout: 10000 });
  });

  test("disabled account cannot login via API", async ({ request }) => {
    const r = await apiLogin(request, "e2e_disabled@test.local", "testpass99");
    expect(r.ok).toBe(false);
  });

  test("register new user", async ({ page }) => {
    const email = `e2e_reg_${Date.now()}@test.local`;
    await registerViaUi(page, email, "testpass99", "NewReg");
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/register$/);
  });

  test("normal user cannot open admin", async ({ page }) => {
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto("/admin");
    // Admin gate blocks the normal user — accept current App.tsx gate copy
    // ("Administrator access required") plus legacy/API error phrasings.
    await expect(page.locator("body")).toContainText(
      /Admin only|administrator access|access required|denied|forbidden/i,
      { timeout: 15000 },
    );
  });

  test("admin can access console", async ({ page }) => {
    await loginViaUi(page, "e2e_admin@test.local", "adminpass99");
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto("/admin");
    await expect(page.locator("body")).toContainText(/Administration|System health|Users/i, {
      timeout: 20000,
    });
    await expect(page.getByTestId("admin-health")).toBeVisible({ timeout: 15000 });
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("password change", () => {
  test("temp password forces change flow", async ({ page, request }) => {
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    test.skip(!admin.ok, "admin not available");
    const email = `e2e_tmp_${Date.now()}@test.local`;
    const created = await request.post(`${PB}/api/footfive/admin/users`, {
      headers: { Authorization: admin.token },
      data: {
        email,
        password: "temppass99",
        display_name: "TempUser",
        reason: "e2e",
      },
    });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    const reset = await request.post(`${PB}/api/footfive/admin/users/${id}/password`, {
      headers: { Authorization: admin.token },
      data: {
        password: "temppass99",
        mustChange: true,
        reason: "e2e force change",
      },
    });
    expect(reset.ok()).toBe(true);

    await loginViaUi(page, email, "temppass99");
    await expect(page).toHaveURL(/change-password/, { timeout: 15000 });
    await page.getByTestId("current-password").fill("temppass99");
    await page.getByTestId("new-password").fill("newpass99");
    await page.getByTestId("confirm-password").fill("newpass99");
    await page.getByTestId("change-password-submit").click();
    await expect(page).toHaveURL(/\/live$/, { timeout: 15000 });
  });
});
