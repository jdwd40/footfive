import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTeamLabel, teamAbbreviation } from "../components/TeamName";
import { postLoginPath, type AuthUser } from "../lib/auth";

const require = createRequire(import.meta.url);
const teamsMod = require(
  path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/teams.js"),
) as {
  TEAMS: Array<{ name: string; slug: string; abbreviation?: string }>;
};

const CANONICAL: Record<string, string> = {
  "New Metro City": "MET",
  "Mega City One": "MC1",
  "Mega City Two": "MC2",
  "Airway City": "AIR",
  Virgin: "VIR",
  "Port Hilo": "PHL",
  "Metro Bay": "MBY",
  "Green Bay": "GRN",
  "Tripper City": "TRI",
  Atlan: "ATL",
  Redstone: "RED",
  Swirl: "SWR",
  "St Marry": "STM",
  "Orlean City": "ORL",
  "Outside City": "OUT",
  "Doge City": "DOG",
};

describe("canonical team abbreviations", () => {
  it("has all 16 teams with correct unique abbreviations", () => {
    expect(teamsMod.TEAMS).toHaveLength(16);
    const seen = new Set<string>();
    for (const t of teamsMod.TEAMS) {
      expect(t.abbreviation).toBe(CANONICAL[t.name]);
      expect(t.abbreviation).toMatch(/^[A-Z0-9]{2,3}$/);
      expect(seen.has(t.abbreviation!)).toBe(false);
      seen.add(t.abbreviation!);
    }
    expect(seen.size).toBe(16);
  });

  it("TeamName short mode uses abbreviation", () => {
    const team = { name: "New Metro City", abbreviation: "MET" };
    expect(teamAbbreviation(team)).toBe("MET");
    expect(resolveTeamLabel(team, "short")).toBe("MET");
    expect(resolveTeamLabel(team, "full")).toBe("New Metro City");
  });
});

describe("post-login admin routing", () => {
  it("sends must_change to change-password", () => {
    const u: AuthUser = {
      id: "1",
      email: "admin@example.com",
      role: "admin",
      must_change_password: true,
    };
    expect(postLoginPath(u)).toBe("/change-password");
  });

  it("sends admin to /admin when password ok", () => {
    const u: AuthUser = {
      id: "1",
      email: "admin@example.com",
      role: "admin",
      must_change_password: false,
    };
    expect(postLoginPath(u)).toBe("/admin");
  });

  it("sends normal user to the live round", () => {
    const u: AuthUser = {
      id: "2",
      email: "u@example.com",
      role: "user",
      must_change_password: false,
    };
    expect(postLoginPath(u)).toBe("/live");
  });
});
