/**
 * Prompt 5 API smoke — requires PocketBase on 127.0.0.1:8090.
 * Run: node tests/integration/prompt5-api.smoke.mjs
 */
const BASE = process.env.PB_URL || "http://127.0.0.1:8090";

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: opts.token } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log("SKIP: PocketBase not reachable at", BASE);
    process.exit(0);
  }

  const stamp = Date.now();
  const emailA = `p5a_${stamp}@test.local`;
  const emailB = `p5b_${stamp}@test.local`;
  const pass = "testpass99";

  // Register two users
  for (const email of [emailA, emailB]) {
    const r = await json("/api/collections/users/records", {
      method: "POST",
      body: {
        email,
        password: pass,
        passwordConfirm: pass,
        display_name: email.split("@")[0],
      },
    });
    assert(r.status === 200 || r.status === 201, `register ${email}: ${r.status}`);
  }

  const authA = await json("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: emailA, password: pass },
  });
  assert(authA.status === 200, "auth A");
  const tokenA = authA.data.token;

  const authB = await json("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: emailB, password: pass },
  });
  assert(authB.status === 200, "auth B");
  const tokenB = authB.data.token;

  const worldA = await json("/api/footfive/world", { token: tokenA });
  const worldB = await json("/api/footfive/world", { token: tokenB });
  assert(worldA.status === 200 && worldB.status === 200, "world");
  assert(
    worldA.data.tournament?.id === worldB.data.tournament?.id ||
      (!worldA.data.tournament && !worldB.data.tournament),
    "shared tournament id",
  );

  const sbA = await json("/api/footfive/scoreboard", { token: tokenA });
  const sbB = await json("/api/footfive/scoreboard", { token: tokenB });
  assert(sbA.status === 200 && sbB.status === 200, "scoreboard");
  assert(
    JSON.stringify(sbA.data.fixtures?.map((f) => f.id)) ===
      JSON.stringify(sbB.data.fixtures?.map((f) => f.id)),
    "same fixtures",
  );

  // Records routes
  const rec = await json("/api/footfive/records/overview", { token: tokenA });
  assert(rec.status === 200, "records overview");
  assert(rec.data.highlights, "highlights");

  const players = await json("/api/footfive/records/players", { token: tokenA });
  assert(players.status === 200, "records players");

  const hist = await json("/api/footfive/bets/history", { token: tokenA });
  assert(hist.status === 200, "bets history");
  assert(typeof hist.data.balance === "number", "balance");

  // Non-admin denied
  const adminDenied = await json("/api/footfive/admin/overview", { token: tokenA });
  assert(adminDenied.status === 403 || adminDenied.status === 400, "admin denied for user");

  // Promote A to admin via superuser if possible — skip if no superuser env
  // Retention Never smoke only for admin

  console.log("OK prompt5 API smoke", {
    tournament: worldA.data.tournament?.number,
    fixtures: sbA.data.fixtures?.length,
    completedTournaments: rec.data.completedTournaments,
  });
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
