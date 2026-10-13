import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import type { FixtureCard, LineupPlayer, LiveView, MatchEvent, MatchView, TeamPublic } from "../src/lib/pocketbase";
import { injectAuth } from "./helpers";

// API-mocked actual MatchPage fed with cosmetic attempts the actual engine generates (FF-73): a visible long-range shot, its
// WIDE/OVER/BLOCKED result shown only at drawn contact, the ball back on the spot real play left it with the side that had it,
// official score and stats untouched, no ticker leak, and no markets request beyond the panel's own 5 s poll while the
// fixture's canonical seq stays on the last real event. Rows are published only once their time has come (after the mounted
// bootstrap), and the fake clock is sampled every 16 ms.
const require = createRequire(import.meta.url);
const eng = require("../pocketbase/pb_hooks/lib/matchEngine.js");
const { TEAMS } = require("../pocketbase/pb_hooks/lib/teams.js");
const { defaultStarters } = require("../pocketbase/pb_hooks/lib/tournament.js");

const MINUTE_MS = 8000; // production pace
const LAG_MS = 1500; // MatchPage's pitch lag
const START = Date.UTC(2030, 0, 1);
const FLIP = new Set(["second_half", "et_break", "extra_time_2", "shootout", "finished"]); // Pitch draws these with x mirrored
const team = (id: string): TeamPublic => ({ id, name: id, abbreviation: id.slice(0, 3).toUpperCase(), grade: "A",
  primary_color: id === "Away" ? "#ff00cc" : "#00e5ff", secondary_color: "#ff00cc", badge_key: "test" });

type EnginePlayer = { name: string; role: string; is_starter: boolean };
type Run = { seed: number; prev: MatchEvent; cos: MatchEvent[]; next: MatchEvent; lineups: { home: LineupPlayer[]; away: LineupPlayer[] } };

/** The first engine-generated cosmetic run (shot → miss|block → bounce, then the next real event) per side and outcome, seeds 1000–1199 at 8 s. */
function engineRuns(): Map<string, Run> {
  const runs = new Map<string, Run>();
  const side = (i: number) => {
    const t = TEAMS[i];
    return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players) as EnginePlayer[] };
  };
  const lineup = (players: EnginePlayer[]): LineupPlayer[] => players.map((p, i) => ({ name: p.name, no: i + 1, role: p.role, starter: p.is_starter }));
  for (let seed = 1000; seed < 1200 && runs.size < 4; seed++) {
    const i = seed - 1000;
    const home = side(i % 16);
    const away = side((i * 7 + 3) % 16);
    const st = eng.createMatch({ fixtureId: "cos" + i, seed, kickoffAt: 0, home, away, timing: eng.buildTiming(MINUTE_MS, 1) });
    const events: MatchEvent[] = eng.advanceTo(st, 1e12);
    for (let k = 1; k + 3 < events.length; k++) {
      const cos = events.slice(k, k + 3);
      if (events[k - 1].cos || cos.map((e) => `${e.t}${e.cos}`).join() !== `shot1,${cos[1].t}1,bounce1` || events[k + 3].cos) continue;
      const key = `${cos[0].side}-${cos[1].t}`;
      if (!runs.has(key)) runs.set(key, { seed, prev: events[k - 1], cos, next: events[k + 3], lineups: { home: lineup(home.players), away: lineup(away.players) } });
    }
  }
  return runs;
}

const RUNS = engineRuns();
const KEYS = ["home-miss", "home-block", "away-miss", "away-block"];

test("the engine produced a cosmetic miss and block for both sides", () => {
  expect([...RUNS.keys()].sort()).toEqual([...KEYS].sort());
});

for (const key of KEYS) {
  test(`cosmetic ${key}: visible shot, result at drawn contact, ball and possession return, no official or market change`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const run = RUNS.get(key)!;
    const [shot, result, bounce] = run.cos;
    const shooting = shot.side!;
    const shift = START + 3000 - run.prev.at;
    // Same rows, same relative times; only the transport seq and the absolute clock are re-based for the mock.
    const events: MatchEvent[] = [run.prev, ...run.cos, run.next].map((e, i) => ({ ...e, seq: i + 1, at: e.at + shift }));
    const [prev, cShot, cResult, cBounce, next] = events;
    const origin = bounce.ball!; // where real play left the ball (the next real event starts here)
    const flip = FLIP.has(prev.st.ph);
    const canonicalSeq = (now: number) => (now >= next.at ? next : prev); // the card stays on the last REAL published event
    const card = (now: number): FixtureCard => {
      const real = canonicalSeq(now);
      return { id: "ff73-cosmetic", slot: "a", index: 0, home: team("Home"), away: team("Away"), status: "live", kickoffAt: START - 600000,
        minuteMs: MINUTE_MS, st: real.st, at: real.at, seq: real.seq, last: null, odds: null };
    };
    const errors: string[] = [];
    const unexpectedApi: string[] = [];
    const markets: Array<{ now: number; seq: number }> = [];
    let bootstrapped = false;
    let cosmeticInBootstrap = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.clock.install({ time: START });
    await page.clock.pauseAt(START + 1000);
    const user = { id: "ff73testuser0001", email: "ff73@example.invalid", display_name: "Cosmetic test", role: "user", must_change_password: false };
    const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.mock-signature`;
    await injectAuth(page, token, user);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const now = await page.evaluate(() => Date.now());
      let body: unknown;
      if (url.pathname === "/api/collections/users/auth-refresh") body = { token, record: user };
      else if (url.pathname === "/api/footfive/me") body = { ...user, credits: 1000 };
      else if (url.pathname === "/api/footfive/live") {
        body = { serverTimeMs: now, paused: false, mode: "live", timing: { minuteMs: MINUTE_MS }, championship: null,
          round: { id: "r", key: "r1", label: "Round 1", status: "live", scheduledAt: START, finishedAt: null },
          fixtures: [card(now)], bracket: [], ticker: [], champion: null, nextChampionshipAt: null } as unknown as LiveView;
      } else if (url.pathname === "/api/footfive/match/ff73-cosmetic") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const published = events.filter((e) => e.at <= now);
        if (published.some((e) => e.cos) && !bootstrapped) cosmeticInBootstrap = true;
        body = { serverTimeMs: now, round: { id: "r", key: "r1", label: "Round 1", status: "live" }, fixture: card(now),
          events: published.filter((e) => e.seq > since), eventsPage: { nextSeq: published.at(-1)?.seq ?? 0, hasMore: false, throughMs: now },
          lineups: run.lineups, sentOff: [], managedSide: null, coach: null } satisfies MatchView;
      } else if (url.pathname === "/api/footfive/bets/mine") body = { credits: 1000, bets: [], settledStaked: 0, settledReturned: 0, net: 0 };
      else if (url.pathname === "/api/footfive/markets/ff73-cosmetic") {
        markets.push({ now, seq: canonicalSeq(now).seq });
        body = { serverTimeMs: now, fixtureId: "ff73-cosmetic", seq: canonicalSeq(now).seq, state: { phase: prev.st.ph, closed: null }, blocked: null, markets: [] };
      } else { unexpectedApi.push(url.pathname); await route.abort(); return; }
      await route.fulfill({ json: body });
    });
    await page.goto("/match/ff73-cosmetic");
    const ball = page.getByTestId("pitch").locator('svg circle[stroke="#111"]');
    await expect.poll(async () => {
      await page.clock.runFor(50);
      return ball.count();
    }).toBe(1);
    bootstrapped = true; // mounted; every row is published only once its time has come, so the run arrives in later polls
    await page.clock.runFor(prev.at + LAG_MS + 100 - (await page.evaluate(() => Date.now())));
    await expect(page.getByTestId("commentary")).toContainText(prev.text);

    const sc = `${prev.st.sc[0]}–${prev.st.sc[1]}`;
    const row = (label: string, k: number) => `${prev.st.x[0][k]}${label}${prev.st.x[1][k]}`;
    const shotsRow = page.getByTestId("stats").locator("div").filter({ has: page.getByText("Shots", { exact: true }) });
    const sotRow = page.getByTestId("stats").locator("div").filter({ has: page.getByText("On target", { exact: true }) });
    const badgeWord = cResult.t === "block" ? "BLOCKED" : (cResult as MatchEvent & { high?: number }).high ? "OVER" : "WIDE";
    const goalLine = shooting === "home" ? 100 : 0;
    await page.clock.runFor(cShot.at + LAG_MS - 200 - (await page.evaluate(() => Date.now())));

    const samples: Array<Record<string, unknown>> = [];
    let shotContact = false;
    let badgeFirst: { text: string; dx: number; contact: boolean; elevation: number } | null = null;
    let badgeBeforeCaption = false;
    let returned = false;
    let opposingRingDuringReturn = false;
    let handover: number | null = null;
    const shots = new Set<string>();
    for (let n = 0; ; n++) {
      await page.clock.runFor(16);
      const now = await page.evaluate(() => Date.now());
      const d = await page.getByTestId("pitch").evaluate((pitch, flipped) => {
        const ballEl = pitch.querySelector('svg circle[stroke="#111"]')!;
        const shadow = pitch.querySelector("svg > ellipse")!;
        const bx = Number(ballEl.getAttribute("cx"));
        const by = Number(shadow.getAttribute("cy")) - 0.9;
        const players = Array.from(pitch.querySelectorAll('[data-testid="player"]')).map((player) => {
          const c = player.getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
          const kit = player.querySelector("[data-kit]")!;
          const x = Number(c[1]);
          const y = Number(c[2]);
          return { side: kit.getAttribute("stroke") === "#ff00cc" ? "away" : "home", keeper: kit.getAttribute("fill") === "#c6ff00",
            ring: !!player.querySelector("[data-ring]"), x: flipped ? 100 - x : x, y, distance: Math.hypot(x - bx, y - by) };
        });
        return { ball: [flipped ? 100 - bx : bx, by], elevation: by - Number(ballEl.getAttribute("cy")), players,
          badges: Array.from(pitch.querySelectorAll("span")).map((s) => s.textContent ?? "") };
      }, flip);
      const caption = (await page.getByTestId("commentary").textContent()) ?? "";
      const badge = d.badges.includes(badgeWord);
      samples.push({ now, caption, badge, ball: d.ball, elevation: d.elevation, rings: d.players.filter((p) => p.ring).map((p) => p.side) });
      expect(d.badges.some((t) => /GOAL/.test(t)), "a cosmetic attempt never shows a goal").toBe(false);

      if (caption.includes(cShot.text)) {
        expect(badge, `${badgeWord} never shows while the shot itself is current`).toBe(false);
        if (d.players.some((p) => p.side === shooting && !p.keeper && p.distance <= 1.6)) shotContact = true;
        if (!shots.has("shot") && shotContact) { shots.add("shot"); await page.screenshot({ path: testInfo.outputPath("cosmetic-shot.png") }); }
      }
      if (badge && !badgeFirst) {
        const blockerSide = cResult.side!;
        badgeFirst = { text: badgeWord, dx: Math.abs(d.ball[0] - goalLine), elevation: d.elevation,
          contact: d.players.some((p) => p.side === blockerSide && !p.keeper && p.distance <= 1.6) };
        if (!caption.includes(cResult.text)) badgeBeforeCaption = true;
        await page.screenshot({ path: testInfo.outputPath("cosmetic-result.png") });
      }
      if (caption.includes(cBounce.text)) {
        const back = Math.hypot(d.ball[0] - origin[0], d.ball[1] - origin[1]) <= 2.5;
        const ours = d.players.some((p) => p.side === shooting && p.ring);
        if (back && ours && !returned) { returned = true; await page.screenshot({ path: testInfo.outputPath("cosmetic-return.png") }); }
        if (returned && d.players.some((p) => p.side !== shooting && p.ring)) opposingRingDuringReturn = true;
      }
      const nextCurrent = caption.includes(next.text);
      if (nextCurrent && handover === null) handover = Math.hypot(d.ball[0] - origin[0], d.ball[1] - origin[1]);
      if (!nextCurrent && n % 6 === 0) {
        // Official numbers hold the last real snapshot through the whole cosmetic run.
        await expect(page.getByTestId("match-score")).toHaveText(sc);
        await expect(page.getByTestId("hud-score")).toContainText(sc);
        await expect(shotsRow).toHaveText(row("Shots", 0));
        await expect(sotRow).toHaveText(row("On target", 1));
        await expect(page.getByTestId("goal-banner")).toHaveCount(0);
      }
      if (nextCurrent && now >= next.at + LAG_MS + 400) break;
      expect(now, "the run reaches the next real event").toBeLessThan(next.at + LAG_MS + 8000);
    }
    await testInfo.attach("cosmetic-samples", { body: JSON.stringify(samples), contentType: "application/json" });

    expect(shotContact, "the cosmetic shot is visible with the shooter on the ball").toBe(true);
    expect(badgeFirst, `${badgeWord} appears`).not.toBeNull();
    expect(badgeBeforeCaption, "badge and result caption are revealed together").toBe(false);
    if (cResult.t === "block") {
      expect(badgeFirst!.contact, "BLOCKED only with the blocker in drawn contact").toBe(true);
      expect(badgeFirst!.elevation, "a block is grounded").toBeLessThan(0.3);
    } else expect(badgeFirst!.dx, `${badgeWord} only once the drawn ball reaches the goal line`).toBeLessThanOrEqual(3);
    expect(returned, "ball back on the original spot with the side that had it").toBe(true);
    expect(opposingRingDuringReturn, "possession never passes to the other side on the way back").toBe(false);
    expect(handover, "the next real event starts near where real play left the ball").not.toBeNull();
    expect(handover!, "handover within the bounded dwell").toBeLessThanOrEqual(12);

    // Spectacle in the feed, nothing in the ticker; official numbers then follow the next real event only.
    await expect(page.getByTestId("event-feed")).toContainText(cShot.text);
    await expect(page.getByTestId("event-feed")).toContainText(cResult.text);
    for (const e of [cShot, cResult, cBounce]) {
      expect(e.major ?? null).toBeNull();
      expect(e.tick ?? null).toBeNull();
      await expect(page.getByTestId("ticker").filter({ hasText: e.text })).toHaveCount(0);
    }
    // Markets: the panel's own 5 s poll only — no refetch triggered by cosmetic rows while the canonical seq stays on the real event.
    const window = markets.filter((m) => m.now >= cShot.at && m.now < next.at);
    for (let i = 1; i < window.length; i++) expect(window[i].now - window[i - 1].now, "no extra markets request").toBeGreaterThanOrEqual(4990);
    expect(window.every((m) => m.seq === prev.seq), "markets keep the last real seq through the cosmetic run").toBe(true);
    expect(window.length).toBeLessThanOrEqual(Math.floor((next.at - cShot.at) / 5000) + 1);
    await testInfo.attach("cosmetic-summary", { contentType: "application/json", body: JSON.stringify({
      key, seed: run.seed, phase: prev.st.ph, minute: prev.min, result: badgeWord, rows: run.cos.map((e) => `${e.t}@${e.at - run.prev.at}`),
      nextReal: `${next.t}@${next.at - prev.at}`, badgeFirst, handover, marketRequestsInRun: window.length, runMs: next.at - cShot.at,
      marketRequestsTotal: markets.length, samples: samples.length }) });
    expect(cosmeticInBootstrap, "cosmetic rows arrive only after the mounted bootstrap").toBe(false);
    expect(unexpectedApi).toEqual([]);
    expect(errors).toEqual([]);
  });
}
