#!/usr/bin/env node
/**
 * Live-view QA watcher: opens the real built app in headless Chromium, watches one match and keeps
 * evidence — frames every N ms, a video, console errors and a chronological log of numeric snapshots
 * (score / clock / shootout) + commentary + pitch flashes/banners.
 *
 *   node scripts/live-watch.mjs --fixture <id> [--seconds 60] [--viewport 1440x900] [--out dir]
 *   node scripts/live-watch.mjs --replay <seed>[@<jump>] ...   jump: shootout | sd | pen | minute:<n> | seq:<n>
 *
 * --fixture watches an ACTUAL engine match on the backend (--pb, default http://127.0.0.1:8097; the
 * app is served from --base, default http://127.0.0.1:5187; login --user / --pass, default seeded e2e_user_a).
 *
 * --replay is a FIXTURE REPLAY: the events come from a real offline run of pocketbase/pb_hooks/lib/matchEngine.js
 * (same teams/timing as the unit tests, 8 s/min) served to the page through a route intercept on
 * /api/footfive/match/replay-*, with the server clock anchored so playback starts at the jump point. Everything
 * else (login, live feed, markets) still hits the real backend. Use it to exercise rare browser choreography
 * (sudden death, in-match penalties) deterministically; never present it as a fetched backend result.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { snapshot } from "./live-watch-snapshot.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = (f) => require(path.join(ROOT, "pocketbase/pb_hooks/lib", f));

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("base", "http://127.0.0.1:5187");
const PB = arg("pb", "http://127.0.0.1:8097");
const USER = arg("user", "e2e_user_a@test.local");
const PASS = arg("pass", "testpass99");
const SECONDS = Number(arg("seconds", 60));
const EVERY = Number(arg("every", 2000));
const [VW, VH] = arg("viewport", "1440x900").split("x").map(Number);
const FIXTURE = arg("fixture");
const REPLAY = arg("replay");
const OUT = arg("out", path.join(ROOT, "qa-watch", new Date().toISOString().replace(/[:.]/g, "-")));
const MOBILE = VW < 500;
fs.mkdirSync(OUT, { recursive: true });

/** Real engine run for a replay: TEAMS + defaultStarters at 8 s/min, kicked off so that `jump` is `lead` ms ahead of now. */
function replayFixture(spec) {
  const eng = lib("matchEngine.js");
  const { TEAMS } = lib("teams.js");
  const { defaultStarters } = lib("tournament.js");
  const [seedStr, jump = "minute:1"] = spec.split("@");
  const seed = Number(seedStr);
  const tp = (t) => ({ id: t.slug, name: t.name, abbreviation: t.abbreviation, grade: t.grade, primary_color: t.primary, secondary_color: t.secondary, badge_key: t.badge });
  const et = (t) => ({ id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: true });
  const th = TEAMS[seed % 16];
  const ta = TEAMS[(seed * 7 + 3) % 16];
  const st = eng.createMatch({ fixtureId: "replay-" + seed, seed, kickoffAt: 0, home: et(th), away: et(ta), timing: eng.buildTiming(8000, 1) });
  const events = eng.advanceTo(st, 1e13);
  let jumpAt = 0;
  if (jump === "shootout") jumpAt = (events.find((e) => e.t === "shootout_start")?.at ?? 0) - 3000;
  else if (jump === "sd") jumpAt = (events.find((e) => e.t === "shootout_setup" && e.kick?.sd)?.at ?? 0) - 2000; // first sudden-death kick
  else if (jump === "pen") jumpAt = (events.find((e) => e.t === "penalty_awarded")?.at ?? 0) - 4000;
  else if (jump.startsWith("minute:")) jumpAt = events.find((e) => e.min >= Number(jump.slice(7)))?.at ?? 0;
  else if (jump.startsWith("seq:")) jumpAt = events.find((e) => e.seq >= Number(jump.slice(4)))?.at ?? 0;
  const kickoffAt = Date.now() + 3000 - Math.max(0, jumpAt);
  for (const e of events) e.at += kickoffAt;
  const pub = (p) => ({ name: p.name, no: p.no, role: p.role, starter: !!p.is_starter });
  const lineups = { home: st.teams.home.players.map(pub), away: st.teams.away.players.map(pub) };
  const summary = { seed, home: th.abbreviation, away: ta.abbreviation, score: st.score, so: st.so && { h: st.so.h, a: st.so.a, kicks: st.so.kicks.length }, by: st.by, winner: st.winner, events: events.length, jump, jumpAt };
  console.log("replay:", JSON.stringify(summary));
  const view = (now, since) => {
    const pub = events.filter((e) => e.at <= now);
    const last = pub[pub.length - 1];
    const reds = pub.filter((e) => e.t === "red_card").map((e) => ({ side: e.side, p: e.p }));
    const fresh = since ? pub.filter((e) => e.seq > since).slice(0, 300) : pub.slice(-60);
    return {
      serverTimeMs: now,
      round: { id: "replay", key: "replay", label: "REPLAY (offline engine run, seed " + seed + ")", status: "live" },
      fixture: { id: "replay-" + seed, slot: "r", index: 0, home: tp(th), away: tp(ta), status: last?.st?.ph === "finished" ? "finished" : "live", kickoffAt, minuteMs: 8000, st: last?.st ?? null, at: last?.at ?? null, seq: last?.seq ?? 0, last: last ? { t: last.t, text: last.text, side: last.side || null } : null, odds: null },
      events: fresh,
      lineups,
      sentOff: reds,
      managedSide: null,
      coach: null,
    };
  };
  return { id: "replay-" + seed, view, summary };
}

async function main() {
  const replay = REPLAY ? replayFixture(REPLAY) : null;
  const fixtureId = replay ? replay.id : FIXTURE;
  if (!fixtureId) throw new Error("--fixture <id> or --replay <seed[@jump]> required");
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, isMobile: MOBILE, hasTouch: MOBILE, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: VW, height: VH } } });
  const page = await ctx.newPage();
  const log = [];
  const errors = [];
  page.on("console", (m) => (m.type() === "error" ? errors.push(m.text()) : null));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  if (replay) {
    await page.route("**/api/footfive/match/replay-*", (route) => {
      const u = new URL(route.request().url());
      route.fulfill({ json: replay.view(Date.now(), Number(u.searchParams.get("since") || 0)) });
    });
    await page.route("**/api/footfive/markets/replay-*", (route) => route.fulfill({ json: { serverTimeMs: Date.now(), fixtureId, seq: 0, state: { phase: "live", closed: null }, blocked: "Replay: no markets", markets: [] } }));
  }
  await page.goto(BASE + "/login");
  await page.getByTestId("login-email").fill(USER);
  await page.getByTestId("login-password").fill(PASS);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 });
  await page.goto(BASE + "/match/" + fixtureId);
  await page.getByTestId("match-scoreboard").waitFor({ timeout: 20000 });
  const t0 = Date.now();
  let i = 0;
  let lastKey = "";
  while (Date.now() - t0 < SECONDS * 1000) {
    const snap = await page.evaluate(snapshot);
    const key = JSON.stringify([snap.score, snap.hud, snap.pens, snap.soTotal, snap.commentary, snap.banner, snap.pen, snap.badge, snap.final]);
    const entry = { t: Date.now() - t0, ...snap };
    if (key !== lastKey) {
      log.push(entry);
      lastKey = key;
      console.log(`${String(entry.t).padStart(6)}ms ${snap.clock ?? "--:--"} ${snap.score ?? "-"} ${snap.pens ?? ""} ${snap.hud ? "hud=" + JSON.stringify(snap.hud) + " " : ""}${snap.badge ? "[" + snap.badge + "] " : ""}${snap.banner ? "{" + snap.banner + "} " : ""}${snap.pen ? "<" + snap.pen + "> " : ""}${snap.commentary ?? ""}`);
    }
    if (i % Math.max(1, Math.round(EVERY / 500)) === 0) await page.screenshot({ path: path.join(OUT, `frame-${String(i).padStart(4, "0")}.png`) });
    i++;
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(OUT, "final.png"), fullPage: true });
  fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify({ base: BASE, fixtureId, viewport: [VW, VH], replay: replay?.summary ?? null, errors, log }, null, 1));
  await ctx.close();
  await browser.close();
  const v = fs.readdirSync(OUT).find((f) => f.endsWith(".webm"));
  if (v) fs.renameSync(path.join(OUT, v), path.join(OUT, "watch.webm"));
  console.log(`done: ${OUT} (${log.length} changes, ${errors.length} console errors)`);
  if (errors.length) console.log("console errors:", errors.slice(0, 5));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
