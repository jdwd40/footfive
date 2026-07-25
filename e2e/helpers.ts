import { expect, type Page, type APIRequestContext, type Browser } from "@playwright/test";

export const PB = process.env.E2E_PB_URL || "http://127.0.0.1:8091";

export async function apiLogin(
  request: APIRequestContext,
  email: string,
  password: string,
) {
  const res = await request.post(`${PB}/api/collections/users/auth-with-password`, {
    data: { identity: email, password },
  });
  const body = await res.json();
  return {
    ok: res.ok(),
    status: res.status(),
    token: body.token as string,
    record: body.record,
  };
}

export async function registerViaUi(
  page: Page,
  email: string,
  password: string,
  displayName?: string,
) {
  await page.goto("/register");
  await page.getByLabel(/display name/i).fill(displayName || email.split("@")[0]);
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /register/i }).click();
}

export async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  // Wait until we leave login (or error appears)
  await Promise.race([
    page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }),
    page.getByTestId("login-error").waitFor({ state: "visible", timeout: 20000 }),
  ]).catch(() => {});
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 2;
  });
  expect(overflow, "page-level horizontal overflow").toBe(false);
}

export async function twoContexts(browser: Browser) {
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const p1 = await c1.newPage();
  const p2 = await c2.newPage();
  return {
    p1,
    p2,
    async close() {
      await c1.close();
      await c2.close();
    },
  };
}

export async function injectAuth(page: Page, token: string, record: unknown) {
  await page.addInitScript(
    ([t, r]) => {
      localStorage.setItem(
        "pocketbase_auth",
        JSON.stringify({ token: t, record: r }),
      );
    },
    [token, record] as const,
  );
}
