import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
const SNAPSHOT =
  '          "${SSH[@]}" "sudo -n python3 -I - /home/jd/footfive/pb_data /var/backups/footfive/${STAMP}/pb_data" < scripts/pb-data-backup.py';
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

  it("records the exact tested SHA marker after health verification", () => {
    expect(deploy).toContain("DEPLOYED_SHA");
    expect(deploy).toContain("DEPLOY_SHA: ${{ needs.gate.outputs.sha }}");
    const healthIdx = deploy.indexOf("/api/footfive/health");
    const shaIdx = deploy.indexOf("echo ${DEPLOY_SHA} > /home/jd/footfive/DEPLOYED_SHA");
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
      "echo ${DEPLOY_SHA} > /home/jd/footfive/DEPLOYED_SHA",
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
      // pb_data is only ever the read-only source of the verified snapshot.
      if (line !== SNAPSHOT) expect(line).not.toMatch(/pb_data/);
      expect(line).not.toMatch(/pocketbase\/pocketbase/);
    }
  });

  it("takes a verified pb_data snapshot from the tested checkout before any production change", () => {
    const lines = deploy.split("\n").map((l) => l.trim());
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const snapshot = lines.indexOf(SNAPSHOT.trim());
    expect(snapshot).toBeGreaterThan(at("sudo -n install -d -m 700 -o root -g root /var/backups/footfive/${STAMP}"));
    for (const change of [
      "mkdir -p /home/jd/footfive/releases", "tar -C dist", "ln -sfn", "rsync -a --delete",
      "rm -rf /home/jd/footfive/pocketbase/pb_hooks", "tar -C scripts", "systemctl restart", "DEPLOYED_SHA",
    ]) {
      expect(at(change), change).toBeGreaterThan(snapshot);
    }
    // The deploy step runs under set -euo pipefail, so a failed snapshot aborts it.
    expect(job(deploy, "deploy")).toMatch(/run: \|\n\s+set -euo pipefail\n\s+test -n "\$\{VPS_USER/);
    expect(deploy).not.toContain("/home/jd/footfive/scripts/pb-data-backup.py\"");
  });

  it("delivers migrations before the hooks that need them (hook changes reload the service)", () => {
    const lines = deploy.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.trim().startsWith(needle));
    const migrations = at("tar -C pocketbase/pb_migrations -czf - .");
    const hooks = at("tar -C pocketbase/pb_hooks -czf - .");
    expect(migrations).toBeGreaterThan(-1);
    expect(hooks).toBeGreaterThan(migrations);
    expect(lines.filter((l) => l.includes("tar -C pocketbase/pb_hooks"))).toHaveLength(1);
  });

  it("delivers the daily backup scripts from the tested checkout, helper first, after the backups", () => {
    const lines = deploy.split("\n");
    const delivery = lines.find((l) => l.includes("tar -C scripts -czf - footfive-backup.sh pb-data-backup.py"));
    expect(delivery).toBeDefined();
    expect(delivery).toContain('s=$(mktemp -d "$d/.stage.XXXXXX")');
    const helper = delivery!.indexOf('mv -f "$s/pb-data-backup.py" "$d/pb-data-backup.py"');
    const daily = delivery!.indexOf('mv -f "$s/footfive-backup.sh" "$d/footfive-backup.sh"');
    expect(helper).toBeGreaterThan(-1);
    expect(daily).toBeGreaterThan(helper);
    expect(lines.indexOf(delivery!)).toBeGreaterThan(lines.findIndex((l) => l.includes("/var/backups/footfive/${STAMP}/scripts")));
  });

  it("declares minimal permissions and job timeouts", () => {
    expect(deploy).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(deploy).toContain("timeout-minutes:");
  });
});

describe("footfive-ci.yml contracts", () => {
  it("gates the API job on the real world-setup suite after verified PocketBase installation", () => {
    const api = job(ci, "api-e2e");
    const steps = api.split(/^ {6}- /m).slice(1);
    const setup = steps.filter((step) => /^ {8}run: npm run test:world-setup$/m.test(step));
    expect(setup).toHaveLength(1);
    expect(setup[0]).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    const install = steps.findIndex((step) => /^ {8}run: bash scripts\/fetch-pocketbase\.sh$/m.test(step));
    expect(install).toBeGreaterThan(-1);
    expect(steps.indexOf(setup[0])).toBeGreaterThan(install);
    expect(api).toMatch(/node-version: "22"/);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:world-setup"]).toBe("node tests/integration/world-setup-atomicity.mjs");
    expect(readFileSync(path.join(root, "tests/integration/world-setup-atomicity.mjs"), "utf8")).toContain('from "node:sqlite"');
  });

  it("gates the API job on the real Command Charge suite after verified PocketBase installation", () => {
    const steps = job(ci, "api-e2e").split(/^ {6}- /m).slice(1);
    const at = (run: string) => steps.findIndex((step) => new RegExp(`^ {8}run: ${run}$`, "m").test(step));
    const charge = steps.filter((step) => /^ {8}run: npm run test:command-charge$/m.test(step));
    expect(charge).toHaveLength(1);
    expect(charge[0]).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    expect(at("npm run test:command-charge")).toBeGreaterThan(at("bash scripts\\/fetch-pocketbase\\.sh"));
    expect(at("npm run test:world-setup")).toBeGreaterThan(-1); // the world-setup gate stays
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:command-charge"]).toBe("node tests/integration/command-charge-atomicity.mjs");
    expect(readFileSync(path.join(root, "tests/integration/command-charge-atomicity.mjs"), "utf8")).toContain("COMMAND_CHARGE_PB_PORT");
  });

  it("gates the API job on the real lineup suite after the Command Charge suite", () => {
    const steps = job(ci, "api-e2e").split(/^ {6}- /m).slice(1);
    const at = (run: string) => steps.findIndex((step) => new RegExp(`^ {8}run: ${run}$`, "m").test(step));
    const lineup = steps.filter((step) => /^ {8}run: npm run test:lineup$/m.test(step));
    expect(lineup).toHaveLength(1);
    expect(lineup[0]).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    expect(at("npm run test:lineup")).toBeGreaterThan(at("bash scripts\\/fetch-pocketbase\\.sh"));
    expect(at("npm run test:lineup")).toBeGreaterThan(at("npm run test:command-charge"));
    expect(at("npm run test:command-charge")).toBeGreaterThan(-1); // the Command Charge gate stays
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:lineup"]).toBe("node tests/integration/lineup-atomicity.mjs");
    expect(readFileSync(path.join(root, "tests/integration/lineup-atomicity.mjs"), "utf8")).toContain("LINEUP_PB_PORT");
  });

  it("gates the API job on the real coaching suite after the lineup suite", () => {
    const steps = job(ci, "api-e2e").split(/^ {6}- /m).slice(1);
    const at = (run: string) => steps.findIndex((step) => new RegExp(`^ {8}run: ${run}$`, "m").test(step));
    const coaching = steps.filter((step) => /^ {8}run: npm run test:coaching$/m.test(step));
    expect(coaching).toHaveLength(1);
    expect(coaching[0]).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    expect(at("npm run test:coaching")).toBeGreaterThan(at("bash scripts\\/fetch-pocketbase\\.sh"));
    expect(at("npm run test:coaching")).toBeGreaterThan(at("npm run test:lineup"));
    expect(at("npm run test:lineup")).toBeGreaterThan(-1); // the lineup gate stays
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:coaching"]).toBe("node tests/integration/coaching-atomicity.mjs");
    expect(readFileSync(path.join(root, "tests/integration/coaching-atomicity.mjs"), "utf8")).toContain("COACHING_PB_PORT");
  });

  it("gates the API job on the real overclock kick-off suite after the coaching suite", () => {
    const steps = job(ci, "api-e2e").split(/^ {6}- /m).slice(1);
    const at = (run: string) => steps.findIndex((step) => new RegExp(`^ {8}run: ${run}$`, "m").test(step));
    const overclock = steps.filter((step) => /^ {8}run: npm run test:overclock$/m.test(step));
    expect(overclock).toHaveLength(1);
    expect(overclock[0]).not.toMatch(/^ {8}(?:if|continue-on-error):/m);
    expect(at("npm run test:overclock")).toBeGreaterThan(at("bash scripts\\/fetch-pocketbase\\.sh"));
    expect(at("npm run test:overclock")).toBeGreaterThan(at("npm run test:coaching"));
    expect(at("npm run test:coaching")).toBeGreaterThan(-1); // the coaching gate stays
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.scripts["test:overclock"]).toBe("node tests/integration/overclock-kickoff.mjs");
    expect(readFileSync(path.join(root, "tests/integration/overclock-kickoff.mjs"), "utf8")).toContain("OVERCLOCK_PB_PORT");
  });

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

// Text of one top-level job, from its key to the next job key.
const job = (yml: string, id: string) => {
  const start = yml.indexOf(`\n  ${id}:\n`);
  expect(start, id).toBeGreaterThan(-1);
  const next = yml.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
};
const code = (yml: string) => yml.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const ciJobNames = [...ci.matchAll(/^ {2}[a-z0-9-]+:\n {4}name: (.+)$/gm)].map((m) => m[1]);
const requiredIn = (file: string) => {
  const src = readFileSync(path.join(root, file), "utf8");
  return JSON.parse(src.match(/\[("[^"\]]+"(?:, )?)+\]/)![0]) as string[];
};

describe("deploy.yml deploys only the exact tested SHA", () => {
  it("triggers on a successful FootFive CI push run on main or a main-only manual dispatch, never a raw push", () => {
    const on = deploy.slice(deploy.indexOf("\non:\n"), deploy.indexOf("\nconcurrency:"));
    expect(on).toMatch(/workflow_run:\n\s+workflows: \[FootFive CI\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
    expect(on).not.toMatch(/^\s+push:/m);
    expect(ci).toMatch(/^name: FootFive CI$/m);
    const gate = job(deploy, "gate");
    for (const condition of [
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      "github.event.workflow_run.path == '.github/workflows/footfive-ci.yml'",
      "github.event.workflow_run.repository.full_name == github.repository",
      "github.event.workflow_run.head_repository.full_name == github.repository",
    ]) {
      expect(gate).toContain(condition);
    }
  });

  it("manual deploys name an exact SHA and pass the same gate; rollback only relaxes the main-head rule", () => {
    expect(deploy).toMatch(/inputs:\n\s+sha:\n\s+description: [^\n]+\n\s+required: true\n\s+type: string/);
    expect(deploy).toMatch(/rollback:\n\s+description: Emergency rollback[^\n]*\n\s+required: false\n\s+default: false\n\s+type: boolean/);
    const gate = job(deploy, "gate");
    expect(gate).toContain('node scripts/verify-deploy-ci.mjs "${args[@]}"');
    expect(gate).toContain('if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ] && [ "$ROLLBACK" = true ]; then args+=(--rollback); fi');
    expect(gate.match(/--rollback/g)).toHaveLength(1);
    expect(gate).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
  });

  it("the shared gate runs before any secret, and every later job checks out and verifies its SHA", () => {
    const gate = job(deploy, "gate");
    const build = job(deploy, "test-and-build");
    const ship = job(deploy, "deploy");
    expect(gate).not.toContain("secrets.");
    expect(gate).not.toMatch(/\bref:/); // gate code comes from the trusted default branch
    expect(build).toMatch(/needs: gate\n/);
    expect(ship).toMatch(/needs: \[gate, test-and-build\]\n/);
    for (const block of [build, ship]) {
      expect(block).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ needs\.gate\.outputs\.sha \}\}\n\s+persist-credentials: false/);
      expect(block).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
    }
    expect(deploy.match(/uses: actions\/checkout@v4/g)).toHaveLength(3);
    expect(deploy.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(deploy).toMatch(/permissions:\n\s+contents: read\n\s+actions: read\n\njobs:/);
    expect(deploy).not.toMatch(/:\s*write\b/);
  });

  it("never uses GITHUB_SHA (the default-branch head on workflow_run) for checkout or provenance", () => {
    expect(code(deploy)).not.toMatch(/GITHUB_SHA|github\.sha\b/);
  });

  it("untrusted SHAs reach the shell only through env, never inline expressions", () => {
    const lines = deploy.split("\n").filter((l) => /\$\{\{\s*(inputs\.|github\.event\.workflow_run\.head_sha)/.test(l));
    expect(lines).toHaveLength(3); // RUN_SHA, INPUT_SHA, ROLLBACK
    for (const line of lines) expect(line).toMatch(/^\s+[A-Z_]+: \$\{\{ [^}]+ \}\}$/);
  });

  it("the deploy and merge gates require exactly FootFive CI's three jobs", () => {
    expect(ciJobNames).toHaveLength(3);
    expect(requiredIn("scripts/verify-deploy-ci.mjs").slice().sort()).toEqual(ciJobNames.slice().sort());
    expect(requiredIn("scripts/verify-pr-ci.mjs").slice().sort()).toEqual(ciJobNames.slice().sort());
  });
});

describe("PocketBase downloads are checksum-verified", () => {
  it("both e2e jobs always install through the pinned helper, never an existing or raw download", () => {
    for (const id of ["api-e2e", "browser-e2e"]) {
      expect(job(ci, id)).toContain("run: bash scripts/fetch-pocketbase.sh\n");
    }
    expect(ci).not.toMatch(/releases\/download|pb\.zip|-x pocketbase\/pocketbase/);
  });

  it("local setup downloads only through the same helper", () => {
    const setup = readFileSync(path.join(root, "scripts/setup-local.sh"), "utf8");
    expect(setup).toContain('bash "$ROOT/scripts/fetch-pocketbase.sh" "$PB_DIR"');
    expect(setup).not.toMatch(/curl|releases\/download|zipfile/);
  });

  it("no other workflow, script or deploy file downloads a PocketBase release", () => {
    const files = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const downloaders = [".github", "scripts", "deploy"].flatMap(files).concat("package.json")
      .filter((f) => !/\.test\.[cm]?[jt]s$/.test(f))
      .filter((f) => readFileSync(path.join(root, f), "utf8").includes("pocketbase/pocketbase/releases/download"));
    expect(downloaders).toEqual(["scripts/fetch-pocketbase.sh"]);
  });
});

describe("public-readiness workflow guards", () => {
  const fable = readFileSync(path.join(root, ".github/workflows/fable-review.yml"), "utf8");
  it("deploy job runs in the production environment", () => {
    const d = job(deploy, "deploy");
    expect(d).toMatch(/\n {4}environment:\n {6}name: production\n {6}url: https:\/\/jdwd40\.com\/footfive\/\n/);
  });
  it("fable review only reacts to owner comments and never cancels from skipped runs", () => {
    const head = fable.slice(0, fable.indexOf("\njobs:\n"));
    expect(head).not.toMatch(/^concurrency:/m);
    const verify = job(fable, "verify");
    expect(code(verify)).toContain("github.event.comment.user.login == github.repository_owner");
    expect(verify).toMatch(/\n {4}concurrency:\n {6}group: fable-review-/);
    // Never checks out or executes PR head code with the write-capable token.
    expect(verify).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(verify).not.toMatch(/github\.event\.pull_request\.head/);
  });
});
