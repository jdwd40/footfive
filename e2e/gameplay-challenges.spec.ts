import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked actual MatchPage: rendered challenges, possession and result boundaries.
const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: id === "Away" ? "#ff00cc" : "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const futureState: PubState = { ...state, sc: [1, 0] };
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const cases = [
  { name: "home tackle", type: "tackle", side: "home", from: [50, 32], ball: [54, 32], phase: "first_half", turn: undefined },
  { name: "away interception in second half", type: "interception", side: "away", from: [50, 32], ball: [46, 32], phase: "second_half", turn: undefined },
  { name: "backward turn-flip pass", type: "pass", side: "home", from: [75, 32], ball: [45, 32], phase: "first_half", turn: 1 },
] as const;

for (const scenario of cases) {
  test(`${scenario.name}: visible contest, timely WON IT and winning-side possession without future results`, async ({ page }, testInfo) => {
    const side = scenario.side === "home" ? "Home" : "Away";
    const opponent = scenario.side === "home" ? "Away" : "Home";
    const currentState: PubState = { ...state, ph: scenario.phase };
    const events: MatchEvent[] = [
      { seq: 1, at: START - 10000, t: "pass", min: 1, side: scenario.side === "home" ? "away" : "home",
        p: `${opponent} P3`, p2: `${opponent} P4`, from: [...scenario.from], ball: [...scenario.from], text: "FF72 prior possession", st: currentState },
      { seq: 2, at: START + 3000, t: scenario.type, min: 1, side: scenario.side, turn: scenario.turn,
        p: `${side} P3`, p2: scenario.turn ? `${side} P4` : `${opponent} P4`, from: [...scenario.from], ball: [...scenario.ball], text: `FF72 ${scenario.name}`, st: currentState },
      { seq: 3, at: START + 60000, t: "goal", min: 2, side: "home", p: "Home P3", target: [100, 32], ball: [85, 32],
        text: "FF72 future goal must stay hidden", major: 1, st: futureState },
    ];
    const fixture: FixtureCard = { id: "ff72-challenges", slot: "a", index: 0, home: team("Home"), away: team("Away"),
      status: "live", kickoffAt: START - 60000, minuteMs: 15000, st: futureState, at: events[2].at, seq: 3, last: null, odds: null };
  const errors: string[] = [];
  const unexpectedApi: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  const user = { id: "ff72testuser0001", email: "ff72@example.invalid", display_name: "Challenge test", role: "user", must_change_password: false };
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
    } else if (url.pathname === "/api/footfive/match/ff72-challenges") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture,
        events: events.filter((event) => event.seq > since), eventsPage: { nextSeq: 3, hasMore: false, throughMs: now },
        lineups: { home: lineup("Home"), away: lineup("Away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/ff72-challenges") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else { unexpectedApi.push(url.pathname); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/match/ff72-challenges");
  const ball = page.getByTestId("pitch").locator('svg circle[stroke="#111"]');
  // Auth/bootstrap and the initial animation frame also use scheduled work. Advance
  // the paused clock until the real pitch mounts, then keep sampling deterministically.
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return ball.count();
  }).toBe(1);
  await expect(ball).toBeVisible();
  await expect(page.getByTestId("commentary")).toContainText(events[0].text);
    const badge = page.getByTestId("won-badge");
    const hidden = async () => {
      await expect(page.getByTestId("match-score")).toHaveText("0–0");
      await expect(page.getByTestId("hud-score")).toContainText("0–0");
      await expect(page.getByTestId("commentary")).not.toContainText(events[2].text);
      await expect(page.getByTestId("event-feed").filter({ hasText: events[2].text })).toHaveCount(0);
      await expect(page.getByTestId("goal-banner")).toHaveCount(0);
    };
    await expect(badge).toHaveCount(0);
    const start = START + 4500; // Event publication plus the real MatchPage's 1500ms lag.
    await page.clock.runFor(start - await page.evaluate(() => Date.now()));
    let contested = false;
    let firstBadgeMs: number | null = null;
    const samples = [];
    for (let elapsed = 50; elapsed <= 2000; elapsed += 50) {
      await page.clock.runFor(50);
      const drawing = await page.getByTestId("pitch").evaluate((pitch) => {
        const ball = pitch.querySelector('svg circle[stroke="#111"]')!;
        const b = [Number(ball.getAttribute("cx")), Number(ball.getAttribute("cy"))];
        const players = Array.from(pitch.querySelectorAll('[data-testid="player"]')).map((player) => {
          const coords = player.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
          const kit = player.querySelector('[data-kit]')!;
          return { side: kit.getAttribute("stroke") === "#ff00cc" ? "away" : "home",
            keeper: kit.getAttribute("fill") === "#c6ff00", ring: !!player.querySelector('[data-ring]'),
            distance: Math.hypot(Number(coords[1]) - b[0], Number(coords[2]) - b[1]) };
        });
        return { ball: b, players };
      });
      const shown = await badge.isVisible();
      samples.push({ elapsed, shown, ...drawing });
      if (["home", "away"].every((side) => drawing.players.some((p) => p.side === side && !p.keeper && p.distance <= 4.5))) contested = true;
      if (shown) {
        await expect(badge).toHaveText("WON IT");
        firstBadgeMs ??= elapsed;
        expect(drawing.players.some((p) => p.side === scenario.side && !p.keeper && p.ring && p.distance <= 1.6), "WON IT requires the winning side in drawn contact with the ball").toBe(true);
        if (firstBadgeMs === elapsed) await page.screenshot({ path: testInfo.outputPath("won-it.png") });
      }
      if (elapsed === 500) await page.screenshot({ path: testInfo.outputPath("contest.png") });
      await hidden();
    }
    await testInfo.attach("challenge-samples", { body: JSON.stringify(samples), contentType: "application/json" });
    expect(contested, "both sides visibly meet at the ball").toBe(true);
    expect(firstBadgeMs, "WON IT appears within two seconds").not.toBeNull();
    expect(firstBadgeMs!).toBeLessThanOrEqual(2000);
    // At two seconds the winner still owns the ball; it must not read as an opposing clearance.
    expect(samples.at(-1)!.players.some((p) => p.side === scenario.side && !p.keeper && p.ring && p.distance <= 1.6)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("winner-possession.png") });
    expect(unexpectedApi).toEqual([]);
    expect(errors).toEqual([]);
  });
}
