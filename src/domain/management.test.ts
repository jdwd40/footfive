import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const bal = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/balance.js"),
) as {
  BALANCE: {
    startingTreasury: number;
    startingCredits: number;
    rewards: { winBase: number; goalBonus: number; champion: number };
    batteryRestore: number;
    commandChargeMax: number;
  };
  upgradeCost: (n: number) => number;
  repairCost: (n: number) => number;
  getTiming: (p: string) => { energyRegenPerHour: number; commandChargeRegenMs: number };
};

const eff = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/effectiveStats.js"),
) as {
  effectivePlayerStats: (
    p: Record<string, unknown>,
    o?: Record<string, unknown>,
  ) => { attack: number; defence: number };
  materialiseEnergy: (s: number, last: number, now: number, r: number) => number;
  materialiseCommandCharge: (
    p: number,
    last: number,
    now: number,
    regen: number,
    max: number,
  ) => { points: number };
  clamp: (n: number, lo: number, hi: number) => number;
};

describe("economy separation", () => {
  it("treasury and betting credits have distinct starting values", () => {
    expect(bal.BALANCE.startingTreasury).toBe(2500);
    expect(bal.BALANCE.startingCredits).toBe(1000);
    expect(bal.BALANCE.startingTreasury).not.toBe(bal.BALANCE.startingCredits);
  });

  it("upgrade costs rise with attribute", () => {
    expect(bal.upgradeCost(70)).toBeGreaterThan(bal.upgradeCost(50));
  });

  it("repair cost is linear", () => {
    expect(bal.repairCost(20)).toBe(bal.repairCost(10) * 2);
  });

  it("reward constants are positive", () => {
    expect(bal.BALANCE.rewards.winBase).toBeGreaterThan(0);
    expect(bal.BALANCE.rewards.goalBonus).toBeGreaterThan(0);
    expect(bal.BALANCE.rewards.champion).toBeGreaterThan(0);
  });
});

describe("effective stats", () => {
  it("low energy reduces attack", () => {
    const full = eff.effectivePlayerStats({
      attack: 80,
      defence: 50,
      role: "att",
      energy: 100,
      condition: 100,
      intensity: "balanced",
    });
    const low = eff.effectivePlayerStats({
      attack: 80,
      defence: 50,
      role: "att",
      energy: 20,
      condition: 100,
      intensity: "balanced",
    });
    expect(low.attack).toBeLessThan(full.attack);
  });

  it("aggressive boosts attack vs passive", () => {
    const base = {
      attack: 70,
      defence: 50,
      role: "att",
      energy: 100,
      condition: 100,
    };
    const agg = eff.effectivePlayerStats({ ...base, intensity: "aggressive" });
    const pas = eff.effectivePlayerStats({ ...base, intensity: "passive" });
    expect(agg.attack).toBeGreaterThan(pas.attack);
  });

  it("energy regenerates from timestamps and clamps at 100", () => {
    const now = 1_000_000;
    const hour = 3_600_000;
    const mid = eff.materialiseEnergy(50, now - hour, now, 12);
    expect(mid).toBeCloseTo(62, 0);
    expect(eff.materialiseEnergy(95, now - hour * 10, now, 12)).toBe(100);
  });

  it("command charge regenerates offline", () => {
    const regen = 15 * 60 * 1000;
    const now = 10_000_000;
    const r = eff.materialiseCommandCharge(2, now - regen * 2, now, regen, 5);
    expect(r.points).toBe(4);
    const cap = eff.materialiseCommandCharge(5, now - regen * 10, now, regen, 5);
    expect(cap.points).toBe(5);
  });
});

describe("match engine still works with wear", () => {
  it("a worn, fully managed squad still completes a match", () => {
    const engine = require(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/matchEngine.js"),
    ) as {
      createMatch: (o: Record<string, unknown>) => Record<string, unknown>;
      advanceTo: (st: Record<string, unknown>, now: number) => Array<{ t: string; st: { win: string | null } }>;
    };
    const team = (name: string) => ({
      id: name,
      name,
      abbr: name,
      grade: "B",
      players: [
        { name: "A", role: "att", attack: 70, defence: 40, energy: 20, condition: 40, is_starter: true, intensity: "aggressive" },
        { name: "B", role: "mid", attack: 65, defence: 50, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
        { name: "C", role: "mid", attack: 60, defence: 55, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
        { name: "D", role: "def", attack: 40, defence: 70, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
        { name: "E", role: "gk", attack: 20, defence: 80, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
        { name: "F", role: "att", attack: 55, defence: 40, energy: 100, condition: 100, is_starter: false, intensity: "balanced" },
        { name: "G", role: "def", attack: 35, defence: 60, energy: 100, condition: 100, is_starter: false, intensity: "balanced" },
      ],
    });
    const st = engine.createMatch({ fixtureId: "m", seed: 11, kickoffAt: 0, home: team("H"), away: team("A") });
    const ev = engine.advanceTo(st, 1e12);
    expect(ev.length).toBeGreaterThan(5);
    expect(ev[ev.length - 1].t).toBe("match_end");
    expect(ev[ev.length - 1].st.win).toMatch(/home|away/);
  });
});
