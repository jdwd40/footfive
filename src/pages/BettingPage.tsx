import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi, type TeamPublic } from "../lib/pocketbase";

type BetFx = {
  fixtureId: string;
  home: TeamPublic;
  away: TeamPublic;
  scheduledAt: string;
  homeOdds: number;
  awayOdds: number;
};

export default function BettingPage() {
  const [fixtures, setFixtures] = useState<BetFx[]>([]);
  const [credits, setCredits] = useState(0);
  const [stake, setStake] = useState(50);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [fx, world] = await Promise.all([
      footfiveApi.bettingFixtures(),
      footfiveApi.world(),
    ]);
    setFixtures(fx.fixtures);
    setCredits(world.credits);
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, []);

  async function bet(fixtureId: string, selectionTeamId: string) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const res = await footfiveApi.placeBet(fixtureId, selectionTeamId, stake);
      setMsg(`Bet placed: ${res.bet.stake} @ ${res.bet.odds}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bet failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Betting">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-xl text-white">Winner bets</h1>
          <p className="text-xs text-muted">
            Fictional credits only · Balance: {credits}
          </p>
        </div>
        <Link to="/dashboard" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
          Dashboard
        </Link>
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm text-muted">
        Stake
        <input
          className="input !min-h-9 !w-24 !py-1"
          type="number"
          min={1}
          value={stake}
          onChange={(e) => setStake(parseInt(e.target.value, 10) || 0)}
        />
      </label>
      {error ? <p className="mb-2 text-sm text-magenta">{error}</p> : null}
      {msg ? <p className="mb-2 text-sm text-lime">{msg}</p> : null}
      <div className="flex flex-col gap-2">
        {fixtures.map((f) => (
          <div key={f.fixtureId} className="glass rounded-2xl p-3">
            <div className="mb-2 text-center text-sm font-semibold">
              {f.home.name} vs {f.away.name}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                className="btn-ghost text-xs"
                onClick={() => bet(f.fixtureId, f.home.id)}
              >
                {f.home.name.split(" ").slice(-1)[0]} @ {f.homeOdds}
              </button>
              <button
                type="button"
                disabled={busy}
                className="btn-ghost text-xs"
                onClick={() => bet(f.fixtureId, f.away.id)}
              >
                {f.away.name.split(" ").slice(-1)[0]} @ {f.awayOdds}
              </button>
            </div>
          </div>
        ))}
        {!fixtures.length ? (
          <p className="text-sm text-muted">No open fixtures to bet on (or only your own match).</p>
        ) : null}
      </div>
    </Layout>
  );
}
