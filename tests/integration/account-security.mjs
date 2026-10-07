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

  // --- 1. Direct writes to protected fields (create) — explicit rejection (F1) ---
  const evilEmail = `sec_evil_${stamp}@t.local`;
  const evilCreated = await createUser(evilEmail, "testpass99", {
    role: "admin",
    disabled: true,
    must_change_password: true,
  });
  ok("create with protected fields rejected", !evilCreated.ok, `status=${evilCreated.status} ${JSON.stringify(evilCreated.data).slice(0, 120)}`);
  const evilLogin = await loginNative(evilEmail, "testpass99");
  ok("rejected create did not persist a user", !evilLogin.ok, `status=${evilLogin.status}`);
  // Ordinary signup (no protected keys) must keep working
  const ordinaryEmail = `sec_ok_${stamp}@t.local`;
  const ordinary = await createUser(ordinaryEmail, "testpass99");
  ok("ordinary signup still works", ordinary.ok, JSON.stringify(ordinary.data).slice(0, 120));
  const ordinaryLogin = await loginRetry(ordinaryEmail, "testpass99");
  ok("ordinary user can log in", ordinaryLogin.ok && ordinaryLogin.data.record.role !== "admin", JSON.stringify(ordinaryLogin.data).slice(0, 120));

  // --- 2. Direct writes to protected fields (update) — explicit rejection (F1) ---
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
  ok("update: role escalation rejected", !rolePatch.ok, `status=${rolePatch.status}`);
  const meAfterRole = await json("/api/footfive/me", { token: tokU });
  ok("update: role still user after attempt", meAfterRole.ok && meAfterRole.data.role !== "admin", JSON.stringify(meAfterRole.data));
  const disPatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { disabled: true },
  });
  ok("update: disabled self-set rejected", !disPatch.ok, `status=${disPatch.status}`);
  const meAfterDis = await json("/api/footfive/me", { token: tokU });
  ok("update: disabled still false after attempt", meAfterDis.ok && meAfterDis.data.disabled === false, JSON.stringify(meAfterDis.data));
  // Unchanged-but-present protected field in the payload is still an attempt
  const unchangedPatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { display_name: "SecSneaky", role: "user" },
  });
  ok("update: unchanged protected field payload rejected", !unchangedPatch.ok, `status=${unchangedPatch.status}`);
  // Legit profile change (ordinary fields only) must keep working
  const profPatch = await json(`/api/collections/users/records/${idU}`, {
    method: "PATCH",
    token: tokU,
    body: { display_name: "SecRenamed" },
  });
  ok("update: legit profile field still works", profPatch.ok && profPatch.data.display_name === "SecRenamed", JSON.stringify(profPatch.data).slice(0, 120));
  ok("update: role untouched by legit edit", profPatch.ok && profPatch.data.role !== "admin", String(profPatch.data.role));

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

  // self-clear attempt must be rejected outright (F1)
  const selfClear = await json(`/api/collections/users/records/${idPw}`, {
    method: "PATCH",
    token: tokPw,
    body: { must_change_password: false },
  });
  ok("flagged: native self-clear of must_change_password rejected", !selfClear.ok, `status=${selfClear.status}`);
  const meAfterClear = await json("/api/footfive/me", { token: tokPw });
  ok("flagged: must_change_password still true after attempt", meAfterClear.ok && meAfterClear.data.must_change_password === true, JSON.stringify(meAfterClear.data));

  // --- 3b. Forced-password native boundaries (F2) ---
  // Native business collection list must return no data (rule excludes the
  // forced-password auth record) or reject outright.
  const nativeTeams = await json("/api/collections/proball_teams/records?perPage=5", { token: tokPw });
  const teamsLeak = nativeTeams.ok && Array.isArray(nativeTeams.data.items) && nativeTeams.data.items.length > 0;
  ok("flagged: native proball_teams list returns no data", !teamsLeak, `status=${nativeTeams.status} items=${nativeTeams.data?.items?.length}`);
  const nativeWorld = await json("/api/collections/world/records?perPage=5", { token: tokPw });
  const worldLeak = nativeWorld.ok && Array.isArray(nativeWorld.data.items) && nativeWorld.data.items.length > 0;
  ok("flagged: native world list returns no data", !worldLeak, `status=${nativeWorld.status} items=${nativeWorld.data?.items?.length}`);
  // Native self profile mutation is rejected while forced
  const forcedProfile = await json(`/api/collections/users/records/${idPw}`, {
    method: "PATCH",
    token: tokPw,
    body: { display_name: "forced-profile-mutated" },
  });
  ok("flagged: native profile mutation rejected", !forcedProfile.ok, `status=${forcedProfile.status}`);
  const meProfile = await json("/api/footfive/me", { token: tokPw });
  ok("flagged: display_name unchanged after native attempt", meProfile.ok && meProfile.data.display_name !== "forced-profile-mutated", JSON.stringify(meProfile.data.display_name));
  // Native password update bypass is rejected while forced
  const forcedPw = await json(`/api/collections/users/records/${idPw}`, {
    method: "PATCH",
    token: tokPw,
    body: { oldPassword: "temppass99", password: "nativepass99", passwordConfirm: "nativepass99" },
  });
  ok("flagged: native password update rejected", !forcedPw.ok, `status=${forcedPw.status}`);
  const nativePwLogin = await loginNative(pwEmail, "nativepass99");
  ok("flagged: native password bypass did not stick", !nativePwLogin.ok, `status=${nativePwLogin.status}`);
  const tempStill = await loginRetry(pwEmail, "temppass99");
  ok("flagged: temporary password still valid after rejected bypass", tempStill.ok, `status=${tempStill.status}`);

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

  // --- 3c. Application admins are NOT exempt at the native boundary (F1) ---
  const idAdmin = adminAuth.data.record.id;
  const adminDis = await json(`/api/collections/users/records/${idAdmin}`, {
    method: "PATCH",
    token: tokAdmin,
    body: { disabled: true },
  });
  ok("admin: native self-disable rejected", !adminDis.ok, `status=${adminDis.status}`);
  const adminOverview1 = await json("/api/footfive/admin/overview", { token: tokAdmin });
  ok("admin: still active after rejected self-disable", adminOverview1.ok, `status=${adminOverview1.status}`);
  const adminEn = await json(`/api/collections/users/records/${idAdmin}`, {
    method: "PATCH",
    token: tokAdmin,
    body: { disabled: false },
  });
  ok("admin: native self-enable rejected", !adminEn.ok, `status=${adminEn.status}`);
  const adminRoleSame = await json(`/api/collections/users/records/${idAdmin}`, {
    method: "PATCH",
    token: tokAdmin,
    body: { role: "admin" },
  });
  ok("admin: unchanged role payload rejected", !adminRoleSame.ok, `status=${adminRoleSame.status}`);
  // forced-password admin cannot self-clear natively nor use admin routes
  const adminReset = await json(`/api/footfive/admin/users/${idAdmin}/password`, {
    method: "POST",
    token: tokAdmin,
    body: { password: "admintemp99", mustChange: true, reason: "F1 admin guard" },
  });
  ok("admin: forced-password reset applied", adminReset.ok && adminReset.data.must_change_password === true, JSON.stringify(adminReset.data));
  const adminForced = await loginRetry("e2e_admin@test.local", "admintemp99");
  ok("admin: temp password login works", adminForced.ok, `status=${adminForced.status}`);
  const tokAf = adminForced.data.token;
  const adminClear = await json(`/api/collections/users/records/${idAdmin}`, {
    method: "PATCH",
    token: tokAf,
    body: { must_change_password: false, role: "admin", disabled: false },
  });
  ok("admin: forced self-clear rejected", !adminClear.ok, `status=${adminClear.status}`);
  const overviewForced = await json("/api/footfive/admin/overview", { token: tokAf });
  ok("admin: forced-password admin denied on admin routes", overviewForced.status === 403 || overviewForced.status === 401, `status=${overviewForced.status}`);
  const adminNativeTeams = await json("/api/collections/proball_teams/records?perPage=5", { token: tokAf });
  const adminTeamsLeak = adminNativeTeams.ok && Array.isArray(adminNativeTeams.data.items) && adminNativeTeams.data.items.length > 0;
  ok("admin: forced-password admin native teams list empty", !adminTeamsLeak, `status=${adminNativeTeams.status}`);
  // complete the required change; this also restores the seeded admin password
  const adminChange = await json("/api/footfive/account/change-password", {
    method: "POST",
    token: tokAf,
    body: { currentPassword: "admintemp99", newPassword: "adminpass99" },
  });
  ok("admin: forced change-password completes", adminChange.ok && adminChange.data.must_change_password === false, JSON.stringify(adminChange.data));
  const adminBack = await loginRetry("e2e_admin@test.local", "adminpass99");
  ok("admin: restored login works", adminBack.ok, `status=${adminBack.status}`);
  const overviewBack = await json("/api/footfive/admin/overview", { token: adminBack.data.token });
  ok("admin: overview 200 after restore", overviewBack.ok, `status=${overviewBack.status}`);
  // The 3c reset rotated the admin tokenKey (fail-closed revocation), so the
  // original tokAdmin is dead by design; sections below use the fresh token.
  const tokAdminLive = adminBack.data.token;

  // --- 3d. Trusted PocketBase superuser exception (F1, intentional) ---
  const sup = await json("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: { identity: "e2e-super@test.local", password: "e2esuper99" },
  });
  if (sup.ok) {
    const supEmail = `sec_sup_${stamp}@t.local`;
    await createUser(supEmail, "testpass99");
    const supTarget = await loginRetry(supEmail, "testpass99");
    const supPatch = await json(`/api/collections/users/records/${supTarget.data.record.id}`, {
      method: "PATCH",
      token: sup.data.token,
      body: { role: "admin" },
    });
    ok("superuser: role change allowed (trusted exception)", supPatch.ok && supPatch.data.role === "admin", JSON.stringify(supPatch.data).slice(0, 120));
    // revert to plain user so no stray admin remains
    await json(`/api/collections/users/records/${supTarget.data.record.id}`, {
      method: "PATCH",
      token: sup.data.token,
      body: { role: "user" },
    });
  } else {
    console.log("  … superuser not seeded; exception case skipped");
  }

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
    token: tokAdminLive,
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
  // Disabled accounts get no exception routes either (F3): /me and
  // change-password must reject just like business routes.
  const meDis = await json("/api/footfive/me", { token: tokD });
  ok("disabled: old token denied on /me exception", meDis.status === 401 || meDis.status === 403, `status=${meDis.status}`);
  const cpDis = await json("/api/footfive/account/change-password", {
    method: "POST",
    token: tokD,
    body: { currentPassword: "testpass99", newPassword: "whatever99" },
  });
  ok("disabled: old token denied on change-password exception", cpDis.status === 401 || cpDis.status === 403, `status=${cpDis.status}`);
  const nativeTeamsDis = await json("/api/collections/proball_teams/records?perPage=5", { token: tokD });
  const disTeamsLeak = nativeTeamsDis.ok && Array.isArray(nativeTeamsDis.data.items) && nativeTeamsDis.data.items.length > 0;
  ok("disabled: native teams list returns no data", !disTeamsLeak, `status=${nativeTeamsDis.status} items=${nativeTeamsDis.data?.items?.length}`);
  const freshDis = await loginNative(dEmail, "testpass99");
  ok("disabled: fresh login rejected", !freshDis.ok, `status=${freshDis.status}`);
  const enable = await json(`/api/footfive/admin/users/${idD}/enable`, {
    method: "POST",
    token: tokAdminLive,
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
  await json(`/api/footfive/admin/users/${idU}/disable`, { method: "POST", token: tokAdminLive, body: { reason: "sec test" } });
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
