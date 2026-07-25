import { test, expect } from "@playwright/test";
import { apiLogin, PB } from "./helpers";

// Prefer request fixture (works even if some UI projects skip)
test.describe("security negative", () => {
  test("user cannot set own role via API", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    expect(a.ok).toBe(true);
    const id = a.record.id;
    const res = await request.patch(`${PB}/api/collections/users/records/${id}`, {
      headers: { Authorization: a.token },
      data: { role: "admin" },
    });
    // either rejected or role ignored
    if (res.ok()) {
      const body = await res.json();
      expect(body.role).not.toBe("admin");
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400);
    }
  });

  test("user cannot set credits", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const id = a.record.id;
    const before = Number(a.record.credits ?? 0);
    const res = await request.patch(`${PB}/api/collections/users/records/${id}`, {
      headers: { Authorization: a.token },
      data: { credits: 999999 },
    });
    // re-auth / re-fetch
    const again = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const after = Number(again.record.credits ?? 0);
    expect(after).not.toBe(999999);
    expect(after).toBe(before);
    // patch may appear ok but value must not stick
    void res;
  });

  test("user cannot mutate match_states", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const list = await request.get(
      `${PB}/api/collections/match_states/records?perPage=1`,
      { headers: { Authorization: a.token } },
    );
    if (!list.ok()) {
      expect([401, 403, 404]).toContain(list.status());
      return;
    }
    const items = (await list.json()).items || [];
    if (!items.length) return;
    const res = await request.patch(
      `${PB}/api/collections/match_states/records/${items[0].id}`,
      {
        headers: { Authorization: a.token },
        data: { score_home: 99 },
      },
    );
    expect(res.ok()).toBe(false);
  });

  test("user cannot call admin overview", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const res = await request.get(`${PB}/api/footfive/admin/overview`, {
      headers: { Authorization: a.token },
    });
    expect(res.ok()).toBe(false);
  });

  test("user cannot run retention", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const res = await request.post(`${PB}/api/footfive/admin/retention/run`, {
      headers: { Authorization: a.token },
    });
    expect(res.ok()).toBe(false);
  });

  test("user cannot run backfill", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const res = await request.post(`${PB}/api/footfive/admin/backfill/run`, {
      headers: { Authorization: a.token },
    });
    expect(res.ok()).toBe(false);
  });

  test("user cannot read another user bets collection freely", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const b = await apiLogin(request, "e2e_user_b@test.local", "testpass99");
    // list shared_bets — rule should scope to own
    const res = await request.get(`${PB}/api/collections/shared_bets/records`, {
      headers: { Authorization: a.token },
    });
    if (res.ok()) {
      const items = (await res.json()).items || [];
      for (const it of items) {
        expect(it.user).toBe(a.record.id);
        expect(it.user).not.toBe(b.record.id);
      }
    }
  });

  test("admin password reset works", async ({ request }) => {
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    if (!admin.ok) {
      test.skip(true, "admin not promoted");
      return;
    }
    // create temp user
    const email = `e2e_pw_${Date.now()}@test.local`;
    const created = await request.post(`${PB}/api/footfive/admin/users`, {
      headers: { Authorization: admin.token },
      data: {
        email,
        password: "oldpass99",
        display_name: "PwReset",
        reason: "e2e",
      },
    });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    const reset = await request.post(`${PB}/api/footfive/admin/users/${id}/password`, {
      headers: { Authorization: admin.token },
      data: {
        password: "newpass99",
        mustChange: true,
        reason: "e2e reset",
      },
    });
    expect(reset.ok()).toBe(true);
    const body = await reset.json();
    expect(body.password).toBeUndefined();
    const oldLogin = await apiLogin(request, email, "oldpass99");
    expect(oldLogin.ok).toBe(false);
    const newLogin = await apiLogin(request, email, "newpass99");
    expect(newLogin.ok).toBe(true);
  });

  test("admin retention preview does not delete", async ({ request }) => {
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    if (!admin.ok) {
      test.skip(true, "admin not promoted");
      return;
    }
    const res = await request.post(`${PB}/api/footfive/admin/retention/preview`, {
      headers: { Authorization: admin.token },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.preview).toBe(true);
    expect(body.deleted).toBe(0);
  });

  test("admin never retention skips delete", async ({ request }) => {
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    if (!admin.ok) {
      test.skip(true, "admin not promoted");
      return;
    }
    await request.patch(`${PB}/api/footfive/admin/world/settings`, {
      headers: { Authorization: admin.token },
      data: { retention_days: 0, reason: "e2e never" },
    });
    const res = await request.post(`${PB}/api/footfive/admin/retention/run`, {
      headers: { Authorization: admin.token },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.deleted).toBe(0);
    await request.patch(`${PB}/api/footfive/admin/world/settings`, {
      headers: { Authorization: admin.token },
      data: { retention_days: 30, reason: "e2e restore" },
    });
  });

  test("backfill preview is safe", async ({ request }) => {
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    if (!admin.ok) {
      test.skip(true, "admin not promoted");
      return;
    }
    const res = await request.post(`${PB}/api/footfive/admin/backfill/preview`, {
      headers: { Authorization: admin.token },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.preview).toBe(true);
  });
});
