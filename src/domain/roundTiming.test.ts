import { describe, expect, it } from "vitest";
import { formatCountdown, roundStartMessage } from "../hooks/useRoundTiming";

describe("round timing helpers", () => {
  it("formats countdown without negative", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5000)).toBe("00:00");
    expect(formatCountdown(65_000)).toBe("01:05");
    expect(formatCountdown(3_661_000)).toMatch(/1:01:01/);
  });

  it("announces round starts clearly", () => {
    expect(roundStartMessage("Round of 16", "r16")).toMatch(/Round of 16/i);
    expect(roundStartMessage("Quarter-finals", "qf")).toMatch(/Quarter/i);
    expect(roundStartMessage("Semi-finals", "sf")).toMatch(/semi/i);
    expect(roundStartMessage("Final", "final")).toMatch(/Final/i);
  });
});
