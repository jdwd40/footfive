// Review B12: admin world settings validate pace and refuse the dead
// tournament_interval_ms setting (championship_gap_minutes replaced it).
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const lib = (f: string) => require(path.resolve(__dirname, "../../pocketbase/pb_hooks/lib", f));

class BadRequest extends Error {}
const g = globalThis as Record<string, unknown>;

function setup(data: Record<string, unknown>) {
  const world = {
    id: "world",
    data: { key: "main", ...data } as Record<string, unknown>,
    get(k: string) {
      return this.data[k];
    },
    set(k: string, v: unknown) {
      this.data[k] = v;
    },
  };
  let saves = 0;
  const app = {
    findRecordsByFilter: (col: string) => (col === "world" ? [world] : []),
    findCollectionByNameOrId: () => {
      throw new Error("no audit collection in this fake");
    },
    save: () => {
      saves++;
    },
  };
  return { world, app, saves: () => saves };
}

beforeEach(() => {
  g.BadRequestError = BadRequest;
  g.ForbiddenError = Error;
});
afterEach(() => {
  delete g.BadRequestError;
  delete g.ForbiddenError;
});

describe("patchWorldSettings", () => {
  const adm = () => lib("adminService.js");

  it("accepts the supported paces", () => {
    const { world, app } = setup({ pace: "normal" });
    adm().patchWorldSettings(app, "admin1", { pace: "dev" }, "r");
    expect(world.get("pace")).toBe("dev");
    adm().patchWorldSettings(app, "admin1", { pace: "normal" }, "r");
    expect(world.get("pace")).toBe("normal");
  });

  it("rejects an unsupported pace without saving", () => {
    const { world, app, saves } = setup({ pace: "normal" });
    for (const pace of ["fast", "", "test", 1]) {
      expect(() => adm().patchWorldSettings(app, "admin1", { pace }, "r")).toThrow(/^pace must be normal\|dev$/);
    }
    expect(world.get("pace")).toBe("normal");
    expect(saves()).toBe(0);
  });

  it("refuses tournament_interval_ms and points at championship_gap_minutes", () => {
    const { world, app, saves } = setup({ pace: "normal", championship_gap_minutes: 10 });
    expect(() =>
      adm().patchWorldSettings(app, "admin1", { tournament_interval_ms: 60000, championship_gap_minutes: 20 }, "r"),
    ).toThrow(/championship_gap_minutes/);
    expect(world.get("championship_gap_minutes")).toBe(10);
    expect(saves()).toBe(0);
  });

  it("still honours championship_gap_minutes", () => {
    const { world, app } = setup({ pace: "normal" });
    const r = adm().patchWorldSettings(app, "admin1", { championship_gap_minutes: 30, fixtures_window_minutes: 5 }, "r");
    expect(world.get("championship_gap_minutes")).toBe(30);
    expect(r.championship_gap_minutes).toBe(30);
  });
});
