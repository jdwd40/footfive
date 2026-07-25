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

  it("user update strips role and credits for non-admin", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const main = fs.readFileSync(
      path.resolve(__dirname, "../../pocketbase/pb_hooks/main.pb.js"),
      "utf8",
    );
    expect(main).toContain('e.record.set("credits"');
    expect(main).toContain("disabled");
    expect(main).toContain("onRecordAuthRequest");
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
