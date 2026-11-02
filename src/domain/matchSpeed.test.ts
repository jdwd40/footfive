import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const bal = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js"),
) as {
  BALANCE: { matchMinuteRealSeconds: number; matchMinuteRealMs: number };
  getTiming: (pace: string, override?: number) => { matchMinuteRealMs: number };
  clampMatchMinuteSeconds: (n: number) => number;
};

describe("match speed balance", () => {
  it("defaults to 6 real seconds per match minute", () => {
    expect(bal.BALANCE.matchMinuteRealSeconds).toBe(6);
    expect(bal.BALANCE.matchMinuteRealMs).toBe(6000);
    expect(bal.getTiming("normal").matchMinuteRealMs).toBe(6000);
  });

  it("override snapshot wins over pace", () => {
    expect(bal.getTiming("dev", 15000).matchMinuteRealMs).toBe(15000);
    expect(bal.getTiming("normal", 8000).matchMinuteRealMs).toBe(8000);
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
    expect(90 * sec).toBe(540); // 9m, before holds/breaks
  });
});

describe("world speed migration #195", () => {
  const migration = readFileSync(path.resolve(__dirname, "../../pocketbase/pb_migrations/1750000020_match_speed_6s.js"), "utf8");
  const setup = (values: number[][]) => {
    const rows = values.map(([sec, ms]) => {
      const data: Record<string, number> = { match_minute_real_seconds: sec, match_minute_real_ms: ms };
      return { data, get: (key: string) => data[key], set: (key: string, value: number) => { data[key] = value; } };
    });
    const save = vi.fn();
    const app = {
      findCollectionByNameOrId: (name: string) => { expect(name).toBe("world"); return { id: "world" }; },
      findRecordsByFilter: (name: string, _filter: string, _sort: string, limit: number, offset: number) => {
        expect(name).toBe("world"); // no access to round, fixture or match-state snapshots
        return rows.slice(offset, offset + limit);
      },
      save,
    };
    type Step = (target: typeof app) => void;
    let up!: Step, down!: Step;
    runInNewContext(migration, { migrate: (u: Step, d: Step) => { up = u; down = d; } });
    return { rows, save, up: () => up(app), down: () => down(app) };
  };

  it("updates every page, including missing/inconsistent settings, and is idempotent", () => {
    const t = setup([...Array.from({ length: 201 }, () => [8, 8000]), [15, 15000], [0, 0], [6, 8000], [6, 6000]]);
    t.up();
    expect(t.rows.every(r => r.data.match_minute_real_seconds === 6 && r.data.match_minute_real_ms === 6000)).toBe(true);
    expect(t.save).toHaveBeenCalledTimes(204); // the already-correct row was not saved
    t.save.mockClear();
    t.up();
    expect(t.save).not.toHaveBeenCalled();
  });

  it("best-effort down restores 8s, preserving later overrides and skipping already-restored rows", () => {
    const t = setup([[6, 6000], [12, 12000], [6, 9000], [8, 8000]]);
    t.down();
    expect(t.rows.map(r => Object.values(r.data))).toEqual([[8, 8000], [12, 12000], [6, 9000], [8, 8000]]);
    expect(t.save).toHaveBeenCalledTimes(1);
    t.save.mockClear();
    t.down();
    expect(t.save).not.toHaveBeenCalled();
  });

  it("does not swallow a save error and silently mark a partial migration applied", () => {
    const t = setup([[8, 8000]]);
    t.save.mockImplementation(() => { throw new Error("write failed"); });
    expect(t.up).toThrow("write failed");
  });
});
