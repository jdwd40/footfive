import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

export default function MatchDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    footfiveApi
      .recordsMatchDetail(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [id]);

  if (error) {
    return (
      <Layout title="Match">
        <p className="text-magenta">{error}</p>
      </Layout>
    );
  }
  if (!data) {
    return (
      <Layout title="Match">
        <p className="text-muted">Loading…</p>
      </Layout>
    );
  }

  if (data.missing) {
    return (
      <Layout title="Match">
        <p className="text-muted">Compact archive only / summary not found.</p>
        <Link to="/records" className="btn-ghost mt-2 inline-block text-xs">
          Back
        </Link>
      </Layout>
    );
  }

  const goals = (data.goals as Array<Record<string, unknown>>) || [];
  const cards = (data.cards as Array<Record<string, unknown>>) || [];
  const kicks = (data.shootoutKicks as Array<Record<string, unknown>>) || [];
  const events = (data.events as Array<Record<string, unknown>>) || [];

  return (
    <Layout title="Match">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] uppercase text-muted">
            {String(data.roundKey)} · {String(data.tournamentId || "").slice(0, 8)}
          </p>
          <h1 className="font-display text-lg text-white">
            {String(data.homeName)}{" "}
            <span className="text-cyan">
              {String(data.scoreHome)}–{String(data.scoreAway)}
            </span>{" "}
            {String(data.awayName)}
          </h1>
          {data.wentShootout ? (
            <p className="text-sm text-amber">
              pens {String(data.shootoutHome)}–{String(data.shootoutAway)}
            </p>
          ) : null}
          {data.wentExtraTime ? (
            <p className="text-xs text-muted">Extra time</p>
          ) : null}
          {data.eventsPurged ? (
            <p className="text-xs text-muted">Detailed timeline purged — compact summary</p>
          ) : null}
        </div>
        <Link to="/records" className="btn-ghost !min-h-9 !px-3 text-xs">
          Back
        </Link>
      </div>

      <section className="glass mb-3 rounded-2xl p-3">
        <h2 className="mb-2 text-[11px] uppercase text-muted">Goals</h2>
        <ul className="space-y-1 text-sm">
          {goals.map((g, i) => (
            <li key={i}>
              {String(g.minute)}&apos; {String(g.player || "?")} ({String(g.team)})
            </li>
          ))}
          {!goals.length ? <li className="text-muted">None recorded</li> : null}
        </ul>
      </section>

      <section className="glass mb-3 rounded-2xl p-3">
        <h2 className="mb-2 text-[11px] uppercase text-muted">Cards</h2>
        <ul className="space-y-1 text-sm">
          {cards.map((c, i) => (
            <li key={i}>
              {String(c.minute)}&apos; {String(c.type)} {String(c.player || "?")}
            </li>
          ))}
          {!cards.length ? <li className="text-muted">None</li> : null}
        </ul>
      </section>

      {kicks.length ? (
        <section className="glass mb-3 rounded-2xl p-3">
          <h2 className="mb-2 text-[11px] uppercase text-muted">Shootout kicks</h2>
          <ul className="space-y-1 text-sm">
            {kicks.map((k, i) => (
              <li key={i}>
                #{String(k.kickIndex)} {String(k.team)} {String(k.player)} —{" "}
                {String(k.outcome)}
                {k.decisive ? " · decisive" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!data.eventsPurged && events.length ? (
        <section className="glass rounded-2xl p-3">
          <h2 className="mb-2 text-[11px] uppercase text-muted">Events (retained)</h2>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {events.map((ev, i) => (
              <li key={i} className="border-b border-white/5 py-1">
                {String(ev.minute ?? "")}&apos; {String(ev.message || ev.type)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}
