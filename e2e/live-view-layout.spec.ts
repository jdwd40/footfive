/**
 * #207 on the real MatchPage with a mocked live match: one scoreboard (score once, big clock, timeline with goal and card markers),
 * one merged ticker, the pitch higher up with the events and line-ups beside it on desktop, no layout shift through a match, and
 * betting folded into a fixed-height tab whose requests, payloads and bet slip flow are unchanged.
 */
import { expect, test, type Page } from "@playwright/test";
import type { FixtureCard, LiveView, Market, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

const START = Date.UTC(2030, 0, 1);
const LAG = 1500; // MatchPage LAG_MS
const MIN_MS = 6000;
const team = (id: string, name: string, abbreviation: string, primary_color: string): TeamPublic => ({ id, name, abbreviation, grade: "A", primary_color, secondary_color: "#111", badge_key: "test" });
const HOME = team("mc2", "Mega City Two", "MC2", "#6ab4ff");
const AWAY = team("met", "New Metro City", "MET", "#ff453a");
const OTHER_H = team("phl", "Port Hilo", "PHL", "#f4c430");
const OTHER_A = team("tri", "Tripper City", "TRI", "#9b59ff");
const lineup = (side: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${side} P${i}`, no: i + 1, role: i ? "util" : "gk", starter: true }));
const T = (s: number) => START + s * 1000;
const st = (sec: number, sc: [number, number], d: 0 | 1 = 0, ph = "first_half"): PubState => ({ sc, so: null, ph, clk: { s: sec, run: 1 }, pos: 50, x: [Array(8).fill(0), Array(8).fill(0)], d, win: null, by: null });
const events: MatchEvent[] = [
  { seq: 1, at: T(0), t: "kickoff", min: 0, side: "home", p: "home P2", major: 1, text: "Kick-off!", st: st(0, [0, 0]) },
  { seq: 2, at: T(3), t: "pass", min: 0, side: "home", p: "home P2", p2: "home P3", ball: [55, 30], text: "home P2 finds home P3", st: st(30, [0, 0]) },
  { seq: 3, at: T(8), t: "yellow_card", min: 1, side: "home", p: "home P3", major: 1, ball: [55, 30], text: "Yellow card — home P3", tick: "Yellow card — home P3 (MC2)", st: st(80, [0, 0]) },
  { seq: 4, at: T(12), t: "pass", min: 2, side: "away", p: "away P2", p2: "away P3", ball: [30, 30], text: "away P2 finds away P3", st: st(120, [0, 0]) },
  { seq: 5, at: T(16), t: "goal", min: 2, side: "away", chain: 5, p: "away P3", ball: [12, 32], target: [0, 32], major: 1, text: "GOAL! away P3 scores for New Metro City", tick: "GOAL! MC2 0–1 MET — away P3, 2′", st: st(160, [0, 1], 1) },
  { seq: 6, at: T(17.4), t: "celebration", min: 2, side: "away", chain: 5, p: "away P3", text: "away P3 wheels away", st: st(160, [0, 1], 1) },
  { seq: 7, at: T(25), t: "kickoff", min: 2, side: "home", p: "home P2", text: "Mega City Two restart", st: st(170, [0, 1]) },
  { seq: 8, at: T(28), t: "pass", min: 3, side: "home", p: "home P2", p2: "home P4", ball: [60, 40], text: "home P2 finds home P4", st: st(200, [0, 1]) },
  { seq: 9, at: T(36), t: "pass", min: 4, side: "home", p: "home P4", p2: "home P2", ball: [62, 30], text: "home P4 back to home P2", st: st(260, [0, 1]) },
] as MatchEvent[];
const OTHER_GOAL = T(21);

/** Real-shaped markets (pocketbase markets.js): the exact grid is the current score to +5. `drop` leaves scores out, as in play. */
function markets(sc: [number, number], phase: "priced" | "withdrawn", closed: string | null): Market[] {
  const exact = [];
  for (let h = sc[0]; h <= sc[0] + 5; h++) for (let a = sc[1]; a <= sc[1] + 5; a++) {
    const id = `${h}-${a}`;
    if (h + a > 7 || (phase === "withdrawn" && id === `${sc[0]}-${sc[1]}`)) continue;
    exact.push({ id, label: `MC2 ${h}–${a} MET`, short: `${h}–${a}`, odds: +(4 + h * 3 + a * 2.5).toFixed(2) });
  }
  return [
    { key: "winner", title: "To qualify", rules: "Team that goes through, including extra time and penalties.", closed, sel: [{ id: "home", label: HOME.name, short: "MC2", odds: 2.4 }, { id: "away", label: AWAY.name, short: "MET", odds: phase === "withdrawn" ? null : 1.55 }] },
    { key: "exact", title: "Exact score (after ET)", rules: "Final football score including extra time. Shootout goals do not count.", closed, sel: exact },
    { key: "next_goal", title: "Next goal", rules: "Next goal after your bet is accepted.", closed, sel: [{ id: "home", label: HOME.name, short: "MC2", odds: 2.1 }, { id: "none", label: "No further goals", short: "None", odds: 3.3 }, { id: "away", label: AWAY.name, short: "MET", odds: 2.0 }] },
  ];
}

type Req = { method: string; path: string; search: string; body: unknown; at: number };
type Opts = { start: number; betTab?: "open"; marketPhase?: (now: number) => "priced" | "withdrawn" };

async function mount(page: Page, opts: Opts) {
  const user = { id: "layout207user01", email: "layout207@example.invalid", display_name: "Layout test", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  const requests: Req[] = [];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: opts.start - 1000 });
  await page.clock.pauseAt(opts.start);
  await injectAuth(page, token, user);
  await page.addInitScript((tab) => {
    if (tab) localStorage.setItem("ff_bet_tab", tab);
    const w = window as unknown as { __shifts: Array<{ value: number; sources: string[]; feed: boolean }> };
    w.__shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
        const nodes = (e.sources ?? []).map((s) => s.node).filter(Boolean) as Node[];
        // A shift led by the rows of the Match events list (a new row goes on top of the older ones, inside the list's own box).
        const feed = nodes.some((n) => n instanceof Element && !!n.closest('[data-testid="event-feed"]'));
        if (!e.hadRecentInput) w.__shifts.push({ value: e.value, feed, sources: (e.sources ?? []).map((s) => (s.node instanceof Element ? `${s.node.tagName}#${s.node.getAttribute("data-testid") ?? ""}.${s.node.className}` : String(s.node?.nodeName))) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, opts.betTab ?? null);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const now = await page.evaluate(() => Date.now());
    requests.push({ method: req.method(), path: url.pathname, search: url.search, body: req.postDataJSON?.() ?? null, at: now });
    const published = events.filter((e) => e.at <= now);
    const last = published.at(-1) ?? null;
    const fixture: FixtureCard = { id: "layout", slot: "a", index: 0, home: HOME, away: AWAY, status: last ? "live" : "scheduled", kickoffAt: START, minuteMs: MIN_MS, st: last?.st ?? null, at: last?.at ?? null, seq: last?.seq ?? 0, last: null, odds: null } as FixtureCard;
    const scored = now >= OTHER_GOAL;
    const other: FixtureCard = { ...fixture, id: "other", slot: "b", index: 1, home: OTHER_H, away: OTHER_A, st: last ? { ...last.st, sc: scored ? [1, 0] : [0, 0], d: 0 } : null };
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: MIN_MS }, championship: null, round: { id: "r", key: "r16", label: "Round of 16", status: "live", scheduledAt: START, finishedAt: null }, fixtures: [fixture, other], bracket: [], ticker: scored ? [{ id: "other:9", fixtureId: "other", seq: 9, at: OTHER_GOAL, t: "goal", side: "home", text: "GOAL! PHL 1–0 TRI", min: 3 }] : [], champion: null, nextChampionshipAt: null } as LiveView;
    else if (url.pathname === "/api/footfive/match/layout") body = { serverTimeMs: now, round: { id: "r", key: "r16", label: "Round of 16", status: "live" }, fixture, events: published.filter((e) => e.seq > Number(url.searchParams.get("since") ?? 0)), eventsPage: { nextSeq: last?.seq ?? 0, hasMore: false, throughMs: now }, lineups: { home: lineup("home"), away: lineup("away") }, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/layout") {
      const closed = last?.st.d ? "Suspended — incident in progress" : null;
      body = { serverTimeMs: now, fixtureId: "layout", seq: last?.seq ?? 0, state: { phase: last ? "live" : "pre", closed }, blocked: null, markets: markets(last?.st.sc ?? [0, 0], opts.marketPhase?.(now) ?? "priced", closed) };
    } else if (url.pathname === "/api/footfive/bets" && req.method() === "POST") {
      const b = req.postDataJSON();
      body = { bet: { id: "bet1", market: b.market, title: "Next goal", label: "Next goal: New Metro City", selection: b.selection, fixtureId: b.fixtureId, stake: b.stake, odds: b.odds, potential: Math.floor(b.stake * b.odds), status: "open", payout: 0 }, duplicate: false };
    } else throw new Error(`Unexpected API in #207 spec: ${req.method()} ${url.pathname}`);
    await route.fulfill({ json: body });
  });
  await page.goto("/match/layout");
  await expect.poll(async () => { await page.clock.runFor(50); return page.getByTestId("pitch").count(); }).toBe(1);
  await page.evaluate(() => document.fonts.ready);
  return requests;
}

const until = async (page: Page, t: number) => page.clock.runFor(Math.max(0, t - (await page.evaluate(() => Date.now()))));
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).first().boundingBox())!;

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`one scoreboard with the big clock and a timeline, one ticker, the pitch higher, side panels — ${vp.width}px`, async ({ page }) => {
    await page.setViewportSize(vp);
    await mount(page, { start: T(30) });
    await until(page, T(30) + LAG + 500);
    // The score appears once, on the scoreboard: no score strip on the pitch, none in the ticker row.
    await expect(page.getByTestId("match-score")).toHaveCount(1);
    await expect(page.getByTestId("match-score")).toHaveText("0–1");
    await expect(page.getByTestId("hud-score")).toHaveCount(0);
    await expect(page.getByTestId("pitch-hud")).toHaveCount(0);
    const board = page.getByTestId("match-scoreboard");
    const clock = board.getByLabel("Match clock");
    await expect(clock).toBeVisible();
    expect(parseFloat(await clock.evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    // Timeline under the score: the card (home, above the line) and the goal (away, below) at their minutes, and the current minute.
    const marks = board.getByTestId("timeline-mark");
    await expect(marks).toHaveCount(2);
    expect(await marks.evaluateAll((els) => els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-side"), e.getAttribute("data-min")]))).toEqual([["yellow", "home", "1"], ["goal", "away", "2"]]);
    const tl = await box(page, "timeline");
    const [yellow, goal] = [(await marks.nth(0).boundingBox())!, (await marks.nth(1).boundingBox())!];
    expect(yellow.y + yellow.height / 2).toBeLessThan(tl.y + tl.height / 2);
    expect(goal.y + goal.height / 2).toBeGreaterThan(tl.y + tl.height / 2);
    expect(Number(await page.getByTestId("timeline-progress").getAttribute("data-minute"))).toBe(3);
    expect(tl.y).toBeGreaterThan((await box(page, "match-score")).y);
    // One ticker row for this match and the others.
    await expect(page.getByTestId("ticker")).toHaveCount(1);
    await expect(page.getByTestId("ticker-badge")).toHaveText(/This match|Elsewhere/);
    // The pitch starts higher (main: 254 px at 390×844, 258 px at 1280×800) and the whole scoreboard sits above it.
    const pitch = await box(page, "pitch");
    const sb = await box(page, "match-scoreboard");
    expect(pitch.y).toBeLessThan(vp.width < 640 ? 230 : 205);
    expect(sb.y + sb.height).toBeLessThanOrEqual(pitch.y);
    const feed = await box(page, "event-feed");
    const lineups = await box(page, "lineups");
    if (vp.width >= 1024) {
      // Desktop: the events and line-ups are beside the pitch, in the first screen.
      for (const b of [feed, lineups]) {
        expect(b.x).toBeGreaterThanOrEqual(pitch.x + pitch.width);
        expect(b.y).toBeLessThan(pitch.y + pitch.height);
      }
      expect(feed.y).toBeLessThan(vp.height);
    } else {
      // Phones: stacked under the pitch.
      for (const b of [feed, lineups]) expect(b.y).toBeGreaterThan(pitch.y + pitch.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)).toBe(false);
  });
}

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`no layout shift from before kick-off through the first card, a goal, a goal elsewhere and withdrawn markets — ${vp.width}px`, async ({ page }) => {
    await page.setViewportSize(vp);
    // The bet tab is open so the markets' withdrawals and suspension are on screen too.
    await mount(page, { start: T(-2), betTab: "open", marketPhase: (now) => (now >= T(26) ? "withdrawn" : "priced") });
    const ids = ["match-top", "match-scoreboard", "timeline", "pitch", "commentary", "bet-tab", "bet-tab-body", "markets-status", "lineups"];
    const geometry = () => page.evaluate((list) => Object.fromEntries(list.map((id) => {
      const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      return [id, [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10)];
    })), ids);
    await until(page, T(-1));
    await expect(page.getByTestId("markets")).toBeVisible();
    const first = await geometry();
    // Loading (the skeleton, the wallet chip) is before the match is on screen; count what happens from here on.
    const loaded = await page.evaluate(() => (window as unknown as { __shifts: unknown[] }).__shifts.length);
    const seen = { ticker: false, card: false, goal: false, elsewhere: false, suspended: false, withdrawn: false };
    for (let t = T(-1); t <= T(40); t += 500) {
      await until(page, t);
      expect(await geometry(), `layout at t=${(t - START) / 1000}s`).toEqual(first);
      seen.ticker ||= (await page.getByTestId("ticker-current").count()) > 0;
      seen.card ||= (await page.getByTestId("timeline-mark").count()) > 0;
      seen.goal ||= (await page.getByTestId("goal-banner").count()) > 0;
      seen.elsewhere ||= (await page.getByTestId("other-score").filter({ hasText: "1–0" }).count()) > 0;
      seen.suspended ||= (await page.getByTestId("markets-suspended").count()) > 0;
      seen.withdrawn ||= (await page.getByTestId("odds-winner-away").textContent())?.includes("Not offered") ?? false;
    }
    expect(seen).toEqual({ ticker: true, card: true, goal: true, elsewhere: true, suspended: true, withdrawn: true });
    // The browser's own measure agrees: (near) zero cumulative layout shift. The page layout adds next to nothing; what is left is
    // the Match events list itself, whose newest row goes on top inside its fixed-height box (it moves nothing outside it).
    const shifts = (await page.evaluate(() => (window as unknown as { __shifts: Array<{ value: number; sources: string[]; feed: boolean }> }).__shifts)).slice(loaded);
    const sum = (list: typeof shifts) => list.reduce((n, s) => n + s.value, 0);
    const top = (list: typeof shifts) => JSON.stringify([...list].sort((x, y) => y.value - x.value).slice(0, 4));
    const layout = shifts.filter((s) => !s.feed);
    await test.info().attach("layout-shifts", { body: JSON.stringify({ total: sum(shifts), page: sum(layout), feed: sum(shifts) - sum(layout), shifts }), contentType: "application/json" });
    expect(sum(layout), top(layout)).toBeLessThan(0.001);
    expect(sum(shifts), top(shifts)).toBeLessThan(0.005);
  });
}

test("betting tab: folded by default, same requests whether open or not, a fixed height, the suspended state, and the bet slip flow with the same payload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const requests = await mount(page, { start: T(40) }); // every event is out: no published sequence moves the markets meanwhile
  const toggle = page.getByTestId("bet-tab-toggle");
  const body = page.getByTestId("bet-tab-body");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(body).toBeHidden();
  // Folded, the markets still load and poll exactly as before (MarketsPanel's 5 s poll); opening the tab changes nothing.
  const marketsCalls = () => requests.filter((r) => r.path === "/api/footfive/markets/layout");
  const t0 = await page.evaluate(() => Date.now());
  await until(page, t0 + 20000);
  const folded = marketsCalls().filter((r) => r.at > t0 && r.at <= t0 + 20000);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(body).toBeVisible();
  const t1 = await page.evaluate(() => Date.now());
  await until(page, t1 + 20000);
  const opened = marketsCalls().filter((r) => r.at > t1 && r.at <= t1 + 20000);
  expect(folded.length).toBeGreaterThanOrEqual(3);
  expect(Math.abs(opened.length - folded.length)).toBeLessThanOrEqual(1);
  for (const r of [...folded, ...opened]) expect([r.method, r.search]).toEqual(["GET", ""]);
  const all = marketsCalls();
  for (let i = 1; i < all.length; i++) if (all[i - 1].at > t0) {
    expect(all[i].at - all[i - 1].at, "markets poll interval").toBeGreaterThanOrEqual(4990);
    expect(all[i].at - all[i - 1].at, "markets poll interval").toBeLessThan(6500);
  }
  // No other request appeared because of the tab.
  const known = ["/api/collections/users/auth-refresh", "/api/footfive/me", "/api/footfive/live", "/api/footfive/match/layout", "/api/footfive/bets/mine", "/api/footfive/markets/layout"];
  expect(requests.filter((r) => !known.includes(r.path)).map((r) => r.path)).toEqual([]);
  expect(requests.filter((r) => r.method !== "GET" && r.path !== "/api/collections/users/auth-refresh").map((r) => r.path)).toEqual([]);
  // A fixed-height body: markets scroll inside it.
  const bodyBox = (await body.boundingBox())!;
  expect(bodyBox.height).toBeCloseTo(320, 0);
  expect(await body.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  // The bet slip flow from the tab is the old one, with the same payload.
  await page.getByTestId("odds-next_goal-away").click();
  const slip = page.getByTestId("bet-slip");
  await expect(slip).toBeVisible();
  await expect(page.getByTestId("slip-odds")).toHaveText("2.00");
  await page.getByTestId("slip-stake").fill("25");
  await expect(slip).toContainText("Total return");
  await page.getByTestId("slip-confirm").click();
  await expect(page.getByTestId("bet-placed")).toBeVisible();
  const posts = requests.filter((r) => r.method === "POST" && r.path !== "/api/collections/users/auth-refresh");
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe("/api/footfive/bets");
  const sent = posts[0].body as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual(["fixtureId", "market", "odds", "requestId", "selection", "stake"]);
  expect(sent).toMatchObject({ market: "next_goal", fixtureId: "layout", selection: "away", stake: 25, odds: 2 });
  expect(String(sent.requestId)).toMatch(/^[0-9a-z]{1,32}$/);
});

test("betting tab: a withdrawn price and a dropped exact score change neither the tab nor the page, and the suspension shows", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Withdrawn from 10.5 s, well before the goal (16 s) moves the exact grid's origin to 0–1.
  await mount(page, { start: T(9), betTab: "open", marketPhase: (now) => (now >= T(10.5) ? "withdrawn" : "priced") });
  const met = page.getByTestId("odds-winner-away");
  await expect(met).toHaveText(/1\.55/);
  const grid = page.getByTestId("exact-grid");
  await expect(grid.locator(":scope > *")).toHaveCount(36);
  await expect(page.getByTestId("odds-exact-0-0")).toBeVisible();
  const ids = ["bet-tab", "bet-tab-body", "markets-status", "exact-grid", "odds-exact-2-1", "pitch", "lineups"];
  const geometry = () => Promise.all(ids.map(async (id) => box(page, id)));
  const before = await geometry();
  await expect.poll(async () => { await page.clock.runFor(1000); return met.textContent(); }).toContain("Not offered");
  await expect(page.getByTestId("odds-exact-0-0")).toHaveCount(0); // dropped from the list, as markets.js does in play
  await expect(grid.locator(":scope > *")).toHaveCount(36);
  await expect(grid.locator(":scope > *").first()).toHaveAttribute("data-testid", "exact-reserved");
  await expect(page.getByTestId("unoffered-hint")).toBeVisible();
  expect(await geometry()).toEqual(before);
  // The goal (an incident) suspends the markets: the reason shows in the panel and on the tab, still without moving anything.
  await until(page, T(16));
  // Suspended from the goal (16 s) until the restart (25 s): the panel picks it up on its next refresh.
  await expect.poll(async () => { await page.clock.runFor(500); return page.getByTestId("markets-suspended").count(); }, { timeout: 15000 }).toBe(1);
  expect(await page.evaluate(() => Date.now())).toBeLessThan(T(25));
  await expect(page.getByTestId("markets-suspended")).toHaveText("Suspended — incident in progress");
  await expect(page.getByTestId("bet-tab-suspended")).toHaveText("Suspended — incident in progress");
  await expect(met).toBeDisabled();
  const suspended = await geometry();
  for (const id of ["bet-tab", "bet-tab-body", "markets-status", "pitch", "lineups"]) {
    const i = ids.indexOf(id);
    expect(suspended[i], id).toEqual(before[i]);
  }
});
