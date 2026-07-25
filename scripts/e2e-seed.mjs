/**
 * Seed E2E PocketBase users; promote admin via python sqlite.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PB = process.env.E2E_PB_URL || "http://127.0.0.1:8091";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA =
  process.env.E2E_PB_DATA
    ? path.join(process.env.E2E_PB_DATA, "data.db")
    : path.join(ROOT, "pocketbase", "pb_data_test", "data.db");

async function json(p, body) {
  const res = await fetch(`${PB}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const h = await fetch(`${PB}/api/health`);
      if (h.ok) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const users = [
    { email: "e2e_user_a@test.local", password: "testpass99", display_name: "E2E A" },
    { email: "e2e_user_b@test.local", password: "testpass99", display_name: "E2E B" },
    { email: "e2e_admin@test.local", password: "adminpass99", display_name: "E2E Admin" },
    { email: "e2e_disabled@test.local", password: "testpass99", display_name: "Disabled" },
  ];

  for (const u of users) {
    const r = await json("/api/collections/users/records", {
      email: u.email,
      password: u.password,
      passwordConfirm: u.password,
      display_name: u.display_name,
    });
    if (r.status !== 200 && r.status !== 201) {
      console.warn("register", u.email, r.status, JSON.stringify(r.data).slice(0, 120));
    }
  }

  // Promote admin / disable user on test DB only
  const py = `
import sqlite3
c=sqlite3.connect(${JSON.stringify(DATA)})
c.execute("UPDATE users SET role='admin' WHERE email='e2e_admin@test.local'")
c.execute("UPDATE users SET disabled=1 WHERE email='e2e_disabled@test.local'")
c.commit()
print('ok', c.execute("select email,role,disabled from users").fetchall())
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  console.log("sql seed", r.stdout || r.stderr);

  const auth = await json("/api/collections/users/auth-with-password", {
    identity: "e2e_user_a@test.local",
    password: "testpass99",
  });
  if (auth.status === 200) {
    await fetch(`${PB}/api/footfive/world`, {
      headers: { Authorization: auth.data.token },
    });
    await fetch(`${PB}/api/footfive/catch-up`, {
      method: "POST",
      headers: { Authorization: auth.data.token },
    });
  }
  console.log("e2e seed complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
