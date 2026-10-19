// Issue #30 (review B18/D1): one body parser and one error policy for protected
// routes. Malformed bodies are rejected instead of running route defaults, and
// internal errors reach clients only as fixed per-route text. Real routes,
// PocketBase parsing and rollback are covered by tests/integration/http-errors.mjs.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const HOOKS = path.resolve(__dirname, "../../pocketbase/pb_hooks");
const http = require(path.join(HOOKS, "lib/http.js"));

class ApiError extends Error {
  status: number;
  data = {};
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
class BadRequestError extends ApiError {
  constructor(m: string) {
    super(400, m);
  }
}
class ForbiddenError extends ApiError {
  constructor(m: string) {
    super(403, m);
  }
}
class NotFoundError extends ApiError {
  constructor(m: string) {
    super(404, m);
  }
}
/** PocketBase surfaces Go errors to JS as Error instances named GoError (step-0). */
function goError(message: string) {
  return Object.assign(new Error(message), { name: "GoError", value: {} });
}

const g = globalThis as Record<string, unknown>;
let logs: string[] = [];
beforeEach(() => {
  Object.assign(g, { ApiError, BadRequestError, ForbiddenError, NotFoundError });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(() => {
  for (const k of ["ApiError", "BadRequestError", "ForbiddenError", "NotFoundError"]) delete g[k];
  vi.restoreAllMocks();
});

function request(result: { body?: unknown; throws?: Error }) {
  let reads = 0;
  const e = {
    requestInfo: () => {
      reads++;
      if (result.throws) throw result.throws;
      return { body: result.body };
    },
  };
  return { e, reads: () => reads };
}

describe("readBody", () => {
  it.each([
    ["an empty or missing body", {}, {}],
    ["an object", { count: 2, reason: "x" }, { count: 2, reason: "x" }],
    ["no body field at all", undefined, {}],
  ])("returns %s as an object, reading once", (_n, body, want) => {
    const r = request({ body });
    expect(http.readBody(r.e)).toEqual(want);
    expect(r.reads()).toBe(1);
  });

  it.each([
    ["malformed JSON (PB parse error)", { throws: goError("unexpected EOF") }],
    ["an unsupported content type", { throws: goError("Unsupported Content-Type.") }],
    ["JSON null", { body: null }],
    ["an array", { body: [1, 2] }],
    ["a string", { body: "x" }],
    ["a number", { body: 5 }],
    ["a boolean", { body: true }],
  ])("rejects %s instead of defaulting to {}", (_n, result) => {
    const r = request(result);
    let err: unknown;
    try {
      http.readBody(r.e);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ status: 400, message: "Invalid request body" });
    expect(String((err as Error).message)).not.toMatch(/EOF|Content-Type/);
    expect(r.reads()).toBe(1);
  });
});

describe("fail", () => {
  const route = { route: "POST /api/footfive/players/{id}/repair", fallback: "Could not repair player" };

  it.each([
    ["a 400", new BadRequestError("Not enough credits.")],
    ["a service 403 (wire stays 400, as before)", new ForbiddenError("Not your player.")],
    ["a 404", new NotFoundError("Fixture not found.")],
    ["a 409", new ApiError(409, "Already done.")],
  ])("keeps the message of %s at the route's status", (_n, err) => {
    const out = http.fail(err, route);
    expect(out).toBeInstanceOf(BadRequestError);
    expect(out).toMatchObject({ status: 400, message: err.message });
    const on404 = http.fail(err, { ...route, status: 404 });
    expect(on404).toBeInstanceOf(NotFoundError);
    expect(on404).toMatchObject({ status: 404, message: err.message });
    expect(logs).toHaveLength(0); // deliberate errors are not internal failures
  });

  const SECRET = "ff30-marker token=eyJhbGciOi password=hunter2 /home/x/pb_hooks/lib/a.js:12 users.email";
  it.each([
    ["a SQL GoError", goError("SQL logic error: no such table: ff30_t (1) " + SECRET), "go"],
    ["a trigger GoError", goError("constraint failed: " + SECRET + " (1811)"), "go"],
    ["a no-rows GoError", goError("sql: no rows in result set"), "go_no_rows"],
    ["a plain Error", new Error("Duplicate admin adjustment key " + SECRET), "js"],
    ["a TypeError", new TypeError("Cannot read property 'split' of undefined " + SECRET), "js"],
    ["a thrown string", SECRET, "other"],
    ["undefined", undefined, "other"],
  ])("replaces %s with the fixed fallback and logs only route and kind", (_n, err, kind) => {
    const out = http.fail(err, route);
    expect(out).toBeInstanceOf(BadRequestError);
    expect(out).toMatchObject({ status: 400, message: "Could not repair player" });
    expect(logs).toHaveLength(1);
    expect(logs[0].startsWith("[footfive-json] ")).toBe(true);
    const entry = JSON.parse(logs[0].slice("[footfive-json] ".length));
    expect(Object.keys(entry).sort()).toEqual(["app", "event", "kind", "level", "route", "ts"]);
    expect(entry).toMatchObject({ event: "route_error", level: "error", route: route.route, kind });
    for (const leak of ["ff30", "eyJ", "hunter2", "pb_hooks", "users.email", "no rows", "SQL"]) {
      expect(logs[0]).not.toContain(leak);
      expect(out.message).not.toContain(leak);
    }
  });

  it("uses notFound only for a no-rows GoError on a route that supplies it", () => {
    const team = { route: "GET /api/footfive/records/teams/{id}", status: 404, fallback: "Team details unavailable", notFound: "Team not found" };
    expect(http.fail(goError("sql: no rows in result set"), team)).toMatchObject({ status: 404, message: "Team not found" });
    expect(http.fail(goError("database is locked"), team)).toMatchObject({ status: 404, message: "Team details unavailable" });
    expect(http.fail(new Error("sql: no rows in result set"), team)).toMatchObject({ status: 404, message: "Team details unavailable" });
    expect(http.fail(goError("sql: no rows in result set"), route)).toMatchObject({ status: 400, message: "Could not repair player" });
  });

  it("still returns the client error if logging itself fails", () => {
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console down");
    });
    expect(http.fail(new Error("x"), route)).toMatchObject({ status: 400, message: "Could not repair player" });
  });
});

describe("protected route wiring in main.pb.js", () => {
  const src = readFileSync(path.join(HOOKS, "main.pb.js"), "utf8");
  type Route = { key: string; text: string };
  const routes: Route[] = src
    .split(/\n(?=routerAdd\()/)
    .map((text) => {
      const m = /^routerAdd\(\s*"(GET|POST|PATCH|DELETE)",\s*"([^"]+)"/.exec(text);
      return m ? { key: `${m[1]} ${m[2]}`, text } : null;
    })
    .filter((r): r is Route => r !== null);
  const byKey = (k: string) => routes.find((r) => r.key === k)!;

  const FAIL: Record<string, string> = {
    "POST /api/footfive/teams/{teamId}/claim": "Could not claim this team",
    "POST /api/footfive/matches/{fixtureId}/coaching": "Could not apply coaching",
    "POST /api/footfive/bets": "Could not place bet",
    "POST /api/footfive/wallet/topup": "Could not top up wallet",
    "POST /api/footfive/my-team/mode": "Could not change mode",
    "POST /api/footfive/my-team/stance": "Could not change stance",
    "GET /api/footfive/my-team": "Team unavailable",
    "GET /api/footfive/my-team/squad": "Squad unavailable",
    "POST /api/footfive/my-team/lineup": "Could not save lineup",
    "POST /api/footfive/my-team/intensity": "Could not change intensity",
    "POST /api/footfive/players/{id}/upgrade": "Could not upgrade player",
    "POST /api/footfive/team-shop/batteries/buy": "Could not buy battery",
    "POST /api/footfive/players/{id}/battery": "Could not use battery",
    "POST /api/footfive/players/{id}/repair": "Could not repair player",
    "GET /api/footfive/my-team/finances": "Finances unavailable",
    "GET /api/footfive/command-charge": "Command Charge unavailable",
    "POST /api/footfive/command-charge/spend": "Could not spend Command Charge",
    "GET /api/footfive/my-team/tactical-scan": "Tactical scan unavailable",
    "POST /api/footfive/admin/users": "Could not create user",
    "DELETE /api/footfive/admin/users/{id}": "Could not delete user",
    "POST /api/footfive/admin/users/{id}/credits": "Could not adjust credits",
    "POST /api/footfive/admin/teams/{id}/treasury": "Could not adjust treasury",
    "POST /api/footfive/admin/teams/{id}/assign": "Could not assign team",
    "POST /api/footfive/admin/teams/{id}/reset": "Could not reset team",
    "PATCH /api/footfive/admin/world/settings": "Could not update world settings",
    "POST /api/footfive/admin/world/apply-between-round": "Could not apply between-round setting",
    "GET /api/footfive/records/teams/{id}": "Team details unavailable",
    "GET /api/footfive/records/tournaments/{id}": "Tournament details unavailable",
    "POST /api/footfive/admin/users/{id}/password": "Could not reset password",
    "POST /api/footfive/account/change-password": "Could not change password",
  };
  const BODY = [
    "POST /api/footfive/matches/{fixtureId}/coaching",
    "POST /api/footfive/bets",
    "POST /api/footfive/my-team/mode",
    "POST /api/footfive/my-team/stance",
    "POST /api/footfive/my-team/lineup",
    "POST /api/footfive/my-team/intensity",
    "POST /api/footfive/players/{id}/upgrade",
    "POST /api/footfive/team-shop/batteries/buy",
    "POST /api/footfive/players/{id}/repair",
    "POST /api/footfive/command-charge/spend",
    "POST /api/footfive/admin/users",
    "POST /api/footfive/admin/users/{id}/disable",
    "POST /api/footfive/admin/users/{id}/enable",
    "DELETE /api/footfive/admin/users/{id}",
    "POST /api/footfive/admin/users/{id}/credits",
    "POST /api/footfive/admin/teams/{id}/treasury",
    "POST /api/footfive/admin/teams/{id}/assign",
    "POST /api/footfive/admin/teams/{id}/release",
    "POST /api/footfive/admin/teams/{id}/reset",
    "PATCH /api/footfive/admin/world/settings",
    "POST /api/footfive/admin/world/apply-between-round",
    "POST /api/footfive/admin/users/{id}/password",
    "POST /api/footfive/account/change-password",
  ];

  it("no route forwards raw error text any more", () => {
    expect(src).not.toMatch(/String\(err\.message \|\| err\)/);
  });

  it.each(Object.entries(FAIL))("%s fails with its own static route and fallback", (key, fallback) => {
    const r = byKey(key);
    const calls = r.text.match(/http\.fail\(err, \{ [^\n]*? \}\)(?=;)/g) || [];
    expect(calls).toHaveLength(1);
    const status = key.startsWith("GET /api/footfive/records/") ? ", status: 404" : "";
    const notFound = key === "GET /api/footfive/records/teams/{id}" ? ', notFound: "Team not found"' : "";
    expect(calls[0]).toBe(`http.fail(err, { route: "${key}", fallback: "${fallback}"${status}${notFound} })`);
    expect(r.text).toContain(`throw ${calls[0]}`);
    expect(fallback[0]).toBe(fallback[0].toUpperCase()); // PocketBase capitalises the wire text anyway
  });

  it("exactly the expected routes fail through the helper", () => {
    expect(routes.filter((r) => r.text.includes("http.fail(")).map((r) => r.key).sort()).toEqual(Object.keys(FAIL).sort());
  });

  it("every protected body reader uses readBody once; only login and the native user hooks read requestInfo", () => {
    expect(routes.filter((r) => r.text.includes("http.readBody(e)")).map((r) => r.key).sort()).toEqual([...BODY].sort());
    for (const key of BODY) expect(byKey(key).text.match(/http\.readBody\(e\)/g)).toHaveLength(1);
    const direct = src.split("\n").filter((l) => l.includes("requestInfo()"));
    expect(direct).toEqual([
      "    createBody = e.requestInfo().body || {};",
      "    body = e.requestInfo().body || {};",
      "    body = e.requestInfo().body || {};",
    ]);
    expect(byKey("POST /api/footfive/auth/login").text).toContain("e.requestInfo().body || {}");
  });

  it("disable, enable and release stay uncaught so their native 403/404 statuses pass through", () => {
    for (const key of [
      "POST /api/footfive/admin/users/{id}/disable",
      "POST /api/footfive/admin/users/{id}/enable",
      "POST /api/footfive/admin/teams/{id}/release",
    ]) {
      expect(byKey(key).text).not.toMatch(/catch \(err\)/);
    }
  });

  it("the unannounced-fixture betting message is a deliberate 400 with its exact text", () => {
    const betting = readFileSync(path.join(HOOKS, "lib/bettingService.js"), "utf8");
    expect(betting).toContain('throw new BadRequestError("Betting opens when the fixtures are announced.");');
    expect(betting).not.toMatch(/throw new Error\("Betting opens/);
    const out = http.fail(new BadRequestError("Betting opens when the fixtures are announced."), { route: "POST /api/footfive/bets", fallback: "Could not place bet" });
    expect(out).toMatchObject({ status: 400, message: "Betting opens when the fixtures are announced." });
  });
});
