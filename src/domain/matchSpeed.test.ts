import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bal = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js"),
) as {
  BALANCE: { matchMinuteRealSeconds: number; matchMinuteRealMs: number };
  getTiming: (pace: string, override?: number) => { matchMinuteRealMs: number };
  clampMatchMinuteSeconds: (n: number) => number;
};

describe("match speed balance", () => {
  it("defaults to 8 real seconds per match minute", () => {
    expect(bal.BALANCE.matchMinuteRealSeconds).toBe(8);
    expect(bal.BALANCE.matchMinuteRealMs).toBe(8000);
    expect(bal.getTiming("normal").matchMinuteRealMs).toBe(8000);
  });

  it("override snapshot wins over pace", () => {
    expect(bal.getTiming("dev", 15000).matchMinuteRealMs).toBe(15000);
  });

  it("clamps admin range 1–60", () => {
    // 0 is invalid → clamp to min 1; NaN/undefined path uses default via callers
    expect(bal.clampMatchMinuteSeconds(0)).toBe(1);
    expect(bal.clampMatchMinuteSeconds(1)).toBe(1);
    expect(bal.clampMatchMinuteSeconds(60)).toBe(60);
    expect(bal.clampMatchMinuteSeconds(99)).toBe(60);
  });

  it("90 minute wall estimate at default", () => {
    const sec = bal.BALANCE.matchMinuteRealSeconds;
    expect(90 * sec).toBe(720); // 12m
  });
});
