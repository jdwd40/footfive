/** #228 calibration prices the last row published at a timestamp, matching worldService.lastPublished. */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helperUrl = pathToFileURL(path.resolve(__dirname, "../../scripts/lib/published-snapshot.mjs")).href;
const { lastPublishedIndex, snapshotAtMinute, openPublishedSnapshot } = await import(helperUrl);
const require = createRequire(import.meta.url);
const lib = (name: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/" + name));
const eng = lib("matchEngine.js"), odds = lib("odds.js");
const { TEAMS } = lib("teams.js"), { defaultStarters } = lib("tournament.js");

const row = (seq: number, at: number, d: number, seconds = 0) => ({ seq, at, st: { d, clk: { s: seconds, run: 1 } } });

describe("published calibration snapshots at shared timestamps", () => {
  it("uses the highest sequence at <= now, including a simultaneous second coaching change", () => {
    const rows = [row(1, 10, 0), row(2, 20, 0, 5100), row(3, 20, 0, 5100), row(4, 30, 1, 5100)];
    expect(lastPublishedIndex(rows, 9)).toBe(-1);
    expect(lastPublishedIndex(rows, 20)).toBe(2);
    expect(lastPublishedIndex(rows, 29)).toBe(2);
    expect(snapshotAtMinute(rows, 85, odds.clockMinute, 6000)).toEqual({ i: 2, t: 20 });
    expect(openPublishedSnapshot(rows, 20)).toEqual({ i: 2, t: 20, moved: false });
  });

  it("does not price an intermediate reopening row if its timestamp group ends suspended", () => {
    const rows = [row(1, 10, 1), row(2, 20, 0), row(3, 20, 1), row(4, 30, 0), row(5, 30, 0)];
    expect(openPublishedSnapshot(rows, 10)).toEqual({ i: 4, t: 30, moved: true });
    expect(openPublishedSnapshot(rows, 20)).toEqual({ i: 4, t: 30, moved: true });
    expect(openPublishedSnapshot(rows.slice(0, 3), 10)).toBeNull();
    expect(openPublishedSnapshot(rows, 9)).toBeNull();
  });

  it("canonicalizes a clock crossing that lands exactly on a later event timestamp", () => {
    const rows = [row(1, 0, 0, 5040), row(2, 6000, 0, 5100), row(3, 6000, 1, 5100), row(4, 7000, 0, 5100)];
    expect(snapshotAtMinute(rows, 85, odds.clockMinute, 6000)).toEqual({ i: 2, t: 6000 });
    expect(openPublishedSnapshot(rows, 6000)).toEqual({ i: 3, t: 7000, moved: true });
  });

  it("prices the final coaching row for real cal89 at 85 minutes, not the first change at the same timestamp", () => {
    const team = (i: number) => {
      const t = TEAMS[i];
      return { id: t.slug, name: t.name, abbr: t.abbreviation, grade: t.grade, players: defaultStarters(t.players), ai: false };
    };
    const st = eng.createMatch({ fixtureId: "c89", seed: eng.hashSeed("cal89"), kickoffAt: 0, timing: eng.buildTiming(6000, 1), home: team(9), away: team(15) });
    const ev = [];
    while (st.phase !== "finished") {
      for (const side of ["home", "away"]) {
        const mine = st.score[side === "home" ? 0 : 1], theirs = st.score[side === "home" ? 1 : 0], minute = st.minute + 1;
        const stance = minute >= 70 && mine < theirs ? "attack" : minute >= 100 && mine === theirs ? "attack" : minute >= 78 && mine === theirs + 1 ? "defend" : "balanced";
        if (st.teams[side].stance !== stance) eng.queueStance(st, side, stance);
      }
      ev.push(...eng.advanceTo(st, st.nextAt));
    }
    const real = ev.filter((e) => !e.cos);
    const first = real.find((e) => e.seq === 447), last = real.find((e) => e.seq === 448);
    expect(first).toMatchObject({ t: "coaching", at: 626246, st: { cs: ["balanced", "attack"] } });
    expect(last).toMatchObject({ t: "coaching", at: first.at, st: { cs: ["balanced", "balanced"] } });
    const snap = snapshotAtMinute(real, 85, odds.clockMinute, 6000);
    expect(snap).toEqual({ i: real.indexOf(last), t: last.at });
    const pub = openPublishedSnapshot(real, snap.t);
    expect(real[pub.i].seq).toBe(448);
    expect(real[pub.i].st.cs).toEqual(["balanced", "balanced"]);
  });
});
