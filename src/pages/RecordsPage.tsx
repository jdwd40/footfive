import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

type Tab = "overview" | "teams" | "players" | "tournaments" | "matches" | "betting";

export default function RecordsPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [teams, setTeams] = useState<Array<Record<string, unknown>>>([]);
  const [players, setPlayers] = useState<Array<Record<string, unknown>>>([]);
  const [tournaments, setTournaments] = useState<Array<Record<string, unknown>>>([]);
  const [matches, setMatches] = useState<Array<Record<string, unknown>>>([]);
  const [betting, setBetting] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        if (tab === "overview") {
          setOverview(await footfiveApi.recordsOverview());
        } else if (tab === "teams") {
          const r = await footfiveApi.recordsTeams();
          setTeams(r.teams || []);
        } else if (tab === "players") {
          const r = await footfiveApi.recordsPlayers("all=1");
          setPlayers(r.players || []);
        } else if (tab === "tournaments") {
          const r = await footfiveApi.recordsTournaments();
          setTournaments(r.tournaments || []);
        } else if (tab === "matches") {
          const r = await footfiveApi.recordsMatches();
          setMatches(r.matches || []);
        } else if (tab === "betting") {
          setBetting(await footfiveApi.betsHistory());
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
      }
    })();
  }, [tab]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "teams", label: "Teams" },
    { id: "players", label: "Players" },
    { id: "tournaments", label: "Tournaments" },
    { id: "matches", label: "Archive" },
    { id: "betting", label: "My bets" },
  ];

  const hl = (overview?.highlights || {}) as Record<
    string,
    { name?: string; championships?: number; wins?: number; goals_for?: number; goals?: number }
  >;

  return (
    <Layout title="Records">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="font-display text-xl text-white">Proball records</h1>
        <Link to="/dashboard" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
          Home
        </Link>
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`shrink-0 rounded-xl px-3 py-2 text-xs font-semibold uppercase ${
              tab === t.id ? "bg-cyan/20 text-cyan" : "bg-white/5 text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? <p className="mb-2 text-sm text-magenta">{error}</p> : null}

      {tab === "overview" && overview ? (
        <div className="space-y-3">
          <section className="glass rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-widest text-muted">Current</p>
            <p className="text-sm">
              Tournament #
              {(overview.currentTournament as { number?: number })?.number ?? "—"} ·{" "}
              {(overview.currentTournament as { round?: string })?.round ?? "—"}
            </p>
            <p className="text-xs text-muted">
              Completed: {String(overview.completedTournaments ?? 0)}
            </p>
          </section>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ["Most titles", hl.mostChampionships?.name, hl.mostChampionships?.championships],
                ["Most wins", hl.mostWins?.name, hl.mostWins?.wins],
                ["Most goals", hl.mostGoals?.name, hl.mostGoals?.goals_for],
                [
                  "Top scorer",
                  hl.leadingScorer?.name,
                  hl.leadingScorer?.goals ?? hl.leadingScorer?.goals_for,
                ],
              ] as const
            ).map(([label, name, val]) => (
              <div key={label} className="glass rounded-xl p-3">
                <p className="text-[10px] uppercase text-muted">{label}</p>
                <p className="font-semibold">{name || "—"}</p>
                <p className="text-cyan">{val ?? 0}</p>
              </div>
            ))}
          </div>
          <section className="glass rounded-2xl p-4">
            <p className="mb-2 text-[11px] uppercase tracking-widest text-muted">
              Recent champions
            </p>
            <ul className="space-y-1 text-sm">
              {((overview.recentChampions as Array<Record<string, unknown>>) || []).map(
                (c, i) => (
                  <li key={i} className="flex justify-between border-b border-white/5 py-1">
                    <span>#{String(c.number)}</span>
                    <span className="text-lime">{String(c.champion || "—")}</span>
                  </li>
                ),
              )}
              {!((overview.recentChampions as unknown[]) || []).length ? (
                <li className="text-muted">No completed tournaments yet</li>
              ) : null}
            </ul>
          </section>
        </div>
      ) : null}

      {tab === "teams" ? (
        <div className="space-y-2">
          {teams.map((t) => (
            <Link
              key={String(t.id)}
              to={`/records/teams/${String(t.id)}`}
              className="glass block rounded-2xl p-3"
            >
              <div className="flex justify-between gap-2">
                <div>
                  <p className="font-semibold">{String(t.name)}</p>
                  <p className="text-xs text-muted">
                    {String(t.grade)} ·{" "}
                    {t.managerName ? String(t.managerName) : "AI controlled"}
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-lime">{String(t.championships)} titles</p>
                  <p className="text-muted">
                    {String(t.wins)}W {String(t.draws)}D {String(t.losses)}L
                  </p>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted">
                GF {String(t.goals_for)} GA {String(t.goals_against)} · pens W{" "}
                {String(t.shootout_wins)} · treasury{" "}
                {Number(t.treasury || 0).toLocaleString("en-GB")}
              </p>
            </Link>
          ))}
        </div>
      ) : null}

      {tab === "players" ? (
        <div className="space-y-2">
          {players.map((p) => (
            <div key={String(p.id)} className="glass rounded-2xl p-3 text-sm">
              <div className="flex justify-between gap-2">
                <div>
                  <p className="font-semibold">{String(p.name)}</p>
                  <p className="text-xs text-muted">
                    {String(p.teamName)} · {String(p.role)}
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-lime">{String(p.goals)} goals</p>
                  <p className="text-muted">
                    {String(p.appearances)} apps · Y{String(p.yellowCards)} R
                    {String(p.redCards)}
                  </p>
                </div>
              </div>
            </div>
          ))}
          {!players.length ? (
            <p className="text-sm text-muted">Player stats fill in as matches complete</p>
          ) : null}
        </div>
      ) : null}

      {tab === "tournaments" ? (
        <div className="space-y-2">
          {tournaments.map((t) => (
            <Link
              key={String(t.id)}
              to={`/records/tournaments/${String(t.tournamentId || t.id)}`}
              className="glass block rounded-2xl p-3"
            >
              <p className="font-display text-cyan">Tournament #{String(t.number)}</p>
              <p className="text-sm">
                Champion: <span className="text-lime">{String(t.champion || "—")}</span>
              </p>
              <p className="text-xs text-muted">
                Runner-up {String(t.runnerUp || "—")} · goals {String(t.totalGoals)} · ET{" "}
                {String(t.extraTimeMatches)} · SO {String(t.shootoutMatches)}
              </p>
            </Link>
          ))}
          {!tournaments.length ? (
            <p className="text-sm text-muted">No tournament summaries yet</p>
          ) : null}
        </div>
      ) : null}

      {tab === "matches" ? (
        <div className="space-y-2">
          {matches.map((m) => (
            <Link
              key={String(m.id)}
              to={`/records/matches/${String(m.id)}`}
              className="glass block rounded-2xl p-3 text-sm"
            >
              <div className="flex justify-between gap-2">
                <span className="font-semibold">
                  {String(m.homeName)} {String(m.scoreHome)}–{String(m.scoreAway)}{" "}
                  {String(m.awayName)}
                </span>
                <span className="text-xs text-muted">{String(m.roundKey)}</span>
              </div>
              {m.wentShootout ? (
                <p className="text-xs text-amber">
                  pens {String(m.shootoutHome)}–{String(m.shootoutAway)}
                </p>
              ) : null}
              {m.eventsPurged ? (
                <p className="text-[10px] text-muted">Compact summary only</p>
              ) : null}
            </Link>
          ))}
          {!matches.length ? (
            <p className="text-sm text-muted">No archived matches yet</p>
          ) : null}
        </div>
      ) : null}

      {tab === "betting" && betting ? (
        <div className="space-y-3">
          <section className="glass rounded-2xl p-4">
            <p className="text-sm">
              Balance: <span className="text-cyan">{String(betting.balance)}</span>
            </p>
            <p className="text-xs text-muted">
              Net betting: {String(betting.netBetting)}
            </p>
          </section>
          <ul className="space-y-2">
            {((betting.bets as Array<Record<string, unknown>>) || []).map((b) => (
              <li key={String(b.id)} className="glass rounded-xl p-3 text-sm">
                <div className="flex justify-between">
                  <span>
                    {String(b.stake)} @ {String(b.odds)}
                  </span>
                  <span className="text-muted">{String(b.status)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Layout>
  );
}
