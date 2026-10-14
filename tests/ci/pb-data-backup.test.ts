// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { createInterface } from "node:readline";

const helper = fileURLToPath(new NodeURL("../../scripts/pb-data-backup.py", import.meta.url));
const directories: string[] = [];
const children: ChildProcess[] = [];

// The writer stays alive throughout the CLI invocation: closing it first could
// checkpoint the WAL and turn the committed-WAL regression into a cold-copy test.
const fixtureProgram = String.raw`
import os, sqlite3, sys
root, mode = sys.argv[1:]
os.mkdir(root)
db = sqlite3.connect(os.path.join(root, "data.db"))
if mode == "wal":
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA wal_autocheckpoint=0")
db.execute("CREATE TABLE evidence(value TEXT)")
db.execute("INSERT INTO evidence VALUES ('committed')")
db.commit()
aux = sqlite3.connect(os.path.join(root, "auxiliary.db"))
aux.execute("CREATE TABLE audit(value INTEGER)")
aux.execute("INSERT INTO audit VALUES (73)")
aux.commit()
aux.close()
os.makedirs(os.path.join(root, "storage", "collection", "record"))
upload = os.path.join(root, "storage", "collection", "record", "upload.db")
with open(upload, "wb") as f:
    f.write(b"Uploaded file, not a SQLite database\x00\xff")
os.chmod(upload, 0o640)
os.utime(upload, (1600000000, 1600000100))
if mode == "wal":
    db.execute("BEGIN IMMEDIATE")
    db.execute("INSERT INTO evidence VALUES ('uncommitted')")
elif mode == "locked":
    db.execute("BEGIN EXCLUSIVE")
    db.execute("INSERT INTO evidence VALUES ('uncommitted')")
print("ready", flush=True)
sys.stdin.readline()
db.rollback()
db.close()
`;

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await closed;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "ff28-pb-backup-"));
  directories.push(dir);
  const source = join(dir, "source");
  const dest = join(dir, "snapshot");
  const writer = spawn("python3", ["-I", "-u", "-c", fixtureProgram, source, mode], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(writer);
  const lines = createInterface({ input: writer.stdout });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SQLite fixture did not become ready")), 5000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      if (line === "ready") resolve(); else reject(new Error(`Unexpected fixture output: ${line}`));
    });
    writer.once("error", (error) => { clearTimeout(timer); reject(error); });
    writer.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Fixture exited early: ${code}`)); });
  });
  lines.close();
  return { dir, source, dest, writer };
}

function backup(source: string, dest: string) {
  const result = spawnSync("python3", ["-I", helper, source, dest], { encoding: "utf8", timeout: 8000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function inspect(source: string) {
  const result = spawnSync("python3", ["-I", "-c", String.raw`
import json, os, sqlite3, sys
from urllib.request import pathname2url
root = sys.argv[1]
result = {}
for name, query in [("data.db", "SELECT value FROM evidence"), ("auxiliary.db", "SELECT value FROM audit")]:
    db = sqlite3.connect("file:" + pathname2url(os.path.join(root, name)) + "?mode=ro", uri=True)
    result[name] = {"rows": db.execute(query).fetchall(), "integrity": db.execute("PRAGMA integrity_check").fetchall(), "journal": db.execute("PRAGMA journal_mode").fetchone()[0]}
    db.close()
print(json.dumps(result))
`, source], { encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const partials = (dir: string) => readdirSync(dir).filter((name) => name.startsWith(".snapshot.partial-"));
function unpublished(dir: string, dest: string) {
  expect(existsSync(dest)).toBe(false);
  expect(partials(dir)).toEqual([]);
}

describe("actual online pb_data backup CLI", () => {
  it("captures committed WAL data but excludes the open transaction without changing live database bytes", async () => {
    const { dir, source, dest, writer } = await fixture("wal");
    const wal = join(source, "data.db-wal");
    expect(statSync(wal).size).toBeGreaterThan(0);
    expect(inspect(source)["data.db"].rows).toEqual([["committed"]]);
    const files = ["data.db", "data.db-wal", "auxiliary.db"];
    const before = files.map((name) => digest(join(source, name)));
    const result = backup(source, dest);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`pb_data snapshot ${dest}: 2 SQLite database(s) verified`);
    expect(writer.exitCode).toBeNull();
    expect(files.map((name) => digest(join(source, name)))).toEqual(before);
    const snapshots = inspect(dest);
    expect(snapshots["data.db"].rows).toEqual([["committed"]]);
    expect(snapshots["auxiliary.db"].rows).toEqual([[73]]);
    for (const name of ["data.db", "auxiliary.db"]) {
      expect(snapshots[name].integrity).toEqual([["ok"]]);
      expect(snapshots[name].journal).toBe("delete");
      for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(join(dest, name + suffix))).toBe(false);
    }
    expect(partials(dir)).toEqual([]);
    // Close the still-open writer by rolling back; the committed source survives.
    const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));
    writer.stdin?.end("finish\n");
    await closed;
    expect(inspect(source)["data.db"].rows).toEqual([["committed"]]);
  });

  it("preserves nested storage named *.db verbatim, including file mode/time/owner", async () => {
    const { source, dest } = await fixture();
    const relative = join("storage", "collection", "record", "upload.db");
    const original = statSync(join(source, relative));
    const result = backup(source, dest);
    expect(result.status, result.stderr).toBe(0);
    const copied = statSync(join(dest, relative));
    expect(copied.mode & 0o777).toBe(original.mode & 0o777);
    expect(copied.mtimeMs).toBe(original.mtimeMs);
    // Reading the source during copy may advance atime under relatime;
    // copy2 preserves that source access time, while mtime stays unchanged.
    expect(copied.atimeMs).toBe(statSync(join(source, relative)).atimeMs);
    if (process.getuid?.() === 0) expect([copied.uid, copied.gid]).toEqual([original.uid, original.gid]);
    expect(readFileSync(join(dest, relative))).toEqual(readFileSync(join(source, relative)));
  });

  it.each(["directory", "dangling symlink"])("refuses an existing destination (%s) without changing it or creating staging", async (kind) => {
    const { dir, source, dest } = await fixture();
    if (kind === "directory") {
      mkdirSync(dest);
      writeFileSync(join(dest, "keep"), "prior backup");
    } else symlinkSync("missing-target", dest);
    const before = lstatSync(dest);
    expect(backup(source, dest).status).not.toBe(0);
    expect(lstatSync(dest).ino).toBe(before.ino);
    if (kind === "directory") {
      expect(readdirSync(dest)).toEqual(["keep"]);
      expect(readFileSync(join(dest, "keep"), "utf8")).toBe("prior backup");
    } else expect(readlinkSync(dest)).toBe("missing-target");
    expect(partials(dir)).toEqual([]);
  });

  it.each(["missing", "empty", "non-SQLite", "corrupt SQLite"])("does not publish a backup with %s data.db", async (kind) => {
    const { dir, source, dest, writer } = await fixture();
    await stop(writer);
    const database = join(source, "data.db");
    if (kind === "missing") rmSync(database);
    if (kind === "empty") writeFileSync(database, "");
    if (kind === "non-SQLite") writeFileSync(database, "not a SQLite database");
    if (kind === "corrupt SQLite") writeFileSync(database, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100, 0xff)]));
    const before = existsSync(database) ? digest(database) : null;
    expect(backup(source, dest).status).not.toBe(0);
    unpublished(dir, dest);
    if (before !== null) expect(digest(database)).toBe(before);
  });

  it("rejects corrupt top-level auxiliary.db even when data.db is valid", async () => {
    const { dir, source, dest, writer } = await fixture();
    await stop(writer);
    writeFileSync(join(source, "auxiliary.db"), "corrupt auxiliary database");
    const before = sourceEvidence(source);
    expect(backup(source, dest).status).not.toBe(0);
    unpublished(dir, dest);
    expect(sourceEvidence(source)).toEqual(before);
  });

  // Root bypasses mode-000 access checks. Do not change identities or assume a
  // privileged runner has an available unprivileged account; CI runs non-root.
  it.skipIf(process.getuid?.() === 0)("fails instead of silently omitting unreadable storage", async () => {
    const { dir, source, dest } = await fixture();
    const privateDir = join(source, "storage", "private");
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, "upload.txt"), "required upload");
    const originalMode = statSync(privateDir).mode & 0o777;
    try {
      chmodSync(privateDir, 0o000);
      expect(() => readdirSync(privateDir)).toThrow();
      expect(backup(source, dest).status).toBe(1);
      unpublished(dir, dest);
    } finally {
      chmodSync(privateDir, originalMode);
      // Also make a wrongly published snapshot removable if this regresses.
      const copiedPrivate = join(dest, "storage", "private");
      if (existsSync(copiedPrivate)) chmodSync(copiedPrivate, originalMode);
    }
  });

  it.each(["direct", "symlink parent"])("refuses destination inside source (%s) before changing source", async (kind) => {
    const { dir, source, writer } = await fixture();
    await stop(writer);
    const alias = join(dir, "source-alias");
    if (kind === "symlink parent") symlinkSync(source, alias);
    const dest = join(kind === "direct" ? source : alias, "snapshot");
    const before = sourceEvidence(source);
    expect(backup(source, dest).status).not.toBe(0);
    unpublished(source, dest);
    expect(sourceEvidence(source)).toEqual(before);
  });

  it.each(["SIGTERM", "SIGHUP"] as const)("cleans an in-progress snapshot after %s without publishing", async (signal) => {
    const { dir, source, dest } = await fixture("locked");
    const child = spawn("python3", ["-I", helper, source, dest], { stdio: "ignore" });
    children.push(child);
    const finished = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 4000;
    // Await concrete staging evidence while SQLite's exclusive lock holds backup.
    while (!partials(dir).length && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(partials(dir)).toHaveLength(1);
    expect(existsSync(dest)).toBe(false);
    expect(child.kill(signal)).toBe(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([finished, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${signal} did not terminate backup within 3s`)), 3000);
      })]);
      expect(outcome.code === null || outcome.code !== 0).toBe(true);
      unpublished(dir, dest);
      expect(inspectSourceFiles(source)).toEqual(["auxiliary.db", "data.db", "storage"]);
    } finally { clearTimeout(timer); }
  }, 10_000);
});

function inspectSourceFiles(source: string) {
  // The writer's rollback journal is legitimate live state, not backup residue.
  return readdirSync(source).filter((name) => !name.endsWith("-journal")).sort();
}

function sourceEvidence(root: string): unknown[] {
  const rootStat = statSync(root);
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const path = join(root, entry.name);
    const stat = statSync(path);
    return [entry.name, stat.mode, stat.mtimeMs, entry.isDirectory() ? sourceEvidence(path) : digest(path)];
  });
  return [rootStat.mode, rootStat.mtimeMs, entries];
}
