import { describe, expect, it } from "vitest";

/**
 * Static security contract tests — documents required protections.
 * Runtime negative tests live in e2e/security.spec.ts.
 */
describe("security contracts", () => {
  it("admin routes require role check pattern", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const main = fs.readFileSync(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/main.pb.js"),
      "utf8",
    );
    expect(main).toContain("requireAdmin");
    expect(main).toContain("/api/footfive/admin/");
    expect(main).toContain("password");
    expect(main).toContain("backfill");
    expect(main).toContain("recovery");
  });

  it("users native create/update reject protected fields for all application users", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const main = fs.readFileSync(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/main.pb.js"),
      "utf8",
    );
    // issue #14 fix wave (review F1/F2): hard rejection at the native boundary,
    // trusted PocketBase superuser excepted; no silent field pinning.
    expect(main).toContain("hasSuperuserAuth");
    expect(main).toContain("is server-owned");
    expect(main).toContain('"must_change_password"');
    expect(main).toContain("onRecordAuthRequest");
    expect(main).toContain("routerUse");
  });

  it("match_states client writes forbidden", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const main = fs.readFileSync(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/main.pb.js"),
      "utf8",
    );
    expect(main).toMatch(/match_states[\s\S]*ForbiddenError/);
  });
});
