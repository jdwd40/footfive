import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The daily root timer (scripts/footfive-backup.sh) and the local backup
// (scripts/backup-local.sh) must take pb_data through the verified snapshot helper
// while PocketBase keeps running, and never publish a failed or colliding backup.
// Real SQLite fixtures; systemctl, curl and date are offline fakes.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const realDate = spawnSync("bash", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
const FIXED = "20260101T000000Z";

const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), "footfive-backup-callers-"));
  dirs.push(d);
  return d;
};

// Committed rows left only in the WAL, as a running (or killed) PocketBase leaves them.
function liveDb(pbData: string, rows: number) {
  mkdirSync(pbData, { recursive: true });
  const r = spawnSync("python3", ["-I", "-c", [
    "import os, sqlite3, sys",
    "c = sqlite3.connect(sys.argv[1]); c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')",
    "c.execute('create table t(i)'); c.executemany('insert into t values(?)', [(i,) for i in range(int(sys.argv[2]))]); c.commit()",
    "os._exit(0)",
  ].join("\n"), path.join(pbData, "data.db"), String(rows)], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(existsSync(path.join(pbData, "data.db-wal"))).toBe(true);
}

// SQLite header followed by an invalid page: fails the snapshot, never copied as-is.
const corruptDb = (pbData: string) => {
  mkdirSync(pbData, { recursive: true });
  writeFileSync(path.join(pbData, "data.db"), Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(8192)]));
};

const rowsIn = (db: string) => {
  const r = spawnSync("python3", ["-I", "-c",
    "import sqlite3, sys; c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True); print(c.execute('select count(*) from t').fetchone()[0], c.execute('pragma integrity_check').fetchone()[0])",
    db], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

function fakes(dir: string) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const calls = path.join(dir, "calls.log");
  for (const name of ["systemctl", "curl"]) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\nexit 0\n`, { mode: 0o700 });
  }
  writeFileSync(path.join(bin, "date"), `#!/bin/sh\nif [ "$*" = "-u +%Y%m%dT%H%M%SZ" ] && [ -n "$FIXED_STAMP" ]; then echo "$FIXED_STAMP"; else exec ${realDate} "$@"; fi\n`, { mode: 0o700 });
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

function daily(setup: (home: string) => void, env: Record<string, string> = {}) {
  const dir = scratch();
  const home = path.join(dir, "home");
  const backups = path.join(dir, "backups");
  for (const sub of ["pocketbase/pb_hooks", "pocketbase/pb_migrations"]) mkdirSync(path.join(home, sub), { recursive: true });
  writeFileSync(path.join(home, "pocketbase/pb_hooks/main.pb.js"), "// hooks\n");
  mkdirSync(backups);
  writeFileSync(path.join(backups, "LATEST"), `${backups}/previous\n`);
  setup(home);
  const f = fakes(dir);
  const result = spawnSync("bash", [path.join(repoRoot, "scripts/footfive-backup.sh")], {
    encoding: "utf8", timeout: 30000,
    env: {
      ...process.env, ...env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`,
      FOOTFIVE_HOME: home, FOOTFIVE_BACKUP_ROOT: backups, FOOTFIVE_SERVICE: "footfive-pocketbase-test", FOOTFIVE_WEB: path.join(dir, "web"),
    },
  });
  const stamps = readdirSync(backups).filter((n) => /^20\d{6}T\d{6}Z$/.test(n));
  return { result, home, backups, stamps, latest: readFileSync(path.join(backups, "LATEST"), "utf8").trim(), calls: f.calls() };
}

test("the daily backup snapshots live WAL data without stopping PocketBase, then publishes it", () => {
  const r = daily((home) => liveDb(path.join(home, "pb_data"), 300));
  expect(r.result.status, r.result.stderr).toBe(0);
  expect(r.stamps).toHaveLength(1);
  const dest = path.join(r.backups, r.stamps[0]);
  expect(r.latest).toBe(dest);
  expect(readFileSync(path.join(dest, "STATUS"), "utf8").trim()).toBe("ok");
  expect(rowsIn(path.join(dest, "pb_data/data.db"))).toBe("300 ok");
  expect(readdirSync(path.join(dest, "pb_data"))).toEqual(["data.db"]);
  expect(readFileSync(path.join(dest, "SHA256SUMS"), "utf8")).toContain("./pb_data/data.db");
  expect(existsSync(path.join(r.home, "pb_data/data.db-wal"))).toBe(true); // live files untouched
  expect(r.calls).toBe(""); // no service stop/start, no health probe
});

test("a failed daily snapshot is marked failed, publishes nothing and leaves LATEST on the previous backup", () => {
  for (const setup of [
    (home: string) => corruptDb(path.join(home, "pb_data")),
    (home: string) => mkdirSync(path.join(home, "pb_data")), // wrong or empty data directory
  ]) {
    const r = daily(setup);
    expect(r.result.status).not.toBe(0);
    expect(r.result.stderr).toContain("pb_data backup FAILED, nothing published");
    expect(r.latest).toBe(`${r.backups}/previous`);
    expect(r.stamps).toHaveLength(1);
    const dest = path.join(r.backups, r.stamps[0]);
    expect(readFileSync(path.join(dest, "STATUS"), "utf8").trim()).toBe("failed");
    expect(readdirSync(dest)).toEqual(["STATUS"]); // no pb_data, no staging, no manifest
    expect(r.calls).toBe("");
  }
});

test("a same-second backup never merges into an existing one", () => {
  const r = daily((home) => {
    liveDb(path.join(home, "pb_data"), 5);
    const existing = path.join(home, "../backups", FIXED);
    mkdirSync(existing);
    writeFileSync(path.join(existing, "STATUS"), "ok\n");
  }, { FIXED_STAMP: FIXED });
  expect(r.result.status).not.toBe(0);
  expect(readdirSync(path.join(r.backups, FIXED))).toEqual(["STATUS"]);
  expect(readFileSync(path.join(r.backups, FIXED, "STATUS"), "utf8")).toBe("ok\n");
  expect(r.latest).toBe(`${r.backups}/previous`);
});

function local(setup: (pbData: string) => void) {
  const root = scratch();
  for (const sub of ["scripts", "pocketbase/pb_hooks", "pocketbase/pb_migrations"]) mkdirSync(path.join(root, sub), { recursive: true });
  for (const f of ["backup-local.sh", "pb-data-backup.py"]) copyFileSync(path.join(repoRoot, "scripts", f), path.join(root, "scripts", f));
  setup(path.join(root, "pocketbase/pb_data"));
  const result = spawnSync("bash", [path.join(root, "scripts/backup-local.sh")], {
    encoding: "utf8", timeout: 30000, env: { ...process.env, BACKUP_DIR: path.join(root, "out") },
  });
  const [stamp] = readdirSync(path.join(root, "out"));
  return { result, dest: path.join(root, "out", stamp) };
}

test("the local backup takes the same verified snapshot while PocketBase may be running", () => {
  const ok = local((pbData) => liveDb(pbData, 42));
  expect(ok.result.status, ok.result.stderr).toBe(0);
  expect(rowsIn(path.join(ok.dest, "pb_data/data.db"))).toBe("42 ok");
  expect(readdirSync(path.join(ok.dest, "pb_data"))).toEqual(["data.db"]);

  const bad = local(corruptDb);
  expect(bad.result.status).not.toBe(0);
  expect(existsSync(path.join(bad.dest, "pb_data"))).toBe(false);
});

test("the deploy's piped form runs the checked-out helper from stdin, as sudo -n python3 -I - does over SSH", () => {
  const dir = scratch();
  liveDb(path.join(dir, "pb_data"), 17);
  const r = spawnSync("bash", ["-c", 'python3 -I - "$1/pb_data" "$1/pb_data.bak" < "$2"', "_", dir, path.join(repoRoot, "scripts/pb-data-backup.py")], { encoding: "utf8", timeout: 30000 });
  expect(r.status, r.stderr).toBe(0);
  expect(rowsIn(path.join(dir, "pb_data.bak/data.db"))).toBe("17 ok");
});
