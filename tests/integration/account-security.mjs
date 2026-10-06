/**
 * Account-security regression suite (issue #14 / review B1, B2, B10).
 * Real sockets against an isolated PocketBase with FootFive hooks loaded.
 *
 * Run inside scripts/e2e-run.sh (after Playwright) or standalone:
 *   E2E_PB_URL=http://127.0.0.1:8091 node tests/integration/account-security.mjs
 *
 * Requires the seeded admin e2e_admin@test.local/adminpass99 (scripts/e2e-seed.mjs).
 * The 429 throttle check runs LAST: it deliberately exhausts the login rate-limit
 * bucket, so a back-to-back re-run against the same server within ~60 s may wait
 * out one window (loginRetry handles that once; a fresh pb_data_test resets it).
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
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
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

async function loginNative(email, password) {
  return json("/api/collections/users/auth-with-password", {
    method: "POST",
    body: { identity: email, password },
  });
}

// Rate-limit tolerant login for the pre-throttle phases: wait out one window on 429.
async function loginRetry(email, password) {
  let r = await loginNative(email, password);
  if (r.status === 429) {
    console.log("  … 429 from previous window, waiting 65 s");
    await new Promise((res) => setTimeout(res, 65000));
    r = await loginNative(email, password);
  }
  return r;
}

async function createUser(email, password, extra = {}) {
  return json("/api/collections/users/records", {
    method: "POST",
    body: {
      email,
      password,
      passwordConfirm: password,
      display_name: email.split("@")[0],
      ...extra,
    },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const health = await fetch(`${PB}/api/health`).catch(() => null);
  if (!health || !health.ok) {
    console.log("SKIP: PocketBase not at", PB);
    process.exit(1);
  }
  console.log("Account-security e2e against", PB);
  const stamp = Date.now();

  const adminAuth = await loginRetry("e2e_admin@test.local", "adminpass99");
  ok("seeded admin login", adminAuth.ok, JSON.stringify(adminAuth.data).slice(0, 120));
  if (!adminAuth.ok) {
    console.log("Result: aborting, admin required");
    process.exit(1);
  }
  const tokAdmin = adminAuth.data.token;

  // --- 1. Direct writes to protected fields (create) ---
  const evilEmail = `sec_evil_${stamp}@t.local`;
  const evilCreated = await createUser(evilEmail, "testpass99", {
    role: "admin",
    disabled: true,
    must_change_password: true,
  });
  ok("create with protected fields accepted", evilCreated.ok, JSON.stringify(evilCreated.data).slice(0, 120));
  const evilLogin = await loginRetry(evilEmail, "testpass99");
  ok("created user can log in (not disabled)", evilLogin.ok, JSON.stringify(evilLogin.data).slice(0, 120));
  if (evilLogin.ok) {
    ok("create: role forced to user", evilLogin.data.record.role !== "admin", String(evilLogin.data.record.role));
    const me = await json("/api/footfive/me", { token: evilLogin.data.token });
    ok("create: must_change_password forced false", me.ok && me.data.must_change_password === false, JSON.stringify(me.data));
    ok("create: disabled forced false", me.ok && me.data.disabled === false, JSON.stringify(me.data));
  }

  // --- 2. Direct writes to protected fields (update) ---
  const uEmail = `sec_u_${stamp}@t.local`;
  await createUser(uEmail, "testpass99");
  const uAuth = await loginRetry(uEmail, "testpass99");
  const tokU = uAuth.data.token;
  const idU = uAuth.data.record.id;
  const rolePatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { role: "admin" },
  });
  if (rolePatch.ok) ok("update: role not escalated", rolePatch.data.role !== "admin", String(rolePatch.data.role));
  else ok("update: role patch rejected", true);
  const disPatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { disabled: true },
  });
  const meAfterDis = await json("/api/footfive/me", { token: tokU });
  ok("update: disabled not self-set", meAfterDis.ok && meAfterDis.data.disabled === false, JSON.stringify(meAfterDis.data));
  void disPatch;
  // legit profile change with unchanged-but-present protected field in payload
  const profPatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { display_name: "SecRenamed", role: "admin" },
  });
  ok("update: legit profile field still works", profPatch.ok && profPatch.data.display_name === "SecRenamed", JSON.stringify(profPatch.data).slice(0, 120));
  ok("update: role pinned during legit edit", profPatch.ok && profPatch.data.role !== "admin", String(profPatch.data.role));

  // --- 3. must_change_password enforcement ---
  const pwEmail = `sec_pw_${stamp}@t.local`;
  const pwCreated = await json("/api/footfive/admin/users", {
    method: "POST",
    token: tokAdmin,
    body: { email: pwEmail, password: "temppass99", display_name: "SecPw", reason: "sec test" },
  });
  ok("admin create pw user", pwCreated.ok, JSON.stringify(pwCreated.data).slice(0, 120));
  const reset = await json(`/api/footfive/admin/users/${pwCreated.data.id}/password`, {
    method: "POST",
    token: tokAdmin,
    body: { password: "temppass99", mustChange: true, reason: "sec test reset" },
  });
  ok("admin reset with mustChange", reset.ok && reset.data.must_change_password === true, JSON.stringify(reset.data));
  const pwLogin = await loginRetry(pwEmail, "temppass99");
  ok("temp password login works", pwLogin.ok, JSON.stringify(pwLogin.data).slice(0, 120));
  const tokPw = pwLogin.data.token;
  const idPw = pwLogin.data.record.id;

  const worldFlag = await json("/api/footfive/world", { token: tokPw });
  ok("flagged: /world denied", worldFlag.status === 401 || worldFlag.status === 403, `status=${worldFlag.status}`);
  const liveFlag = await json("/api/footfive/live", { token: tokPw });
  ok("flagged: /live denied", liveFlag.status === 401 || liveFlag.status === 403, `status=${liveFlag.status}`);
  const betsFlag = await json("/api/footfive/bets/mine", { token: tokPw });
  ok("flagged: /bets/mine denied", betsFlag.status === 401 || betsFlag.status === 403, `status=${betsFlag.status}`);
  const meFlag = await json("/api/footfive/me", { token: tokPw });
  ok("flagged: /me allowed (session discovery)", meFlag.ok && meFlag.data.must_change_password === true, JSON.stringify(meFlag.data));

  // self-clear attempt must not stick
  await json(`/api/collections/users/records/${idPw}`, {
    method: "PATCH",
    token: tokPw,
    body: { must_change_password: false },
  });
  const meAfterClear = await json("/api/footfive/me", { token: tokPw });
  ok("flagged: self-clear of must_change_password rejected", meAfterClear.ok && meAfterClear.data.must_change_password === true, JSON.stringify(meAfterClear.data));

  const badChange = await json("/api/footfive/account/change-password", {
    method: "POST",
    token: tokPw,
    body: { currentPassword: "wrongpass99", newPassword: "realpass99" },
  });
  ok("flagged: change-password with wrong current rejected", !badChange.ok, `status=${badChange.status}`);
  const goodChange = await json("/api/footfive/account/change-password", {
    method: "POST",
    token: tokPw,
    body: { currentPassword: "temppass99", newPassword: "realpass99" },
  });
  ok("flagged: valid change-password allowed", goodChange.ok && goodChange.data.must_change_password === false, JSON.stringify(goodChange.data));
  // token may be rotated by the change; re-login with the new password
  const pwRelogin = await loginRetry(pwEmail, "realpass99");
  ok("re-login with new password", pwRelogin.ok, JSON.stringify(pwRelogin.data).slice(0, 120));
  const worldAfter = await json("/api/footfive/world", { token: pwRelogin.data.token });
  ok("after change: /world allowed", worldAfter.ok, `status=${worldAfter.status}`);

  // --- 4. Disabled user: existing token revoked, stays revoked after re-enable ---
  const dEmail = `sec_d_${stamp}@t.local`;
  await createUser(dEmail, "testpass99");
  const dAuth = await loginRetry(dEmail, "testpass99");
  const tokD = dAuth.data.token;
  const idD = dAuth.data.record.id;
  const worldBefore = await json("/api/footfive/world", { token: tokD });
  ok("pre-disable: /world works", worldBefore.ok, `status=${worldBefore.status}`);
  const disable = await json(`/api/footfive/admin/users/${idD}/disable`, {
    method: "POST",
    token: tokAdmin,
    body: { reason: "sec test" },
  });
  ok("admin disable", disable.ok && disable.data.disabled === true, JSON.stringify(disable.data));
  const worldDis = await json("/api/footfive/world", { token: tokD });
  ok("disabled: old token denied on custom route", worldDis.status === 401 || worldDis.status === 403, `status=${worldDis.status}`);
  const recDis = await json(`/api/collections/users/records/${idD}`, { token: tokD });
  // revoked token => guest; users viewRule hides the row (404) or PB rejects (401/403)
  ok("disabled: old token denied on native collection", recDis.status === 401 || recDis.status === 403 || recDis.status === 404, `status=${recDis.status}`);
  const refreshDis = await json("/api/collections/users/auth-refresh", { method: "POST", token: tokD });
  ok("disabled: old token denied on auth-refresh", refreshDis.status === 400 || refreshDis.status === 401 || refreshDis.status === 403, `status=${refreshDis.status}`);
  const freshDis = await loginNative(dEmail, "testpass99");
  ok("disabled: fresh login rejected", !freshDis.ok, `status=${freshDis.status}`);
  const enable = await json(`/api/footfive/admin/users/${idD}/enable`, {
    method: "POST",
    token: tokAdmin,
    body: { reason: "sec test" },
  });
  ok("admin re-enable", enable.ok && enable.data.disabled === false, JSON.stringify(enable.data));
  const worldRe = await json("/api/footfive/world", { token: tokD });
  ok("re-enabled: old token still invalid on custom route", worldRe.status === 401 || worldRe.status === 403, `status=${worldRe.status}`);
  const refreshRe = await json("/api/collections/users/auth-refresh", { method: "POST", token: tokD });
  ok("re-enabled: old token still invalid on auth-refresh", refreshRe.status === 400 || refreshRe.status === 401 || refreshRe.status === 403, `status=${refreshRe.status}`);
  const freshRe = await loginRetry(dEmail, "testpass99");
  ok("re-enabled: fresh login works", freshRe.ok, `status=${freshRe.status}`);

  // --- 5. Generic login errors (custom route) ---
  const g1 = await json("/api/footfive/auth/login", { method: "POST", body: { identity: `ghost_${stamp}@t.local`, password: "testpass99" } });
  const g2 = await json("/api/footfive/auth/login", { method: "POST", body: { identity: uEmail, password: "wrongpass99" } });
  // disable user U first so both disabled variants are covered
  await json(`/api/footfive/admin/users/${idU}/disable`, { method: "POST", token: tokAdmin, body: { reason: "sec test" } });
  const g3 = await json("/api/footfive/auth/login", { method: "POST", body: { identity: uEmail, password: "testpass99" } });
  const g4 = await json("/api/footfive/auth/login", { method: "POST", body: { identity: uEmail, password: "wrongpass99" } });
  const msgs = [g1, g2, g3, g4].map((r) => `${r.status}:${r.data.message}`);
  ok("custom login: nonexistent is generic 401", g1.status === 401, msgs[0]);
  ok("custom login: wrong password is generic 401", g2.status === 401, msgs[1]);
  ok("custom login: disabled+correct password is generic 401", g3.status === 401, msgs[2]);
  ok("custom login: disabled+wrong password is generic 401", g4.status === 401, msgs[3]);
  ok("custom login: identical error message", new Set([g1, g2, g3, g4].map((r) => r.data.message)).size === 1, msgs.join(" | "));
  ok("custom login: no 'disabled' leak", ![g1, g2, g3, g4].some((r) => /disabled/i.test(String(r.data.message))), msgs.join(" | "));

  // native route parity
  const n1 = await loginNative(`ghost_${stamp}@t.local`, "testpass99");
  const n2 = await loginNative(uEmail, "testpass99"); // disabled, correct password
  ok("native login: disabled+correct is generic failure", n1.status === 400 && n2.status === 400 && n1.data.message === n2.data.message, `${n1.status}:${n1.data.message} vs ${n2.status}:${n2.data.message}`);

  // --- 6. Real 429 throttling (LAST — exhausts the login buckets) ---
  // Limits are 120/min (migration 1750000015); ghost identities skip bcrypt so this is fast.
  let saw429 = false;
  for (let i = 0; i < 200 && !saw429; i++) {
    const r = await json("/api/footfive/auth/login", { method: "POST", body: { identity: `ghost_${stamp}@t.local`, password: "x" } });
    if (r.status === 429) saw429 = true;
  }
  ok("custom login route is throttled (429)", saw429);
  let saw429Native = false;
  for (let i = 0; i < 200 && !saw429Native; i++) {
    const r = await loginNative(`ghost_${stamp}@t.local`, "x");
    if (r.status === 429) saw429Native = true;
  }
  ok("native auth endpoint is throttled (429)", saw429Native);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
