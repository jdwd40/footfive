import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bal = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js"),
) as {
  BALANCE: { startingCredits: number; segmentMatchMinutes: number; coaching: Record<string, { attack: number }> };
  getTiming: (p: string) => { segmentMatchMinutes: number; matchMinuteRealMs: number };
  coachingMod: (s: string) => { attack: number; defence: number };
};

describe("shared world balance", () => {
  it("starting credits are fictional and positive", () => {
    expect(bal.BALANCE.startingCredits).toBe(1000);
  });

  it("segment timing is ~5 match minutes at 15s/min", () => {
    const t = bal.getTiming("normal");
    expect(t.segmentMatchMinutes).toBe(5);
    // 5 match minutes × 15 real seconds = 75s wall clock per segment
    expect(t.matchMinuteRealMs * t.segmentMatchMinutes).toBe(75000);
  });

  it("coaching stances are not identical", () => {
    expect(bal.coachingMod("defend").defence).not.toBe(bal.coachingMod("attack").defence);
  });
});
