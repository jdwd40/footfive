import { expect, test, type Page } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.toUpperCase(), grade: "A", primary_color: id === "home" ? "#00e5ff" : "#ff00cc", secondary_color: "#fff", badge_key: "test" });
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i ? "util" : "gk", starter: true }));

async function mount(page: Page) {
  const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50, x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
  const scored: PubState = { ...state, sc: [1, 0] };
  const events: MatchEvent[] = [
    { seq: 1, at: START - 10000, t: "pass", min: 1, side: "home", p: "home P2", p2: "home P3", ball: [85, 32], text: "Prior play", st: state },
    { seq: 2, at: START + 3000, t: "goal", min: 1, side: "home", p: "home P3", ball: [85, 32], target: [100, 32], major: 1, text: "Home scores", st: scored },
  ];
  const fixture: FixtureCard = { id: "stadium", slot: "a", index: 0, home: team("home"), away: team("away"), status: "live", kickoffAt: START - 60000, minuteMs: 15000, st: scored, at: events[1].at, seq: 2, last: null, odds: null };
  const user = { id: "stadiumtestuser1", email: "stadium@example.invalid", display_name: "Stadium test", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  await injectAuth(page, token, user);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const now = await page.evaluate(() => Date.now());
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: 15000 }, championship: null, round: { id: "r", key: "r1", label: "Round 1", status: "live", scheduledAt: START, finishedAt: null }, fixtures: [fixture], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as LiveView;
    else if (url.pathname === "/api/footfive/match/stadium") body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture, events: events.filter(e => e.seq > Number(url.searchParams.get("since") ?? 0)), eventsPage: { nextSeq: 2, hasMore: false, throughMs: now }, lineups: { home: lineup("home"), away: lineup("away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/stadium") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 2, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else throw new Error(`Unexpected stadium test API: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.goto("/match/stadium");
  await expect.poll(async () => { await page.clock.runFor(50); return page.getByTestId("pitch").count(); }).toBe(1);
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ width: 320, height: 700 }, { width: 360, height: 800 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1366, height: 768 }]) {
  test(`stadium keeps the original pitch geometry at ${viewport.width}px through a goal`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await mount(page);
    const pitch = page.getByTestId("pitch");
    const stadium = page.getByTestId("stadium");
    const home = page.getByTestId("home-crowd");
    const away = page.getByTestId("away-crowd");
    const before = (await pitch.boundingBox())!;
    const band = await stadium.evaluate(el => parseFloat(getComputedStyle(el).getPropertyValue("--stadium-band")));
    expect(band).toBe(viewport.width < 360 ? 3 : 8);
    const left = (await home.boundingBox())!;
    const right = (await away.boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    expect(left.x).toBeGreaterThanOrEqual(main.x);
    expect(right.x + right.width).toBeLessThanOrEqual(main.x + main.width + 0.1);
    expect(left.x).toBeCloseTo(before.x - band, 1);
    expect(right.x + right.width).toBeCloseTo(before.x + before.width + band, 1);
    expect(left.y).toBeCloseTo(before.y - band, 1);
    expect(left.height).toBeCloseTo(before.height + band * 2, 1);
    // Removing only the decorative wrapper's box recreates the original direct-child pitch layout.
    const baselineStyle = await page.addStyleTag({ content: ".stadium { display: contents !important; } .stadium-stand { display: none !important; }" });
    const baseline = (await pitch.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) expect(before[key]).toBeCloseTo(baseline[key], 2);
    await baselineStyle.evaluate(el => el.remove());
    await expect(home).not.toHaveClass(/cheer/);
    await expect(away).not.toHaveClass(/cheer/);
    const homePattern = await home.evaluate(el => getComputedStyle(el, "::before").backgroundImage);
    const awayPattern = await away.evaluate(el => getComputedStyle(el, "::before").backgroundImage);
    expect(homePattern).toContain("rgb(0, 229, 255)");
    expect(awayPattern).toContain("rgb(255, 0, 204)");
    await page.clock.runFor(START + 9500 - await page.evaluate(() => Date.now()));
    await expect(page.getByTestId("goal-banner")).toBeVisible();
    await expect(home).toHaveClass(/cheer/);
    await expect(away).not.toHaveClass(/cheer/);
    const after = (await pitch.boundingBox())!;
    const baselineGoalStyle = await page.addStyleTag({ content: ".stadium { display: contents !important; } .stadium-stand { display: none !important; }" });
    const baselineAfter = (await pitch.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) expect(after[key]).toBeCloseTo(baselineAfter[key], 2);
    // The pre-existing empty ticker can wrap on phones. The crowd must add no shift to that original layout.
    expect(after.y - before.y).toBeCloseTo(baselineAfter.y - baseline.y, 2);
    for (const key of ["x", "width", "height"] as const) expect(after[key]).toBeCloseTo(before[key], 2);
    await testInfo.attach("stadium-layout", { body: JSON.stringify({ before, baseline, after, baselineAfter }), contentType: "application/json" });
    await baselineGoalStyle.evaluate(el => el.remove());
    const animation = await home.evaluate(el => ({ name: getComputedStyle(el, "::before").animationName, duration: getComputedStyle(el, "::before").animationDuration }));
    expect(animation).toEqual({ name: "stadium-cheer", duration: "2s" });
    await stadium.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`stadium-${viewport.width}.png`) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await home.evaluate(el => ({ animation: getComputedStyle(el, "::before").animationName, transform: getComputedStyle(el, "::before").transform, opacity: getComputedStyle(el, "::before").opacity }));
    expect(reduced).toEqual({ animation: "none", transform: "none", opacity: "1" });
    expect(await stadium.locator(".stadium-stand").count()).toBe(2);
    expect(await home.evaluate(el => el.childElementCount)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)).toBe(false);
    expect(errors).toEqual([]);
  });
}
