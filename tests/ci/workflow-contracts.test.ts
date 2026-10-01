import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deploy = readFileSync(
  path.join(root, ".github/workflows/deploy.yml"),
  "utf8",
);
const ci = readFileSync(
  path.join(root, ".github/workflows/footfive-ci.yml"),
  "utf8",
);
const lock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
) as { packages: Record<string, { version: string }> };

describe("deploy.yml contracts", () => {
  it("pins host identity via VPS_KNOWN_HOSTS, never runtime ssh-keyscan", () => {
    expect(deploy).toContain("secrets.VPS_KNOWN_HOSTS");
    expect(deploy).toContain('Missing secret VPS_KNOWN_HOSTS');
    // no actual ssh-keyscan invocation (comments may mention it)
    expect(deploy).not.toMatch(/^\s*ssh-keyscan\s/m);
    expect(deploy).not.toMatch(/ssh-keyscan\s+-/);
    expect(deploy).toContain("StrictHostKeyChecking=yes");
  });

  it("backs up to root-only /var/backups/footfive via scoped sudo -n, fail-loud", () => {
    expect(deploy).toContain(
      "sudo -n install -d -m 700 -o root -g root /var/backups/footfive/",
    );
    // No suppressed backup failures: backups must not use `|| true`
    const backupLines = deploy
      .split("\n")
      .filter((l) => l.includes("/var/backups/footfive/"));
    for (const line of backupLines) {
      expect(line).not.toContain("|| true");
      expect(line).not.toContain("2>/dev/null");
      if (line.includes("cp -a")) {
        expect(line).toContain("sudo -n cp -a");
      }
    }
    // jd must not try to mkdir inside the root-only backup tree directly
    const mkdirLines = deploy
      .split("\n")
      .filter((l) => l.includes("mkdir") && l.includes("/var/backups"));
    for (const line of mkdirLines) {
      expect(line).toContain("sudo -n");
    }
  });

  it("records deployed SHA marker after health verification", () => {
    expect(deploy).toContain("DEPLOYED_SHA");
    expect(deploy).toContain("${GITHUB_SHA}");
    const healthIdx = deploy.indexOf("/api/footfive/health");
    const shaIdx = deploy.indexOf("echo ${GITHUB_SHA} > /home/jd/footfive/DEPLOYED_SHA");
    expect(healthIdx).toBeGreaterThan(-1);
    expect(shaIdx).toBeGreaterThan(healthIdx);
  });

  it("health checks are captured unpiped under remote set -eu (curl failure cannot be masked)", () => {
    // Regression: `curl -sf ... | cut` exits 0 via cut even when curl fails,
    // letting DEPLOYED_SHA be written for an unhealthy deploy.
    expect(deploy).not.toContain("| cut");
    const healthLines = deploy
      .split("\n")
      .filter((l) => l.includes("curl") && l.includes("/api/"));
    expect(healthLines.length).toBeGreaterThan(0);
    for (const line of healthLines) {
      expect(line).not.toMatch(/curl[^\n]*\|\s*(cut|head|tail|jq|sed|grep)\b/);
      // smoke-test captures are fine; bare piped curl is not
      expect(line).not.toMatch(/curl[^\n)]*\|/);
    }
    // remote restart-health command must fail loudly before the SHA marker
    const restartLine = healthLines.find((l) =>
      l.includes("footfive-pocketbase.service"),
    );
    expect(restartLine).toBeDefined();
    expect(restartLine).toContain("set -eu");
    expect(restartLine).toContain("pb_health=\\$(curl -sf");
    expect(restartLine).toContain("ff_health=\\$(curl -sf");
  });

  it("avoids SIGPIPE-prone head pipes under pipefail", () => {
    expect(deploy).not.toContain("| head");
  });

  it("both health gates semantically validate app health via the shared validator", () => {
    // Regression (Sol P1): HTTP-200 degraded / missing-world / malformed app
    // health previously passed both gates and DEPLOYED_SHA was still written.
    const uses = (deploy.match(/node scripts\/validate-health\.mjs/g) || [])
      .length;
    expect(uses).toBeGreaterThanOrEqual(2); // remote gate + public smoke
    // remote gate: extracted delimited body is piped into the validator
    expect(deploy).toContain(
      'printf \'%s\' "$ff_body" | node scripts/validate-health.mjs',
    );
    // public smoke: captured health body is piped into the validator
    expect(deploy).toContain(
      'printf \'%s\' "$health" | node scripts/validate-health.mjs',
    );
    // markers are written strictly after the validated-healthy remote gate
    const validateIdx = deploy.indexOf(
      'printf \'%s\' "$ff_body" | node scripts/validate-health.mjs',
    );
    const stampIdx = deploy.indexOf(
      "echo ${STAMP} > /home/jd/footfive/DEPLOYED_STAMP",
    );
    const shaIdx = deploy.indexOf(
      "echo ${GITHUB_SHA} > /home/jd/footfive/DEPLOYED_SHA",
    );
    expect(validateIdx).toBeGreaterThan(-1);
    expect(stampIdx).toBeGreaterThan(validateIdx);
    expect(shaIdx).toBeGreaterThan(validateIdx);
    // transport failure propagation retained: curl -sf under remote set -eu
    expect(deploy).toContain("ff_health=\\$(curl -sf");
    // the validator script exists in the checkout the deploy job uses
    expect(deploy).toContain("uses: actions/checkout@v4");
  });

  it("never touches pb_data or the PocketBase binary", () => {
    const remoteCmds = deploy
      .split("\n")
      .filter((l) => l.includes('"${SSH[@]}"'));
    for (const line of remoteCmds) {
      expect(line).not.toMatch(/pb_data/);
      expect(line).not.toMatch(/pocketbase\/pocketbase/);
    }
  });

  it("declares minimal permissions and job timeouts", () => {
    expect(deploy).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(deploy).toContain("timeout-minutes:");
  });
});

describe("footfive-ci.yml contracts", () => {
  it("lint is a hard gate (no || true on gate steps)", () => {
    expect(ci).not.toContain("npm run lint || true");
    expect(ci).not.toContain("npm run test || true");
    expect(ci).not.toContain("npm run typecheck || true");
    const lintLines = ci.split("\n").filter((l) => l.includes("npm run lint"));
    expect(lintLines).toHaveLength(1);
  });

  it("Playwright job uses stock ubuntu + matching browser install, no stale container", () => {
    expect(ci).not.toContain("mcr.microsoft.com/playwright");
    expect(ci).not.toContain("container:");
    expect(ci).toContain("npx playwright install --with-deps chromium");
  });

  it("no pinned browser version that mismatches package-lock", () => {
    const locked = lock.packages["node_modules/@playwright/test"].version;
    const mentioned = [...ci.matchAll(/playwright:v(\d+\.\d+\.\d+)/g)].map(
      (m) => m[1],
    );
    for (const v of mentioned) {
      expect(v).toBe(locked);
    }
  });

  it("declares minimal permissions and job timeouts", () => {
    expect(ci).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    const jobCount = (ci.match(/^  [a-z-]+:\n    name:/gm) || []).length;
    const timeoutCount = (ci.match(/timeout-minutes:/g) || []).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(jobCount);
  });
});
