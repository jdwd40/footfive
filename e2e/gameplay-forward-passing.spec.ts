import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked actual MatchPage: constructive lay-offs, forward releases and ordinary-pass control.
const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: id === "Away" ? "#ff00cc" : "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });
const state: PubState = { sc: [0, 0], so: null, ph: "first_half", clk: { s: 60, run: 1 }, pos: 50,
  x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
const futureState: PubState = { ...state, sc: [1, 0] };
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const cases = (["home", "away"] as const).flatMap((side) => (["backward", "ordinary forward"] as const).map((kind) => ({ side, kind })));

for (const scenario of cases) {
  test(`${scenario.side} ${scenario.kind}: controlled possession, authored endpoint and no future result leak`, async ({ page }, testInfo) => {
    const side = scenario.side === "home" ? "Home" : "Away";
    const backward = scenario.kind === "backward";
    const pt = (x: number, y: number): [number, number] => [scenario.side === "home" ? x : 100 - x, y];
    const events: MatchEvent[] = [
      { seq: 1, at: START + 3000, t: "pass", min: 1, side: scenario.side, p: `${side} P1`, p2: `${side} P2`,
        from: pt(50, 32), ball: pt(backward ? 40 : 60, 36), text: `FF69 ${scenario.side} ${scenario.kind} pass`, st: state },
      { seq: 3, at: START + 60000, t: "goal", min: 2, side: "home", p: "Home P3", target: [100, 32], ball: [85, 32],
        text: "FF69 future goal must stay hidden", major: 1, st: futureState },
    ];
    const fixture: FixtureCard = { id: "ff69-forward-passing", slot: "a", index: 0, home: team("Home"), away: team("Away"),
      status: "live", kickoffAt: START - 60000, minuteMs: 8000, st: state, at: events[1].at, seq: 3, last: null, odds: null };
  const errors: string[] = [];
  const unexpectedApi: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  const user = { id: "ff69testuser0001", email: "ff69@example.invalid", display_name: "Forward passing test", role: "user", must_change_password: false };
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
    } else if (url.pathname === "/api/footfive/match/ff69-forward-passing") {
      const since = Number(url.searchParams.get("since") ?? 0);
      body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture,
        events: events.filter((event) => event.seq > since), eventsPage: { nextSeq: 3, hasMore: false, throughMs: now },
        lineups: { home: lineup("Home"), away: lineup("Away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/ff69-forward-passing") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: "first_half", closed: null }, blocked: null, markets: [] };
    else { unexpectedApi.push(url.pathname); await route.abort(); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/match/ff69-forward-passing");
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
    const direction = scenario.side === "home" ? 1 : -1;
    const samples = [];
    let controlNo: number | null = null;
    let firstControl: { elapsed: number; ball: number[] } | null = null;
    let lastControl: { elapsed: number; ball: number[] } | null = null;
    let finalContact: { elapsed: number; ball: number[] } | null = null;
    let releaseFlight = false;
    const shots = new Set<string>();
    for (let elapsed = 16; elapsed <= 1456; elapsed += 16) {
      await page.clock.runFor(16);
      const drawing = await page.getByTestId("pitch").evaluate((pitch) => {
        const ball = pitch.querySelector('svg circle[stroke="#111"]')!;
        const b = [Number(ball.getAttribute("cx")), Number(ball.getAttribute("cy"))];
        const players = Array.from(pitch.querySelectorAll('[data-testid="player"]')).map((player) => {
          const coords = player.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
          const kit = player.querySelector('[data-kit]')!;
          return { side: kit.getAttribute("stroke") === "#ff00cc" ? "away" : "home", no: Number(player.querySelector("text")!.textContent),
            keeper: kit.getAttribute("fill") === "#c6ff00", ring: !!player.querySelector('[data-ring]'),
            distance: Math.hypot(Number(coords[1]) - b[0], Number(coords[2]) - b[1]) };
        });
        return { ball: b, players };
      });
      samples.push({ elapsed, ...drawing });
      const holders = drawing.players.filter((p) => p.ring);
      expect(holders.some((p) => p.side !== scenario.side), "pass must not invent opposing possession").toBe(false);
      const intermediate = holders.find((p) => p.side === scenario.side && !p.keeper && p.no !== 2 && p.no !== 3);
      // The pass is over by 1067ms at this pace; subsequent dwell is a different
      // possession sequence and cannot be counted as the constructive lay-off.
      if (intermediate && elapsed < 900) {
        expect(intermediate.distance, "drawn receiving touch must be on the grounded ball").toBeLessThanOrEqual(1.6);
        controlNo ??= intermediate.no;
        expect(intermediate.no, "the same teammate controls the lay-off").toBe(controlNo);
        firstControl ??= { elapsed, ball: drawing.ball };
        lastControl = { elapsed, ball: drawing.ball };
        if (!shots.has("control")) {
          shots.add("control");
          await page.screenshot({ path: testInfo.outputPath("controlled-touch.png") });
        }
      }
      if (lastControl && !holders.length && direction * (drawing.ball[0] - lastControl.ball[0]) > 0.5 && elapsed < 1100) releaseFlight = true;
      const receiver = holders.find((p) => p.side === scenario.side && p.no === 3 && p.distance <= 1.6);
      if (receiver && Math.hypot(drawing.ball[0] - events[0].ball![0], drawing.ball[1] - events[0].ball![1]) <= 1.6) finalContact ??= { elapsed, ball: drawing.ball };
      if (elapsed % 80 === 0) {
        await expect(page.getByTestId("match-score")).toHaveText("0–0");
        await expect(page.getByTestId("hud-score")).toContainText("0–0");
        await expect(page.getByTestId("commentary")).toHaveText(events[0].text);
        await expect(page.getByTestId("event-feed").filter({ hasText: events[1].text })).toHaveCount(0);
        await expect(page.getByTestId("goal-banner")).toHaveCount(0);
      }
    }
    await testInfo.attach("pass-samples", { body: JSON.stringify(samples), contentType: "application/json" });
    if (backward) {
      expect(firstControl, "backward pass has a distinct controlled lay-off before release").not.toBeNull();
      expect(lastControl!.elapsed - firstControl!.elapsed, "receiving touch stays readable").toBeGreaterThanOrEqual(80);
      expect(direction * (events[0].from![0] - firstControl!.ball[0]), "initial leg is the lay-off").toBeGreaterThan(5);
      expect(releaseFlight, "control is followed by a forward free-flight release").toBe(true);
      expect(direction * (finalContact!.ball[0] - lastControl!.ball[0]), "release advances into named receiver").toBeGreaterThan(2);
    } else {
      expect(firstControl, "ordinary forward pass must not gain an extra lay-off participant").toBeNull();
      expect(direction * (samples.at(-1)!.ball[0] - samples[0].ball[0])).toBeGreaterThan(5);
    }
    expect(finalContact, "named final receiver P2 (shirt 3) meets the ball at the published endpoint").not.toBeNull();
    await page.screenshot({ path: testInfo.outputPath("final-receiver.png") });
    expect(unexpectedApi).toEqual([]);
    expect(errors).toEqual([]);
  });
}
