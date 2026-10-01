import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppHealth } from "../../scripts/validate-health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const validator = path.join(root, "scripts/validate-health.mjs");
const deploy = readFileSync(
  path.join(root, ".github/workflows/deploy.yml"),
  "utf8",
);

const healthyBody = JSON.stringify({
  status: "ok",
  app: "footfive",
  serverTime: "2026-10-01T12:00:00.000Z",
  serverTimeMs: 1793572800000,
  worldAvailable: true,
  tournament: { number: 3, round: 2, status: "active" },
});
// healthService.js: storage failure -> status "degraded", worldAvailable false
const degradedBody = JSON.stringify({
  status: "degraded",
  app: "footfive",
  serverTime: "2026-10-01T12:00:00.000Z",
  serverTimeMs: 1793572800000,
  worldAvailable: false,
  tournament: null,
});
// healthService.js: missing world row -> status "ok", worldAvailable false
const missingWorldBody = JSON.stringify({
  status: "ok",
  app: "footfive",
  serverTime: "2026-10-01T12:00:00.000Z",
  serverTimeMs: 1793572800000,
  worldAvailable: false,
  tournament: null,
});

function runValidator(input: string) {
  return spawnSync(process.execPath, [validator], { input, encoding: "utf8" });
}

describe("validateAppHealth semantics", () => {
  it("accepts a healthy app body (status ok, worldAvailable true)", () => {
    expect(validateAppHealth(healthyBody).ok).toBe(true);
  });

  it("rejects a degraded body (world storage lookup failed)", () => {
    const r = validateAppHealth(degradedBody);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("status");
  });

  it("rejects a missing-world body even when status is ok", () => {
    const r = validateAppHealth(missingWorldBody);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("worldAvailable");
  });

  it("rejects malformed JSON", () => {
    for (const bad of ["{not json", '{"status":"ok"', "ok", "<html>502</html>"]) {
      expect(validateAppHealth(bad).ok).toBe(false);
    }
  });

  it("rejects empty / whitespace-only bodies", () => {
    for (const bad of ["", "   ", "\n\n"]) {
      expect(validateAppHealth(bad).ok).toBe(false);
    }
  });

  it("rejects JSON that is not an object", () => {
    for (const bad of ['"ok"', "null", "[]", "200", "true"]) {
      expect(validateAppHealth(bad).ok).toBe(false);
    }
  });

  it("rejects truthy-but-not-strictly-true worldAvailable", () => {
    for (const v of [1, "yes", "true"]) {
      const body = JSON.stringify({ status: "ok", worldAvailable: v });
      expect(validateAppHealth(body).ok).toBe(false);
    }
  });
});

describe("validate-health.mjs CLI exit codes", () => {
  it("exits 0 for a healthy body", () => {
    const r = runValidator(healthyBody);
    expect(r.status).toBe(0);
  });

  it("exits 1 for degraded, missing-world, malformed, and empty bodies", () => {
    for (const bad of [degradedBody, missingWorldBody, "{oops", ""]) {
      const r = runValidator(bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("app health gate FAILED");
    }
  });
});

describe("remote health-body extraction from deploy.yml", () => {
  const awkMatch = deploy.match(/awk '([^']+)'/);
  const awkProgram = awkMatch?.[1] ?? "";

  function extract(remoteStdout: string): string {
    expect(awkProgram).toContain("FF_HEALTH_BEGIN");
    const r = spawnSync("awk", [awkProgram], {
      input: remoteStdout,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    return r.stdout;
  }

  function remoteOutput(appBody: string): string {
    return [
      '{"code":200,"message":"API is healthy."}',
      "FF_HEALTH_BEGIN",
      appBody,
      "FF_HEALTH_END",
      "",
    ].join("\n");
  }

  it("extracts the delimited app health body from remote output", () => {
    expect(extract(remoteOutput(healthyBody))).toBe(healthyBody + "\n");
  });

  it("extracted healthy body passes the gate", () => {
    const r = runValidator(extract(remoteOutput(healthyBody)));
    expect(r.status).toBe(0);
  });

  it("extracted degraded body fails the gate (full remote-path behavior)", () => {
    const r = runValidator(extract(remoteOutput(degradedBody)));
    expect(r.status).toBe(1);
  });

  it("missing delimiters yield an empty body that fails the gate", () => {
    const extracted = extract('{"code":200,"message":"API is healthy."}\n');
    expect(extracted.trim()).toBe("");
    expect(runValidator(extracted).status).toBe(1);
  });
});
