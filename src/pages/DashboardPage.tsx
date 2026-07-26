import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";
import { footfiveApi, type WorldSnapshot } from "../lib/pocketbase";

export default function DashboardPage() {
  const { isAdmin } = useAuth();
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [bets, setBets] = useState<
    Array<{ id: string; stake: number; odds: number; status: string }>
  >([]);
  const [finances, setFinances] = useState<
    Array<{ amount: number; type: string; description: string }>
  >([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [w, b] = await Promise.all([footfiveApi.world(), footfiveApi.myBets()]);
      setWorld(w);
      setBets(b.bets.slice(0, 5));
      if (!w.isSpectator) {
        try {
          const fin = await footfiveApi.teamFinances();
          setFinances(fin.entries.slice(0, 5));
        } catch {
          setFinances([]);
        }
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const cc = (world as WorldSnapshot & { commandCharge?: { points: number; max: number } })
    ?.commandCharge;
  const av = (world as WorldSnapshot & { squadAverages?: { energy: number; condition: number } })
    ?.squadAverages;
  const treasury = (world as WorldSnapshot & { teamTreasury?: number })?.teamTreasury;

  return (
    <Layout title="Proball">
      {error ? <p className="text-sm text-magenta">{error}</p> : null}
      <section className="glass rounded-2xl p-5">
        <p className="text-xs uppercase tracking-widest text-muted">Shared world</p>
        <h1 className="font-display mt-1 text-2xl text-cyan">
          {world?.managedTeam?.name || "Spectator"}
        </h1>
        <div className="mt-2 space-y-1 text-sm text-muted">
          <p>
            <span className="text-white">Betting credits:</span> {world?.credits ?? "—"}{" "}
            <span className="text-xs">(personal)</span>
          </p>
          {!world?.isSpectator ? (
            <p>
              <span className="text-white">Team treasury:</span> {treasury ?? "—"}{" "}
              <span className="text-xs">(squad funds)</span>
            </p>
          ) : null}
          {av ? (
            <p>
              Squad Energy {av.energy} · Condition {av.condition}
            </p>
          ) : null}
          {cc ? (
            <p>
              Command Charge {cc.points}/{cc.max}
            </p>
          ) : null}
        </div>

        {world?.activeRound ? (
          <div className="mt-4 rounded-xl border border-cyan/20 bg-ink/40 p-3">
            <div className="text-sm font-semibold text-white">
              Tournament #{world.tournament?.number} · {world.activeRound.label}
            </div>
            <div className="text-xs text-muted">
              Status: {world.activeRound.status}
              {world.activeRound.scheduledAt
                ? ` · kickoff ${world.activeRound.scheduledAt}`
                : ""}
            </div>
            <div className="mt-1 text-xs text-muted">
              Management:{" "}
              {world.managementOpen ? (
                <span className="text-lime">open</span>
              ) : (
                <span className="text-amber">locked</span>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">Waiting for next Proball tournament…</p>
        )}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Link to="/scoreboard" className="btn-primary flex-1 text-center">
            Live scoreboard
          </Link>
          {!world?.isSpectator ? (
            <Link to="/squad" className="btn-ghost flex-1 text-center">
              Manage squad
            </Link>
          ) : (
            <Link to="/career/new" className="btn-ghost flex-1 text-center">
              Claim team
            </Link>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Link to="/betting" className="btn-ghost flex-1 text-center text-xs">
            Betting
          </Link>
          <Link to="/records" className="btn-ghost flex-1 text-center text-xs">
            Records
          </Link>
          <button
            type="button"
            className="btn-ghost flex-1 text-xs"
            onClick={async () => {
              await footfiveApi.catchUp();
              await load();
            }}
          >
            Catch up
          </button>
        </div>
        {isAdmin ? (
          <div className="mt-3">
            <Link
              to="/admin"
              className="btn-primary flex w-full items-center justify-center gap-2 text-center"
              data-testid="dashboard-admin-link"
            >
              Administration console
            </Link>
          </div>
        ) : null}
      </section>

      {finances.length ? (
        <section className="glass mt-4 rounded-2xl p-4">
          <p className="mb-2 text-[11px] uppercase tracking-widest text-muted">
            Recent team finances
          </p>
          <ul className="space-y-1 text-sm">
            {finances.map((f, i) => (
              <li key={i} className="flex justify-between gap-2 border-b border-white/5 py-1">
                <span className="truncate text-muted">{f.description || f.type}</span>
                <span className={f.amount >= 0 ? "text-lime" : "text-magenta"}>
                  {f.amount >= 0 ? "+" : ""}
                  {f.amount}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {bets.length ? (
        <section className="glass mt-4 rounded-2xl p-4">
          <p className="mb-2 text-[11px] uppercase tracking-widest text-muted">Your bets</p>
          <ul className="space-y-1 text-sm">
            {bets.map((b) => (
              <li key={b.id} className="flex justify-between gap-2 border-b border-white/5 py-1">
                <span>
                  {b.stake} @ {b.odds}
                </span>
                <span className="text-muted">{b.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}
