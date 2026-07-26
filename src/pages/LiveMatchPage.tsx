import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import TeamBadge from "../components/TeamBadge";
import MatchSwitcher from "../components/live/MatchSwitcher";
import ShootoutBoard from "../components/live/ShootoutBoard";
import PenaltyFocus from "../components/live/PenaltyFocus";
import { useLiveMatch } from "../hooks/useLiveMatch";
import { useRoundStore } from "../hooks/useRoundStore";
import { footfiveApi } from "../lib/pocketbase";
import { isPenaltyChainType, isShootoutType } from "../domain/eventDisplay";

function phaseBanner(status: string, phase: string, finished: boolean, minute: number) {
  if (finished || status === "finished") return "Full-time";
  if (status === "scheduled" || phase === "scheduled") return "Pre-match";
  if (status === "half_time" || phase === "half_time") return "Half-time";
  if (status === "shootout" || phase === "shootout") return "Penalties";
  if (status === "extra_time" || phase.startsWith("extra")) return `Extra time · ${minute}'`;
  if (status === "live") return `Live · ${minute}'`;
  return phase.replaceAll("_", " ");
}

export default function LiveMatchPage() {
  const { fixtureId = "" } = useParams();
  const nav = useNavigate();
  const { meta, error, offline, display, catchUpToLive, setError } = useLiveMatch(fixtureId);
  const { fixtures, refresh } = useRoundStore();
  const [managedId, setManagedId] = useState<string | null>(null);
  const [coachPending, setCoachPending] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  useEffect(() => {
    footfiveApi
      .world()
      .then((w) => setManagedId(w.managedTeam?.id ?? null))
      .catch(() => {});
  }, []);

  const showShootout = !!(
    display.phase === "shootout" ||
    meta?.status === "shootout" ||
    display.shootoutHome > 0 ||
    display.shootoutAway > 0 ||
    (display.current && isShootoutType(display.current.type))
  );

  const showPenalty = !!(
    display.current &&
    isPenaltyChainType(display.current.type) &&
    !showShootout
  );

  const suddenDeath =
    showShootout &&
    (display.shootoutHome >= 5 ||
      display.shootoutAway >= 5 ||
      (display.current?.message || "").toLowerCase().includes("sudden"));

  const others = useMemo(
    () => fixtures.filter((f) => f.fixtureId !== fixtureId),
    [fixtures, fixtureId],
  );

  const flashGoal =
    display.current &&
    (display.current.type === "goal" ||
      display.current.type === "penalty_scored" ||
      display.current.type === "shootout_goal");

  const coachingStance =
    meta?.managedSide === "home"
      ? meta.homeCoaching
      : meta?.managedSide === "away"
        ? meta.awayCoaching
        : null;

  return (
    <Layout title="Live">
      {/* Top nav */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link
          to="/scoreboard"
          className="btn-ghost !min-h-10 !px-3 !py-2 text-xs"
        >
          ← Scoreboard
        </Link>
        {display.behind > 0 ? (
          <button
            type="button"
            className="btn-primary !min-h-10 !px-3 !py-2 text-xs"
            onClick={catchUpToLive}
            data-testid="catch-up"
          >
            Catch up ({display.behind})
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost !min-h-10 !px-3 !py-2 text-xs"
            onClick={() => {
              catchUpToLive();
              refresh();
            }}
            data-testid="live-refresh"
          >
            Live
          </button>
        )}
      </div>

      {/* Match switcher */}
      <div className="mb-3" data-testid="match-switcher">
        <MatchSwitcher
          fixtures={fixtures}
          activeId={fixtureId}
          managedTeamId={managedId}
          onSelect={(id) => nav(`/match/${id}`)}
        />
      </div>

      {offline ? (
        <p
          className="mb-2 rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber"
          role="status"
          data-testid="connection-warning"
        >
          Connection issue — showing last known events. Retrying…
        </p>
      ) : null}

      {error && !offline ? (
        <p className="mb-2 text-sm text-magenta" role="alert" data-testid="match-error">
          {error}
        </p>
      ) : null}

      {/* Main scoreboard */}
      <section
        className={`glass relative overflow-hidden rounded-3xl p-4 ${flashGoal ? "goal-anim" : ""}`}
        style={{
          backgroundImage:
            `linear-gradient(180deg, rgba(7,11,20,0.7), rgba(7,11,20,0.92)), url(${import.meta.env.BASE_URL}assets/broadcast-frame.jpg)`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
        aria-label="Match score"
        data-testid="match-scoreboard"
      >
        <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider">
          <span className="text-muted">
            {phaseBanner(
              meta?.status || display.phase,
              display.phase,
              display.finished,
              display.minute,
            )}
          </span>
          <span className="font-bold text-lime">
            {display.finished
              ? "FT"
              : display.phase === "scheduled" || meta?.status === "scheduled"
                ? "—"
                : `${display.minute}'`}
          </span>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:gap-3">
          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            {meta ? (
              <TeamBadge
                badgeKey={meta.home.badge_key}
                color={meta.home.primary_color}
                name={meta.home.name}
                size={48}
              />
            ) : null}
            <div className="w-full truncate text-xs font-semibold sm:text-sm">
              {meta?.home.name || "Home"}
            </div>
            {meta?.homeCoaching ? (
              <span className="text-[10px] uppercase text-muted">{meta.homeCoaching}</span>
            ) : null}
          </div>

          <div className="px-1 text-center font-display">
            <div
              className="text-4xl tabular-nums leading-none text-white sm:text-5xl"
              aria-live="polite"
              aria-atomic="true"
              data-testid="score-normal"
            >
              <span data-testid="score-home">{display.scoreHome}</span>
              <span className="mx-1.5 text-muted sm:mx-2">–</span>
              <span data-testid="score-away">{display.scoreAway}</span>
            </div>
            {showShootout || display.shootoutHome > 0 || display.shootoutAway > 0 ? (
              <div
                className="mt-1 text-sm text-amber"
                aria-label="Shootout score"
                data-testid="score-shootout"
              >
                pens {display.shootoutHome}–{display.shootoutAway}
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col items-center gap-1 text-center">
            {meta ? (
              <TeamBadge
                badgeKey={meta.away.badge_key}
                color={meta.away.primary_color}
                name={meta.away.name}
                size={48}
              />
            ) : null}
            <div className="w-full truncate text-xs font-semibold sm:text-sm">
              {meta?.away.name || "Away"}
            </div>
            {meta?.awayCoaching ? (
              <span className="text-[10px] uppercase text-muted">{meta.awayCoaching}</span>
            ) : null}
          </div>
        </div>
      </section>

      {/* Penalty focus OR shootout board OR current event */}
      {showPenalty && display.current ? (
        <div className="mt-3">
          <PenaltyFocus stage={display.current.type} message={display.current.message || ""} />
        </div>
      ) : showShootout && meta ? (
        <div className="mt-3">
          <ShootoutBoard
            homeName={meta.home.name}
            awayName={meta.away.name}
            shootoutHome={display.shootoutHome}
            shootoutAway={display.shootoutAway}
            kicks={meta.shootoutKicks || []}
            shootoutSide={meta.shootoutSide}
            suddenDeath={suddenDeath}
            currentMessage={display.current?.message}
          />
        </div>
      ) : (
        <section
          className="glass mt-3 rounded-2xl p-4"
          aria-live="polite"
          aria-relevant="additions text"
        >
          <p className="mb-1 text-[11px] uppercase tracking-widest text-muted">
            {display.cfg?.label || "Event"}
          </p>
          <p
            key={display.current?.seq ?? "none"}
            className={`event-enter text-lg font-semibold leading-snug sm:text-xl ${
              display.cfg?.className || "text-white"
            }`}
          >
            {display.current?.message ||
              (display.phase === "scheduled"
                ? "Waiting for kickoff…"
                : display.finished
                  ? "Match complete"
                  : "…")}
          </p>
          {display.current ? (
            <p className="mt-1 text-xs text-muted">
              {display.current.minute}&apos; · {display.current.type.replaceAll("_", " ")}
            </p>
          ) : null}
        </section>
      )}

      {/* Coaching */}
      {meta?.canCoach && !display.finished ? (
        <section className="glass mt-3 rounded-2xl p-3" data-testid="coaching-panel">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-widest text-muted">
              Coaching · {meta.managedSide}
            </p>
            <span
              className="text-xs capitalize text-cyan"
              data-testid="coaching-stance"
            >
              {coachingStance || "balanced"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(["defend", "balanced", "attack"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={coachPending}
                aria-pressed={coachingStance === s}
                data-testid={`coach-${s}`}
                className={`btn-ghost !min-h-11 text-xs capitalize ${
                  coachingStance === s ? "ring-2 ring-cyan" : ""
                } ${coachPending ? "opacity-60" : ""}`}
                onClick={async () => {
                  if (coachPending) return;
                  setCoachPending(true);
                  setError("");
                  try {
                    await footfiveApi.coaching(fixtureId, s);
                    catchUpToLive();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Coaching failed");
                  } finally {
                    setCoachPending(false);
                  }
                }}
              >
                {s}
              </button>
            ))}
          </div>
          {coachPending ? (
            <p className="mt-2 text-center text-[11px] text-muted" data-testid="coach-pending">
              Sending…
            </p>
          ) : null}
        </section>
      ) : meta && !meta.canCoach && (meta.homeCoaching || meta.awayCoaching) ? (
        <p className="mt-2 text-center text-[11px] text-muted">
          Stances: {meta.homeCoaching || "balanced"} / {meta.awayCoaching || "balanced"}
        </p>
      ) : null}

      {/* Other scores ticker */}
      {others.length ? (
        <section className="mt-3" aria-label="Other fixtures">
          <p className="mb-1 text-[11px] uppercase tracking-widest text-muted">Round ticker</p>
          <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {others.map((f) => (
              <button
                key={f.fixtureId}
                type="button"
                onClick={() => nav(`/match/${f.fixtureId}`)}
                aria-label={`${f.home.name} ${f.scoreHome} to ${f.away.name} ${f.scoreAway}`}
                className="glass min-w-[7.5rem] max-w-[10rem] shrink-0 rounded-xl px-2.5 py-2 text-left active:scale-[0.98]"
              >
                <div className="text-[10px] uppercase text-muted">
                  {f.finished
                    ? "FT"
                    : f.status === "shootout"
                      ? "PENS"
                      : f.status === "half_time"
                        ? "HT"
                        : f.status === "extra_time"
                          ? "ET"
                          : `${f.minute}′`}
                </div>
                <div className="text-xs font-semibold tabular-nums">
                  <span title={f.home.name} aria-label={f.home.name}>
                    {(f.home.abbreviation || f.home.name.slice(0, 3)).toUpperCase()}
                  </span>{" "}
                  {f.scoreHome}–{f.scoreAway}{" "}
                  <span title={f.away.name} aria-label={f.away.name}>
                    {(f.away.abbreviation || f.away.name.slice(0, 3)).toUpperCase()}
                  </span>
                </div>
                {f.shootoutHome > 0 || f.shootoutAway > 0 ? (
                  <div className="text-[10px] text-amber">
                    pens {f.shootoutHome}–{f.shootoutAway}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* History */}
      <section className="glass mt-3 rounded-2xl p-3" data-testid="event-feed">
        <p className="mb-2 text-[11px] uppercase tracking-widest text-muted">Event feed</p>
        <ul className="max-h-56 space-y-2 overflow-y-auto sm:max-h-72">
          {display.history.map((e) => (
            <li
              key={e.seq}
              data-testid={`event-${e.seq}`}
              className="border-b border-white/5 pb-2 text-sm last:border-0"
            >
              <span className="mr-2 tabular-nums text-muted">{e.minute}&apos;</span>
              <span className={e.type.includes("goal") ? "text-lime" : ""}>{e.message}</span>
            </li>
          ))}
          {!display.history.length ? (
            <li className="text-sm text-muted">No events yet</li>
          ) : null}
        </ul>
      </section>

      {/* Stats disclosure */}
      <div className="mt-3">
        <button
          type="button"
          className="btn-ghost w-full !min-h-10 text-xs"
          onClick={() => setStatsOpen((v) => !v)}
          aria-expanded={statsOpen}
        >
          {statsOpen ? "Hide stats" : "Match stats"}
        </button>
        {statsOpen && meta?.stats ? (
          <section className="glass mt-2 rounded-2xl p-3 text-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ["shots", "Shots"],
                  ["shots_on_target", "On target"],
                  ["saves", "Saves"],
                  ["corners", "Corners"],
                  ["fouls", "Fouls"],
                  ["yellow_cards", "Yellows"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <div className="text-cyan">
                    {(meta.stats?.home as Record<string, number>)?.[key] ?? 0}
                  </div>
                  <div className="text-[10px] text-muted">{label}</div>
                  <div>{(meta.stats?.away as Record<string, number>)?.[key] ?? 0}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {/* Finished panel */}
      {display.finished && meta ? (
        <section className="glass mt-3 rounded-2xl p-4 text-center">
          <p className="font-display text-lg text-lime">
            {meta.winnerTeamId === meta.home.id
              ? meta.home.name
              : meta.winnerTeamId === meta.away.id
                ? meta.away.name
                : "Result"}{" "}
            advances
          </p>
          <p className="mt-1 text-sm text-muted">
            FT {display.scoreHome}–{display.scoreAway}
            {display.shootoutHome || display.shootoutAway
              ? ` · pens ${display.shootoutHome}–${display.shootoutAway}`
              : ""}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Link to="/scoreboard" className="btn-primary flex-1 text-center text-xs">
              Round scoreboard
            </Link>
            {others.find((o) => !o.finished) ? (
              <button
                type="button"
                className="btn-ghost flex-1 text-xs"
                onClick={() => {
                  const next = others.find((o) => !o.finished);
                  if (next) nav(`/match/${next.fixtureId}`);
                }}
              >
                Next live match
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </Layout>
  );
}
