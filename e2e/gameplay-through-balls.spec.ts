import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked actual MatchPage: rendered through-ball runs and result boundaries.
const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: id === "Away" ? "#ff00cc" : "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const futureState: PubState = { ...state, sc: [1, 0] };
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const cases = [
  { name: "home long through-ball", side: "home", from: [56, 30], ball: [80, 34], phase: "first_half" },
  { name: "away short mirrored through-ball in second half", side: "away", from: [68, 30], ball: [74, 30], phase: "second_half" },
] as const;

for (const scenario of cases) {
  test(`${scenario.name}: named runner beats a late marker and collects the grounded ball without future results`, async ({ page }, testInfo) => {
    const side = scenario.side === "home" ? "Home" : "Away";
    const currentState: PubState = { ...state, ph: scenario.phase };
    const events: MatchEvent[] = [
      { seq: 2, at: START + 3000, t: "through_ball", min: 1, side: scenario.side, p: `${side} P3`, p2: `${side} P4`,
        from: [...scenario.from], ball: [...scenario.ball], text: `FF70 ${scenario.name}`, st: currentState },
      { seq: 3, at: START + 60000, t: "goal", min: 2, side: "home", p: "Home P3", target: [100, 32], ball: [85, 32],
        text: "FF70 future goal must stay hidden", major: 1, st: futureState },
    ];
    const fixture: FixtureCard = { id: "ff70-through-balls", slot: "a", index: 0, home: team("Home"), away: team("Away"),
      status: "live", kickoffAt: START - 60000, minuteMs: 15000, st: currentState, at: events[1].at, seq: 3, last: null, odds: null };
  const errors: string[] = [];
  const unexpectedApi: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  const user = { id: "ff70testuser0001", email: "ff70@example.invalid", display_name: "Through-ball test", role: "user", must_change_password: false };
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
    } else if (url.pathname === "/api/footfive/match/ff70-through-balls") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture,
        events: events.filter((event) => event.seq > since), eventsPage: { nextSeq: 3, hasMore: false, throughMs: now },
        lineups: { home: lineup("Home"), away: lineup("Away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/ff70-through-balls") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else { unexpectedApi.push(url.pathname); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/match/ff70-through-balls");
  const ball = page.getByTestId("pitch").locator('svg circle[stroke="#111"]');
  // Auth/bootstrap and the initial animation frame also use scheduled work. Advance
  // the paused clock until the real pitch mounts, then keep sampling deterministically.
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return ball.count();
  }).toBe(1);
  await expect(ball).toBeVisible();
    const hidden = async () => {
      await expect(page.getByTestId("match-score")).toHaveText("0–0");
      await expect(page.getByTestId("hud-score")).toContainText("0–0");
      await expect(page.getByTestId("commentary")).not.toContainText(events[1].text);
      await expect(page.getByTestId("event-feed").filter({ hasText: events[1].text })).toHaveCount(0);
      await expect(page.getByTestId("goal-banner")).toHaveCount(0);
    };
    // Start the first live scene only after auth and the real pitch have mounted,
    // so bootstrap scheduling cannot skip the runner's initial approach.
    const start = events[0].at + 1500;
    await page.clock.runFor(start - await page.evaluate(() => Date.now()));
    // SVG coordinates already include phase orientation; both side and second-half
    // projection determine which way the runner is advancing on the displayed pitch.
    const direction = (scenario.side === "home" ? 1 : -1) * (scenario.phase === "second_half" ? -1 : 1);
    const samples = [];
    for (let step = 50; step <= 2200; step += 50) {
      await page.clock.runFor(50);
      const elapsed = await page.evaluate(() => Date.now()) - start;
      const drawing = await page.getByTestId("pitch").evaluate((pitch) => {
        const ball = pitch.querySelector('svg circle[stroke="#111"]')!;
        const ground = pitch.querySelector('svg > ellipse')!;
        const b = [Number(ball.getAttribute("cx")), Number(ball.getAttribute("cy"))];
        const players = Array.from(pitch.querySelectorAll('[data-testid="player"]')).map((player) => {
          const coords = player.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
          const kit = player.querySelector('[data-kit]')!;
          return { side: kit.getAttribute("stroke") === "#ff00cc" ? "away" : "home", no: Number(player.querySelector("text")!.textContent),
            x: Number(coords[1]), y: Number(coords[2]), keeper: kit.getAttribute("fill") === "#c6ff00", ring: !!player.querySelector('[data-ring]'),
            distance: Math.hypot(Number(coords[1]) - b[0], Number(coords[2]) - b[1]) };
        });
        return { ball: b, grounded: Math.abs(b[1] - (Number(ground.getAttribute("cy")) - 0.9)) < 0.15, players };
      });
      samples.push({ elapsed, ...drawing });
      expect(drawing.players.some((p) => p.side !== scenario.side && p.ring), "through-ball must not grant opposing possession").toBe(false);
      await hidden();
      if (step === 250) await page.screenshot({ path: testInfo.outputPath("runner-in-space.png") });
    }
    await testInfo.attach("through-ball-samples", { body: JSON.stringify(samples), contentType: "application/json" });
    const runner = (sample: typeof samples[number]) => sample.players.find((p) => p.side === scenario.side && p.no === 5)!; // P4's shirt
    const early = samples[0];
    const earlyRunner = runner(early);
    const contact = samples.find((sample) => sample.grounded && runner(sample).ring && runner(sample).distance <= 1.6);
    expect(contact, "named runner P4 (shirt 5) collects the grounded through-ball").toBeDefined();
    const collected = runner(contact!);
    expect(direction * (collected.x - earlyRunner.x), "runner advances into space rather than waiting at the destination").toBeGreaterThan(3);
    const beaten = early.players.filter((p) => p.side !== scenario.side && !p.keeper && direction * (p.x - earlyRunner.x) > 0.5 && Math.hypot(p.x - earlyRunner.x, p.y - earlyRunner.y) < 12)
      .some((marker) => {
        const late = contact!.players.find((p) => p.side === marker.side && p.no === marker.no)!;
        return direction * (collected.x - late.x) > 1 && late.distance > 2;
      });
    expect(beaten, "runner crosses an initially ahead marker and reaches the ball before him").toBe(true);
    await expect(page.getByTestId("commentary")).toContainText(events[0].text);
    await page.screenshot({ path: testInfo.outputPath("runner-collected.png") });
    expect(unexpectedApi).toEqual([]);
    expect(errors).toEqual([]);
  });
}
