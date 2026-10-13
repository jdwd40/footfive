import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked actual MatchPage: wide crosses, arriving headers and published-information boundaries.
const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: id === "Away" ? "#ff00cc" : "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const futureState: PubState = { ...state, sc: [1, 0] };
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const cases = [
  { name: "home wide cross to different header shooter", side: "home", feederShoots: false, late: false },
  { name: "away wide cross to different header shooter", side: "away", feederShoots: false, late: false },
  { name: "feeder arrives to head his own move", side: "home", feederShoots: true, late: false },
  { name: "late published header preserves fallback continuity", side: "home", feederShoots: false, late: true },
] as const;

for (const scenario of cases) {
  test(`${scenario.name}: wide winger, same named arriving shooter, elevated contact and no future results`, async ({ page }, testInfo) => {
    const side = scenario.side === "home" ? "Home" : "Away";
    const pt = (x: number, y: number): [number, number] => [scenario.side === "home" ? x : 100 - x, y];
    const shooterNo = scenario.feederShoots ? 2 : scenario.late ? 5 : 4;
    const headerStats: PubState["x"] = [state.x[0].slice(), state.x[1].slice()];
    headerStats[scenario.side === "home" ? 0 : 1][0] = 1;
    const headerState: PubState = { ...state, x: headerStats };
    const goalState: PubState = { ...futureState, x: [Array(7).fill(9), Array(7).fill(9)] };
    const events: MatchEvent[] = [
      { seq: 1, at: START + 3000, t: "cross", min: 1, side: scenario.side, chain: 71, p: `${side} P1`, p2: `${side} P2`,
        from: pt(56, 28), ball: pt(75, 8), text: "FF71 winger delivers from wide", st: state },
      { seq: 2, at: START + 6000, t: "shot", header: 1, min: 1, side: scenario.side, chain: 71, p: `${side} P${shooterNo - 1}`,
        from: pt(75, 8), ball: pt(84, 28), text: "FF71 named shooter heads the cross", st: headerState },
      { seq: 3, at: START + 60000, t: "goal", min: 2, side: "home", p: "Home P3", target: [100, 32], ball: [85, 32],
        text: "FF71 future goal must stay hidden", major: 1, st: goalState },
    ];
    const fixture: FixtureCard = { id: "ff71-crosses", slot: "a", index: 0, home: team("Home"), away: team("Away"),
      status: "live", kickoffAt: START - 60000, minuteMs: 8000, st: state, at: events[2].at, seq: 3, last: null, odds: null };
  const errors: string[] = [];
  const unexpectedApi: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  const user = { id: "ff71testuser0001", email: "ff71@example.invalid", display_name: "Cross test", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  await injectAuth(page, token, user);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const now = await page.evaluate(() => Date.now());
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") {
      body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: 8000 }, championship: null,
        round: { id: "r", key: "r1", label: "Round 1", status: "live", scheduledAt: START, finishedAt: null },
        fixtures: [fixture], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as LiveView;
    } else if (url.pathname === "/api/footfive/match/ff71-crosses") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture,
        events: events.filter((event) => event.seq > since && (event.seq === 1 || !scenario.late || now >= START + 5000)),
        eventsPage: { nextSeq: scenario.late && now < START + 5000 ? 1 : 3, hasMore: false, throughMs: now },
        lineups: { home: lineup("Home"), away: lineup("Away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/ff71-crosses") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else { unexpectedApi.push(url.pathname); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/match/ff71-crosses");
  const ball = page.getByTestId("pitch").locator('svg circle[stroke="#111"]');
  // Auth/bootstrap and the initial animation frame also use scheduled work. Advance
  // the paused clock until the real pitch mounts, then keep sampling deterministically.
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return ball.count();
  }).toBe(1);
  await expect(ball).toBeVisible();
    const start = events[0].at + 1500;
    await page.clock.runFor(start - await page.evaluate(() => Date.now()));
    const samples = [];
    const shotRow = page.getByTestId("stats").locator('div').filter({ has: page.getByText("Shots", { exact: true }) });
    let crossContact = false;
    let headerContact = false;
    let previous: { ball: number[]; shooter: number[] } | null = null;
    let largestBallStep = 0;
    let largestShooterStep = 0;
    let step = 0;
    const screenshots = new Set<string>();
    while (step < 4000) {
      // Audit every render tick through the late fetch and header handoff; the
      // initial cross flight has a different speed and is outside this window.
      const interval = scenario.late && step >= 1000 ? 16 : 50;
      await page.clock.runFor(interval);
      step += interval;
      const now = await page.evaluate(() => Date.now());
      const drawing = await page.getByTestId("pitch").evaluate((pitch) => {
        const ball = pitch.querySelector('svg circle[stroke="#111"]')!;
        const shadow = pitch.querySelector('svg > ellipse')!;
        const b = [Number(ball.getAttribute("cx")), Number(shadow.getAttribute("cy")) - 0.9];
        const players = Array.from(pitch.querySelectorAll('[data-testid="player"]')).map((player) => {
          const coords = player.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
          const kit = player.querySelector('[data-kit]')!;
          return { side: kit.getAttribute("stroke") === "#ff00cc" ? "away" : "home", no: Number(player.querySelector("text")!.textContent),
            x: Number(coords[1]), y: Number(coords[2]), ring: !!player.querySelector('[data-ring]'),
            distance: Math.hypot(Number(coords[1]) - b[0], Number(coords[2]) - b[1]) };
        });
        return { ball: b, elevation: b[1] - Number(ball.getAttribute("cy")), players };
      });
      const shooter = drawing.players.find((p) => p.side === scenario.side && p.no === shooterNo)!;
      const winger = drawing.players.find((p) => p.side === scenario.side && p.no === 3)!;
      const headerCurrent = now >= events[1].at + 1500;
      if (!headerCurrent) {
        expect(winger.y, "winger holds his wide line while delivering").toBeLessThan(13);
        await expect(page.getByTestId("commentary")).not.toContainText(events[1].text);
        await expect(shotRow).toHaveText("0Shots0");
        if (drawing.elevation > 1 && shooter.distance <= 1.6 && (scenario.side === "home" ? shooter.x > 80 : shooter.x < 20)) crossContact = true;
      } else {
        if (drawing.elevation > 1 && shooter.distance <= 1.6) headerContact = true;
      }
      expect(drawing.players.some((p) => p.side !== scenario.side && p.ring), "cross/header cannot grant opposing possession").toBe(false);
      await expect(page.getByTestId("match-score")).toHaveText("0–0");
      await expect(page.getByTestId("hud-score")).toContainText("0–0");
      await expect(page.getByTestId("commentary")).not.toContainText(events[2].text);
      await expect(page.getByTestId("event-feed").filter({ hasText: events[2].text })).toHaveCount(0);
      await expect(page.getByTestId("goal-banner")).toHaveCount(0);
      await expect(page.getByTestId("stats")).not.toContainText("9");
      // The initial cross legitimately travels fast at the 8s pace. Start the
      // continuity audit after its flight, before the later poll supplies the header.
      if (previous && interval === 16) {
        largestBallStep = Math.max(largestBallStep, Math.hypot(drawing.ball[0] - previous.ball[0], drawing.ball[1] - previous.ball[1]));
        largestShooterStep = Math.max(largestShooterStep, Math.hypot(shooter.x - previous.shooter[0], shooter.y - previous.shooter[1]));
      }
      previous = { ball: drawing.ball, shooter: [shooter.x, shooter.y] };
      samples.push({ step, headerCurrent, ...drawing });
      if (step >= 700 && !screenshots.has("wide")) {
        screenshots.add("wide");
        await page.screenshot({ path: testInfo.outputPath("wide-delivery.png") });
      }
      if (step >= 2800 && !screenshots.has("arrival")) {
        screenshots.add("arrival");
        await page.screenshot({ path: testInfo.outputPath("arriving-shooter.png") });
      }
    }
    await testInfo.attach("cross-header-samples", { body: JSON.stringify(samples), contentType: "application/json" });
    expect(crossContact, "same named header shooter arrives in the box and meets the elevated cross").toBe(true);
    expect(headerContact, "same shirt meets the elevated ball when the header is shown").toBe(true);
    if (scenario.late) {
      expect(largestBallStep, "late header geometry must not teleport the ball at 16ms").toBeLessThan(2);
      expect(largestShooterStep, "late named shooter must follow bounded 16ms cross sprint motion").toBeLessThanOrEqual(120 * 16 / 1000 + 0.01);
    }
    await expect(page.getByTestId("commentary")).toContainText(events[1].text);
    expect(unexpectedApi).toEqual([]);
    expect(errors).toEqual([]);
  });
}
