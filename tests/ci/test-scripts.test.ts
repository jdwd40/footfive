// @vitest-environment node
// Issue #31 (review B20/B21): the package test scripts point at real tests, and
// `test:integration` runs the real API suites against a disposable PocketBase
// instead of asking Vitest to collect standalone .mjs programs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<string, string>;

describe("package test scripts", () => {
  it("every path a vitest script names exists", () => {
    for (const name of ["test", "test:unit", "test:security"]) {
      const args = scripts[name].split(/\s+/).slice(2).filter((a) => !a.startsWith("-"));
      for (const arg of args) expect(existsSync(path.join(root, arg)), `${name}: ${arg}`).toBe(true);
    }
  });

  it("test:security runs behaviour tests, not source greps", () => {
    expect(scripts["test:security"]).toMatch(/collectionGuards\.test\.ts/);
    expect(existsSync(path.join(root, "src/domain/security.test.ts"))).toBe(false);
  });

  it("test:integration is the disposable API-only runner", () => {
    expect(scripts["test:integration"]).toBe("bash scripts/e2e-run.sh --api-only");
    // Nothing in tests/integration is a Vitest file: they are standalone programs.
    const files = readdirSync(path.join(root, "tests/integration"));
    expect(files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))).toEqual([]);
  });

  it("--api-only refuses to reset the test database while its port is in use", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    const data = path.join(root, "pocketbase/pb_data_test");
    const before = existsSync(data) ? readdirSync(data).sort() : null;
    try {
      const run = spawnSync("bash", [path.join(root, "scripts/e2e-run.sh"), "--api-only"], {
        env: { ...process.env, E2E_PB_PORT: String(port) },
        encoding: "utf8",
        timeout: 30_000,
      });
      if (!existsSync(path.join(root, "pocketbase/pocketbase"))) {
        expect(run.stdout).toMatch(/Missing pocketbase binary/);
      } else {
        expect(run.stdout).toMatch(new RegExp(`Port ${port} is already in use`));
      }
      expect(run.status).toBe(1);
      expect(existsSync(data) ? readdirSync(data).sort() : null).toEqual(before);
    } finally {
      server.close();
    }
  });
});
