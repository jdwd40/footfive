/**
 * #208: one mocked live match for the dead-time spec (and its before/after screenshots): line-ups before kick-off, a first half
 * with a save, a miss, a card, a headed goal and a block, the half-time break, a second half with two goals and the woodwork, and
 * full time. Engine-shaped events (canonical coordinates: home attacks x = 100) at the live pace of 6000 ms per match minute.
 */
import { expect, type Page } from "@playwright/test";
import type { FixtureCard, LiveView, MatchEvent, MatchView, PubState, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

export const START = Date.UTC(2030, 0, 1);
export const LAG = 1500; // MatchPage LAG_MS
export const MIN_MS = 6000;
/** Real time of a match second (one match second is MIN_MS / 60 ms of real time). */
const SEC = MIN_MS / 60;
const team = (id: string, name: string, abbreviation: string, primary_color: string): TeamPublic => ({ id, name, abbreviation, grade: "A", primary_color, secondary_color: "#111", badge_key: "test" });
export const HOME = team("mc2", "Mega City Two", "MC2", "#6ab4ff");
export const AWAY = team("met", "New Metro City", "MET", "#ff453a");
const ROLES = ["gk", "def", "def", "mid", "att"];
const lineup = (side: string) => ROLES.map((role, i) => ({ name: `${side === "home" ? "H" : "A"}. ${["Keeper", "Wall", "Stone", "Engine", "Striker"][i]}`, no: i + 1, role, starter: true }));
export const LINEUPS = { home: lineup("home"), away: lineup("away") };
const P = (side: "home" | "away", i: number) => LINEUPS[side][i].name;

/** Kick-off and half-time / second-half / full-time times (real ms). The engine's half-time break is 30 s whatever the pace. */
export const KICKOFF = START;
export const HT = START + 2700 * SEC;
export const SECOND = HT + 30000;
export const FT = SECOND + 2700 * SEC;

type Raw = Omit<MatchEvent, "seq" | "st"> & { ph?: string; run?: 0 | 1; s: number };
const at1 = (s: number) => KICKOFF + s * SEC;
const at2 = (s: number) => SECOND + (s - 2700) * SEC;
const raw: Raw[] = [
  { at: at1(0), s: 0, t: "kickoff", min: 0, side: "home", p: P("home", 3), ball: [50, 32], text: "Kick-off! Mega City Two v New Metro City" },
  { at: at1(60), s: 60, t: "pass", min: 1, side: "home", p: P("home", 3), p2: P("home", 4), ball: [60, 30], text: "H. Engine finds H. Striker" },
  { at: at1(300), s: 300, t: "shot", min: 5, side: "home", chain: 3, p: P("home", 4), ball: [84, 30], from: null, text: "H. Striker shoots!" },
  { at: at1(300) + 480, s: 300, t: "save", min: 5, side: "away", chain: 3, p: P("away", 0), p2: P("home", 4), from: [84, 30], target: [100, 31], ball: [96, 31], text: "Brilliant stop by A. Keeper!" },
  { at: at1(700), s: 700, t: "shot", min: 11, side: "away", chain: 5, p: P("away", 4), ball: [20, 40], from: null, text: "A. Striker lets fly!" },
  { at: at1(700) + 480, s: 700, t: "miss", min: 11, side: "away", chain: 5, p: P("away", 4), from: [20, 40], target: [0, 25], ball: [0, 25], text: "A. Striker pulls it wide of the post" },
  { at: at1(900), s: 900, t: "yellow_card", min: 15, side: "away", p: P("away", 2), ball: [40, 30], major: 1, text: "Yellow card — A. Stone", tick: "Yellow card — A. Stone (MET)" },
  { at: at1(1500), s: 1500, t: "shot", min: 25, side: "home", chain: 8, p: P("home", 4), ball: [88, 36], from: [80, 10], header: 1, text: "H. Striker rises to meet it!" },
  { at: at1(1500) + 480, s: 1500, t: "goal", min: 25, side: "home", chain: 8, p: P("home", 4), p2: P("away", 0), target: [100, 33], ball: [100, 33], major: 1, text: "GOAL! H. Striker scores for Mega City Two", tick: "MC2 1–0 MET — H. Striker scores, 25′." },
  { at: at1(1500) + 480 + 3150, s: 1532, t: "celebration", min: 25, side: "home", chain: 8, p: P("home", 4), text: "H. Striker wheels away" },
  { at: at1(1500) + 480 + 9000, s: 1590, t: "restart", min: 26, side: "away", ball: [50, 32], text: "New Metro City restart" },
  { at: at1(2000), s: 2000, t: "pass", min: 33, side: "away", p: P("away", 3), p2: P("away", 4), ball: [40, 30], text: "A. Engine finds A. Striker" },
  { at: at1(2400), s: 2400, t: "shot", min: 40, side: "away", chain: 13, p: P("away", 3), ball: [30, 30], from: null, long: 1, text: "A. Engine shoots from range!" },
  { at: at1(2400) + 480, s: 2400, t: "block", min: 40, side: "home", chain: 13, p: P("home", 1), p2: P("away", 3), from: [30, 30], ball: [25, 30], text: "H. Wall blocks A. Engine's shot" },
  { at: HT, s: 2700, run: 0, ph: "half_time", t: "half_time", min: 45, text: "Half-time: MC2 1–0 MET" },
  { at: SECOND, s: 2700, ph: "second_half", t: "second_half", min: 45, side: "away", p: P("away", 3), ball: [50, 32], text: "Second half under way" },
  { at: at2(3000), s: 3000, ph: "second_half", t: "pass", min: 50, side: "away", p: P("away", 3), p2: P("away", 4), ball: [30, 34], text: "A. Engine finds A. Striker" },
  { at: at2(3600), s: 3600, ph: "second_half", t: "shot", min: 60, side: "away", chain: 18, p: P("away", 4), ball: [14, 34], from: null, text: "A. Striker shoots!" },
  { at: at2(3600) + 480, s: 3600, ph: "second_half", t: "goal", min: 60, side: "away", chain: 18, p: P("away", 4), p2: P("home", 0), target: [0, 31], ball: [0, 31], major: 1, text: "GOAL! A. Striker scores for New Metro City", tick: "MC2 1–1 MET — A. Striker scores, 60′." },
  { at: at2(3600) + 480 + 3150, s: 3632, ph: "second_half", t: "celebration", min: 60, side: "away", chain: 18, p: P("away", 4), text: "A. Striker salutes the fans" },
  { at: at2(3600) + 480 + 9000, s: 3690, ph: "second_half", t: "restart", min: 61, side: "home", ball: [50, 32], text: "Mega City Two restart" },
  { at: at2(4800), s: 4800, ph: "second_half", t: "shot", min: 80, side: "home", chain: 22, p: P("home", 3), ball: [82, 26], from: null, text: "H. Engine goes for goal" },
  { at: at2(4800) + 480, s: 4800, ph: "second_half", t: "goal", min: 80, side: "home", chain: 22, p: P("home", 3), p2: P("away", 0), target: [100, 30], ball: [100, 30], major: 1, text: "GOAL! H. Engine scores for Mega City Two", tick: "MC2 2–1 MET — H. Engine scores, 80′." },
  { at: at2(4800) + 480 + 3150, s: 4832, ph: "second_half", t: "celebration", min: 80, side: "home", chain: 22, p: P("home", 3), text: "H. Engine wheels away" },
  { at: at2(4800) + 480 + 9000, s: 4890, ph: "second_half", t: "restart", min: 81, side: "away", ball: [50, 32], text: "New Metro City restart" },
  { at: at2(5200), s: 5200, ph: "second_half", t: "shot", min: 86, side: "away", chain: 26, p: P("away", 4), ball: [24, 44], from: null, text: "A. Striker shoots!" },
  { at: at2(5200) + 480, s: 5200, ph: "second_half", t: "woodwork", min: 86, side: "away", chain: 26, p: P("away", 4), post: "right", from: [24, 44], target: [0, 36], ball: [8, 40], text: "A. Striker hits the post!" },
  { at: FT, s: 5400, run: 0, ph: "finished", t: "match_end", min: 90, side: "home", major: 1, text: "Full-time: MC2 2–1 MET. Mega City Two go through.", tick: "FT: MC2 2–1 MET. MC2 go through." },
];

/** Engine-shaped state per event: score, shots / on target / saves / yellow cards counted as matchEngine.js counts them. */
export const EVENTS: MatchEvent[] = (() => {
  const sc: [number, number] = [0, 0];
  const x: [number[], number[]] = [Array(8).fill(0), Array(8).fill(0)];
  const i = (s?: string | null) => (s === "away" ? 1 : 0);
  return raw.map(({ ph, run, s, ...e }, n) => {
    if (e.t === "shot") x[i(e.side)][0] += 1;
    if (e.t === "goal") {
      sc[i(e.side)] += 1;
      x[i(e.side)][1] += 1;
    }
    if (e.t === "save") {
      x[1 - i(e.side)][1] += 1;
      x[i(e.side)][2] += 1;
    }
    if (e.t === "yellow_card") x[i(e.side)][5] += 1;
    const fin = ph === "finished";
    const st: PubState = { sc: [...sc] as [number, number], so: null, ph: ph ?? "first_half", clk: { s, run: run ?? 1 }, pos: 52, x: [[...x[0]], [...x[1]]], d: 0, win: fin ? "home" : null, by: fin ? "normal" : null };
    return { ...e, seq: n + 1, st } as MatchEvent;
  });
})();

export type Req = { method: string; path: string; at: number };

/** Mount the real MatchPage at `start` (page clock paused there) against the mocked API; returns the request log. */
export async function mountMatch(page: Page, start: number, opts: { reducedMotion?: boolean; betTab?: "open" } = {}) {
  const user = { id: "deadtime208user", email: "deadtime208@example.invalid", display_name: "Dead time", role: "user", must_change_password: false };
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
  const requests: Req[] = [];
  await page.emulateMedia({ reducedMotion: opts.reducedMotion ? "reduce" : "no-preference" });
  await page.clock.install({ time: start - 1000 });
  await page.clock.pauseAt(start);
  await injectAuth(page, token, user);
  await page.addInitScript((tab) => {
    if (tab) localStorage.setItem("ff_bet_tab", tab);
    // Layout shifts (as #207's spec counts them): a shift led by the Match events list's own rows is marked `feed`.
    const w = window as unknown as { __shifts: Array<{ value: number; feed: boolean; sources: string[] }> };
    w.__shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
        const nodes = (e.sources ?? []).map((x) => x.node).filter(Boolean) as Node[];
        const feed = nodes.some((n) => n instanceof Element && !!n.closest('[data-testid="event-feed"]'));
        if (!e.hadRecentInput) w.__shifts.push({ value: e.value, feed, sources: nodes.map((n) => (n instanceof Element ? `${n.tagName}#${n.getAttribute("data-testid") ?? ""}` : n.nodeName)) });
      }
    }).observe({ type: "layout-shift", buffered: true });
  }, opts.betTab ?? null);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const now = await page.evaluate(() => Date.now());
    requests.push({ method: req.method(), path: url.pathname, at: now });
    const published = EVENTS.filter((e) => e.at <= now);
    const last = published.at(-1) ?? null;
    const status = !last ? "scheduled" : last.t === "match_end" ? "finished" : "live";
    const fixture = { id: "deadtime", slot: "a", index: 0, home: HOME, away: AWAY, status, kickoffAt: KICKOFF, minuteMs: MIN_MS, st: last?.st ?? null, at: last?.at ?? null, seq: last?.seq ?? 0, last: null, odds: null } as FixtureCard;
    let body: unknown;
    if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
    else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
    else if (url.pathname === "/api/footfive/live") body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: MIN_MS }, championship: null, round: { id: "r", key: "r16", label: "Round of 16", status: "live", scheduledAt: START, finishedAt: null }, fixtures: [fixture], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as unknown as LiveView;
    else if (url.pathname === "/api/footfive/match/deadtime") body = { serverTimeMs: now, round: { id: "r", key: "r16", label: "Round of 16", status: "live" }, fixture, events: published.filter((e) => e.seq > Number(url.searchParams.get("since") ?? 0)), eventsPage: { nextSeq: last?.seq ?? 0, hasMore: false, throughMs: now }, lineups: LINEUPS, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
    else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
    else if (url.pathname === "/api/footfive/markets/deadtime") {
      const sc = last?.st.sc ?? [0, 0];
      body = { serverTimeMs: now, fixtureId: "deadtime", seq: last?.seq ?? 0, state: { phase: last ? "live" : "pre", closed: null }, blocked: null, markets: [{ key: "winner", title: "To qualify", rules: "Team that goes through.", closed: null, sel: [{ id: "home", label: HOME.name, short: "MC2", odds: sc[0] > sc[1] ? 1.3 : 2.4 }, { id: "away", label: AWAY.name, short: "MET", odds: 2.1 }] }] };
    } else return route.fulfill({ status: 404, json: { message: "not mocked" } }); // recorded above: the spec checks for strays
    await route.fulfill({ json: body });
  });
  await page.goto("/match/deadtime");
  await expect.poll(async () => { await page.clock.runFor(50); return page.getByTestId("pitch").count(); }).toBe(1);
  await page.evaluate(() => document.fonts.ready);
  return requests;
}

/** Run the page clock on to absolute time `t`. */
export const until = async (page: Page, t: number) => page.clock.runFor(Math.max(0, t - (await page.evaluate(() => Date.now()))));

/** Every endpoint the match page used before #208 (a summary or walkout must add none). */
export const KNOWN = ["/api/collections/users/auth-refresh", "/api/footfive/me", "/api/footfive/live", "/api/footfive/match/deadtime", "/api/footfive/bets/mine", "/api/footfive/markets/deadtime"];

/** Layout shifts recorded since `from` (an index into the list), outside the Match events list. */
export async function pageShifts(page: Page, from = 0) {
  const all = await page.evaluate(() => (window as unknown as { __shifts: Array<{ value: number; feed: boolean; sources: string[] }> }).__shifts);
  return all.slice(from).filter((x) => !x.feed);
}
