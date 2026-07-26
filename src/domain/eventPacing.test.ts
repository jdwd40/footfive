import { describe, expect, it } from "vitest";
import {
  EVENT_PACING,
  getEventDisplay,
  holdForCatchUp,
  isMajorEventType,
} from "./eventDisplay";

describe("event pacing (15s/min era)", () => {
  it("minor events hold several seconds", () => {
    const cfg = getEventDisplay("midfield_play");
    expect(cfg.holdMs).toBeGreaterThanOrEqual(3500);
    expect(cfg.holdMs).toBeLessThanOrEqual(6000);
  });

  it("goals hold longer than minor events", () => {
    const goal = getEventDisplay("goal");
    const minor = getEventDisplay("corner");
    expect(goal.holdMs).toBeGreaterThan(minor.holdMs);
    expect(goal.holdMs).toBeGreaterThanOrEqual(9000);
  });

  it("live mode does not shorten holds", () => {
    const cfg = getEventDisplay("build_up");
    expect(holdForCatchUp(cfg, 2, "live")).toBe(cfg.holdMs);
  });

  it("catch-up never collapses major events below floor", () => {
    const goal = getEventDisplay("goal");
    const h = holdForCatchUp(goal, 20, "catchup");
    expect(h).toBeGreaterThanOrEqual(EVENT_PACING.catchUpMajorMinMs);
    expect(isMajorEventType("goal")).toBe(true);
  });

  it("shootout kicks remain major and slow", () => {
    expect(getEventDisplay("shootout_walkup").holdMs).toBeGreaterThanOrEqual(5000);
    expect(getEventDisplay("shootout_goal").holdMs).toBeGreaterThanOrEqual(7000);
  });
});
