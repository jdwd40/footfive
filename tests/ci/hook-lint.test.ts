// @vitest-environment node
// Issue #31 (review O8/O9): PocketBase hooks are linted with JSVM-aware rules, using
// the repository's real eslint.config.js: PB globals are known, real undefined names,
// redeclarations and unused locals fail, and *.pb.js keeps no top-level bindings
// (PB runs hook handlers without the file's scope).
import { ESLint } from "eslint";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({ cwd: root });
const LIB = "pocketbase/pb_hooks/lib/zz_lint_fixture.js";
const HOOK = "pocketbase/pb_hooks/zz_lint_fixture.pb.js";

async function lint(code: string, file: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.map((m) => `${m.ruleId ?? "parse"}: ${m.message}`);
}

describe("PocketBase hook lint", () => {
  it("the real hooks lint clean", async () => {
    const results = await eslint.lintFiles(["pocketbase/pb_hooks"]);
    const problems = results.flatMap((r) => r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}`));
    expect(results.length).toBeGreaterThan(10);
    expect(problems).toEqual([]);
  }, 60_000);

  it("knows the JSVM globals and CommonJS lib modules", async () => {
    const code = `var other;
try {
  other = require(__hooks + "/lib/balance.js");
} catch (e) {
  other = require("./balance.js");
}
function save(id, _now) {
  var rows = arrayOf(new Record());
  $app.recordQuery("users").andWhere($dbx.exp("id = {:id}", { id: id })).all(rows);
  if (!rows.length) throw new BadRequestError("missing");
  try {
    $app.save(rows[0]);
  } catch (_) {}
  return other;
}
module.exports = { save: save };
`;
    expect(await lint(code, LIB)).toEqual([]);
  });

  it.each([
    ["an undefined name", "module.exports = { f: function () { return missingThing; } };", /no-undef/],
    ["a redeclared variable", "var a = 1;\nvar a = 2;\nmodule.exports = { a: a };", /no-redeclare/],
    ["an unused local", "function f() {\n  var x = 1;\n  return 2;\n}\nmodule.exports = { f: f };", /no-unused-vars/],
    ["an unused top-level function", "function unused() {}\nmodule.exports = {};", /no-unused-vars/],
    ["an unused trailing parameter", "function f(a, b) {\n  return a;\n}\nmodule.exports = { f: f };", /no-unused-vars/],
  ])("rejects %s in lib modules", async (_name, code, rule) => {
    const messages = await lint(code, LIB);
    expect(messages.some((m) => rule.test(m)), messages.join("\n")).toBe(true);
  });

  it("rejects top-level bindings in *.pb.js, which handlers could not see", async () => {
    for (const code of [
      'var helper = 1;\nrouterAdd("GET", "/x", function (e) { return e.json(200, { helper: helper }); });',
      'function helper() { return 1; }\nrouterAdd("GET", "/x", function (e) { return e.json(200, helper()); });',
    ]) {
      const messages = await lint(code, HOOK);
      expect(messages.some((m) => /no-restricted-syntax/.test(m)), messages.join("\n")).toBe(true);
    }
  });

  it("rejects redeclaring a PB global in a hook script", async () => {
    const messages = await lint('var Record = 1;\nrouterAdd("GET", "/x", function (e) { return e.json(200, {}); });', HOOK);
    expect(messages.some((m) => /no-redeclare/.test(m)), messages.join("\n")).toBe(true);
  });

  it("allows handler-local state and per-handler require in *.pb.js", async () => {
    const code = `routerAdd("GET", "/x", function (e) {
  var svc = require(__hooks + "/lib/worldService.js");
  var n = 1;
  return e.json(200, { n: n, ok: !!svc });
});
onRecordDeleteRequest(function (e) {
  if (e.hasSuperuserAuth()) return e.next();
  throw new ForbiddenError("no");
}, "users");
`;
    expect(await lint(code, HOOK)).toEqual([]);
  });

  it("leaves applied migrations ignored", async () => {
    expect(await eslint.isPathIgnored(path.join(root, "pocketbase/pb_migrations/1750000000_init_footfive.js"))).toBe(true);
    expect(await eslint.isPathIgnored(path.join(root, "pocketbase/pb_hooks/main.pb.js"))).toBe(false);
  });
});
