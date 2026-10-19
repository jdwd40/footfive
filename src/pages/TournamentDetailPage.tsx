import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

const ROUND_ORDER = ["r16", "qf", "sf", "final"] as const;
const ROUND_LABEL: Record<string, string> = {
  r16: "Round of 16",
  qf: "Quarter-finals",
  sf: "Semi-finals",
  final: "Final",
};

export default function TournamentDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    footfiveApi
      .recordsTournamentDetail(id)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed"));
  }, [id]);

  if (error) {
    return (
      <Layout title="Tournament">
        <p className="text-magenta">{error}</p>
        <Link to="/records" className="btn-ghost mt-2 inline-block text-xs">
          Back
        </Link>
      </Layout>
    );
  }
  if (!data) {
    return (
      <Layout title="Tournament">
        <p className="text-muted">Loading…</p>
      </Layout>
    );
  }

  const rounds = (data.rounds || {}) as Record<string, Array<Record<string, unknown>>>;
  // Matches outside the standard rounds (legacy or missing round keys, grouped as "other") follow them.
  const otherRounds = Object.keys(rounds).filter((k) => !(ROUND_ORDER as readonly string[]).includes(k));
  const top = data.topScorer as { name?: string; goals?: number } | null;

  return (
    <Layout title={`Tournament #${String(data.number)}`}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-xl text-cyan">
            Tournament #{String(data.number)}
          </h1>
          <p className="text-sm">
            Champion: <span className="text-lime">{String(data.champion || "—")}</span>
          </p>
          <p className="text-xs text-muted">
            Runner-up {String(data.runnerUp || "—")} · goals {String(data.totalGoals)} · ET{" "}
            {String(data.extraTimeMatches)} · SO {String(data.shootoutMatches)}
          </p>
          {top ? (
            <p className="text-xs text-muted">
              Top scorer: {top.name} ({top.goals})
            </p>
          ) : null}
        </div>
        <Link to="/records" className="btn-ghost !min-h-9 !px-3 text-xs">
          Records
        </Link>
      </div>

      {/* Mobile-first vertical bracket */}
      <div className="space-y-4">
        {[...ROUND_ORDER, ...otherRounds].map((rk) => {
          const list = rounds[rk] || [];
          if (!list.length) return null;
          return (
            <section key={rk}>
              <h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted">
                {ROUND_LABEL[rk] || (rk === "other" ? "Other rounds" : rk)}
              </h2>
              <ul className="space-y-2">
                {list.map((m) => (
                  <li key={String(m.id)}>
                    <Link
                      to={`/records/matches/${String(m.id)}`}
                      className="glass block rounded-2xl p-3 text-sm"
                    >
                      <div className="flex justify-between gap-2 font-semibold">
                        <span className="min-w-0 truncate">{String(m.homeName)}</span>
                        <span className="shrink-0 tabular-nums text-cyan">
                          {String(m.scoreHome)}–{String(m.scoreAway)}
                        </span>
                        <span className="min-w-0 truncate text-right">{String(m.awayName)}</span>
                      </div>
                      {m.wentShootout ? (
                        <p className="mt-1 text-center text-xs text-amber">
                          pens {String(m.shootoutHome)}–{String(m.shootoutAway)}
                        </p>
                      ) : null}
                      {!ROUND_LABEL[rk] && m.roundKey && String(m.roundKey) !== rk ? (
                        <p className="mt-1 text-center text-xs text-muted">{String(m.roundKey)}</p>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Layout>
  );
}
