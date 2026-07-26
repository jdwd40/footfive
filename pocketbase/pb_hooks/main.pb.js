/// <reference path="../pb_data/types.d.ts" />

/**
 * FootFive Phase 2 — shared 24/7 Proball.
 * IMPORTANT: no outer-scope helpers — PB JSVM drops them.
 */

onBootstrap((e) => {
  // Complete app init first (migrations applied before/with bootstrap in PB 0.28)
  e.next();
  try {
    const svc = require(`${__hooks}/lib/worldService.js`);
    const log = require(`${__hooks}/lib/logger.js`);
    // JSVM has no setTimeout — retry synchronously a few times for empty-DB settle
    let lastErr = "";
    let ok = false;
    for (let n = 0; n < 15; n++) {
      try {
        if (!svc.isSchemaReady($app)) {
          lastErr = "schema_not_ready";
          // brief busy-wait (~50ms) without setTimeout
          const t0 = Date.now();
          while (Date.now() - t0 < 50) {}
          continue;
        }
        svc.ensureWorld($app);
        log.info("bootstrap_ok", { attempt: n + 1 });
        console.log("[footfive] shared world ready");
        ok = true;
        break;
      } catch (err) {
        lastErr = String(err);
        const t1 = Date.now();
        while (Date.now() - t1 < 50) {}
      }
    }
    if (!ok) {
      log.error("bootstrap_deferred", {
        message: (lastErr || "unknown").slice(0, 200),
        note: "catch-up will ensureWorld when schema ready",
      });
      console.log(
        "[footfive] world bootstrap deferred (catch-up will finish): " + lastErr,
      );
    }
  } catch (err) {
    console.log("[footfive] world bootstrap: " + err);
  }
});

onRecordCreateRequest((e) => {
  if (e.collection.name !== "users") {
    e.next();
    return;
  }
  e.record.set("role", "user");
  try {
    const bal = require(`${__hooks}/lib/balance.js`);
    e.record.set("credits", bal.BALANCE.startingCredits);
  } catch (_) {
    e.record.set("credits", 1000);
  }
  e.next();
}, "users");

onRecordUpdateRequest((e) => {
  if (e.collection.name !== "users") {
    e.next();
    return;
  }
  // PocketBase superuser (server ops CLI) may update roles
  try {
    if (typeof e.hasSuperuserAuth === "function" && e.hasSuperuserAuth()) {
      e.next();
      return;
    }
  } catch (_) {}
  const auth = e.auth;
  const isAdmin = auth && auth.get("role") === "admin";
  let original = null;
  try {
    original = e.record.originalCopy ? e.record.originalCopy() : null;
  } catch (_) {
    original = null;
  }
  // Prefer reloading from DB if originalCopy missing
  let dbUser = null;
  try {
    dbUser = $app.findRecordById("users", e.record.id);
  } catch (_) {}
  const src = original || dbUser;
  try {
    const newRole = e.record.get("role");
    const oldRole = src ? src.get("role") : "user";
    if (newRole !== oldRole && !isAdmin) {
      e.record.set("role", oldRole || "user");
    }
    // Credits only change via footfive admin/betting routes
    if (src && !isAdmin) {
      e.record.set("credits", src.get("credits"));
    }
    if (!isAdmin && src) {
      e.record.set("disabled", src.get("disabled"));
      e.record.set("admin_note", src.get("admin_note") || "");
      e.record.set("role", src.get("role") || "user");
    }
  } catch (_) {
    if (src) {
      e.record.set("role", src.get("role") || "user");
      if (!isAdmin) e.record.set("credits", src.get("credits"));
    }
  }
  e.next();
}, "users");

// Block disabled accounts from signing in / refreshing tokens
onRecordAuthRequest((e) => {
  try {
    if (e.record && e.record.get("disabled")) {
      throw new ForbiddenError("Account disabled");
    }
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
  }
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_teams");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_teams");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "match_states");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "match_states");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_fixtures");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_fixtures");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_bets");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_bets");

// Phase 6: lock more server-owned collections from client mutation
// (inline per-collection — PB JSVM must not rely on outer-scope loops)
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "global_team_records");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "global_team_records");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "global_player_records");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "global_player_records");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "match_summaries");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "match_summaries");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "tournament_summaries");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "tournament_summaries");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "credit_ledger");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "credit_ledger");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "team_finance_ledger");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "team_finance_ledger");
// admin_audit_logs: createRule is null — clients cannot create; superuser CLI + $app.save allowed
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_players");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_players");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_tournaments");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_tournaments");
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_rounds");
onRecordUpdateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "shared_rounds");
// Teams: block client create/update; superuser CLI needs manager release
onRecordCreateRequest((e) => {
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_teams");
onRecordUpdateRequest((e) => {
  try {
    if (typeof e.hasSuperuserAuth === "function" && e.hasSuperuserAuth()) {
      e.next();
      return;
    }
  } catch (_) {}
  throw new ForbiddenError("Use protected FootFive routes");
}, "proball_teams");
cronAdd("footfive_catchup", "*/1 * * * *", () => {
  const log = require(`${__hooks}/lib/logger.js`);
  const health = require(`${__hooks}/lib/healthService.js`);
  const svc = require(`${__hooks}/lib/worldService.js`);
  const t0 = Date.now();
  try {
    if (!svc.isSchemaReady($app)) {
      log.warn("catchup_skipped_schema", { message: "schema not ready" });
      return;
    }
    // Ensure world exists (idempotent) before catch-up
    try {
      svc.ensureWorld($app);
    } catch (bootErr) {
      log.warn("catchup_ensure_world", { message: String(bootErr).slice(0, 160) });
      return;
    }
    const recov = require(`${__hooks}/lib/recoveryService.js`);
    const stalls = recov.detectStalls($app);
    log.info("catchup_start", { hasStalls: !!stalls.hasStalls });
    let r;
    if (stalls.hasStalls) {
      r = recov.recoverAll($app, { preview: false });
      log.info("recovery_complete", {
        durationMs: Date.now() - t0,
        actions: (r.actions || []).length,
        success: !r.error,
      });
    } else {
      r = svc.catchUpWorld($app);
      log.info("catchup_complete", {
        durationMs: Date.now() - t0,
        actions: (r.actions || []).length,
        success: true,
      });
    }
    health.recordCatchUp(
      $app,
      {
        actions: r.actions || r,
        hasStalls: !!stalls.hasStalls,
      },
      Date.now() - t0,
      "",
    );
  } catch (err) {
    log.error("catchup_error", {
      durationMs: Date.now() - t0,
      message: String(err).slice(0, 200),
    });
    try {
      health.recordCatchUp($app, {}, Date.now() - t0, String(err).slice(0, 200));
    } catch (_) {}
  }
});

// Public health (no secrets)
routerAdd("GET", "/api/footfive/health", (e) => {
  const health = require(`${__hooks}/lib/healthService.js`);
  return e.json(200, health.publicHealth($app));
});

routerAdd(
  "GET",
  "/api/footfive/server-time",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const now = Date.now();
    return e.json(200, {
      serverTime: new Date(now).toISOString(),
      serverTimeMs: now,
    });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/world",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    try {
      return e.json(200, svc.worldSnapshot($app, auth.id));
    } catch (err) {
      console.log("[footfive] world error: " + err);
      throw new BadRequestError("world: " + err);
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/teams",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    try {
      return e.json(200, { teams: svc.listTeams($app) });
    } catch (err) {
      console.log("[footfive] teams error: " + err);
      throw new BadRequestError("teams: " + err);
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/teams/{teamId}/claim",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    const teamId = e.request.pathValue("teamId");
    try {
      const team = svc.claimTeam($app, auth.id, teamId);
      return e.json(200, { team: svc.teamPublic(team) });
    } catch (err) {
      console.log("[footfive] claim error: " + err);
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/catch-up",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    try {
      return e.json(200, svc.catchUpWorld($app));
    } catch (err) {
      console.log("[footfive] catch-up error: " + err);
      throw new BadRequestError("catch-up: " + err);
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/tournament",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    return e.json(200, svc.worldSnapshot($app, auth.id));
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/scoreboard",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    try {
      return e.json(200, svc.buildScoreboard($app));
    } catch (err) {
      console.log("[footfive] scoreboard: " + err);
      throw new BadRequestError("scoreboard: " + err);
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/match/{fixtureId}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    const fixtureId = e.request.pathValue("fixtureId");
    let sinceSeq = 0;
    try {
      const q = e.request.url.query().get("sinceSeq");
      if (q) sinceSeq = parseInt(q, 10) || 0;
    } catch (_) {}
    try {
      return e.json(200, svc.buildMatchView($app, fixtureId, sinceSeq, auth.id));
    } catch (err) {
      console.log("[footfive] match: " + err);
      throw new BadRequestError("match: " + err);
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/matches/{fixtureId}/coaching",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    const fixtureId = e.request.pathValue("fixtureId");
    let body = {};
    try {
      const info = e.requestInfo();
      if (info.body && typeof info.body === "object") body = info.body;
      else {
        const raw = readerToString(e.request.body);
        body = raw ? JSON.parse(raw) : {};
      }
    } catch (_) {}
    try {
      return e.json(200, svc.setCoaching($app, auth.id, fixtureId, body.stance));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/teams/{teamId}/lineup",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    const teamId = e.request.pathValue("teamId");
    let body = {};
    try {
      const info = e.requestInfo();
      if (info.body && typeof info.body === "object") body = info.body;
      else {
        const raw = readerToString(e.request.body);
        body = raw ? JSON.parse(raw) : {};
      }
    } catch (_) {}
    try {
      return e.json(
        200,
        svc.saveLineup($app, auth.id, teamId, body.starters || [], body.subs || []),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/betting/fixtures",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    return e.json(200, { fixtures: svc.listBettingFixtures($app, auth.id) });
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/bets",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    let body = {};
    try {
      const info = e.requestInfo();
      if (info.body && typeof info.body === "object") body = info.body;
      else {
        const raw = readerToString(e.request.body);
        body = raw ? JSON.parse(raw) : {};
      }
    } catch (_) {}
    try {
      const bet = svc.placeBet(
        $app,
        auth.id,
        body.fixtureId,
        body.selectionTeamId,
        body.stake,
      );
      return e.json(200, { bet: bet });
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/bets/mine",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rows = $app.findRecordsByFilter(
      "shared_bets",
      "user = {:u}",
      "-created",
      50,
      0,
      { u: auth.id },
    );
    const list = [];
    for (let i = 0; i < (rows || []).length; i++) {
      const b = rows[i];
      list.push({
        id: b.id,
        fixtureId: b.get("fixture"),
        selectionTeamId: b.get("selection_team"),
        stake: b.get("stake"),
        odds: b.get("odds"),
        status: b.get("status"),
        settled: !!b.get("settled"),
        created: b.get("created"),
      });
    }
    return e.json(200, { bets: list });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/admin/ping",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    if (auth.get("role") !== "admin") throw new ForbiddenError("Admin only");
    return e.json(200, { ok: true, admin: auth.id });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/templates",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const svc = require(`${__hooks}/lib/worldService.js`);
    const teams = svc.listTeams($app);
    return e.json(200, { templates: teams, teams: teams });
  },
  $apis.requireAuth(),
);

// --- Phase 3 management ---
routerAdd(
  "GET",
  "/api/footfive/my-team",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    try {
      return e.json(200, mgmt.getSquad($app, auth.id));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/my-team/squad",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    try {
      return e.json(200, mgmt.getSquad($app, auth.id));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/my-team/lineup",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    let body = {};
    try {
      const info = e.requestInfo();
      body = info.body || {};
    } catch (_) {}
    try {
      return e.json(200, mgmt.setLineup($app, auth.id, body.starters || [], body.subs || []));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/my-team/intensity",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    let body = {};
    try {
      const info = e.requestInfo();
      body = info.body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        mgmt.setIntensity($app, auth.id, body.playerId, body.intensity),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/players/{id}/upgrade",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, mgmt.upgradePlayer($app, auth.id, id, body.attribute));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/team-shop/batteries/buy",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, mgmt.buyBattery($app, auth.id, body.count || 1));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/players/{id}/battery",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    const id = e.request.pathValue("id");
    try {
      return e.json(200, mgmt.useBattery($app, auth.id, id));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/players/{id}/repair",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, mgmt.repairPlayer($app, auth.id, id, body.points || 25));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/my-team/finances",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    try {
      return e.json(200, mgmt.teamFinances($app, auth.id, 40));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/command-charge",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    try {
      return e.json(200, mgmt.getCommandChargeState($app, auth.id));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/command-charge/spend",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const mgmt = require(`${__hooks}/lib/managementService.js`);
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        mgmt.commandChargeSpend(
          $app,
          auth.id,
          body.action,
          body.playerId,
          body.fixtureId,
        ),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/my-team/tactical-scan",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    try {
      const rows = $app.findRecordsByFilter(
        "tactical_scans",
        "user = {:u} && consumed != true",
        "-created",
        5,
        0,
        { u: auth.id },
      );
      const list = [];
      for (let i = 0; i < (rows || []).length; i++) {
        list.push({
          id: rows[i].id,
          fixtureId: rows[i].get("fixture_id"),
          report: rows[i].get("report_json"),
          created: rows[i].get("created"),
        });
      }
      return e.json(200, { scans: list });
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

// --- Phase 5: records ---
routerAdd(
  "GET",
  "/api/footfive/records/overview",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    return e.json(200, rec.recordsOverview($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/teams",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    return e.json(200, { teams: rec.recordsOverview($app).teams });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/tournaments",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    return e.json(200, { tournaments: rec.listTournaments($app) });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/matches",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    let filters = {};
    try {
      const q = e.request.url.query();
      if (q.get("tournamentId")) filters.tournamentId = q.get("tournamentId");
      if (q.get("teamId")) filters.teamId = q.get("teamId");
      if (q.get("shootout") === "1") filters.shootoutOnly = true;
      if (q.get("et") === "1") filters.etOnly = true;
    } catch (_) {}
    return e.json(200, { matches: rec.listMatchArchive($app, filters) });
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/bets/history",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    return e.json(200, rec.userBettingHistory($app, auth.id));
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/players",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    let filters = { leaders: true };
    try {
      const q = e.request.url.query();
      if (q.get("teamId")) filters.teamId = q.get("teamId");
      if (q.get("role")) filters.role = q.get("role");
      if (q.get("all") === "1") filters.leaders = false;
    } catch (_) {}
    return e.json(200, { players: rec.listPlayerRecords($app, filters) });
  },
  $apis.requireAuth(),
);

// --- Phase 5: admin ---
routerAdd(
  "GET",
  "/api/footfive/admin/overview",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    return e.json(200, adm.overview($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/admin/users",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    let q = "";
    try {
      q = e.request.url.query().get("q") || "";
    } catch (_) {}
    return e.json(200, { users: adm.listUsers($app, q) });
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/users",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, adm.createUser($app, auth.id, body));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/users/{id}/disable",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    return e.json(200, adm.setUserDisabled($app, auth.id, id, true, body.reason || ""));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/users/{id}/enable",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    return e.json(200, adm.setUserDisabled($app, auth.id, id, false, body.reason || ""));
  },
  $apis.requireAuth(),
);

routerAdd(
  "DELETE",
  "/api/footfive/admin/users/{id}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, adm.deleteUser($app, auth.id, id, body.reason || "delete"));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/users/{id}/credits",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        adm.adjustCredits($app, auth.id, id, body.mode || "add", body.amount, body.reason),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/teams/{id}/treasury",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        adm.adjustTreasury($app, auth.id, id, body.mode || "add", body.amount, body.reason),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/teams/{id}/assign",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(200, adm.assignTeam($app, auth.id, id, body.userId, body.reason || ""));
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/teams/{id}/release",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    return e.json(200, adm.assignTeam($app, auth.id, id, null, body.reason || "release"));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/teams/{id}/reset",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        adm.resetTeamOps($app, auth.id, id, body.mode || "energy", body.reason || "reset"),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/admin/world",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    return e.json(200, adm.overview($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/world/catch-up",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const svc = require(`${__hooks}/lib/worldService.js`);
    const r = svc.catchUpWorld($app);
    adm.audit($app, auth.id, "world_catchup", "world", "main", null, r, "manual", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/world/pause",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    return e.json(
      200,
      adm.patchWorldSettings($app, auth.id, { progression_paused: true }, "pause"),
    );
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/world/resume",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    return e.json(
      200,
      adm.patchWorldSettings($app, auth.id, { progression_paused: false }, "resume"),
    );
  },
  $apis.requireAuth(),
);

routerAdd(
  "PATCH",
  "/api/footfive/admin/world/settings",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        adm.patchWorldSettings($app, auth.id, body, body.reason || "settings"),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/world/apply-between-round",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const svc = require(`${__hooks}/lib/worldService.js`);
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        svc.applyBetweenRoundToWaiting($app, auth.id, body.reason || "apply_between_round"),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

// Username or email login (does not log passwords)
routerAdd("POST", "/api/footfive/auth/login", (e) => {
  let body = {};
  try {
    body = e.requestInfo().body || {};
  } catch (_) {}
  const identity = String(body.identity || body.email || body.username || "").trim();
  const password = String(body.password || "");
  if (!identity || !password) throw new BadRequestError("identity and password required");
  let authRecord = null;
  try {
    if (identity.indexOf("@") >= 0) {
      authRecord = $app.findAuthRecordByEmail("users", identity);
    } else {
      const rows = $app.findRecordsByFilter(
        "users",
        "username = {:u}",
        "",
        1,
        0,
        { u: identity },
      );
      if (rows && rows.length) authRecord = rows[0];
    }
  } catch (_) {
    authRecord = null;
  }
  if (!authRecord) throw new UnauthorizedError("Invalid credentials");
  try {
    if (authRecord.get("disabled")) throw new ForbiddenError("Account disabled");
  } catch (err) {
    if (err instanceof ForbiddenError) throw err;
  }
  if (!authRecord.validatePassword(password)) {
    throw new UnauthorizedError("Invalid credentials");
  }
  return $apis.recordAuthResponse(e, authRecord);
});

routerAdd(
  "GET",
  "/api/footfive/admin/retention",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const ret = require(`${__hooks}/lib/retentionService.js`);
    return e.json(200, ret.retentionStatus($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/retention/preview",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const ret = require(`${__hooks}/lib/retentionService.js`);
    return e.json(200, ret.runRetention($app, { preview: true, adminId: auth.id }));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/retention/run",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const ret = require(`${__hooks}/lib/retentionService.js`);
    const r = ret.runRetention($app, { preview: false, adminId: auth.id });
    adm.audit($app, auth.id, "retention_run", "retention", "main", null, r, "manual", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/admin/audit",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    return e.json(200, { entries: adm.listAudit($app, {}) });
  },
  $apis.requireAuth(),
);

// Daily retention job ~03:00
cronAdd("footfive_retention_daily", "0 3 * * *", () => {
  try {
    const ret = require(`${__hooks}/lib/retentionService.js`);
    const r = ret.runRetention($app, { preview: false });
    console.log("[footfive] retention " + JSON.stringify(r).slice(0, 200));
  } catch (err) {
    console.log("[footfive] retention error: " + err);
  }
});

// --- Phase 6: detail records ---
routerAdd(
  "GET",
  "/api/footfive/records/teams/{id}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    try {
      return e.json(200, rec.teamDetail($app, e.request.pathValue("id")));
    } catch (err) {
      throw new NotFoundError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/tournaments/{id}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    try {
      return e.json(200, rec.tournamentDetail($app, e.request.pathValue("id")));
    } catch (err) {
      throw new NotFoundError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/records/matches/{id}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const rec = require(`${__hooks}/lib/recordsService.js`);
    return e.json(200, rec.matchDetail($app, e.request.pathValue("id")));
  },
  $apis.requireAuth(),
);

// Admin password reset
routerAdd(
  "POST",
  "/api/footfive/admin/users/{id}/password",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const id = e.request.pathValue("id");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    try {
      return e.json(
        200,
        adm.resetUserPassword($app, auth.id, id, body.password, {
          mustChange: !!body.mustChange,
          reason: body.reason || "admin password reset",
        }),
      );
    } catch (err) {
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

// Backfill
routerAdd(
  "GET",
  "/api/footfive/admin/backfill/status",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const bf = require(`${__hooks}/lib/backfillService.js`);
    return e.json(200, bf.backfillStatus($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/backfill/preview",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const bf = require(`${__hooks}/lib/backfillService.js`);
    const r = bf.runBackfill($app, { preview: true, adminId: auth.id });
    adm.audit($app, auth.id, "backfill_preview", "backfill", "main", null, r, "preview", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/backfill/run",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const bf = require(`${__hooks}/lib/backfillService.js`);
    const r = bf.runBackfill($app, { preview: false, adminId: auth.id });
    adm.audit($app, auth.id, "backfill_run", "backfill", "main", null, r, "run", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

// Stall recovery
routerAdd(
  "GET",
  "/api/footfive/admin/recovery/status",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const recov = require(`${__hooks}/lib/recoveryService.js`);
    return e.json(200, recov.detectStalls($app));
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/recovery/run",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const recov = require(`${__hooks}/lib/recoveryService.js`);
    const r = recov.recoverAll($app, { preview: false });
    adm.audit($app, auth.id, "recovery_run", "world", "main", null, r, "manual recovery", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/recovery/clear-lock",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const recov = require(`${__hooks}/lib/recoveryService.js`);
    const r = recov.clearWorldLock($app);
    adm.audit($app, auth.id, "clear_world_lock", "world", "main", r.before, r.after, "clear lock", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "POST",
  "/api/footfive/admin/recovery/retry-match/{id}",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const recov = require(`${__hooks}/lib/recoveryService.js`);
    const id = e.request.pathValue("id");
    const r = recov.retryMatch($app, id);
    adm.audit($app, auth.id, "retry_match", "fixture", id, null, r, "retry match", true);
    return e.json(200, r);
  },
  $apis.requireAuth(),
);

routerAdd(
  "GET",
  "/api/footfive/admin/health",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const adm = require(`${__hooks}/lib/adminService.js`);
    adm.requireAdmin(auth);
    const health = require(`${__hooks}/lib/healthService.js`);
    return e.json(200, health.adminHealth($app));
  },
  $apis.requireAuth(),
);

/**
 * Authenticated user changes password (required when must_change_password).
 * Body: { currentPassword, newPassword } — never logged.
 */
routerAdd(
  "POST",
  "/api/footfive/account/change-password",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    let body = {};
    try {
      body = e.requestInfo().body || {};
    } catch (_) {}
    const currentPassword = body.currentPassword || body.current_password || "";
    const newPassword = body.newPassword || body.new_password || "";
    if (!newPassword || String(newPassword).length < 8) {
      throw new BadRequestError("New password must be at least 8 characters");
    }
    if (newPassword === currentPassword) {
      throw new BadRequestError("New password must differ from current");
    }
    try {
      const rec = $app.findRecordById("users", auth.id);
      if (!currentPassword) {
        throw new BadRequestError("Current password required");
      }
      // PocketBase 0.28 Record.validatePassword
      let valid = false;
      try {
        if (typeof rec.validatePassword === "function") {
          valid = !!rec.validatePassword(currentPassword);
        }
      } catch (_) {
        valid = false;
      }
      if (!valid) {
        throw new BadRequestError("Current password incorrect");
      }
      rec.set("password", newPassword);
      rec.set("passwordConfirm", newPassword);
      rec.set("must_change_password", false);
      try {
        if (typeof $security !== "undefined" && $security.randomString) {
          rec.set("tokenKey", $security.randomString(50));
        }
      } catch (_) {}
      $app.save(rec);
      try {
        const adm = require(`${__hooks}/lib/adminService.js`);
        adm.audit(
          $app,
          auth.id,
          "password_change",
          "users",
          auth.id,
          null,
          { must_change_password: false },
          "user password change",
          true,
        );
      } catch (_) {}
      const log = require(`${__hooks}/lib/logger.js`);
      log.info("password_change", { userId: auth.id, success: true });
      return e.json(200, { ok: true, must_change_password: false });
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      throw new BadRequestError(String(err.message || err));
    }
  },
  $apis.requireAuth(),
);

// Me endpoint includes must_change_password
routerAdd(
  "GET",
  "/api/footfive/me",
  (e) => {
    const auth = e.auth;
    if (!auth || !auth.id) throw new UnauthorizedError("Authentication required");
    const u = $app.findRecordById("users", auth.id);
    return e.json(200, {
      id: u.id,
      email: u.get("email"),
      display_name: u.get("display_name"),
      role: u.get("role") || "user",
      credits: u.get("credits") || 0,
      must_change_password: !!u.get("must_change_password"),
      disabled: !!u.get("disabled"),
    });
  },
  $apis.requireAuth(),
);

