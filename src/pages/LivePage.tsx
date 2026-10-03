import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import FixtureCard from "../components/FixtureCard";
import Ticker from "../components/Ticker";
import MarketsPanel from "../components/MarketsPanel";
import { Abbr, PendingTeam, TeamLabel } from "../components/Team";
import { useSlip } from "../components/BetSlip";
import { countdown, ukTime, useLive } from "../lib/live";
import { footfiveApi, type ChampionInfo, type FixtureCard as Fx, type LiveView, type WorldSnapshot } from "../lib/pocketbase";

function useMyTeamId() {
  const [w, setW] = useState<WorldSnapshot | null>(null);
  useEffect(() => {
    footfiveApi.world().then(setW).catch(() => {});
    const id = setInterval(() => footfiveApi.world().then(setW).catch(() => {}), 15000);
    return () => clearInterval(id);
  }, []);
  return w?.managedTeam?.id || null;
}

export default function LivePage() {
  const { live, error, stale, now } = useLive();
  const myTeam = useMyTeamId();
  const [betFx, setBetFx] = useState<Fx | null>(null);

  if (!live) {
    return (
      <Layout wide>
        {error ? (
          <div className="panel mx-auto mt-10 max-w-md p-6 text-center" role="alert">
            <p className="font-display text-amber">Can't reach the stadium</p>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <p className="mt-2 text-sm text-muted">Retrying automatically…</p>
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </Layout>
    );
  }

  return (
    <Layout wide>
      <div className="space-y-3">
        <Header live={live} now={now} stale={stale} />
        {live.mode === "champion" && live.champion ? <ChampionStage c={live.champion} live={live} now={now} /> : null}
        {live.mode === "idle" ? <Idle live={live} now={now} /> : null}
        {live.mode !== "champion" && live.mode !== "idle" ? (
          <>
            {live.recentChampion ? <ChampionStrip c={live.recentChampion} /> : null}
            <Ticker items={live.ticker} />
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4" data-testid="fixtures-grid">
              {live.fixtures.map((fx) => (
                <FixtureCard
                  key={fx.id}
                  fx={fx}
                  now={now}
                  stale={stale}
                  onBet={setBetFx}
                  blocked={!!myTeam && (fx.home.id === myTeam || fx.away.id === myTeam)}
                />
              ))}
            </div>
            {live.round?.status === "scheduled" ? <RoundBets live={live} /> : null}
            <Bracket live={live} />
          </>
        ) : null}
        {live.mode === "champion" ? <Ticker items={live.ticker} label="Final round events" /> : null}
      </div>
      {betFx ? <BetDrawer fx={betFx} onClose={() => setBetFx(null)} /> : null}
    </Layout>
  );
}

function SkeletonGrid() {
  return (
    <div className="space-y-3" data-testid="live-loading" aria-busy>
      <div className="panel h-16 animate-pulse" />
      <div className="panel h-11 animate-pulse" />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="panel h-40 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function Header({ live, now, stale }: { live: LiveView; now: number; stale: boolean }) {
  const r = live.round;
  let status: React.ReactNode = null;
  if (live.paused) status = <span className="chip chip-amber">Paused by admin</span>;
  else if (live.mode === "live") status = stale ? <span className="chip chip-muted">Reconnecting</span> : <span className="chip chip-live">Live</span>;
  else if (live.mode === "fixtures" && r)
    status = (
      <span className="chip chip-amber tabular" data-testid="kickoff-countdown">
        Kick-off in {countdown(r.scheduledAt - now)}
      </span>
    );
  const done = live.fixtures.filter((f) => f.status === "finished" || f.st?.ph === "finished").length;
  return (
    <div className="panel flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          {live.championship ? `Championship #${live.championship.number}` : "FootFive Championship"}
        </p>
        <h1 className="font-display text-xl font-black sm:text-2xl" data-testid="round-title">
          {live.mode === "champion" ? "Champions crowned" : r ? r.label : "Waiting for the next championship"}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {status}
        {live.mode === "live" ? (
          <span className="text-muted">
            {done}/{live.fixtures.length} finished
          </span>
        ) : null}
        {live.mode === "fixtures" && r ? <span className="text-muted">{ukTime(r.scheduledAt)} UK</span> : null}
      </div>
    </div>
  );
}

function ChampionStage({ c, live, now }: { c: ChampionInfo; live: LiveView; now: number }) {
  const f = c.final;
  const to = live.fixturesAt ? live.fixturesAt - now : null;
  return (
    <section className="panel relative overflow-hidden p-5 text-center sm:p-8" data-testid="champion-stage">
      <div className="pointer-events-none absolute inset-0 opacity-40" style={{ background: `radial-gradient(600px 300px at 50% 0%, ${c.team?.primary_color || "#ffb020"}55, transparent 70%)` }} />
      <div className="relative space-y-3">
        <div className="trophy-glow text-6xl" aria-hidden>
          🏆
        </div>
        <p className="text-xs uppercase tracking-[0.3em] text-amber">Championship #{c.number} winners</p>
        <h2 className="font-display text-3xl font-black sm:text-5xl" style={{ color: c.team?.primary_color }}>
          {c.team?.name}
        </h2>
        <p className="text-muted">The cyborgs of {c.team?.name} are champions — what a run!</p>
        {f ? (
          <p className="text-lg font-semibold">
            Final: {f.home.name} {f.sh}–{f.sa} {f.away.name}
            {f.by === "pens" ? ` (${f.soh}–${f.soa} pens)` : f.by === "aet" ? " (AET)" : ""}
          </p>
        ) : null}
        <div className="mx-auto grid max-w-md grid-cols-2 gap-2 pt-2">
          <div className="panel p-3">
            <p className="text-xs text-muted">Next fixtures</p>
            <p className="text-3xl font-bold tabular text-cyan" data-testid="fixtures-countdown">
              {to != null ? countdown(to) : "–"}
            </p>
          </div>
          <div className="panel p-3">
            <p className="text-xs text-muted">Next kick-off</p>
            <p className="text-3xl font-bold tabular">{live.nextChampionshipAt ? ukTime(live.nextChampionshipAt) : "–"}</p>
            <p className="text-[11px] text-muted">UK time</p>
          </div>
        </div>
        {f ? (
          <Link to={`/match/${f.fixtureId}`} className="btn-ghost mt-2 inline-flex">
            Final result & highlights
          </Link>
        ) : null}
      </div>
    </section>
  );
}

function ChampionStrip({ c }: { c: ChampionInfo }) {
  return (
    <div className="panel flex items-center gap-3 px-4 py-2 text-sm" data-testid="recent-champion">
      <span aria-hidden>🏆</span>
      <span className="text-muted">Reigning champions</span>
      {c.team ? <TeamLabel team={c.team} /> : null}
      {c.final ? (
        <span className="ml-auto hidden text-muted sm:inline">
          Final {c.final.home.abbreviation} {c.final.sh}–{c.final.sa} {c.final.away.abbreviation}
          {c.final.by === "pens" ? ` (${c.final.soh}–${c.final.soa} p)` : ""}
        </span>
      ) : null}
    </div>
  );
}

function Idle({ live, now }: { live: LiveView; now: number }) {
  return (
    <section className="panel p-6 text-center" data-testid="idle">
      <p className="font-display text-lg">The next championship is being prepared</p>
      {live.nextChampionshipAt ? (
        <p className="mt-2 text-muted">
          Kick-off {ukTime(live.nextChampionshipAt)} UK · fixtures in {countdown((live.fixturesAt || live.nextChampionshipAt) - now)}
        </p>
      ) : null}
    </section>
  );
}

/** Round & championship futures, shown on the main screen during the break. */
function RoundBets({ live }: { live: LiveView }) {
  const r = live.round!;
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Round & championship bets</h2>
        <span className="text-xs text-muted">Close at kick-off · {ukTime(r.scheduledAt)} UK</span>
      </div>
      <p className="mt-1 text-sm text-muted">
        First team to score in the {r.label}
        {r.key === "r16" ? ", championship winner and the four semi-finalists" : ""} — on the{" "}
        <Link to="/betting" className="text-cyan underline">
          Betting
        </Link>{" "}
        screen.
      </p>
    </section>
  );
}

function Bracket({ live }: { live: LiveView }) {
  if (!live.bracket.length) return null;
  return (
    <section className="panel p-3" aria-label="Championship bracket">
      <h2 className="panel-title mb-2">Road to the final</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {live.bracket.map((round) => (
          <div key={round.key} className="space-y-1.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted">{round.label}</h3>
            {round.fixtures.map((f) => (
              <div key={f.slot} className={`rounded-md border border-line px-2 py-1 text-xs ${f.fixtureId === undefined ? "opacity-70" : ""}`}>
                {(["home", "away"] as const).map((side) => {
                  const t = side === "home" ? f.home : f.away;
                  const pend = side === "home" ? f.homePending : f.awayPending;
                  const won = f.winner === side;
                  return (
                    <div key={side} className={`flex items-center justify-between gap-1 ${f.winner && !won ? "opacity-45" : ""}`}>
                      {t ? <Abbr team={t} away={side === "away"} /> : <PendingTeam text={pend || "TBC"} />}
                      {f.sh != null ? (
                        <span className="tabular font-bold">
                          {side === "home" ? f.sh : f.sa}
                          {f.by === "pens" ? <span className="text-magenta"> ({side === "home" ? f.soh : f.soa})</span> : null}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function BetDrawer({ fx, onClose }: { fx: Fx; onClose: () => void }) {
  const { pick } = useSlip();
  useEffect(() => {
    if (pick) onClose();
  }, [pick, onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-label="Match markets" onClick={onClose}>
      <div className="glass max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-display text-sm">
            {fx.home.name} <span className="text-muted">v</span> {fx.away.name}
          </h2>
          <button type="button" className="text-muted" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <MarketsPanel fixtureId={fx.id} seq={fx.seq} fixtureLabel={`${fx.home.abbreviation} v ${fx.away.abbreviation}`} />
      </div>
    </div>
  );
}
