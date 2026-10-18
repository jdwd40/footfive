import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Person = {
  id: string;
  name: string;
  role: string;
  is_starter: boolean;
  attack: number;
  defence: number;
  energy: number;
  condition: number;
  intensity: string;
};
type Side = { players: Array<{ no: number }> };
type Numbered = (p: Person, i: number, all: Person[]) => { no: number };

const file = path.resolve(__dirname, "../../pocketbase/pb_hooks/lib/worldService.js");
const require = createRequire(file);
const sandbox: {
  module: { exports: Record<string, unknown> };
  require: NodeRequire;
  __dirname: string;
  __hooks: string;
  numbered?: Numbered;
} = {
  module: { exports: {} },
  require,
  __dirname: path.dirname(file),
  __hooks: path.resolve(__dirname, "../../pocketbase/pb_hooks"),
};
vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
if (typeof sandbox.numbered !== "function") throw new Error("Actual private callback was not loaded");
const numbered: Numbered = sandbox.numbered;

const eng = require("./matchEngine.js") as {
  createMatch: (o: Record<string, unknown>) => { rc: number; teams: { home: Side; away: Side } };
  buildTiming: (minuteMs: number, rate: number) => unknown;
};

function person(role: string, starter: boolean, i: number): Person {
  return { id: `p${i}`, name: `Player${i}`, role, is_starter: starter, attack: 70, defence: 70, energy: 100, condition: 100, intensity: "balanced" };
}

/** The lead probe list: starting goalkeeper, one bench outfielder, four starters, bench goalkeeper. */
function probePlayers(): Person[] {
  return ["gk", "att", "def", "mid", "att", "mid", "gk"].map((role, i) => person(role, i === 0 || (i >= 2 && i <= 5), i));
}

function people(spec: Array<[string, boolean]>): Person[] {
  return spec.map(([role, starter], i) => person(role, starter, i));
}

function team(id: string, players: Person[]) {
  return { id, name: id, abbr: id.slice(0, 3).toUpperCase(), grade: "B", ai: false, stance: "balanced", players };
}

function shirts(players: Person[], statePlayers: Array<{ no: number }>) {
  const before = JSON.stringify(players);
  const preview = players.map(numbered).map((p) => p.no);
  expect(preview).toEqual(statePlayers.map((p) => p.no));
  expect(JSON.stringify(players)).toBe(before);
  return preview;
}

describe("preview shirt numbers", () => {
  it("matches the live constructor across goalkeeper and bench order", () => {
    const home = probePlayers();
    const away = people([
      ["att", true],
      ["gk", true],
      ["def", false],
      ["mid", true],
      ["att", true],
      ["mid", true],
      ["gk", false],
    ]);
    const shifted = people([
      ["gk", true],
      ["att", true],
      ["gk", false],
      ["def", true],
      ["mid", true],
      ["att", false],
      ["mid", true],
    ]);
    const state = eng.createMatch({
      fixtureId: "preview45",
      seed: 1000,
      kickoffAt: 0,
      timing: eng.buildTiming(15000, 1),
      home: team("Home", home),
      away: team("Away", away),
    });
    expect(state.rc).toBe(0);
    expect(shirts(home, state.teams.home.players)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    shirts(away, state.teams.away.players);
    const again = eng.createMatch({
      fixtureId: "preview45b",
      seed: 1000,
      kickoffAt: 0,
      timing: eng.buildTiming(15000, 1),
      home: team("Shift", shifted),
      away: team("Copy", probePlayers()),
    });
    expect(again.rc).toBe(0);
    shirts(shifted, again.teams.home.players);
  });
});
