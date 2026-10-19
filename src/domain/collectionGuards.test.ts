// Issue #21 (review B8/D2): one native request guard per collection and event,
// superuser team updates restored, native deletes superuser-only. Runs the real
// main.pb.js registrations in a VM; native rule ordering, statuses and the
// cleanup CLI are covered on real PocketBase by tests/integration/collection-guards.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "../../pocketbase/pb_hooks/main.pb.js"), "utf8");

class ForbiddenError extends Error {
  status = 403;
}

type Handler = (e: unknown) => unknown;
type Reg = { event: "create" | "update" | "delete" | "auth"; fn: Handler; tags: string[] };

/** Every onRecord*Request registration main.pb.js makes, in order. */
function registrations(): Reg[] {
  const regs: Reg[] = [];
  const on = (event: Reg["event"]) => (fn: Handler, ...tags: string[]) => {
    regs.push({ event, fn, tags });
  };
  const noop = () => {};
  const sandbox = {
    onRecordCreateRequest: on("create"),
    onRecordUpdateRequest: on("update"),
    onRecordDeleteRequest: on("delete"),
    onRecordAuthRequest: on("auth"),
    routerAdd: noop,
    routerUse: noop,
    cronAdd: noop,
    onBootstrap: noop,
    $apis: new Proxy({}, { get: () => noop }),
    ForbiddenError,
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "main.pb.js" });
  return regs;
}

const DENY_CREATE = [
  "proball_teams", "match_states", "shared_fixtures", "shared_bets", "global_team_records",
  "global_player_records", "match_summaries", "tournament_summaries", "credit_ledger",
  "team_finance_ledger", "proball_players", "shared_tournaments", "shared_rounds",
];
const OPS = [
  "admin_audit_logs", "app_settings", "backfill_runs", "coaching_commands", "command_charge",
  "match_events", "retention_runs", "reward_settlements", "tactical_scans", "world",
];
const BASE = [...DENY_CREATE, ...OPS];

/** What a guard does for a superuser and for an application client. */
function behaviour(fn: Handler) {
  const run = (superuser: boolean) => {
    let nexted = false;
    try {
      fn({ hasSuperuserAuth: () => superuser, next: () => ((nexted = true), undefined), auth: null, collection: { name: "x" } });
    } catch (err) {
      return err instanceof ForbiddenError ? `403 ${err.message}` : `threw ${String(err)}`;
    }
    return nexted ? "next" : "returned";
  };
  return { superuser: run(true), client: run(false) };
}

const regs = registrations();
const guardsFor = (event: Reg["event"]) => regs.filter((r) => r.event === event && !r.tags.includes("users"));
const tagsOf = (rs: Reg[]) => rs.flatMap((r) => r.tags).sort();

describe("native collection request guards", () => {
  it("registers each (event, collection) pair once", () => {
    const seen = new Map<string, number>();
    for (const r of regs) for (const t of r.tags) seen.set(`${r.event}:${t}`, (seen.get(`${r.event}:${t}`) || 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("covers every app base collection for create, update and delete", () => {
    for (const event of ["create", "update"] as const) expect(tagsOf(guardsFor(event))).toEqual([...BASE].sort());
    expect(tagsOf(regs.filter((r) => r.event === "delete"))).toEqual([...BASE, "users"].sort());
  });

  it("create: server state denied to everyone, the other ten superuser-only", () => {
    for (const r of guardsFor("create")) {
      const b = behaviour(r.fn);
      if (r.tags.includes("proball_teams")) {
        expect(r.tags.sort()).toEqual([...DENY_CREATE].sort());
        expect(b).toEqual({ superuser: "403 Use protected FootFive routes", client: "403 Use protected FootFive routes" });
      } else {
        expect(r.tags.sort()).toEqual([...OPS].sort());
        expect(b).toEqual({ superuser: "next", client: "403 Use protected FootFive routes" });
      }
    }
  });

  it("update: server state denied to everyone except the restored superuser team update", () => {
    for (const r of guardsFor("update")) {
      const b = behaviour(r.fn);
      if (r.tags.includes("match_states")) {
        expect(r.tags.sort()).toEqual(DENY_CREATE.filter((t) => t !== "proball_teams").sort());
        expect(b).toEqual({ superuser: "403 Use protected FootFive routes", client: "403 Use protected FootFive routes" });
      } else {
        expect(r.tags.sort()).toEqual(["proball_teams", ...OPS].sort());
        expect(b).toEqual({ superuser: "next", client: "403 Use protected FootFive routes" });
      }
    }
  });

  it("delete: superuser-only everywhere, including users (no native self-delete)", () => {
    const del = regs.filter((r) => r.event === "delete");
    expect(del).toHaveLength(1);
    expect(behaviour(del[0].fn)).toEqual({ superuser: "next", client: "403 Use protected FootFive routes" });
  });

  it("keeps the users create, update and auth hooks as their own single registrations", () => {
    for (const event of ["create", "update", "auth"] as const) {
      const users = regs.filter((r) => r.event === event && r.tags.includes("users"));
      expect(users).toHaveLength(1);
      expect(users[0].tags).toEqual(["users"]);
    }
  });

  it("guard callbacks are self-contained (PB JSVM runs them without their outer scope)", () => {
    for (const r of [...guardsFor("create"), ...guardsFor("update"), ...regs.filter((x) => x.event === "delete")]) {
      const isolated = vm.runInNewContext(`(${r.fn.toString()})`, { ForbiddenError }) as Handler;
      expect(behaviour(isolated)).toEqual(behaviour(r.fn));
    }
  });
});
