#!/usr/bin/env node
/**
 * Trusted-server FootFive app-admin tools.
 * Run only on the VPS or a trusted machine with superuser credentials.
 *
 * Env:
 *   FOOTFIVE_PB_URL=http://127.0.0.1:8091
 *   FOOTFIVE_SUPERUSER_EMAIL=...
 *   FOOTFIVE_SUPERUSER_PASSWORD=...   (never commit)
 *
 * Usage:
 *   node scripts/footfive-admin.mjs list
 *   node scripts/footfive-admin.mjs promote --email a@b.c --confirm
 *   node scripts/footfive-admin.mjs demote --email a@b.c --confirm
 *   node scripts/footfive-admin.mjs cleanup-smoke --confirm
 */
import process from "node:process";

const PB = (process.env.FOOTFIVE_PB_URL || "http://127.0.0.1:8091").replace(/\/$/, "");
const SU_EMAIL = process.env.FOOTFIVE_SUPERUSER_EMAIL || "";
const SU_PASS = process.env.FOOTFIVE_SUPERUSER_PASSWORD || "";

function usage() {
  console.log(`footfive-admin.mjs
  list
  promote --email EMAIL --confirm
  demote --email EMAIL --confirm [--force-last]
  cleanup-smoke --confirm
Env: FOOTFIVE_PB_URL FOOTFIVE_SUPERUSER_EMAIL FOOTFIVE_SUPERUSER_PASSWORD`);
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
  if (!res.ok) {
    const err = new Error(data.message || res.statusText || String(res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function superuserToken() {
  if (!SU_EMAIL || !SU_PASS) {
    throw new Error("Set FOOTFIVE_SUPERUSER_EMAIL and FOOTFIVE_SUPERUSER_PASSWORD");
  }
  const auth = await json("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: SU_EMAIL, password: SU_PASS },
  });
  return auth.token;
}

async function findUserByEmail(token, email) {
  const q = encodeURIComponent(`email="${email.replace(/"/g, '\\"')}"`);
  const list = await json(`/api/collections/users/records?filter=${q}&perPage=5`, {
    token,
  });
  const items = list.items || [];
  if (!items.length) return null;
  return items[0];
}

async function listUsers(token) {
  const list = await json("/api/collections/users/records?perPage=200&sort=-created", {
    token,
  });
  for (const u of list.items || []) {
    console.log(
      [
        u.id,
        u.email,
        `role=${u.role || "user"}`,
        u.disabled ? "DISABLED" : "active",
        u.display_name || "",
      ].join("\t"),
    );
  }
  console.log(`total=${(list.items || []).length}`);
}

async function countAdmins(token) {
  const q = encodeURIComponent('role="admin" && disabled!=true');
  const list = await json(`/api/collections/users/records?filter=${q}&perPage=50`, {
    token,
  });
  return (list.items || []).length;
}

async function audit(token, action, user, before, after, reason) {
  // admin_audit_logs.createRule is null — superuser can create; admin relation optional
  try {
    await json("/api/collections/admin_audit_logs/records", {
      method: "POST",
      token,
      body: {
        action,
        target_type: "users",
        target_id: user.id,
        meta: {
          before,
          after,
          reason,
          via: "footfive-admin.mjs",
          target_email: user.email,
        },
      },
    });
  } catch (e) {
    console.warn("audit write skipped:", e.message);
  }
}

async function promote(email, confirm) {
  if (!confirm) throw new Error("Refusing without --confirm");
  const token = await superuserToken();
  const user = await findUserByEmail(token, email);
  if (!user) throw new Error(`No user with email ${email}`);
  if (user.role === "admin") {
    console.log("already admin", user.id);
    return;
  }
  const before = { role: user.role || "user" };
  const updated = await json(`/api/collections/users/records/${user.id}`, {
    method: "PATCH",
    token,
    body: { role: "admin" },
  });
  await audit(token, "cli_promote_admin", user, before, { role: updated.role }, "cli promote");
  console.log("promoted", updated.email, "role=", updated.role);
}

async function demote(email, confirm, forceLast) {
  if (!confirm) throw new Error("Refusing without --confirm");
  const token = await superuserToken();
  const user = await findUserByEmail(token, email);
  if (!user) throw new Error(`No user with email ${email}`);
  if ((user.role || "user") !== "admin") {
    console.log("not admin", user.id);
    return;
  }
  const n = await countAdmins(token);
  if (n <= 1 && !forceLast) {
    throw new Error("Refusing to demote last active admin (use --force-last for emergency)");
  }
  const before = { role: "admin" };
  const updated = await json(`/api/collections/users/records/${user.id}`, {
    method: "PATCH",
    token,
    body: { role: "user" },
  });
  await audit(token, "cli_demote_admin", user, before, { role: updated.role }, "cli demote");
  console.log("demoted", updated.email, "role=", updated.role);
}

async function cleanupSmoke(confirm) {
  if (!confirm) throw new Error("Refusing without --confirm");
  const token = await superuserToken();
  const list = await json("/api/collections/users/records?perPage=200", { token });
  const re = /^(deploy_smoke_|p5a_|admin_p5_|e2e_|api_a_|api_b_|api_admin_|api_pw_|perf_|p6admin_|p7_)/i;
  const candidates = (list.items || []).filter(
    (u) => re.test(u.email || "") || /smoke/i.test(u.display_name || ""),
  );
  for (const u of candidates) {
    // release team if any
    const teams = await json(
      `/api/collections/proball_teams/records?filter=${encodeURIComponent(`manager="${u.id}"`)}&perPage=5`,
      { token },
    );
    for (const t of teams.items || []) {
      await json(`/api/collections/proball_teams/records/${t.id}`, {
        method: "PATCH",
        token,
        body: { manager: "" },
      });
      console.log("released team", t.name || t.id, "from", u.email);
    }
    // check open bets
    const bets = await json(
      `/api/collections/shared_bets/records?filter=${encodeURIComponent(`user="${u.id}" && settled=false`)}&perPage=20`,
      { token },
    ).catch(() => ({ items: [] }));
    if ((bets.items || []).length) {
      console.log("disable (open bets)", u.email);
      await json(`/api/collections/users/records/${u.id}`, {
        method: "PATCH",
        token,
        body: { disabled: true, admin_note: "disabled: deploy smoke with open bets" },
      });
      await audit(token, "cli_disable_smoke", u, { disabled: false }, { disabled: true }, "smoke cleanup");
      continue;
    }
    await json(`/api/collections/users/records/${u.id}`, {
      method: "DELETE",
      token,
    });
    await audit(token, "cli_delete_smoke", u, { email: u.email }, null, "smoke cleanup");
    console.log("deleted", u.email);
  }
  console.log("cleanup done candidates=", candidates.length);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm") args.confirm = true;
    else if (a === "--force-last") args.forceLast = true;
    else if (a === "--email") args.email = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "help" || cmd === "-h") {
    usage();
    process.exit(0);
  }
  if (cmd === "list") {
    const token = await superuserToken();
    await listUsers(token);
    return;
  }
  if (cmd === "promote") {
    if (!args.email) throw new Error("--email required");
    await promote(args.email, !!args.confirm);
    return;
  }
  if (cmd === "demote") {
    if (!args.email) throw new Error("--email required");
    await demote(args.email, !!args.confirm, !!args.forceLast);
    return;
  }
  if (cmd === "cleanup-smoke") {
    await cleanupSmoke(!!args.confirm);
    return;
  }
  usage();
  process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
