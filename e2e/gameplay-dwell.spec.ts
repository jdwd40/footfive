import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked real MatchPage. Run with chromium-mobile and chromium-desktop; no PocketBase needed.
const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const futureState: PubState = { ...state, sc: [1, 0] };
const events: MatchEvent[] = [
  { seq: 1, at: START - 10000, t: "pass", min: 1, side: "home", p: "Home P3", p2: "Home P4",
    from: [50, 32], ball: [62, 32], text: "FF68 current possession", st: state },
  { seq: 2, at: START + 7000, t: "pass", min: 1, side: "home", p: "Home P4", p2: "Home P3",
    from: [50, 32], ball: [52, 32], text: "FF68 midfield continuation", st: state },
  // Already fetched but ahead of the lagged playhead: neither verdict nor newest fixture score may leak.
  { seq: 3, at: START + 60000, t: "goal", min: 2, side: "home", p: "Home P3", target: [100, 32],
    ball: [85, 32], text: "FF68 future goal must stay hidden", major: 1, st: futureState },
];
const fixture: FixtureCard = { id: "ff68-dwell", slot: "a", index: 0, home: team("Home"), away: team("Away"),
  status: "live", kickoffAt: START - 60000, minuteMs: 15000, st: futureState, at: events[2].at, seq: 3, last: null, odds: null };
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));

test("long carrier dwell stays moving and bounded, then enters midfield continuously without future-result leakage", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const unexpectedApi: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  const user = { id: "ff68testuser0001", email: "ff68@example.invalid", display_name: "Dwell test", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  await injectAuth(page, token, user);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const now = await page.evaluate(() => Date.now());
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") {
      body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: 15000 }, championship: null,
        round: { id: "r", key: "r1", label: "Round 1", status: "live", scheduledAt: START, finishedAt: null },
        fixtures: [fixture], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as LiveView;
    } else if (url.pathname === "/api/footfive/match/ff68-dwell") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture,
        events: events.filter((event) => event.seq > since), eventsPage: { nextSeq: 3, hasMore: false, throughMs: now },
        lineups: { home: lineup("Home"), away: lineup("Away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/ff68-dwell") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else { unexpectedApi.push(url.pathname); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/match/ff68-dwell");
  const ball = page.getByTestId("pitch").locator('svg circle[stroke="#111"]');
  await expect(ball).toBeVisible();
  await expect(page.getByTestId("commentary")).toContainText(events[0].text);
  const position = async () => ball.evaluate((node) => [Number(node.getAttribute("cx")), Number(node.getAttribute("cy"))]);
  const hidden = async () => {
    await expect(page.getByTestId("match-score")).toHaveText("0–0");
    await expect(page.getByTestId("hud-score")).toContainText("0–0");
    await expect(page.getByTestId("commentary")).not.toContainText(events[2].text);
    await expect(page.getByTestId("event-feed")).not.toContainText(events[2].text);
    await expect(page.getByTestId("goal-banner")).toHaveCount(0);
  };
  const dwell: number[][] = [];
  // Scene ended >6 seconds ago at mount. Sample across a full lay-off cycle, not arbitrary real sleeps.
  for (let i = 0; i < 14; i++) {
    await page.clock.runFor(250);
    dwell.push(await position());
    await hidden();
  }
  await testInfo.attach("dwell-samples", { body: JSON.stringify(dwell), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("long-dwell.png") });
  expect(Math.max(...dwell.map(([x]) => x)), "routine dwell must not enter the attacking box").toBeLessThanOrEqual(71);
  expect(Math.max(...dwell.map(([, y]) => y)) - Math.min(...dwell.map(([, y]) => y)), "long dwell must keep circulating").toBeGreaterThan(1);

  // The next scene becomes current at START+8500 (published at +7000, 1500ms playback lag).
  const clock = await page.evaluate(() => Date.now());
  await page.clock.runFor(START + 8450 - clock);
  let previous = await position();
  let largestStep = 0;
  for (let i = 0; i < 35; i++) {
    await page.clock.runFor(20);
    const next = await position();
    largestStep = Math.max(largestStep, Math.hypot(next[0] - previous[0], next[1] - previous[1]));
    previous = next;
    await hidden();
  }
  expect(largestStep, "no backward ball teleport when midfield event becomes current").toBeLessThan(2);
  await expect(page.getByTestId("commentary")).toContainText(events[1].text);
  await page.screenshot({ path: testInfo.outputPath("midfield-boundary.png") });
  expect(unexpectedApi).toEqual([]);
  expect(errors).toEqual([]);
});
