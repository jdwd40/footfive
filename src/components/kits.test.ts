import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CLASH, colourDistance, kitsFor } from "./kits";

const require = createRequire(import.meta.url);
const { TEAMS } = require("../../pocketbase/pb_hooks/lib/teams.js") as { TEAMS: { abbreviation: string; primary: string; secondary: string }[] };
const team = (primary_color: string, secondary_color = "#0a0a1a") => ({ primary_color, secondary_color });

describe("pitch kits (#204)", () => {
  it("colour distance separates the real teams' near-identical colours from clearly different ones", () => {
    expect(colourDistance("#ffffff", "#ffffff")).toBe(0);
    expect(colourDistance("#ff453a", "#b23a31")).toBeLessThan(CLASH); // New Metro red vs Redstone red
    expect(colourDistance("#2f5bff", "#5856d6")).toBeLessThan(CLASH); // two blues
    expect(colourDistance("#ffffff", "#ff453a")).toBeGreaterThan(CLASH);
    expect(colourDistance("#fff", "#ffffff")).toBe(0); // short hex is accepted
  });

  it("home wears its colour; away keeps the house white shirt with team-colour sleeves when that does not clash", () => {
    const k = kitsFor(team("#6ab4ff"), team("#ff453a"));
    expect(k.home).toMatchObject({ body: "#6ab4ff", sleeves: "#6ab4ff" });
    expect(k.away).toMatchObject({ body: "#f4f7ff", sleeves: "#ff453a", trim: "#ff453a", num: "#0b1404" });
    expect(k.changed).toBe(false);
  });

  it("clash rule: against a white home kit the away side changes to its own colour with white trim", () => {
    const k = kitsFor(team("#ffffff"), team("#ff453a"));
    expect(k.changed).toBe(true);
    expect(k.away).toMatchObject({ body: "#ff453a", sleeves: "#f4f7ff", trim: "#f4f7ff", num: "#fff" });
  });

  it("clash rule falls through to the secondary colour, then a dark shirt, when the away colour also clashes", () => {
    expect(kitsFor(team("#ffffff"), team("#f0f0f0", "#3a1f8f")).away.body).toBe("#3a1f8f");
    expect(kitsFor(team("#ffffff"), team("#f0f0f0", "#fafafa")).away.body).toBe("#15181f");
  });

  it("missing colours use the old fallbacks (#00f0ff home, #ff2d95 away)", () => {
    const k = kitsFor({ primary_color: "", secondary_color: "" }, { primary_color: "", secondary_color: "" });
    expect(k.home.body).toBe("#00f0ff");
    expect(k.away.sleeves).toBe("#ff2d95");
  });

  it("for every real pairing, the two outfield shirts and both keepers are four mutually distinct colours", () => {
    for (const h of TEAMS) for (const a of TEAMS) {
      if (h === a) continue;
      const k = kitsFor(team(h.primary, h.secondary), team(a.primary, a.secondary));
      const bodies = [k.home.body, k.away.body, k.homeGk.body, k.awayGk.body];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        expect(colourDistance(bodies[i], bodies[j]), `${h.abbreviation} v ${a.abbreviation}: ${bodies[i]} / ${bodies[j]}`).toBeGreaterThanOrEqual(CLASH);
      }
    }
  });
});
