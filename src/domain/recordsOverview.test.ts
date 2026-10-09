import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const records = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/recordsService.js"),
) as {
  recordsOverview: (app: unknown) => {
    completedTournaments: number;
    currentTournament: { id: string; number: number; round: string; roundLabel: string } | null;
    recentChampions: { number: number; champion: string }[];
  };
};

function row(id: string, values: Record<string, unknown>) {
  return { id, get: (key: string) => values[key] };
}

function history(completed: number, stage: string | null = "sf") {
  // Gaps in tournament numbers must not inflate the number of completed records.
  const summaries = Array.from({ length: completed }, (_, i) => row(`summary${i}`, {
    number: (i + 1) * 2,
    champion_name: `Champion ${i + 1}`,
    runner_up_name: `Runner-up ${i + 1}`,
    completed_at: "2026-10-09 12:00:00.000Z",
  }));
  const active = stage ? row("active", { number: completed * 2 + 1, current_round: stage }) : null;
  const app = {
    findRecordsByFilter: vi.fn((collection: string, _filter: string, sort: string, limit: number, offset: number) => {
      if (collection === "tournament_summaries") {
        const sorted = sort === "-number" ? summaries.slice().reverse() : summaries;
        return sorted.slice(offset, offset + limit);
      }
      if (collection === "shared_tournaments") return active ? [active] : [];
      return [];
    }),
    countRecords: vi.fn((collection: string) => {
      if (collection !== "tournament_summaries") throw new Error(`Unexpected count: ${collection}`);
      return summaries.length;
    }),
  };
  return { app, summaries };
}

describe("History Overview", () => {
  it.each([0, 7, 20, 21, 49, 500, 537])("counts all %i completed tournaments while keeping recent champions bounded", (completed) => {
    const { app, summaries } = history(completed);
    const result = records.recordsOverview(app);

    expect(result.completedTournaments).toBe(completed);
    expect(result.recentChampions).toHaveLength(Math.min(completed, 8));
    expect(result.recentChampions.map((champion) => champion.number)).toEqual(
      summaries.slice().reverse().slice(0, 8).map((summary) => summary.get("number")),
    );
    if (completed) expect(result.recentChampions[0].champion).toBe(`Champion ${completed}`);
    expect(result.currentTournament?.number).toBe(completed * 2 + 1);
    // The total must not load an unbounded history list into the response.
    expect(app.findRecordsByFilter).toHaveBeenCalledWith("tournament_summaries", "id != ''", "-number", 20, 0);
  });

  it("increases the completed total beyond both former list ceilings", () => {
    const { app, summaries } = history(537);
    expect(records.recordsOverview(app).completedTournaments).toBe(537);
    summaries.push(row("next", { number: 1076, champion_name: "Next champion" }));
    const next = records.recordsOverview(app);
    expect(next.completedTournaments).toBe(538);
    expect(next.recentChampions).toHaveLength(8);
    expect(next.recentChampions[0].champion).toBe("Next champion");
  });

  it.each([
    ["r16", "Round of 16"],
    ["qf", "Quarter-finals"],
    ["sf", "Semi-finals"],
    ["final", "Final"],
  ])("labels %s using the tournament stage vocabulary without changing the round key", (stage, label) => {
    const { app } = history(49, stage);
    expect(records.recordsOverview(app).currentTournament).toEqual({
      id: "active", number: 99, round: stage, roundLabel: label,
    });
  });

  it("keeps completed history available when there is no active tournament", () => {
    const { app } = history(49, null);
    const result = records.recordsOverview(app);
    expect(result.currentTournament).toBeNull();
    expect(result.completedTournaments).toBe(49);
    expect(result.recentChampions).toHaveLength(8);
  });

  it("propagates a failed total query instead of displaying a plausible capped count", () => {
    const { app } = history(49);
    app.countRecords.mockImplementation(() => { throw new Error("count unavailable"); });
    expect(() => records.recordsOverview(app)).toThrow("count unavailable");
  });
});
