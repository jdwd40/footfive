import { test, expect } from "@playwright/test";
import { apiLogin, PB, loginViaUi, expectNoHorizontalOverflow } from "./helpers";

test.describe("shared world", () => {
  test("two users see same tournament and fixtures", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const b = await apiLogin(request, "e2e_user_b@test.local", "testpass99");
    expect(a.ok && b.ok).toBe(true);

    const worldA = await request.get(`${PB}/api/footfive/world`, {
      headers: { Authorization: a.token },
    });
    const worldB = await request.get(`${PB}/api/footfive/world`, {
      headers: { Authorization: b.token },
    });
    expect(worldA.ok()).toBe(true);
    expect(worldB.ok()).toBe(true);
    const ja = await worldA.json();
    const jb = await worldB.json();
    expect(ja.tournament?.id || null).toEqual(jb.tournament?.id || null);
    expect(ja.tournament?.number || null).toEqual(jb.tournament?.number || null);

    const sbA = await request.get(`${PB}/api/footfive/scoreboard`, {
      headers: { Authorization: a.token },
    });
    const sbB = await request.get(`${PB}/api/footfive/scoreboard`, {
      headers: { Authorization: b.token },
    });
    const sa = await sbA.json();
    const sb = await sbB.json();
    const idsA = (sa.fixtures || []).map((f: { id: string }) => f.id).sort();
    const idsB = (sb.fixtures || []).map((f: { id: string }) => f.id).sort();
    expect(idsA).toEqual(idsB);
  });

  test("register does not create second tournament", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const before = await (
      await request.get(`${PB}/api/footfive/world`, {
        headers: { Authorization: a.token },
      })
    ).json();

    const email = `e2e_extra_${Date.now()}@test.local`;
    await request.post(`${PB}/api/collections/users/records`, {
      data: {
        email,
        password: "testpass99",
        passwordConfirm: "testpass99",
        display_name: "Extra",
      },
    });
    const afterAuth = await apiLogin(request, email, "testpass99");
    const after = await (
      await request.get(`${PB}/api/footfive/world`, {
        headers: { Authorization: afterAuth.token },
      })
    ).json();
    expect(after.tournament?.id || null).toEqual(before.tournament?.id || null);
  });

  test("claim conflict and single team", async ({ request }) => {
    const a = await apiLogin(request, "e2e_user_a@test.local", "testpass99");
    const b = await apiLogin(request, "e2e_user_b@test.local", "testpass99");
    const admin = await apiLogin(request, "e2e_admin@test.local", "adminpass99");
    // release any prior claims for isolation across projects
    if (admin.ok) {
      const teamsRes0 = await request.get(`${PB}/api/footfive/teams`, {
        headers: { Authorization: a.token },
      });
      const all = (await teamsRes0.json()).teams || [];
      for (const t of all) {
        if (t.managerId || t.manager) {
          await request.post(`${PB}/api/footfive/admin/teams/${t.id}/release`, {
            headers: { Authorization: admin.token },
            data: { reason: "e2e reset" },
          });
        }
      }
    }
    const teamsRes = await request.get(`${PB}/api/footfive/teams`, {
      headers: { Authorization: a.token },
    });
    const teams = (await teamsRes.json()).teams || [];
    const free = teams.filter(
      (t: { managerId?: string; manager?: string }) => !t.managerId && !t.manager,
    );
    if (free.length < 2) {
      test.skip(true, "need free teams");
      return;
    }
    const t1 = free[0].id;
    const t2 = free[1].id;
    const c1 = await request.post(`${PB}/api/footfive/teams/${t1}/claim`, {
      headers: { Authorization: a.token },
    });
    expect(c1.ok()).toBe(true);
    const conflict = await request.post(`${PB}/api/footfive/teams/${t1}/claim`, {
      headers: { Authorization: b.token },
    });
    expect(conflict.ok()).toBe(false);
    const c2 = await request.post(`${PB}/api/footfive/teams/${t2}/claim`, {
      headers: { Authorization: b.token },
    });
    expect(c2.ok()).toBe(true);
    // A cannot claim second team
    const teams2 = (
      await (
        await request.get(`${PB}/api/footfive/teams`, {
          headers: { Authorization: a.token },
        })
      ).json()
    ).teams;
    const free2 = teams2.find(
      (t: { id: string; managerId?: string; manager?: string }) =>
        t.id !== t1 && t.id !== t2 && !t.managerId && !t.manager,
    );
    if (free2) {
      const double = await request.post(`${PB}/api/footfive/teams/${free2.id}/claim`, {
        headers: { Authorization: a.token },
      });
      expect(double.ok()).toBe(false);
    }
  });

  test("scoreboard UI no overflow", async ({ page }) => {
    await loginViaUi(page, "e2e_user_a@test.local", "testpass99");
    await page.goto("/scoreboard");
    await page.waitForTimeout(1500);
    await expectNoHorizontalOverflow(page);
  });
});
