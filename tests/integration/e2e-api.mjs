/**
 * Full API e2e suite (no browser). Isolated PB on 8091 preferred; falls back to 8090.
 * Run after: bash scripts/e2e-run.sh (or against dev PB with seed users).
 *
 * Standalone:
 *   E2E_PB_URL=http://127.0.0.1:8090 node tests/integration/e2e-api.mjs
 */
const PB = process.env.E2E_PB_URL || process.env.PB_URL || "http://127.0.0.1:8090";

let passed = 0;
let failed = 0;

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗", name, detail);
  }
}

async function json(path, opts = {}) {
  const res = await fetch(`${PB}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: opts.token } : {}),
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
  return { status: res.status, ok: res.ok, data };
}

async function login(email, password) {
  return json("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password },
  });
}

async function main() {
  const health = await fetch(`${PB}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log("SKIP: PocketBase not at", PB);
    process.exit(0);
  }
  console.log("API e2e against", PB);

  // Ensure users
  const stamp = Date.now();
  const users = {
    a: { email: `api_a_${stamp}@t.local`, pass: "testpass99" },
    b: { email: `api_b_${stamp}@t.local`, pass: "testpass99" },
    admin: { email: `api_admin_${stamp}@t.local`, pass: "adminpass99" },
  };
  for (const u of Object.values(users)) {
    await json("/api/collections/users/records", {
      method: "POST",
      body: {
        email: u.email,
        password: u.pass,
        passwordConfirm: u.pass,
        display_name: u.email.split("@")[0],
      },
    });
  }

  // promote admin via sqlite if possible
  const { spawnSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const fs = await import("node:fs");
  const dbs = [
    process.env.E2E_PB_DATA && path.join(process.env.E2E_PB_DATA, "data.db"),
    path.join(root, "pocketbase/pb_data_test/data.db"),
    path.join(root, "pocketbase/pb_data_rehearsal/data.db"),
    path.join(root, "pocketbase/pb_data/data.db"),
  ]
    .filter(Boolean)
    .filter((db) => fs.existsSync(db));
  for (const db of dbs) {
    const r = spawnSync(
      "python3",
      [
        "-c",
        `import sqlite3
c=sqlite3.connect(${JSON.stringify(db)})
cur=c.execute("update users set role='admin' where email=?", (${JSON.stringify(users.admin.email)},))
c.commit()
print('updated', cur.rowcount, ${JSON.stringify(db)})
`,
      ],
      { encoding: "utf8" },
    );
    console.log("sql", (r.stdout || r.stderr || "").trim());
    if (r.stdout && r.stdout.includes("updated 1")) break;
  }

  const authA = await login(users.a.email, users.a.pass);
  const authB = await login(users.b.email, users.b.pass);
  const authAdmin = await login(users.admin.email, users.admin.pass);
  ok("login A", authA.ok);
  ok("login B", authB.ok);
  ok("login admin", authAdmin.ok, JSON.stringify(authAdmin.data).slice(0, 80));

  const tokA = authA.data.token;
  const tokB = authB.data.token;
  const tokAdmin = authAdmin.data.token;

  // Shared world
  const wA = await json("/api/footfive/world", { token: tokA });
  const wB = await json("/api/footfive/world", { token: tokB });
  ok("same tournament", wA.data.tournament?.id === wB.data.tournament?.id);
  const sbA = await json("/api/footfive/live", { token: tokA });
  const sbB = await json("/api/footfive/live", { token: tokB });
  const idsA = (sbA.data.fixtures || []).map((f) => f.id).sort().join(",");
  const idsB = (sbB.data.fixtures || []).map((f) => f.id).sort().join(",");
  ok("same fixtures", idsA === idsB);

  // Security
  const rolePatch = await json(
    `/api/collections/users/records/${authA.data.record.id}`,
    { method: "PATCH", token: tokA, body: { role: "admin" } },
  );
  if (rolePatch.ok) {
    ok("role not escalated", rolePatch.data.role !== "admin");
  } else {
    ok("role patch rejected", true);
  }
  const credBefore = Number(authA.data.record.credits || 0);
  await json(`/api/collections/users/records/${authA.data.record.id}`, {
    method: "PATCH",
    token: tokA,
    body: { credits: 999999 },
  });
  const reA = await login(users.a.email, users.a.pass);
  ok("credits not self-set", Number(reA.data.record.credits) === credBefore, String(reA.data.record.credits));

  const adminDenied = await json("/api/footfive/admin/overview", { token: tokA });
  ok("user denied admin", !adminDenied.ok);

  // Admin flows
  if (authAdmin.ok) {
    const ov = await json("/api/footfive/admin/overview", { token: tokAdmin });
    ok("admin overview", ov.ok);
    const prev = await json("/api/footfive/admin/retention/preview", {
      method: "POST",
      token: tokAdmin,
    });
    ok("retention preview", prev.ok && prev.data.preview === true && prev.data.deleted === 0);
    const bf = await json("/api/footfive/admin/backfill/preview", {
      method: "POST",
      token: tokAdmin,
    });
    ok("backfill preview", bf.ok && bf.data.preview === true);
    const rec = await json("/api/footfive/admin/recovery/status", { token: tokAdmin });
    ok("recovery status", rec.ok);
    // password reset
    const email = `api_pw_${stamp}@t.local`;
    const created = await json("/api/footfive/admin/users", {
      method: "POST",
      token: tokAdmin,
      body: { email, password: "oldpass99", display_name: "pw", reason: "test" },
    });
    ok("admin create user", created.ok);
    if (created.ok) {
      const reset = await json(`/api/footfive/admin/users/${created.data.id}/password`, {
        method: "POST",
        token: tokAdmin,
        body: { password: "newpass99", mustChange: true, reason: "reset" },
      });
      ok("password reset", reset.ok && !reset.data.password);
      const oldL = await login(email, "oldpass99");
      const newL = await login(email, "newpass99");
      ok("old password dead", !oldL.ok);
      ok("new password works", newL.ok);
    }
    // claim conflict
    const teams = await json("/api/footfive/teams", { token: tokA });
    const free = (teams.data.teams || []).filter((t) => !t.managerId && !t.manager);
    if (free.length >= 2) {
      const c1 = await json(`/api/footfive/teams/${free[0].id}/claim`, {
        method: "POST",
        token: tokA,
      });
      const conflict = await json(`/api/footfive/teams/${free[0].id}/claim`, {
        method: "POST",
        token: tokB,
      });
      const c2 = await json(`/api/footfive/teams/${free[1].id}/claim`, {
        method: "POST",
        token: tokB,
      });
      ok("claim A", c1.ok);
      ok("claim conflict", !conflict.ok);
      ok("claim B other", c2.ok);
    }

    // detail routes
    if (free?.length) {
      const det = await json(`/api/footfive/records/teams/${free[0].id}`, { token: tokA });
      ok("team detail", det.ok && det.data.name);
    }
    const recOv = await json("/api/footfive/records/overview", { token: tokA });
    ok("records overview", recOv.ok);
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
