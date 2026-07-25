import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bf = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/backfillService.js"),
) as {
  runBackfill: (
    app: unknown,
    opts: { preview?: boolean },
  ) => { preview: boolean; created_summaries: number; error: string };
};

function stubApp() {
  return {
    findRecordsByFilter: (col: string) => {
      if (col === "match_states") return [];
      if (col === "match_summaries") return [];
      if (col === "shared_tournaments") return [];
      if (col === "backfill_runs") return [];
      return [];
    },
    findCollectionByNameOrId: () => {
      throw new Error("no");
    },
    findRecordById: () => {
      throw new Error("no");
    },
    save: () => {},
  };
}

describe("backfill", () => {
  it("preview on empty world creates zero writes", () => {
    const r = bf.runBackfill(stubApp(), { preview: true });
    expect(r.preview).toBe(true);
    expect(r.created_summaries).toBe(0);
  });
});
