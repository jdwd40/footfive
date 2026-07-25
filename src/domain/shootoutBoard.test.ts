import { describe, expect, it } from "vitest";

// Mirror ShootoutBoard marksFromKicks logic for unit coverage without DOM
type Kick = {
  team: "home" | "away";
  outcome: "goal" | "save" | "miss";
};

function marksFromKicks(
  kicks: Kick[],
  side: "home" | "away",
  nextSide: "home" | "away" | null,
) {
  const sideKicks = kicks.filter((k) => k.team === side);
  const marks: string[] = sideKicks.map((k) =>
    k.outcome === "goal" ? "goal" : "miss",
  );
  const n = Math.max(5, marks.length + (nextSide === side ? 1 : 0));
  while (marks.length < n) {
    if (marks.length === sideKicks.length && nextSide === side) {
      marks.push("current");
    } else {
      marks.push("pending");
    }
  }
  return marks.slice(0, Math.min(8, n));
}

describe("shootout board markers", () => {
  it("uses authoritative kicks not score alone", () => {
    const kicks: Kick[] = [
      { team: "home", outcome: "goal" },
      { team: "away", outcome: "miss" },
      { team: "home", outcome: "goal" },
    ];
    const home = marksFromKicks(kicks, "home", "away");
    const away = marksFromKicks(kicks, "away", "away");
    expect(home.filter((m) => m === "goal")).toHaveLength(2);
    expect(away.filter((m) => m === "miss")).toHaveLength(1);
    expect(away).toContain("current");
  });

  it("does not invent future kicks beyond pending slots", () => {
    const kicks: Kick[] = [{ team: "home", outcome: "goal" }];
    const home = marksFromKicks(kicks, "home", "away");
    expect(home.filter((m) => m === "goal")).toHaveLength(1);
    expect(home.filter((m) => m === "pending").length).toBeGreaterThan(0);
    expect(home).not.toContain("current");
  });
});
