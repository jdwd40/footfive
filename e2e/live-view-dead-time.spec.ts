/**
 * #208 on the real MatchPage with a mocked live match (6000 ms a match minute), on phone and desktop (the two Playwright projects):
 * the pre-match line-up walkout, the half-time summary after the large banner, the full-time summary before the auto-return, a
 * late join straight onto the right card — all inside the pitch box, with no new request, no layout shift and the bet tab usable.
 */
import { expect, test, type Page } from "@playwright/test";
import { FT, HT, KICKOFF, KNOWN, LAG, mountMatch, pageShifts, until } from "./dead-time-match";

const box = async (page: Page, testId: string) => (await page.getByTestId(testId).first().boundingBox())!;
const inside = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }) =>
  inner.x >= outer.x - 0.5 && inner.y >= outer.y - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5 && inner.y + inner.height <= outer.y + outer.height + 0.5;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const ids = ["match-top", "match-scoreboard", "pitch", "commentary", "bet-tab", "lineups"];
const geometry = (page: Page) =>
  page.evaluate((list) => Object.fromEntries(list.map((id) => {
    const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
    return [id, [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10)];
  })), ids);
/** The cards actually on screen, by id. */
const visibleCards = (page: Page) => page.locator('[data-testid="break-card"]:visible').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));

test("before kick-off both line-ups walk out of the tunnel to their formation inside the pitch, and give way to the kick-off", async ({ page }) => {
  await mountMatch(page, KICKOFF - 20000);
  const pitch = await box(page, "pitch");
  await expect(page.getByTestId("prematch")).toBeVisible();
  await expect(page.getByTestId("prematch-title")).toHaveText("LINE-UPS · MC2 v MET");
  const players = page.getByTestId("prematch-player");
  await expect(players).toHaveCount(10);
  // Walking: the last one out is still on its way from the tunnel, then everyone stands in his half.
  const walk = page.locator(".walkout").last();
  expect(await walk.evaluate((e) => getComputedStyle(e).animationName)).toBe("walkout");
  await until(page, KICKOFF - 20000 + 4000);
  for (const p of await players.all()) {
    const b = (await p.boundingBox())!;
    expect(inside(b, pitch), "each player is inside the pitch").toBe(true);
    const side = await p.getAttribute("data-side");
    if (side === "home") expect(b.x + b.width / 2).toBeLessThan(pitch.x + pitch.width / 2);
    else expect(b.x + b.width / 2).toBeGreaterThan(pitch.x + pitch.width / 2);
  }
  await expect(page.getByTestId("prematch-player").filter({ hasText: "STRIKER" })).toHaveCount(2);
  // The kick-off reaches the lagged pitch: the walkout goes, the match's players are drawn, and the pitch never moved.
  await until(page, KICKOFF + LAG + 500);
  await expect(page.getByTestId("prematch")).toHaveCount(0);
  await expect(page.getByTestId("player")).toHaveCount(10);
  expect(await box(page, "pitch")).toEqual(pitch);
});

test("half-time: the large banner first, then the summary on the pitch turning its cards — the bet tab still works, no new request, no shift", async ({ page }) => {
  const requests = await mountMatch(page, HT - 4000, { betTab: "open" });
  await expect(page.getByTestId("markets")).toBeVisible();
  const first = await geometry(page);
  const loaded = (await pageShifts(page)).length;
  await until(page, HT + LAG + 2500);
  const banner = page.getByTestId("period-banner");
  await expect(banner).toHaveText("HALF-TIME · MC2 1–0 MET");
  await expect(banner).not.toHaveAttribute("data-docked");
  await expect(page.getByTestId("break-summary")).toHaveCount(0);
  await until(page, HT + LAG + 5500);
  const summary = page.getByTestId("break-summary");
  await expect(summary).toBeVisible();
  await expect(banner).toHaveAttribute("data-docked");
  await expect(banner).toHaveText("HALF-TIME · MC2 1–0 MET");
  const pitch = await box(page, "pitch");
  expect(inside(await box(page, "break-overlay"), pitch)).toBe(true);
  // Narrow pitch: one card at a time; wide pitch: two side by side. Either way the four come round in the break.
  const narrow = pitch.width < 520;
  expect(await visibleCards(page)).toEqual(narrow ? ["stats"] : ["stats", "shots"]);
  for (const c of await page.locator('[data-testid="break-card"]:visible').all()) expect(inside((await c.boundingBox())!, pitch)).toBe(true);
  await expect(page.getByTestId("break-stats")).toContainText("Shots");
  const seen = new Set<string>();
  for (let t = HT + LAG + 5500; t < HT + LAG + 29500; t += 1000) {
    await until(page, t);
    for (const c of await visibleCards(page)) seen.add(c!);
    expect(await geometry(page), `layout at HT+${(t - HT) / 1000}s`).toEqual(first);
  }
  expect([...seen].sort()).toEqual(["goals", "players", "shots", "stats"]);
  // The shot map and the goals are the first half as shown: two home attempts (a save, the headed goal), two away (wide, blocked).
  await page.getByRole("button", { name: "Show shot map" }).click();
  await expect(page.getByTestId("shot-dot")).toHaveCount(4);
  expect(await page.getByTestId("shot-dot").evaluateAll((d) => d.map((e) => `${(e as HTMLElement).dataset.side}:${(e as HTMLElement).dataset.result}`))).toEqual(["home:save", "away:miss", "home:goal", "away:block"]);
  await page.getByRole("button", { name: "Show goals" }).click();
  await expect(page.getByTestId("break-goal")).toHaveText(["25′MC2H. Striker1–0"]);
  // The bet tab sits outside the pitch, uncovered, and still folds and opens with its markets during the break.
  expect(overlaps(await box(page, "bet-tab"), await box(page, "break-overlay"))).toBe(false);
  await page.getByTestId("bet-tab-toggle").click();
  await expect(page.getByTestId("bet-tab-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("bet-tab-toggle").click();
  await expect(page.getByTestId("markets")).toBeVisible();
  // The second half's kick-off ends it.
  await until(page, HT + 30000 + LAG + 500);
  await expect(page.getByTestId("break-summary")).toHaveCount(0);
  await expect(page.getByTestId("period-banner")).toHaveText(/SECOND HALF/);
  // Same endpoints as ever, the markets still polled through the break, and no page layout shift.
  expect(requests.filter((r) => !KNOWN.includes(r.path)).map((r) => r.path)).toEqual([]);
  expect(requests.filter((r) => r.path === "/api/footfive/markets/deadtime" && r.at > HT && r.at < HT + 30000).length).toBeGreaterThanOrEqual(4);
  const shifts = (await pageShifts(page)).slice(loaded);
  expect(shifts.reduce((n, s) => n + s.value, 0), JSON.stringify(shifts.slice(0, 4))).toBeLessThan(0.001);
});

test("joining at half-time lands on the card for that moment at once", async ({ page }) => {
  await mountMatch(page, HT + LAG + 18000);
  await expect(page.getByTestId("break-summary")).toBeVisible();
  const narrow = (await box(page, "pitch")).width < 520;
  expect(await visibleCards(page)).toEqual(narrow ? ["goals"] : ["goals", "players"]);
  await expect(page.getByTestId("period-banner")).toHaveText("HALF-TIME · MC2 1–0 MET");
});

test("full time: the FULL-TIME banner, then the summary of the match, and still back to the round after 20 s", async ({ page }) => {
  await mountMatch(page, FT - 3000);
  await until(page, FT + LAG + 2000);
  const banner = page.getByTestId("ft-banner");
  await expect(banner).toContainText("FULL-TIME");
  await expect(banner).not.toHaveAttribute("data-docked");
  await until(page, FT + LAG + 6000);
  await expect(page.getByTestId("break-summary")).toHaveAttribute("data-kind", "ft");
  await expect(banner).toHaveAttribute("data-docked");
  await expect(banner).toContainText("Mega City Two go through!");
  await expect(page.getByTestId("auto-return")).toContainText("tap to stay");
  expect(await visibleCards(page)).toContain("stats");
  // No interaction with the page: the auto-return still runs, summary or not.
  await until(page, FT + 26000);
  await expect(page).toHaveURL(/\/live$/);
});

test("reduced motion: no walk, the line-ups are simply in formation", async ({ page }) => {
  await mountMatch(page, KICKOFF - 20000, { reducedMotion: true });
  await expect(page.getByTestId("prematch-player")).toHaveCount(10);
  expect(await page.locator(".walkout").first().evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
});

test("reduced motion at half-time: the summary comes on time, headed by the half-time title", async ({ page }) => {
  await mountMatch(page, HT + LAG + 8000, { reducedMotion: true });
  await expect(page.getByTestId("break-summary")).toBeVisible();
  await expect(page.getByTestId("period-banner")).toHaveText("HALF-TIME · MC2 1–0 MET");
});
