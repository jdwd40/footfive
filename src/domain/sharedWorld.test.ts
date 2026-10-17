import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bal = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js"),
) as {
  BALANCE: { startingCredits: number; segmentMatchMinutes: number; coaching: Record<string, { tempo: number; foul: number }> };
  getTiming: (p: string) => { segmentMatchMinutes: number; matchMinuteRealMs: number };
  coachingMod: (s: string) => { tempo: number; foul: number };
};

describe("shared world balance", () => {
  it("starting credits are fictional and positive", () => {
    expect(bal.BALANCE.startingCredits).toBe(1000);
  });

  it("segment timing is ~5 match minutes at 8s/min", () => {
    const t = bal.getTiming("normal");
    expect(t.segmentMatchMinutes).toBe(5);
    // 5 match minutes × 8 real seconds = 40s wall clock per segment
    expect(t.matchMinuteRealMs * t.segmentMatchMinutes).toBe(40000);
  });

  it("coaching stances set an opposite, symmetric match tempo", () => {
    expect(bal.coachingMod("attack").tempo).toBeGreaterThan(0);
    expect(bal.coachingMod("defend").tempo).toBe(-bal.coachingMod("attack").tempo);
    expect(bal.coachingMod("balanced")).toEqual({ tempo: 0, foul: 1 });
    expect(bal.coachingMod("attack").foul).toBeGreaterThan(bal.coachingMod("defend").foul);
  });

  it("an unknown or prototype stance falls back to balanced", () => {
    for (const s of ["", "park_the_bus", "toString", "constructor", "__proto__"]) {
      expect(bal.coachingMod(s)).toBe(bal.BALANCE.coaching.balanced);
    }
  });
});
