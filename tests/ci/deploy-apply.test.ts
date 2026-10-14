import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// deploy/deploy.sh apply is the manual new-release path: it must run the shared
// exact-SHA CI gate before any test, build, backup or copy. Runs the real script
// against a throwaway git checkout and temp targets; gh and npm are offline fakes.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const NAMES = ["Unit / type / lint / build", "PocketBase API E2E", "Playwright Chromium"];
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@test.local", "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8" }).stdout.trim();

type Ci = { failJob?: string; main?: string };

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "footfive-deploy-apply-"));
  dirs.push(dir);
  const root = path.join(dir, "app");
  for (const sub of ["deploy", "scripts", "pocketbase/pb_hooks", "pocketbase/pb_migrations"]) mkdirSync(path.join(root, sub), { recursive: true });
  mkdirSync(path.join(dir, "bin"));
  copyFileSync(path.join(repoRoot, "deploy/deploy.sh"), path.join(root, "deploy/deploy.sh"));
  copyFileSync(path.join(repoRoot, "scripts/verify-deploy-ci.mjs"), path.join(root, "scripts/verify-deploy-ci.mjs"));
  copyFileSync(path.join(repoRoot, "scripts/pb-data-backup.py"), path.join(root, "scripts/pb-data-backup.py"));
  writeFileSync(path.join(root, "pocketbase/pb_hooks/main.pb.js"), "// hooks\n");
  writeFileSync(path.join(root, "pocketbase/pb_migrations/1_init.js"), "// migration\n");
  writeFileSync(path.join(root, ".gitignore"), "dist/\nbackups/\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "release");
  const sha = git(root, "rev-parse", "HEAD");
  const state = path.join(dir, "state.json");
  writeFileSync(path.join(dir, "bin/npm"), `#!${process.execPath}
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.env.APPLY_TEST_STATE, 'utf8'));
const args = process.argv.slice(2);
st.log.push(['npm', ...args]);
fs.writeFileSync(process.env.APPLY_TEST_STATE, JSON.stringify(st));
if (args.join(' ') === 'run build') { fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.html', 'built'); }
`, { mode: 0o700 });
  writeFileSync(path.join(dir, "bin/gh"), `#!${process.execPath}
const fs = require('node:fs');
const st = JSON.parse(fs.readFileSync(process.env.APPLY_TEST_STATE, 'utf8'));
const endpoint = process.argv[3] || '';
st.log.push(['gh', endpoint]);
fs.writeFileSync(process.env.APPLY_TEST_STATE, JSON.stringify(st));
const out = (x) => process.stdout.write(JSON.stringify(x));
if (endpoint.includes('/actions/workflows/footfive-ci.yml/runs?')) out([{ workflow_runs: st.runs }]);
else if (/\\/actions\\/runs\\/\\d+\\/jobs\\?/.test(endpoint)) out([{ jobs: st.jobs }]);
else if (endpoint.endsWith('/git/ref/heads/main')) out({ object: { sha: st.main } });
else process.exit(2);
`, { mode: 0o700 });
  return { dir, root, sha, state };
}

function apply(p: ReturnType<typeof project>, args: string[], ci: Ci = {}) {
  const repo = "jdwd40/footfive";
  const runs = [{ id: 7, path: ".github/workflows/footfive-ci.yml", event: "push", head_branch: "main", head_sha: p.sha, status: "completed", conclusion: "success", repository: { full_name: repo }, head_repository: { full_name: repo } }];
  const jobs = NAMES.map((name, i) => ({ id: 70 + i, run_id: 7, name, head_sha: p.sha, status: "completed", conclusion: name === ci.failJob ? "failure" : "success" }));
  writeFileSync(p.state, JSON.stringify({ runs, jobs, main: ci.main ?? p.sha, log: [] }));
  const result = spawnSync("bash", [path.join(p.root, "deploy/deploy.sh"), ...args], {
    encoding: "utf8", timeout: 20000,
    env: {
      ...gitEnv, PATH: `${path.join(p.dir, "bin")}${path.delimiter}${process.env.PATH}`, APPLY_TEST_STATE: p.state,
      FOOTFIVE_ROOT: p.root, PB_ROOT: path.join(p.dir, "pb"), WEB_ROOT: path.join(p.dir, "web"),
      BACKUP_DIR: path.join(p.dir, "backups"), SERVICE_NAME: "", GH_REPO: repo,
    },
  });
  const log: string[][] = JSON.parse(readFileSync(p.state, "utf8")).log;
  return {
    result, log,
    gh: log.filter((c) => c[0] === "gh").length,
    npm: log.filter((c) => c[0] === "npm").map((c) => c.slice(1).join(" ")),
    touched: ["backups", "web", "pb"].filter((d) => existsSync(path.join(p.dir, d))),
  };
}

test("a clean checkout of the CI-passed main head is gated first, then tested, built and deployed", () => {
  const p = project();
  const r = apply(p, ["apply", p.sha]);
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.result.stdout).toContain(`Deploy gate: ${p.sha} passed FootFive CI run 7`);
  expect(r.gh).toBe(3);
  expect(r.log.findIndex((c) => c[0] === "npm")).toBe(r.gh); // every gate call precedes npm
  expect(r.npm).toEqual(["run test", "run typecheck", "run build"]);
  expect(readFileSync(path.join(p.dir, "web/index.html"), "utf8")).toBe("built");
  expect(existsSync(path.join(p.dir, "pb/pb_hooks/main.pb.js"))).toBe(true);
  expect(existsSync(path.join(p.dir, "backups/LATEST"))).toBe(true);
});

test("apply without an exact, checked-out, clean SHA refuses before any GitHub call, build, backup or copy", () => {
  const cases: [string, (p: ReturnType<typeof project>) => string[], string][] = [
    ["no SHA", () => ["apply"], "FULL_40_CHARACTER_SHA"],
    ["abbreviated SHA", (p) => ["apply", p.sha.slice(0, 7)], "FULL_40_CHARACTER_SHA"],
    ["branch name", () => ["apply", "main"], "FULL_40_CHARACTER_SHA"],
    ["another commit checked out", (p) => {
      writeFileSync(path.join(p.root, "pocketbase/pb_hooks/main.pb.js"), "// newer\n");
      git(p.root, "commit", "-q", "-am", "newer");
      return ["apply", p.sha];
    }, "checkout is at"],
    ["modified tracked file", (p) => {
      writeFileSync(path.join(p.root, "pocketbase/pb_hooks/main.pb.js"), "// local edit\n");
      return ["apply", p.sha];
    }, "has local changes"],
    ["untracked file", (p) => {
      writeFileSync(path.join(p.root, "pocketbase/pb_hooks/extra.pb.js"), "// untracked\n");
      return ["apply", p.sha];
    }, "has local changes"],
  ];
  for (const [label, args, message] of cases) {
    const p = project();
    const r = apply(p, args(p));
    expect(r.result.status, label).toBe(1);
    expect(r.result.stderr, label).toContain(message);
    expect(r.log, label).toEqual([]);
    expect(r.touched, label).toEqual([]);
  }
});

test("apply refuses a SHA whose CI did not fully pass, or that main has moved past, before build or backup", () => {
  for (const [ci, message] of [
    [{ failJob: "Playwright Chromium" }, 'did not pass "Playwright Chromium"'],
    [{ failJob: "PocketBase API E2E" }, 'did not pass "PocketBase API E2E"'],
    [{ main: "b".repeat(40) }, `main is at ${"b".repeat(40)}`],
  ] as [Ci, string][]) {
    const p = project();
    const r = apply(p, ["apply", p.sha], ci);
    expect(r.result.status).toBe(1);
    expect(r.result.stderr).toContain(message);
    expect(r.npm).toEqual([]);
    expect(r.touched).toEqual([]);
  }
});

test("emergency rollback restores the last backup without the new-release gate", () => {
  const p = project();
  expect(apply(p, ["apply", p.sha]).result.status).toBe(0);
  writeFileSync(path.join(p.dir, "web/index.html"), "broken release");
  const r = apply(p, ["rollback"], { failJob: "Playwright Chromium" });
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.log).toEqual([]);
  expect(readFileSync(path.join(p.dir, "web/index.html"), "utf8")).toBe("built");
});

// PocketBase data with committed rows still only in its WAL, as a running server has it.
function liveData(p: ReturnType<typeof project>, rows: number) {
  const pbData = path.join(p.dir, "pb/pb_data");
  mkdirSync(pbData, { recursive: true });
  const r = spawnSync("python3", ["-I", "-c", [
    "import os, sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1]); c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')",
    "c.execute('create table t(i)'); c.executemany('insert into t values(?)', [(i,) for i in range(int(sys.argv[2]))]); c.commit()",
    "os._exit(0)",
  ].join("\n"), path.join(pbData, "data.db"), String(rows)], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return pbData;
}

test("apply snapshots the live PocketBase data, verified, before replacing any code", () => {
  const p = project();
  liveData(p, 120);
  const r = apply(p, ["apply", p.sha]);
  expect(r.result.status, r.result.stderr).toBe(0);
  const latest = readFileSync(path.join(p.dir, "backups/LATEST"), "utf8").trim();
  expect(readdirSync(path.join(latest, "pb_data"))).toEqual(["data.db"]);
  const check = spawnSync("python3", ["-I", "-c",
    "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); print(c.execute('select count(*) from t').fetchone()[0], c.execute('pragma integrity_check').fetchone()[0])",
    path.join(latest, "pb_data/data.db")], { encoding: "utf8" });
  expect(check.stdout.trim()).toBe("120 ok");
  expect(existsSync(path.join(p.dir, "pb/pb_hooks/main.pb.js"))).toBe(true);
});

test("a failed data snapshot aborts apply before any code, frontend or LATEST change", () => {
  for (const broken of [
    (pbData: string) => {
      for (const f of ["data.db-wal", "data.db-shm"]) rmSync(path.join(pbData, f));
      writeFileSync(path.join(pbData, "data.db"), Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(8192)]));
    },
    (pbData: string) => rmSync(path.join(pbData, "data.db")), // wrong or emptied data directory
  ]) {
    const p = project();
    broken(liveData(p, 3));
    const r = apply(p, ["apply", p.sha]);
    expect(r.result.status).not.toBe(0);
    expect(r.result.stderr).toContain("pb_data backup FAILED, nothing published");
    expect(existsSync(path.join(p.dir, "pb/pb_hooks"))).toBe(false);
    expect(existsSync(path.join(p.dir, "web"))).toBe(false);
    expect(existsSync(path.join(p.dir, "backups/LATEST"))).toBe(false);
  }
});
