import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const retention = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/retentionService.js"),
) as {
  getRetentionDays: ($app: unknown) => number;
  runRetention: (
    $app: unknown,
    opts?: { preview?: boolean; days?: number },
  ) => {
    preview: boolean;
    retention_days: number;
    examined: number;
    deleted: number;
    skipped: string[];
    eligible: string[];
  };
};

/** Minimal stub app for Never / preview unit behaviour without SQLite. */
function stubApp(retentionDays: number) {
  const world = {
    get: (k: string) => {
      if (k === "retention_days") return retentionDays;
      return null;
    },
    set: () => {},
  };
  return {
    findRecordsByFilter: (col: string) => {
      if (col === "world") return [world];
      if (col === "match_summaries") return [];
      if (col === "tactical_scans") return [];
      return [];
    },
    findCollectionByNameOrId: () => {
      throw new Error("no col");
    },
  };
}

describe("retention policy", () => {
  it("Never (0) skips deletion", () => {
    const r = retention.runRetention(stubApp(0), { preview: false, days: 0 });
    expect(r.retention_days).toBe(0);
    expect(r.deleted).toBe(0);
    expect(r.skipped.some((s) => /Never/i.test(s))).toBe(true);
  });

  it("preview flag is echoed and deletes 0 on empty", () => {
    const r = retention.runRetention(stubApp(30), { preview: true, days: 30 });
    expect(r.preview).toBe(true);
    expect(r.deleted).toBe(0);
  });

  it("supported day values include 7 30 90", () => {
    for (const d of [7, 30, 90]) {
      const r = retention.runRetention(stubApp(d), { preview: true, days: d });
      expect(r.retention_days).toBe(d);
    }
  });
});
