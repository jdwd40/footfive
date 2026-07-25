import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import FixtureCard from "../components/FixtureCard";
import { useRoundStore } from "../hooks/useRoundStore";
import { useEffect, useState } from "react";
import { footfiveApi } from "../lib/pocketbase";

export default function ScoreboardPage() {
  const { board, fixtures, round, error, refresh } = useRoundStore();
  const [managedId, setManagedId] = useState<string | null>(null);

  useEffect(() => {
    footfiveApi
      .world()
      .then((w) => setManagedId(w.managedTeam?.id ?? null))
      .catch(() => {});
  }, []);

  return (
    <Layout title="Scoreboard">
      <div className="mb-3 flex items-center justify-between gap-2" data-testid="scoreboard-page">
        <div className="min-w-0">
          <h1 className="font-display truncate text-xl text-white">
            {round?.label || "Current round"}
          </h1>
          <p className="text-xs text-muted">
            Shared Proball · {round?.status || "loading"}
            {board?.serverTime
              ? ` · ${new Date(board.serverTime).toLocaleTimeString()}`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
            onClick={() => refresh()}
          >
            Refresh
          </button>
          <Link to="/dashboard" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
            Home
          </Link>
        </div>
      </div>
      {error ? <p className="mb-3 text-sm text-magenta">{error}</p> : null}
      <div className="flex flex-col gap-2" data-testid="fixture-list">
        {fixtures.map((f) => (
          <FixtureCard key={f.fixtureId} fixture={f} managedTeamId={managedId} />
        ))}
        {!fixtures.length && !error ? (
          <p className="text-sm text-muted">Waiting for fixtures…</p>
        ) : null}
      </div>
    </Layout>
  );
}
