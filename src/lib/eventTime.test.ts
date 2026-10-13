import { describe, expect, it } from "vitest";
import { eventTime } from "./live";
import type { MatchEvent } from "./pocketbase";

const e = (o: Partial<MatchEvent>) => ({ seq: 1, at: 0, t: "pass", min: 5, text: "", st: { clk: null }, ...o }) as unknown as MatchEvent;

describe("eventTime (#78)", () => {
  it("reads the event's published clock as mm:ss, like the pitch clock", () => {
    expect(eventTime(e({ st: { clk: { s: 0, run: 1 } } as MatchEvent["st"] }))).toBe("00:00");
    expect(eventTime(e({ st: { clk: { s: 2700, run: 0 } } as MatchEvent["st"] }))).toBe("45:00");
    expect(eventTime(e({ st: { clk: { s: 3661.9, run: 1 } } as MatchEvent["st"] }))).toBe("61:01");
  });
  it("falls back to the minute without a clock, and P for shootout kicks", () => {
    expect(eventTime(e({}))).toBe("5′");
    expect(eventTime(e({ t: "shootout_kick", st: { clk: { s: 7200, run: 0 } } as MatchEvent["st"] }))).toBe("P");
  });
});
