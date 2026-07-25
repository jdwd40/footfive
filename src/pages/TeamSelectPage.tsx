import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import TeamBadge from "../components/TeamBadge";
import { footfiveApi, type TeamPublic } from "../lib/pocketbase";

export default function TeamSelectPage() {
  const nav = useNavigate();
  const [teams, setTeams] = useState<TeamPublic[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [managedId, setManagedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [world, res] = await Promise.all([footfiveApi.world(), footfiveApi.teams()]);
        if (cancelled) return;
        if (world.managedTeam) {
          setManagedId(world.managedTeam.id);
        }
        setTeams(res.teams);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load teams");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function claim(teamId: string) {
    setBusy(true);
    setError("");
    try {
      await footfiveApi.claimTeam(teamId);
      nav("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
      const res = await footfiveApi.teams();
      setTeams(res.teams);
    } finally {
      setBusy(false);
    }
  }

  const available = teams.filter((t) => t.available);
  const taken = teams.filter((t) => !t.available);

  return (
    <Layout title="Claim team">
      <div className="mb-4 space-y-2">
        <h1 className="font-display text-2xl text-white">Shared Proball squads</h1>
        <p className="text-sm text-muted">
          One global championship. Claim any free team (one manager per side) or continue as a
          spectator.
        </p>
        {managedId ? (
          <p className="text-sm text-lime">You already manage a team.</p>
        ) : available.length === 0 ? (
          <p className="text-sm text-amber">All 16 teams are claimed — you can still watch & bet.</p>
        ) : null}
      </div>
      {error ? <p className="mb-3 text-sm text-magenta">{error}</p> : null}

      <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">Available</h2>
      <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {available.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={busy || !!managedId}
            onClick={() => claim(t.id)}
            className="glass flex items-center gap-3 rounded-2xl p-3 text-left transition active:scale-[0.99]"
          >
            <TeamBadge badgeKey={t.badge_key} color={t.primary_color} name={t.name} size={44} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{t.name}</div>
              <div className="text-xs text-muted">
                Grade {t.grade} · STR {t.strength}
              </div>
            </div>
            <span className="text-xs font-semibold text-lime">Claim</span>
          </button>
        ))}
        {!available.length ? (
          <p className="text-sm text-muted">No free teams right now.</p>
        ) : null}
      </div>

      <h2 className="mb-2 text-xs uppercase tracking-widest text-muted">Managed</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {taken.map((t) => (
          <div key={t.id} className="glass flex items-center gap-3 rounded-2xl p-3 opacity-90">
            <TeamBadge badgeKey={t.badge_key} color={t.primary_color} name={t.name} size={44} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{t.name}</div>
              <div className="text-xs text-muted">
                {t.managerName || "Manager"} · {t.grade}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-3 mt-4 flex flex-col gap-2">
        <button type="button" className="btn-ghost w-full" onClick={() => nav("/dashboard")}>
          Continue as spectator
        </button>
        {managedId ? (
          <button type="button" className="btn-primary w-full" onClick={() => nav("/dashboard")}>
            Enter dashboard
          </button>
        ) : null}
      </div>
    </Layout>
  );
}
