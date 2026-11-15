/**
 * JSON fields read losslessly through real PocketBase (Codex review on PR #238).
 *
 * The JSVM can hand a json field back from record.get() as UTF-8 bytes; a shared
 * reader that guessed at those bytes returned [91,93] for [], [123,125] for {} and
 * "JosÃ©" for "José". Records are now read with getString() at the record boundary.
 * This inserts one match summary with an empty cards list, an empty shootout list,
 * an empty coaching object and an accented scorer, then checks the archive list and
 * the match detail API return them exactly.
 *
 * Runs inside `npm run test:integration` (scripts/e2e-run.sh) after the seed, or:
 *   E2E_PB_URL=http://127.0.0.1:8091 E2E_PB_DATA=pocketbase/pb_data_test node tests/integration/json-fields.mjs
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const PB = process.env.E2E_PB_URL || "http://127.0.0.1:8091";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB = process.env.E2E_PB_DATA
  ? path.join(process.env.E2E_PB_DATA, "data.db")
  : path.join(ROOT, "pocketbase", "pb_data_test", "data.db");

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗", name, String(detail).slice(0, 400));
  }
}
// Key order is not compared: PocketBase stores json fields with sorted keys.
const same = (a, b) => isDeepStrictEqual(a, b);

async function json(p, { method = "GET", token, body } = {}) {
  const res = await fetch(`${PB}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

const suffix = Date.now().toString(36).slice(-6).padStart(6, "0");
const SUMMARY_ID = ("jsonfields" + suffix).slice(0, 15);
const FIXTURE_ID = "jf_fixture_" + suffix;
const TOURNAMENT_ID = "jf_tourn_" + suffix;
const GOALS = [{ player: "José", minute: 12, side: "home" }];

async function main() {
  console.log("JSON fields e2e @", PB);
  const db = new DatabaseSync(DB);
  try {
    db.prepare(
      `INSERT INTO match_summaries (id, fixture_id, tournament_id, round_key, slot, home_name, away_name,
         score_home, score_away, went_extra_time, went_shootout, goals_json, cards_json,
         shootout_kicks_json, coaching_json, stats_json, events_purged, completed_at)
       VALUES (?, ?, ?, 'r16', 'R16_1', 'Home FC', 'Away FC', 1, 0, 0, 0, ?, '[]', '[]', '{}', NULL, 1, ?)`,
    ).run(SUMMARY_ID, FIXTURE_ID, TOURNAMENT_ID, JSON.stringify(GOALS), new Date().toISOString().replace("T", " "));

    const login = await json("/api/collections/users/auth-with-password", {
      method: "POST",
      body: { identity: "e2e_user_a@test.local", password: "testpass99" },
    });
    ok("login", login.status === 200, JSON.stringify(login.data));
    const token = login.data.token;

    const list = await json(`/api/footfive/records/matches?tournamentId=${TOURNAMENT_ID}`, { token });
    const row = (list.data.matches || []).find((m) => m.id === SUMMARY_ID);
    ok("archive lists the summary", list.status === 200 && !!row, JSON.stringify(list.data));
    if (row) {
      ok("archive: no cards is an empty list", same(row.cards, []), JSON.stringify(row.cards));
      ok("archive: no shootout kicks is an empty list", same(row.shootoutKicks, []), JSON.stringify(row.shootoutKicks));
      ok("archive: accented scorer is preserved", same(row.goals, GOALS), JSON.stringify(row.goals));
      ok("archive: JSON-null stats gives the null fallback", row.stats === null, JSON.stringify(row.stats));
    }

    const detail = await json(`/api/footfive/records/matches/${SUMMARY_ID}`, { token });
    const d = detail.data;
    ok("detail returns the summary", detail.status === 200 && d.id === SUMMARY_ID, JSON.stringify(d));
    ok("detail: no cards is an empty list", same(d.cards, []), JSON.stringify(d.cards));
    ok("detail: no shootout kicks is an empty list", same(d.shootoutKicks, []), JSON.stringify(d.shootoutKicks));
    ok("detail: empty coaching object stays {}", same(d.coaching, {}), JSON.stringify(d.coaching));
    ok("detail: accented scorer is preserved", same(d.goals, GOALS), JSON.stringify(d.goals));
  } finally {
    db.prepare("DELETE FROM match_summaries WHERE id = ?").run(SUMMARY_ID);
    db.close();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
