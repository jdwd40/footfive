/**
 * #203 on the real MatchPage with a mocked live match: no camera zoom through two penalties and a penalty goal, the
 * half-time banner inside the pitch from 320 to 1920 px, one Match events row per attack with each penalty's cause, and a
 * withdrawn price that turns unavailable without moving the page.
 */
import { expect, test, type Page } from "@playwright/test";
import type { FixtureCard, LiveView, Market, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

const START = Date.UTC(2030, 0, 1);
const LAG = 1500; // MatchPage LAG_MS: the pitch plays this far behind the server clock
const team = (id: string, name: string, abbreviation: string, primary_color: string): TeamPublic => ({ id, name, abbreviation, grade: "A", primary_color, secondary_color: "#111", badge_key: "test" });
const HOME = team("mc2", "Mega City Two", "MC2", "#6ab4ff");
const AWAY = team("met", "New Metro City", "MET", "#ff453a");
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i ? "util" : "gk", starter: true }));
const st = (min: number, sc: [number, number], ph = "first_half", run: 0 | 1 = 1): PubState => ({ sc, so: null, ph, clk: { s: min * 60, run }, pos: 50, x: [Array(8).fill(0), Array(8).fill(0)], d: 0, win: null, by: null });
const T = (s: number) => START + s * 1000;
const pen = (outcome: string) => ({ col: 0, height: outcome === "woodwork" ? 2 : 0, dive: 1, post: outcome === "woodwork" ? "bar" : null, run: 0, outcome });
const AWARD_1 = "PENALTY to New Metro City! away P2 is brought down by home P3";
const AWARD_2 = "PENALTY to New Metro City! away P3 is brought down by home P2";
const events: MatchEvent[] = [
  { seq: 1, at: T(0), t: "kickoff", min: 0, side: "home", p: "home P2", text: "Kick-off!", st: st(0, [0, 0]) },
  { seq: 2, at: T(4), t: "shot", min: 5, side: "home", chain: 2, p: "home P2", ball: [80, 30], text: "home P2 lets fly!", st: st(5, [0, 0]) },
  { seq: 3, at: T(5.3), t: "save", min: 5, side: "away", chain: 2, p: "away P0", p2: "home P2", from: [80, 30], target: [100, 31], ball: [97, 31], text: "Brilliant stop by away P0!", st: st(5, [0, 0]) },
  { seq: 4, at: T(10), t: "penalty_awarded", min: 39, side: "away", chain: 4, p: "away P2", p2: "home P3", ball: [11, 32], major: 1, text: AWARD_1, st: st(39, [0, 0], "first_half", 0) },
  { seq: 5, at: T(15), t: "penalty_setup", min: 39, side: "away", chain: 4, p: "away P1", p2: "home P0", ball: [11, 32], text: "away P1 places the ball.", st: st(39, [0, 0], "first_half", 0) },
  { seq: 6, at: T(20), t: "penalty_woodwork", min: 39, side: "away", chain: 4, p: "away P1", p2: "home P0", ball: [11, 32], pen: pen("woodwork"), major: 1, text: "away P1 hits the bar from the spot!", st: st(39, [0, 0], "first_half", 0) } as MatchEvent,
  { seq: 7, at: T(22), t: "restart", min: 39, side: "home", ball: [5, 32], text: "Mega City Two clear their lines", st: st(39, [0, 0]) },
  { seq: 8, at: T(26), t: "penalty_awarded", min: 45, side: "away", chain: 8, p: "away P3", p2: "home P2", ball: [11, 32], major: 1, text: AWARD_2, st: st(44.5, [0, 0], "first_half", 0) },
  { seq: 9, at: T(31), t: "penalty_setup", min: 45, side: "away", chain: 8, p: "away P1", p2: "home P0", ball: [11, 32], text: "away P1 places the ball.", st: st(44.5, [0, 0], "first_half", 0) },
  { seq: 10, at: T(36), t: "penalty_goal", min: 45, side: "away", chain: 8, p: "away P1", p2: "home P0", target: [0, 32], ball: [0, 32], pen: pen("goal"), major: 1, text: "PENALTY SCORED! away P1 scores for New Metro City", st: st(44.5, [0, 1], "first_half", 0) } as MatchEvent,
  { seq: 11, at: T(37.4), t: "celebration", min: 45, side: "away", chain: 8, p: "away P1", text: "away P1 wheels away", st: st(44.5, [0, 1], "first_half", 0) },
  { seq: 12, at: T(42), t: "half_time", min: 45, text: "Half-time: MC2 0–1 MET", st: st(45, [0, 1], "half_time", 0) },
];
const winner = (away: number | null): Market => ({ key: "winner", title: "To qualify", rules: "Team that goes through, including extra time and penalties.", closed: null, sel: [{ id: "home", label: HOME.name, short: "MC2", odds: null }, { id: "away", label: AWAY.name, short: "MET", odds: away }] });
const nextGoal: Market = { key: "next_goal", title: "Next goal", rules: "Next goal after your bet is accepted.", closed: null, sel: [{ id: "home", label: HOME.name, short: "MC2", odds: 4.1 }, { id: "none", label: "No further goals", short: "None", odds: 1.6 }, { id: "away", label: AWAY.name, short: "MET", odds: 2.2 }] };

async function mount(page: Page, opts: { pause: number; marketCalls?: { n: number } }) {
  const user = { id: "quickfixuser0001", email: "quickfix@example.invalid", display_name: "Quick fix test", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: opts.pause - 1000 });
  await page.clock.pauseAt(opts.pause);
  await injectAuth(page, token, user);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const now = await page.evaluate(() => Date.now());
    const published = events.filter((e) => e.at <= now);
    const last = published.at(-1)!;
    const fixture: FixtureCard = { id: "quickfix", slot: "a", index: 0, home: HOME, away: AWAY, status: "live", kickoffAt: START, minuteMs: 6000, st: last.st, at: last.at, seq: last.seq, last: null, odds: null };
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: 6000 }, championship: null, round: { id: "r", key: "r16", label: "Round of 16", status: "live", scheduledAt: START, finishedAt: null }, fixtures: [fixture], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as LiveView;
    else if (url.pathname === "/api/footfive/match/quickfix") body = { serverTimeMs: now, round: { id: "r", key: "r16", label: "Round of 16", status: "live" }, fixture, events: published.filter((e) => e.seq > Number(url.searchParams.get("since") ?? 0)), eventsPage: { nextSeq: last.seq, hasMore: false, throughMs: now }, lineups: { home: lineup("home"), away: lineup("away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/quickfix") {
      // First answer prices MET at 1.06; every later one has withdrawn it (null), as odds.js does once it is all but certain.
      const n = opts.marketCalls ? opts.marketCalls.n++ : 1;
      body = { serverTimeMs: now, fixtureId: "quickfix", seq: last.seq, state: { phase: "live", closed: null }, blocked: null, markets: [winner(n === 0 ? 1.06 : null), nextGoal] };
    } else throw new Error(`Unexpected API in #203 spec: ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.goto("/match/quickfix");
  await expect.poll(async () => { await page.clock.runFor(50); return page.getByTestId("pitch").count(); }).toBe(1);
  await page.evaluate(() => document.fonts.ready);
}

const until = async (page: Page, t: number) => page.clock.runFor(Math.max(0, t - (await page.evaluate(() => Date.now()))));

test("no camera zoom through a penalty award, the kick, a penalty goal and its celebration", async ({ page }) => {
  await mount(page, { pause: T(9) });
  const svg = page.getByTestId("pitch").locator("svg");
  const seen = new Set<string>();
  let penalty = false;
  let goal = false;
  for (let t = T(10) + LAG + 300; t < T(41) + LAG; t += 400) {
    await until(page, t);
    seen.add((await svg.getAttribute("viewBox"))!);
    penalty ||= (await page.getByText("PENALTY", { exact: true }).count()) > 0;
    goal ||= (await page.getByTestId("goal-banner").count()) > 0;
  }
  expect([...seen]).toEqual(["-4 -3 108 77"]);
  expect(penalty, "the PENALTY tag still shows").toBe(true);
  expect(goal, "the big GOOOAL message still shows for the penalty goal").toBe(true);
});

test("the half-time banner stays large and inside the pitch from 320 to 1920 px, with the crowd drawn round it", async ({ page }) => {
  await mount(page, { pause: T(42) + LAG + 2500 });
  const banner = page.getByTestId("period-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText("HALF-TIME · MC2 0–1 MET");
  for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.clock.runFor(100);
    const pitch = (await page.getByTestId("pitch").boundingBox())!;
    const lines = await page.getByTestId("banner-title").evaluate((title) =>
      [...title.children].filter((c) => (c as HTMLElement).offsetParent).map((c) => {
        const range = document.createRange();
        range.selectNodeContents(c);
        const r = range.getBoundingClientRect();
        return { text: c.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, px: parseFloat(getComputedStyle(c).fontSize) };
      }));
    expect(lines.map((l) => l.text), `${viewport.width}px`).toEqual(["HALF-TIME", "MC2 0–1 MET"]);
    for (const l of lines) {
      expect(l.left, `${l.text} at ${viewport.width}px`).toBeGreaterThanOrEqual(pitch.x);
      expect(l.right, `${l.text} at ${viewport.width}px`).toBeLessThanOrEqual(pitch.x + pitch.width);
      expect(l.top).toBeGreaterThanOrEqual(pitch.y);
      expect(l.bottom).toBeLessThanOrEqual(pitch.y + pitch.height);
      expect(l.px, `still large at ${viewport.width}px`).toBeGreaterThanOrEqual(Math.min(60, pitch.width * 0.08));
    }
    for (const side of ["home", "away"]) {
      const crowd = (await page.getByTestId(`${side}-crowd`).boundingBox())!;
      expect(crowd.height, `${side} crowd at ${viewport.width}px`).toBeGreaterThan(pitch.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)).toBe(false);
  }
});

test("Match events: one row per attack, and each penalty row says what caused it", async ({ page }) => {
  await mount(page, { pause: T(42) + LAG + 2500 });
  const rows = page.getByTestId("event-feed").locator("li");
  await expect(rows).toHaveCount(5); // half-time, 2nd penalty + goal, 1st penalty + bar, shot + save, kick-off
  await expect(rows.nth(1)).toContainText(`${AWARD_2} (2nd penalty of the match, a new foul in the box) — PENALTY SCORED!`);
  await expect(rows.nth(2)).toContainText(`${AWARD_1} — away P1 hits the bar from the spot!`);
  await expect(rows.nth(3)).toContainText("home P2 lets fly! — Brilliant stop by away P0!");
  await expect(rows.nth(3)).toContainText("MC2"); // the attack's side, not the keeper's
  await expect(rows.nth(1).getByRole("button", { name: /Replay/ })).toBeVisible(); // the merged row replays the kick
});

test("a price withdrawn on refresh becomes unavailable in place, without moving the page", async ({ page }) => {
  await mount(page, { pause: T(43) + LAG, marketCalls: { n: 0 } }); // every event is out: nothing else moves the layout meanwhile
  await page.getByTestId("bet-tab-toggle").click(); // #207: betting is folded into one tab
  const met = page.getByTestId("odds-winner-away");
  await expect(met).toHaveText(/1\.06/);
  const markets = page.getByTestId("markets");
  const tab = page.getByTestId("bet-tab");
  const pitch = page.getByTestId("pitch");
  const before = { button: (await met.boundingBox())!, panel: (await markets.boundingBox())!, tab: (await tab.boundingBox())!, pitch: (await pitch.boundingBox())! };
  await expect.poll(async () => { await page.clock.runFor(1000); return met.textContent(); }).toContain("Not offered");
  await expect(met).toBeDisabled();
  const after = { button: (await met.boundingBox())!, panel: (await markets.boundingBox())!, tab: (await tab.boundingBox())!, pitch: (await pitch.boundingBox())! };
  for (const k of ["x", "y", "width", "height"] as const) {
    expect(after.button[k], `button ${k}`).toBeCloseTo(before.button[k], 1);
    expect(after.panel[k], `markets ${k}`).toBeCloseTo(before.panel[k], 1);
    expect(after.tab[k], `bet tab ${k}`).toBeCloseTo(before.tab[k], 1);
    expect(after.pitch[k], `pitch ${k}`).toBeCloseTo(before.pitch[k], 1);
  }
  // #207 (deferred #203 finding): the reason is now visible to sighted users too, in the panel's reserved status line, so it
  // still moves nothing (the geometry above).
  const hint = page.getByTestId("unoffered-hint");
  await expect(hint).toBeVisible();
  await expect(hint).not.toHaveClass(/sr-only/);
  await expect(met).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
});
