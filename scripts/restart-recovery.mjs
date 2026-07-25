/**
 * Restart resilience test against running PocketBase (dev or rehearsal).
 * 1) catch-up while live 2) stop not automated here — simulates recovery API path
 * Usage: PB_URL=http://127.0.0.1:8090 node scripts/restart-recovery.mjs
 */
const BASE = process.env.PB_URL || process.env.E2E_PB_URL || "http://127.0.0.1:8090";

async function json(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: opts.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) {
    console.log("SKIP no PB");
    process.exit(0);
  }

  const email = `recov_${Date.now()}@t.local`;
  await json("/api/collections/users/records", {
    method: "POST",
    body: {
      email,
      password: "testpass99",
      passwordConfirm: "testpass99",
      display_name: "recov",
    },
  });
  const auth = await json("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password: "testpass99" },
  });
  const token = auth.data.token;

  const before = await json("/api/footfive/scoreboard", { token });
  const fix = (before.data.fixtures || [])[0];
  let eventsBefore = 0;
  if (fix) {
    const id = fix.fixtureId || fix.id;
    const m = await json(`/api/footfive/match/${id}?sinceSeq=0`, { token });
    eventsBefore = (m.data.events || []).length;
  }

  // Simulate "after downtime": double catch-up must be idempotent
  await json("/api/footfive/catch-up", { method: "POST", token });
  await json("/api/footfive/catch-up", { method: "POST", token });

  if (fix) {
    const id = fix.fixtureId || fix.id;
    const m2 = await json(`/api/footfive/match/${id}?sinceSeq=0`, { token });
    const eventsAfter = (m2.data.events || []).length;
    const seqs = (m2.data.events || []).map((e) => e.seq);
    const unique = new Set(seqs);
    console.log({
      eventsBefore,
      eventsAfter,
      uniqueSeqs: unique.size,
      totalSeqs: seqs.length,
      score: `${m2.data.scoreHome}-${m2.data.scoreAway}`,
    });
    if (unique.size !== seqs.length) {
      console.error("FAIL duplicate event seqs");
      process.exit(1);
    }
  }

  // Health public
  const ph = await json("/api/footfive/health");
  if (!ph.ok) {
    console.error("FAIL public health");
    process.exit(1);
  }
  console.log("recovery smoke OK", ph.data.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
