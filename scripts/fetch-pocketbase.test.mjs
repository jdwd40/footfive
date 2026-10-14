import { afterEach, expect, test } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const helper = fileURLToPath(new NodeURL("./fetch-pocketbase.sh", import.meta.url));
const officialPins = fileURLToPath(new NodeURL("./pocketbase-release.sha256", import.meta.url));
const asset = (arch) => `pocketbase_0.28.4_linux_${arch}.zip`;
const releaseUrl = (arch) => `https://github.com/pocketbase/pocketbase/releases/download/v0.28.4/${asset(arch)}`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
// Fake release binary: records that it was executed, then reports its version.
const binary = (version) => `#!/bin/sh\necho ran >> "$FETCH_TEST_RAN"\necho "pocketbase version ${version}"\n`;

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "footfive-fetch-pb-"));
  dirs.push(dir);
  return dir;
}

function zip(dir, name, files) {
  const file = path.join(dir, name);
  const r = spawnSync("python3", ["-I", "-c",
    "import json, sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z:\n    for n, c in json.loads(sys.argv[2]).items(): z.writestr(n, c)",
    file, JSON.stringify(files)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return readFileSync(file);
}

// Run a verbatim copy of the helper beside a test pin file, with curl and uname
// replaced by fakes that serve local archives. No network access.
function fetchPb({ served = {}, pins, machine = "x86_64", curlFails = false, env = {}, existing } = {}) {
  const dir = scratch();
  for (const sub of ["scripts", "bin", "served"]) mkdirSync(path.join(dir, sub));
  copyFileSync(helper, path.join(dir, "scripts/fetch-pocketbase.sh"));
  const archives = {};
  for (const [arch, files] of Object.entries(served)) archives[arch] = zip(path.join(dir, "served"), asset(arch), files);
  const pinText = typeof pins === "function" ? pins(archives) : pins ?? "";
  writeFileSync(path.join(dir, "scripts/pocketbase-release.sha256"), pinText);
  const dest = path.join(dir, "pocketbase");
  if (existing !== undefined) {
    mkdirSync(dest);
    writeFileSync(path.join(dest, "pocketbase"), existing, { mode: 0o755 });
  }
  const state = path.join(dir, "curl.json");
  writeFileSync(state, "[]");
  writeFileSync(path.join(dir, "bin/curl"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.FETCH_TEST_STATE, 'utf8'));
calls.push(args);
fs.writeFileSync(process.env.FETCH_TEST_STATE, JSON.stringify(calls));
const url = args[args.length - 1];
const source = path.join(${JSON.stringify(path.join(dir, "served"))}, path.basename(url));
if (${curlFails} || !fs.existsSync(source)) process.exit(22);
fs.copyFileSync(source, args[args.indexOf('-o') + 1]);
`, { mode: 0o700 });
  writeFileSync(path.join(dir, "bin/uname"), `#!/bin/sh\necho ${machine}\n`, { mode: 0o700 });
  const ran = path.join(dir, "ran");
  const result = spawnSync("bash", [path.join(dir, "scripts/fetch-pocketbase.sh")], {
    encoding: "utf8", timeout: 20000,
    env: { ...process.env, ...env, PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, FETCH_TEST_STATE: state, FETCH_TEST_RAN: ran },
  });
  const installed = path.join(dest, "pocketbase");
  return {
    result, archives, installed: existsSync(installed) ? readFileSync(installed, "utf8") : null,
    mode: existsSync(installed) ? statSync(installed).mode : 0,
    executed: existsSync(ran), curls: JSON.parse(readFileSync(state, "utf8")),
  };
}

const release = (version = "0.28.4") => ({
  amd64: { pocketbase: binary(version), "CHANGELOG.md": "amd64" },
  arm64: { pocketbase: binary(version), "CHANGELOG.md": "arm64" },
});
const pinBoth = (a) => `${sha256(a.amd64)}  ${asset("amd64")}\n${sha256(a.arm64)}  ${asset("arm64")}\n`;

test("installs the pinned release for amd64 and arm64 from its official URL once the checksum matches", () => {
  for (const [machine, arch] of [["x86_64", "amd64"], ["aarch64", "arm64"]]) {
    const r = fetchPb({ served: release(), pins: pinBoth, machine });
    expect(r.result.status, r.result.stderr).toBe(0);
    expect(r.installed).toBe(binary("0.28.4"));
    expect(r.mode & 0o111).toBe(0o111);
    expect(r.curls).toHaveLength(1);
    expect(r.curls[0].at(-1)).toBe(releaseUrl(arch));
    expect(r.result.stdout).toContain(`linux_${arch}, sha256 ${sha256(r.archives[arch])}`);
  }
  // The pinned version may be named explicitly.
  expect(fetchPb({ served: release(), pins: pinBoth, env: { PB_VERSION: "0.28.4" } }).result.status).toBe(0);
});

test("a tampered archive is refused before it is extracted, run or installed", () => {
  const genuine = zip(scratch(), asset("amd64"), release().amd64);
  const r = fetchPb({
    served: { amd64: { pocketbase: binary("0.28.4") + "# implant\n", "CHANGELOG.md": "amd64" } },
    pins: `${sha256(genuine)}  ${asset("amd64")}\n`,
    existing: "previous binary",
  });
  expect(r.result.status).toBe(1);
  expect(r.result.stderr).toContain(`does not match the pinned ${sha256(genuine)}`);
  expect(r.executed).toBe(false);
  expect(r.installed).toBe("previous binary");
});

test("a checksum-matching archive whose binary is another version is not installed", () => {
  const r = fetchPb({ served: release("0.29.0"), pins: pinBoth });
  expect(r.result.status).toBe(1);
  expect(r.result.stderr).toContain("binary reports 'pocketbase version 0.29.0'");
  expect(r.installed).toBeNull();
});

test("a failed download installs nothing", () => {
  const r = fetchPb({ served: release(), pins: pinBoth, curlFails: true });
  expect(r.result.status).not.toBe(0);
  expect(r.installed).toBeNull();
  expect(r.executed).toBe(false);
});

test("unsupported architectures, version overrides and missing or ambiguous pins fail before downloading", () => {
  const amd64Only = (a) => `${sha256(a.amd64)}  ${asset("amd64")}\n`;
  for (const [opts, message] of [
    [{ machine: "riscv64" }, "Unsupported architecture"],
    [{ env: { PB_VERSION: "0.29.0" } }, "PB_VERSION=0.29.0 is not verified"],
    [{ machine: "aarch64", pins: amd64Only }, "exactly one pinned PocketBase checksum for linux_arm64"],
    [{ pins: (a) => amd64Only(a) + amd64Only(a) }, "exactly one pinned PocketBase checksum for linux_amd64"],
    [{ pins: (a) => `${sha256(a.amd64).slice(1)}  ${asset("amd64")}\n` }, "exactly one pinned"],
  ]) {
    const r = fetchPb({ served: release(), pins: pinBoth, ...opts });
    expect(r.result.status).toBe(1);
    expect(r.result.stderr).toContain(message);
    expect(r.curls).toHaveLength(0);
    expect(r.installed).toBeNull();
  }
});

test("committed pins are the official PocketBase 0.28.4 linux release checksums", () => {
  // From the v0.28.4 release checksums.txt; GitHub's asset digests and a fresh download agree.
  expect(readFileSync(officialPins, "utf8")).toBe(
    "44161d9e8838d3226fee7f2a857b8033f642ace1f3486a1125b99fd6b8b08532  pocketbase_0.28.4_linux_amd64.zip\n" +
    "2386604f93b28f10a47cc447659c48b6bb9314ac84b1b3146271c1e183e56b44  pocketbase_0.28.4_linux_arm64.zip\n",
  );
});
