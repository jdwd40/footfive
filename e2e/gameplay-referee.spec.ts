import { expect, test } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

const START = Date.UTC(2030, 0, 1);
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.toUpperCase(), grade: "A", primary_color: id === "home" ? "#00e5ff" : "#ff00cc", secondary_color: "#fff", badge_key: "test" });
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i ? "util" : "gk", starter: true }));
const scenarios = [
  { type: "yellow_card", side: "home", phase: "first_half", pose: "card-yellow", colour: "#ffd400" },
  { type: "red_card", side: "away", phase: "second_half", pose: "card-red", colour: "#ff3344" },
  { type: "foul", side: "home", phase: "second_half", pose: "point", colour: null },
  { type: "penalty_awarded", side: "away", phase: "first_half", pose: "point", colour: null },
] as const;

for (const scenario of scenarios) for (const reduced of [false, true]) {
  test(`${scenario.type}: visible referee signal and reset, reduced motion=${reduced}`, async ({ page }, testInfo) => {
    const state: PubState = { sc: [0, 0], so: null, ph: scenario.phase, clk: { s: 60, run: 1 }, pos: 50, x: [Array(7).fill(0), Array(7).fill(0)], d: 0, win: null, by: null };
    const other = scenario.side === "home" ? "away" : "home";
    const card = scenario.colour !== null;
    const events: MatchEvent[] = [
      { seq: 1, at: START - 10000, t: "pass", min: 1, side: "home", p: "home P2", p2: "home P3", ball: [50, 32], text: "Prior play", st: state },
      { seq: 2, at: START + 3000, t: scenario.type, min: 1, side: scenario.side, p: `${scenario.side} P3`,
        ...(card ? {} : { p2: `${other} P3`, ball: scenario.type === "penalty_awarded" ? [11, 32] : [50, 32] }), text: "Referee decision", st: state },
      { seq: 3, at: START + 15000, t: "pass", min: 2, side: "home", p: "home P2", p2: "home P3", ball: [50, 32], text: "Play resumes", st: state },
    ];
    const fixture: FixtureCard = { id: "referee-signals", slot: "a", index: 0, home: team("home"), away: team("away"), status: "live", kickoffAt: START - 60000, minuteMs: 15000, st: state, at: events[2].at, seq: 3, last: null, odds: null };
    const user = { id: "refereetestuser1", email: "referee@example.invalid", display_name: "Referee test", role: "user", must_change_password: false };
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
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
      else if (url.pathname === "/api/footfive/match/referee-signals") body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture, events: events.filter(e => e.seq > Number(url.searchParams.get("since") ?? 0)), eventsPage: { nextSeq: 3, hasMore: false, throughMs: now }, lineups: { home: lineup("home"), away: lineup("away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
      else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
      else if (url.pathname === "/api/footfive/markets/referee-signals") body = { serverTimeMs: now, fixtureId: fixture.id, seq: 3, state: { phase: scenario.phase, closed: null }, blocked: null, markets: [] };
      else { unexpected.push(url.pathname); await route.abort(); return; }
      await route.fulfill({ json: body });
    });
    await page.goto("/match/referee-signals");
    const ref = page.getByTestId("ref");
    await expect.poll(async () => { await page.clock.runFor(50); return ref.count(); }).toBe(1);
    await page.clock.runFor(START + 4600 - await page.evaluate(() => Date.now()));
    if (scenario.type === "foul" && !reduced) await expect(ref).toHaveAttribute("data-pose", "whistle");
    await page.clock.runFor(2500);
    await expect(ref).toHaveAttribute("data-pose", scenario.pose);
    if (scenario.colour) {
      await expect(page.getByTestId("ref-card")).toHaveAttribute("fill", scenario.colour);
      await expect(page.getByText(scenario.type === "red_card" ? "RED CARD" : "BOOKED", { exact: true })).toBeVisible();
    } else {
      await expect(ref.locator("[data-ref-arm]")).toHaveCount(1);
      await expect(page.getByTestId("ref-card")).toHaveCount(0);
    }
    if (scenario.type === "foul") {
      // Home committed the foul; away attacks the canonical left goal, shown on the right in this second-half event.
      expect(Number(await ref.locator("[data-ref-arm]").getAttribute("x2"))).toBeGreaterThan(0);
    }
    if (scenario.type === "penalty_awarded") {
      const clearance = await page.getByTestId("pitch").evaluate(pitch => {
        const ref = pitch.querySelector('[data-testid="ref"]')!.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
        const ball = pitch.querySelector('circle[stroke="#111"]')!;
        return Math.hypot(Number(ref[1]) - Number(ball.getAttribute("cx")), Number(ref[2]) - Number(ball.getAttribute("cy")));
      });
      expect(clearance, "referee remains clear of the ball while pointing to the spot").toBeGreaterThan(4);
    }
    if (reduced) {
      const position = await ref.getAttribute("transform");
      await page.clock.runFor(300);
      await expect(ref).toHaveAttribute("transform", position!);
    }
    await page.getByTestId("pitch").screenshot({ path: testInfo.outputPath("referee-signal.png") });
    await expect(page.getByTestId("match-score")).toHaveText("0–0");
    await expect(page.getByTestId("won-badge")).toHaveCount(0);
    await page.clock.runFor(START + 16600 - await page.evaluate(() => Date.now()));
    await expect(ref).toHaveAttribute("data-pose", "run");
    await expect(page.getByTestId("ref-card")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
