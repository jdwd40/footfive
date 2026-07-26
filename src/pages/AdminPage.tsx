import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

export default function AdminPage() {
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [teams, setTeams] = useState<Array<Record<string, unknown>>>([]);
  const [retention, setRetention] = useState<Record<string, unknown> | null>(null);
  const [audit, setAudit] = useState<Array<Record<string, unknown>>>([]);
  const [backfill, setBackfill] = useState<Record<string, unknown> | null>(null);
  const [recovery, setRecovery] = useState<Record<string, unknown> | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [betweenMins, setBetweenMins] = useState(3);
  const [matchSec, setMatchSec] = useState(15);
  const [tab, setTab] = useState<
    "dash" | "users" | "teams" | "retention" | "tools" | "audit"
  >("dash");

  async function load() {
    try {
      // Load overview first so shell is never blank if a secondary call fails
      const o = await footfiveApi.adminOverview();
      setOverview(o);
      const bm = Number(o.betweenRoundMinutes ?? 3);
      if (!Number.isNaN(bm) && bm >= 1) setBetweenMins(bm);
      const ms = Number(o.matchMinuteRealSeconds ?? 15);
      if (!Number.isNaN(ms) && ms >= 1) setMatchSec(ms);

      const results = await Promise.allSettled([
        footfiveApi.adminUsers(),
        footfiveApi.recordsTeams(),
        footfiveApi.adminRetention(),
        footfiveApi.adminAudit(),
        footfiveApi.adminBackfillStatus(),
        footfiveApi.adminRecoveryStatus(),
        footfiveApi.adminHealth(),
      ]);
      if (results[0].status === "fulfilled") setUsers(results[0].value.users || []);
      if (results[1].status === "fulfilled") setTeams(results[1].value.teams || []);
      if (results[2].status === "fulfilled") setRetention(results[2].value);
      if (results[3].status === "fulfilled") setAudit(results[3].value.entries || []);
      if (results[4].status === "fulfilled") setBackfill(results[4].value);
      if (results[5].status === "fulfilled") setRecovery(results[5].value);
      if (results[6].status === "fulfilled") setHealth(results[6].value);

      const failed = results.filter((r) => r.status === "rejected").length;
      setError(failed ? `${failed} admin panel(s) failed to load — retry` : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Admin API unavailable");
      // Keep shell visible — overview null still shows header/tabs
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg("");
    setError("");
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Layout title="Admin">
      <div className="mb-3 flex items-center justify-between gap-2" data-testid="admin-shell">
        <h1 className="font-display text-xl text-cyan">Administration</h1>
        <div className="flex gap-1">
          <button
            type="button"
            className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
            onClick={() => void load()}
            data-testid="admin-retry"
          >
            Retry
          </button>
          <Link to="/dashboard" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
            Exit
          </Link>
        </div>
      </div>

      {!overview && error ? (
        <div className="glass mb-3 rounded-2xl p-4 text-sm" data-testid="admin-api-error">
          <p className="text-magenta">{error}</p>
          <button type="button" className="btn-primary mt-3 text-xs" onClick={() => void load()}>
            Retry admin API
          </button>
        </div>
      ) : null}

      <div className="mb-3 flex gap-1 overflow-x-auto">
        {(
          [
            ["dash", "Dashboard"],
            ["users", "Users"],
            ["teams", "Teams"],
            ["retention", "Retention"],
            ["tools", "Tools"],
            ["audit", "Audit"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 rounded-xl px-3 py-2 text-xs font-semibold ${
              tab === id ? "bg-cyan/20 text-cyan" : "bg-white/5 text-muted"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="mb-2 text-sm text-magenta">{error}</p> : null}
      {msg ? <p className="mb-2 text-sm text-lime">{msg}</p> : null}

      {tab === "dash" && overview ? (
        <div className="space-y-3">
          {health ? (
            <section
              className="glass rounded-2xl p-4 text-sm"
              data-testid="admin-health"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-widest text-muted">
                  System health
                </p>
                <span
                  className={
                    health.status === "healthy"
                      ? "text-lime"
                      : health.status === "failed"
                        ? "text-magenta"
                        : "text-amber"
                  }
                  data-testid="health-status"
                >
                  {String(health.status)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  Live FX{" "}
                  <span className="text-cyan">{String(health.liveFixtures)}</span>
                </div>
                <div>
                  Stalled{" "}
                  <span className="text-cyan">{String(health.stalledFixtures)}</span>
                </div>
                <div className="col-span-2 text-muted">
                  Last catch-up: {String(health.lastCatchUpAt || "—")}
                  {health.lastCatchUpDurationMs != null
                    ? ` (${String(health.lastCatchUpDurationMs)}ms)`
                    : ""}
                </div>
                {health.lastCatchUpError ? (
                  <div className="col-span-2 text-magenta">
                    {String(health.lastCatchUpError)}
                  </div>
                ) : null}
                <div className="col-span-2 text-muted">
                  Retention: {String(health.lastRetentionAt || "—")} · Recovery:{" "}
                  {String(health.lastRecoveryAt || "—")}
                </div>
              </div>
            </section>
          ) : null}
          <section className="glass grid grid-cols-2 gap-2 rounded-2xl p-4 text-sm">
            <div>
              Users <span className="text-cyan">{String(overview.users)}</span>
            </div>
            <div>
              Managed <span className="text-cyan">{String(overview.managedTeams)}</span>
            </div>
            <div>
              Available <span className="text-cyan">{String(overview.availableTeams)}</span>
            </div>
            <div>
              Live FX <span className="text-cyan">{String(overview.liveFixtures)}</span>
            </div>
            <div className="col-span-2 text-xs text-muted">
              Tourney #{String((overview.tournament as { number?: number })?.number ?? "—")} ·{" "}
              {String((overview.tournament as { round?: string })?.round ?? "—")} · retention{" "}
              {String(overview.retentionDays)}d ·{" "}
              {overview.progressionPaused ? "PAUSED" : "running"}
            </div>
          </section>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => run(() => footfiveApi.adminCatchUp(), "Catch-up run")}
            >
              Catch up
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() =>
                run(
                  () =>
                    overview.progressionPaused
                      ? footfiveApi.adminResume()
                      : footfiveApi.adminPause(),
                  overview.progressionPaused ? "Resumed" : "Paused",
                )
              }
            >
              {overview.progressionPaused ? "Resume" : "Pause"}
            </button>
          </div>

          <section
            className="glass space-y-2 rounded-2xl p-4 text-sm"
            data-testid="admin-timing"
          >
            <p className="text-[11px] uppercase tracking-widest text-muted">
              Between-round timing
            </p>
            <p className="text-xs text-muted">
              Server: {String(overview.serverTime || "—")} · Next action:{" "}
              {String(overview.nextActionAt || "—")}
            </p>
            {overview.activeRound ? (
              <p className="text-xs text-cyan" data-testid="admin-active-round">
                Round:{" "}
                {String((overview.activeRound as { label?: string }).label || "")} ·{" "}
                {String((overview.activeRound as { status?: string }).status || "")} ·
                kickoff{" "}
                {String(
                  (overview.activeRound as { scheduledAt?: string }).scheduledAt || "—",
                )}
              </p>
            ) : null}
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted">Minutes between rounds</span>
              <input
                className="input !min-h-9 !w-24 !py-1 text-sm"
                type="number"
                min={1}
                max={1440}
                value={betweenMins}
                onChange={(e) => setBetweenMins(Number(e.target.value))}
                data-testid="between-round-minutes"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn-primary text-xs"
                data-testid="save-between-round"
                onClick={() =>
                  run(
                    () =>
                      footfiveApi.adminWorldSettings({
                        between_round_minutes: betweenMins,
                        reason: "admin_timing",
                      }),
                    `Saved ${betweenMins} min interval`,
                  )
                }
              >
                Save interval
              </button>
              <button
                type="button"
                className="btn-ghost text-xs"
                data-testid="apply-between-round"
                onClick={() =>
                  run(
                    () => footfiveApi.adminApplyBetweenRound("admin_apply_waiting"),
                    "Applied to waiting round",
                  )
                }
              >
                Apply to waiting round
              </button>
            </div>
            <p className="text-[11px] text-muted">
              Apply only works when the next round has not started. Live rounds are never
              rescheduled.
            </p>
          </section>

          <section
            className="glass space-y-2 rounded-2xl p-4 text-sm"
            data-testid="admin-match-speed"
          >
            <p className="text-[11px] uppercase tracking-widest text-muted">
              Real seconds per match minute
            </p>
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">Seconds</span>
              <input
                className="input !min-h-9 !w-24 !py-1 text-sm"
                type="number"
                min={1}
                max={60}
                value={matchSec}
                onChange={(e) => setMatchSec(Number(e.target.value))}
                data-testid="match-minute-seconds"
              />
            </label>
            <p className="text-xs text-cyan" data-testid="match-speed-estimate">
              {matchSec}s per match minute · 90′ ≈ {Math.round((90 * matchSec) / 60)}m{" "}
              {(90 * matchSec) % 60}s · ET (30′) ≈ {Math.round((30 * matchSec) / 60)}m{" "}
              {(30 * matchSec) % 60}s
            </p>
            <p className="text-[11px] text-muted">
              Applies to matches that have not started. Live fixtures keep their kickoff
              speed snapshot.
            </p>
            <button
              type="button"
              className="btn-primary text-xs"
              data-testid="save-match-speed"
              onClick={() =>
                run(
                  () =>
                    footfiveApi.adminWorldSettings({
                      match_minute_real_seconds: matchSec,
                      reason: "admin_match_speed",
                    }),
                  `Saved ${matchSec}s per match minute (next unstarted matches)`,
                )
              }
            >
              Save match speed
            </button>
          </section>
        </div>
      ) : null}

      {tab === "users" ? (
        <div className="space-y-2">
          <form
            className="glass space-y-2 rounded-2xl p-3 text-sm"
            onSubmit={(ev) => {
              ev.preventDefault();
              const fd = new FormData(ev.currentTarget);
              void run(
                () =>
                  footfiveApi.adminCreateUser({
                    email: String(fd.get("email") || ""),
                    password: String(fd.get("password") || ""),
                    display_name: String(fd.get("display_name") || ""),
                    reason: "admin create",
                  }),
                "User created",
              );
              ev.currentTarget.reset();
            }}
          >
            <p className="text-[11px] uppercase tracking-widest text-muted">Create user</p>
            <input
              name="email"
              type="email"
              required
              placeholder="email"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-sm"
            />
            <input
              name="display_name"
              placeholder="display name"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-sm"
            />
            <input
              name="password"
              type="password"
              required
              minLength={8}
              placeholder="initial password"
              className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-sm"
            />
            <button type="submit" className="btn-primary w-full text-xs">
              Create
            </button>
          </form>
          {users.map((u) => (
            <div key={String(u.id)} className="glass rounded-2xl p-3 text-sm">
              <div className="flex justify-between gap-2">
                <div>
                  <p className="font-semibold">{String(u.display_name || u.email)}</p>
                  <p className="text-xs text-muted">
                    {String(u.email)} · {String(u.role)} · credits {String(u.credits)}
                    {u.disabled ? " · DISABLED" : ""}
                  </p>
                  <p className="text-xs text-muted">
                    Team:{" "}
                    {(u.team as { name?: string } | null)?.name || "none"}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() =>
                    run(
                      () =>
                        footfiveApi.adminCredits(
                          String(u.id),
                          "add",
                          100,
                          "admin bonus",
                        ),
                      "Credits +100",
                    )
                  }
                >
                  +100 credits
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() =>
                    run(
                      () =>
                        u.disabled
                          ? footfiveApi.adminEnableUser(String(u.id), "enable")
                          : footfiveApi.adminDisableUser(String(u.id), "disable"),
                      u.disabled ? "Enabled" : "Disabled",
                    )
                  }
                >
                  {u.disabled ? "Enable" : "Disable"}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-magenta/20 px-2 py-1 text-[10px] text-magenta"
                  onClick={() => {
                    if (confirm(`Delete ${String(u.email)}?`)) {
                      void run(
                        () => footfiveApi.adminDeleteUser(String(u.id), "admin delete"),
                        "Deleted",
                      );
                    }
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() => {
                    const pw = prompt("New temporary password (min 8 chars)");
                    if (!pw || pw.length < 8) return;
                    if (!confirm(`Reset password for ${String(u.email)}?`)) return;
                    void run(
                      () =>
                        footfiveApi.adminResetPassword(
                          String(u.id),
                          pw,
                          true,
                          "admin password reset",
                        ),
                      "Password reset (not shown)",
                    );
                  }}
                >
                  Reset password
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "teams" ? (
        <div className="space-y-2">
          {teams.map((t) => (
            <div key={String(t.id)} className="glass rounded-2xl p-3 text-sm">
              <p className="font-semibold">{String(t.name)}</p>
              <p className="text-xs text-muted">
                {t.managerName ? String(t.managerName) : "AI"} · treasury{" "}
                {String(t.treasury)}
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() =>
                    run(
                      () =>
                        footfiveApi.adminTreasury(
                          String(t.id),
                          "add",
                          500,
                          "admin top-up",
                        ),
                      "Treasury +500",
                    )
                  }
                >
                  +500 treasury
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() =>
                    run(
                      () => footfiveApi.adminReleaseTeam(String(t.id), "admin release"),
                      "Released",
                    )
                  }
                >
                  Release manager
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-white/10 px-2 py-1 text-[10px]"
                  onClick={() =>
                    run(
                      () =>
                        footfiveApi.adminResetTeam(String(t.id), "energy", "admin energy"),
                      "Energy reset",
                    )
                  }
                >
                  Reset energy
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "retention" && retention ? (
        <div className="space-y-3">
          <section className="glass rounded-2xl p-4 text-sm">
            <p>
              Policy:{" "}
              {retention.never
                ? "Never delete"
                : `${String(retention.retention_days)} days`}
            </p>
            <p className="text-xs text-muted">
              Summaries {String(retention.match_summaries)} · purged{" "}
              {String(retention.events_purged)}
            </p>
            <p className="text-xs text-muted">
              Last run: {String(retention.last_retention_at || "never")}
            </p>
          </section>
          <div className="flex flex-wrap gap-2">
            {[0, 7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                className="btn-ghost !min-h-9 text-xs"
                onClick={() =>
                  run(
                    () =>
                      footfiveApi.adminWorldSettings({
                        retention_days: d,
                        reason: "set retention",
                      }),
                    `Retention ${d || "never"}`,
                  )
                }
              >
                {d === 0 ? "Never" : `${d}d`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost w-full text-xs"
            onClick={() =>
              run(() => footfiveApi.adminRetentionPreview(), "Preview done (no delete)")
            }
          >
            Preview cleanup
          </button>
          <button
            type="button"
            className="btn-primary w-full text-xs"
            onClick={() => {
              if (confirm("Run retention cleanup now?")) {
                void run(() => footfiveApi.adminRetentionRun(), "Cleanup run");
              }
            }}
          >
            Run cleanup
          </button>
          <p className="text-xs text-muted">
            Backup: stop PocketBase, copy <code>pocketbase/pb_data/</code>, restart. Never commit
            pb_data. Restore by replacing pb_data from backup.
          </p>
        </div>
      ) : null}

      {tab === "tools" ? (
        <div className="space-y-4">
          <section className="glass space-y-2 rounded-2xl p-4 text-sm">
            <p className="text-[11px] uppercase tracking-widest text-muted">Backfill</p>
            {backfill ? (
              <p className="text-xs text-muted">
                Finalised states {String(backfill.finalised_match_states)} · summaries{" "}
                {String(backfill.match_summaries)} · missing ~{" "}
                {String(backfill.estimated_missing_summaries)}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-ghost w-full text-xs"
              onClick={() =>
                run(() => footfiveApi.adminBackfillPreview(), "Backfill preview")
              }
            >
              Preview backfill
            </button>
            <button
              type="button"
              className="btn-primary w-full text-xs"
              onClick={() => {
                if (confirm("Run historical backfill? Idempotent; no fabrication.")) {
                  void run(() => footfiveApi.adminBackfillRun(), "Backfill run");
                }
              }}
            >
              Run backfill
            </button>
          </section>
          <section className="glass space-y-2 rounded-2xl p-4 text-sm">
            <p className="text-[11px] uppercase tracking-widest text-muted">Stall recovery</p>
            {recovery ? (
              <p className="text-xs text-muted">
                Stalls:{" "}
                {recovery.hasStalls
                  ? `${((recovery.stalledMatches as unknown[]) || []).length} matches, ${((recovery.stalledRounds as unknown[]) || []).length} rounds`
                  : "none detected"}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-ghost w-full text-xs"
              onClick={() =>
                run(() => footfiveApi.adminRecoveryStatus().then(setRecovery), "Status refreshed")
              }
            >
              Refresh stall status
            </button>
            <button
              type="button"
              className="btn-ghost w-full text-xs"
              onClick={() => {
                if (confirm("Clear stale world processing lock?")) {
                  void run(() => footfiveApi.adminClearLock(), "Lock cleared");
                }
              }}
            >
              Clear world lock
            </button>
            <button
              type="button"
              className="btn-primary w-full text-xs"
              onClick={() => {
                if (confirm("Run global recovery (catch-up + clear stale locks)?")) {
                  void run(() => footfiveApi.adminRecoveryRun(), "Recovery run");
                }
              }}
            >
              Run recovery
            </button>
          </section>
        </div>
      ) : null}

      {tab === "audit" ? (
        <ul className="space-y-2 text-xs">
          {audit.map((a) => (
            <li key={String(a.id)} className="glass rounded-xl p-2">
              <span className="text-cyan">{String(a.action)}</span>{" "}
              <span className="text-muted">
                {String(a.target_type)} {String(a.target_id)}
              </span>
              <div className="text-muted">{String(a.created)}</div>
            </li>
          ))}
        </ul>
      ) : null}
    </Layout>
  );
}
