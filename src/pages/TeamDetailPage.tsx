import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

export default function TeamDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    footfiveApi
      .recordsTeamDetail(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [id]);

  if (error) {
    return (
      <Layout title="Team">
        <p className="text-magenta">{error}</p>
        <Link to="/records" className="btn-ghost mt-2 inline-block text-xs">
          Back
        </Link>
      </Layout>
    );
  }
  if (!data) {
    return (
      <Layout title="Team">
        <p className="text-muted">Loading…</p>
      </Layout>
    );
  }

  const squad = (data.squad as Array<Record<string, unknown>>) || [];
  const form = (data.recentForm as string[]) || [];
  const matches = (data.recentMatches as Array<Record<string, unknown>>) || [];
  const finance = (data.finance as Array<Record<string, unknown>>) || [];

  return (
    <Layout title={String(data.name)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-xl text-white">{String(data.name)}</h1>
          <p className="text-xs text-muted">
            {String(data.grade)} ·{" "}
            {data.aiControlled ? "AI controlled" : String(data.managerName || "Manager")}
          </p>
        </div>
        <Link to="/records" className="btn-ghost !min-h-9 !px-3 text-xs">
          Records
        </Link>
      </div>

      <section className="glass mb-3 grid grid-cols-2 gap-2 rounded-2xl p-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-[10px] uppercase text-muted">Titles</p>
          <p className="text-lime">{String(data.championships)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-muted">Record</p>
          <p>
            {String(data.wins)}W {String(data.draws)}D {String(data.losses)}L
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-muted">Goals</p>
          <p>
            {String(data.goals_for)}:{String(data.goals_against)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-muted">Treasury</p>
          <p className="text-cyan">
            {Number(data.treasury || 0).toLocaleString("en-GB")}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-muted">Finals</p>
          <p>{String(data.finals_reached || 0)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase text-muted">Pens</p>
          <p>
            {String(data.shootout_wins)}W / {String(data.shootout_losses)}L
          </p>
        </div>
        <div className="col-span-2">
          <p className="text-[10px] uppercase text-muted">Form</p>
          <p className="tracking-widest">{form.join(" ") || "—"}</p>
        </div>
      </section>

      {data.biggestWin ? (
        <p className="mb-3 text-xs text-muted">
          Biggest win:{" "}
          <span className="text-white">
            {(data.biggestWin as { score?: string; opponent?: string }).score} vs{" "}
            {(data.biggestWin as { opponent?: string }).opponent}
          </span>
        </p>
      ) : null}

      <h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted">Squad</h2>
      <ul className="mb-4 space-y-2">
        {squad.map((p) => (
          <li key={String(p.id)} className="glass rounded-xl p-3 text-sm">
            <div className="flex justify-between gap-2">
              <div>
                <span className="font-semibold">{String(p.name)}</span>
                <span className="ml-2 text-xs text-muted">
                  {String(p.role)}
                  {p.is_starter ? " · XI" : " · sub"}
                </span>
              </div>
              <span className="text-xs text-lime">{String(p.goals)}g</span>
            </div>
            <p className="text-xs text-muted">
              ATK {String(p.attack)} DEF {String(p.defence)} · E{String(p.energy)} C
              {String(p.condition)} · apps {String(p.appearances)}
            </p>
          </li>
        ))}
      </ul>

      <h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted">
        Recent matches
      </h2>
      <ul className="mb-4 space-y-1 text-sm">
        {matches.slice(0, 8).map((m) => (
          <li key={String(m.id)}>
            <Link
              to={`/records/matches/${String(m.id)}`}
              className="flex justify-between rounded-lg px-2 py-1.5 hover:bg-white/5"
            >
              <span>
                {String(m.homeName)} {String(m.scoreHome)}–{String(m.scoreAway)}{" "}
                {String(m.awayName)}
              </span>
              <span className="text-xs text-muted">{String(m.roundKey)}</span>
            </Link>
          </li>
        ))}
        {!matches.length ? <li className="text-muted">No archived matches</li> : null}
      </ul>

      <h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted">Finance</h2>
      <ul className="space-y-1 text-xs">
        {finance.slice(0, 8).map((f, i) => (
          <li key={i} className="flex justify-between border-b border-white/5 py-1">
            <span>{String(f.description || f.type)}</span>
            <span className={Number(f.amount) >= 0 ? "text-lime" : "text-magenta"}>
              {Number(f.amount).toLocaleString("en-GB")}
            </span>
          </li>
        ))}
        {!finance.length ? <li className="text-muted">No ledger entries</li> : null}
      </ul>
    </Layout>
  );
}
