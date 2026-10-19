/**
 * Lightweight local timing sample against running PocketBase.
 * Usage: PB_URL=http://127.0.0.1:8090 node scripts/perf-sample.mjs
 */
const BASE = process.env.PB_URL || "http://127.0.0.1:8090";

async function time(label, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const ms = performance.now() - t0;
    console.log(`${label.padEnd(28)} ${ms.toFixed(1)}ms  status=${r.status}`);
    return ms;
  } catch (e) {
    console.log(`${label.padEnd(28)} FAIL ${e.message}`);
    return null;
  }
}

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) {
    console.log("SKIP: no PocketBase at", BASE);
    process.exit(0);
  }

  const email = `perf_${Date.now()}@test.local`;
  const pass = "testpass99";
  await fetch(`${BASE}/api/collections/users/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: pass,
      passwordConfirm: pass,
      display_name: "perf",
    }),
  });
  const auth = await (
    await fetch(`${BASE}/api/collections/users/auth-with-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: email, password: pass }),
    })
  ).json();
  const h = { Authorization: auth.token };

  await time("health", () => fetch(`${BASE}/api/health`));
  await time("world", () => fetch(`${BASE}/api/footfive/world`, { headers: h }));
  await time("public-scoreboard", () =>
    fetch(`${BASE}/api/footfive/public-scoreboard`),
  );
  await time("records/overview", () =>
    fetch(`${BASE}/api/footfive/records/overview`, { headers: h }),
  );
  await time("records/teams", () =>
    fetch(`${BASE}/api/footfive/records/teams`, { headers: h }),
  );
  console.log("Note: admin timings require admin token; run separately if needed.");
}

main();
