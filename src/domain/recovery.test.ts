import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rec = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/recoveryService.js"),
) as {
  detectStalls: (app: unknown) => {
    hasStalls: boolean;
    stalledMatches: unknown[];
    stalledRounds: unknown[];
  };
  getThreshold: (app: unknown) => number;
};

function stubApp() {
  const world = {
    get: (k: string) => {
      if (k === "stall_threshold_ms") return 120000;
      if (k === "processing_status") return "idle";
      if (k === "next_action_at") return new Date().toISOString();
      return null;
    },
  };
  return {
    findRecordsByFilter: (col: string) => {
      if (col === "world") return [world];
      return [];
    },
  };
}

describe("recovery", () => {
  it("detects no stalls on idle empty world", () => {
    const r = rec.detectStalls(stubApp());
    expect(r.hasStalls).toBe(false);
    expect(r.stalledMatches).toEqual([]);
  });

  it("threshold default positive", () => {
    expect(rec.getThreshold(stubApp())).toBeGreaterThan(0);
  });
});
