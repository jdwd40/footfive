/**
 * Batch knockout sim sample for balance reporting.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engine = require(path.join(__dirname, "../pocketbase/pb_hooks/lib/matchEngine.js"));

function team(name, grade, atk) {
  return {
    name,
    grade,
    players: [
      { name: "A", role: "att", attack: atk, defence: 40, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
      { name: "B", role: "mid", attack: atk - 5, defence: 50, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
      { name: "C", role: "mid", attack: atk - 8, defence: 55, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
      { name: "D", role: "def", attack: 40, defence: atk - 10, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
      { name: "E", role: "gk", attack: 15, defence: atk, energy: 100, condition: 100, is_starter: true, intensity: "balanced" },
      { name: "F", role: "att", attack: atk - 15, defence: 35, energy: 100, condition: 100, is_starter: false, intensity: "balanced" },
      { name: "G", role: "def", attack: 30, defence: atk - 15, energy: 100, condition: 100, is_starter: false, intensity: "balanced" },
    ],
  };
}

const grades = ["A++", "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
const N = 80;
let et = 0;
let so = 0;
let sd = 0;
let goals = 0;
let upsets = 0;

for (let i = 0; i < N; i++) {
  const g1 = grades[i % grades.length];
  const g2 = grades[(i * 3 + 1) % grades.length];
  const home = team("H" + i, g1, 55 + (i % 30));
  const away = team("A" + i, g2, 50 + ((i * 2) % 30));
  const res = engine.simulateMatch({
    home,
    away,
    seed: "bal-sample-" + i,
    pace: "test",
  });
  goals += res.scoreHome + res.scoreAway;
  if (res.wentExtraTime) et++;
  if (res.wentShootout) {
    so++;
    const kicks = res.events.filter((e) =>
      ["shootout_goal", "shootout_save", "shootout_miss"].includes(e.type),
    ).length;
    if (kicks > 10) sd++;
  }
  // crude upset: weaker grade wins
  const str = (g) =>
    ({ "A++": 96, "A+": 90, A: 85, "A-": 80, "B+": 75, B: 70, "B-": 65, "C+": 60, C: 55, "C-": 50 })[
      g
    ] || 60;
  if (res.winnerSide === "home" && str(g1) < str(g2) - 5) upsets++;
  if (res.winnerSide === "away" && str(g2) < str(g1) - 5) upsets++;
}

console.log(
  JSON.stringify(
    {
      matches: N,
      extraTimePct: Math.round((et / N) * 1000) / 10,
      shootoutPct: Math.round((so / N) * 1000) / 10,
      suddenDeathAmongSO: so ? Math.round((sd / so) * 1000) / 10 : 0,
      avgGoals: Math.round((goals / N) * 100) / 100,
      upsetPct: Math.round((upsets / N) * 1000) / 10,
    },
    null,
    2,
  ),
);
