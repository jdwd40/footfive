import { describe, expect, it } from "vitest";
import { eventClockTime, eventTime, minuteLabel } from "./live";
import type { MatchEvent } from "./pocketbase";

const e = (o: Partial<MatchEvent>) => ({ seq: 1, at: 0, t: "pass", min: 5, text: "", st: { clk: null }, ...o }) as unknown as MatchEvent;
const clk = (s: number, run: 0 | 1 = 1) => ({ clk: { s, run } }) as MatchEvent["st"];

describe("canonical match minutes (#129)", () => {
  it("formats the engine minute and does not derive it from the clock", () => {
    expect(minuteLabel(0)).toBe("0′");
    expect(minuteLabel(45)).toBe("45′");
    expect(minuteLabel(59)).toBe("59′");
    expect(minuteLabel(61)).toBe("61′");
    expect(minuteLabel(90)).toBe("90′");
    expect(minuteLabel(105)).toBe("105′");
    expect(minuteLabel(120)).toBe("120′");
  });

  it("labels minute 59 and a coaching minute 59 alike, while the clock stays 58:xx", () => {
    const shot = e({ t: "shot", min: 59, st: clk(58 * 60 + 20) });
    const coaching = e({ t: "coaching", min: 59, st: clk(58 * 60) });
    expect(eventTime(shot)).toBe("59′");
    expect(eventTime(coaching)).toBe(minuteLabel(59));
    expect(eventTime(shot)).toBe(eventTime(coaching));
    expect(eventClockTime(shot)).toBe("58:20");
    expect(eventClockTime(coaching)).toBe("58:00");
  });

  it("labels a 60:05 card as minute 61, the same ordinal the ticker already prints", () => {
    const card = e({ t: "red_card", min: 61, st: clk(3605) });
    const ticker = "HOM 0–0 AWA — Red card: Poe (HOM), 61′.";
    expect(eventTime(card)).toBe("61′");
    expect(eventTime(card)).toBe(minuteLabel(61));
    expect(ticker).toContain(eventTime(card));
    expect(eventClockTime(card)).toBe("60:05");
    expect(eventTime(card)).not.toBe(eventClockTime(card));
  });

  it("keeps kick-off and period-end minutes canonical instead of floor(clock)+1", () => {
    expect(eventTime(e({ t: "kickoff", min: 0, st: clk(0) }))).toBe("0′");
    expect(eventClockTime(e({ t: "kickoff", min: 0, st: clk(0) }))).toBe("00:00");
    expect(eventTime(e({ t: "half_time", min: 45, st: clk(2700, 0) }))).toBe("45′");
    expect(eventClockTime(e({ t: "half_time", min: 45, st: clk(2700, 0) }))).toBe("45:00");
    expect(eventTime(e({ t: "end_of_normal_time", min: 90, st: clk(5400, 0) }))).toBe("90′");
    expect(eventClockTime(e({ t: "end_of_normal_time", min: 90, st: clk(5400, 0) }))).toBe("90:00");
    expect(eventTime(e({ t: "et_half_time", min: 105, st: clk(6300, 0) }))).toBe("105′");
    expect(eventClockTime(e({ t: "et_half_time", min: 105, st: clk(6300, 0) }))).toBe("105:00");
    expect(eventTime(e({ t: "match_end", min: 120, st: clk(7200, 0) }))).toBe("120′");
    expect(eventClockTime(e({ t: "match_end", min: 120, st: clk(7200, 0) }))).toBe("120:00");
  });

  it("keeps the published clock helper exact, including a fractional second", () => {
    expect(eventClockTime(e({ st: clk(0) }))).toBe("00:00");
    expect(eventClockTime(e({ st: clk(2700, 0) }))).toBe("45:00");
    expect(eventClockTime(e({ min: 62, st: clk(3661.9) }))).toBe("61:01");
    expect(eventTime(e({ min: 62, st: clk(3661.9) }))).toBe("62′");
    expect(eventClockTime(e({}))).toBe("");
  });

  it("falls back to the canonical minute without a clock, and P for every shootout event", () => {
    expect(eventTime(e({}))).toBe("5′");
    expect(eventTime(e({ t: "shootout_start", min: 120 }))).toBe("P");
    expect(eventClockTime(e({ t: "shootout_start", min: 120 }))).toBe("");
    expect(eventTime(e({ t: "shootout_kick", min: 120, st: clk(7200, 0) }))).toBe("P");
    expect(eventClockTime(e({ t: "shootout_kick", min: 120, st: clk(7200, 0) }))).toBe("120:00");
    expect(eventTime(e({ t: "shootout_end", min: 120, st: clk(7200, 0) }))).toBe("P");
  });
});
