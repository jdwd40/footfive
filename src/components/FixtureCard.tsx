import { Link } from "react-router-dom";
import { useEffect, useId, useRef, useState } from "react";
import type { FixtureCard as Fx } from "../lib/pocketbase";
import { clockSeconds, clockText, countdown, phaseInfo, ukTime } from "../lib/live";
import { NO_CURRENT_PRICE, UNOFFERED_HINT, formatOdds, selectionLabel } from "../lib/priceLabel";
import { TeamLabel } from "./Team";

/** Counter that bumps when `value` changes (never on first render) — drives subtle flashes. */
export function useChanged(value: string) {
  const prev = useRef(value);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setFlash((n) => n + 1);
    }
  }, [value]);
  return flash;
}

export function PhaseChip({ fx, now }: { fx: Fx; now: number }) {
  if (!fx.st) {
    if (fx.kickoffAt && now >= fx.kickoffAt) return <span className="chip chip-amber">Kick-off</span>;
    return <span className="chip chip-muted">Scheduled</span>;
  }
  const p = phaseInfo(fx.st);
  return <span className={`chip chip-${p.tone}`}>{p.label}</span>;
}

/** Clock: regulation / extra time, "PENS" in a shootout, kick-off time before the start. */
export function MatchClock({ fx, now, big = false }: { fx: Fx; now: number; big?: boolean }) {
  const st = fx.st;
  if (!st) return <span className="tabular text-muted">{ukTime(fx.kickoffAt)} UK</span>;
  if (st.ph === "shootout") return <span className={`font-display text-magenta ${big ? "text-lg" : ""}`}>PENS</span>;
  if (st.ph === "finished") return <span className="font-display text-lime">FT</span>;
  const s = clockSeconds(st, fx.at, now, fx.minuteMs);
  const paused = !st.clk?.run;
  const et = st.ph.startsWith("extra") || st.ph === "et_half_time";
  return (
    <span className={`tabular font-bold ${et ? "text-magenta" : "text-cyan"} ${paused ? "opacity-70" : ""} ${big ? "text-xl" : "text-sm"}`} aria-label="Match clock">
      {clockText(s)}
      {et ? <span className="ml-1 text-[9px]">ET</span> : null}
    </span>
  );
}

/** Compact scoreboard card for the round grid. Stable position; never reorders. */
export default function FixtureCard({
  fx,
  now,
  stale,
  onBet,
  blocked,
}: {
  fx: Fx;
  now: number;
  stale: boolean;
  onBet?: (fx: Fx) => void;
  blocked?: boolean;
}) {
  const st = fx.st;
  const scoreKey = st ? st.sc.join("-") + (st.so ? `/${st.so.h}-${st.so.a}` : "") : "";
  const flash = useChanged(scoreKey);
  const finished = fx.status === "finished" || st?.ph === "finished";
  const winner = finished ? (st?.win ?? fx.result?.winner ?? null) : null;
  const preKick = !st;
  const toKick = fx.kickoffAt - now;
  const oddsOpen = !!fx.odds && !fx.odds.closed && !blocked;
  const hintId = useId();
  const unoffered = oddsOpen && (formatOdds(fx.odds?.home) == null || formatOdds(fx.odds?.away) == null);

  return (
    <article
      data-testid="fixture-card"
      data-fixture-id={fx.id}
      className={`panel flex flex-col gap-2 p-3 ${stale ? "opacity-75" : ""}`}
      aria-label={`${fx.home.name} versus ${fx.away.name}`}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <PhaseChip fx={fx} now={now} />
        <MatchClock fx={fx} now={now} />
      </div>

      <div key={flash} className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg ${flash ? "card-flash" : ""}`}>
        {(["home", "away"] as const).map((side, i) => {
          const team = side === "home" ? fx.home : fx.away;
          const lost = winner && winner !== side;
          return (
            <div key={side} className="contents">
              <TeamLabel team={team} away={side === "away"} className={`text-[15px] ${lost ? "opacity-50" : ""}`} />
              <div className="flex items-center justify-end gap-1.5 tabular">
                {st ? (
                  <span className={`text-2xl font-bold leading-none ${flash ? "score-pop" : ""}`} data-testid={`score-${side}`}>
                    {st.sc[i]}
                  </span>
                ) : i === 0 ? (
                  <span className="font-display text-xs text-muted">vs</span>
                ) : null}
                {st?.so ? (
                  <span className="rounded bg-magenta/15 px-1 text-xs font-bold text-magenta" title="Shootout score (not part of the football score)">
                    ({i === 0 ? st.so.h : st.so.a})
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="min-h-[1.25rem] truncate text-xs text-muted">
        {finished && winner ? (
          <span className="text-lime">
            {(winner === "home" ? fx.home : fx.away).abbreviation} go through
            {st?.by === "pens" && st.so ? ` · ${Math.max(st.so.h, st.so.a)}–${Math.min(st.so.h, st.so.a)} on pens` : st?.by === "aet" ? " after extra time" : ""}
          </span>
        ) : preKick ? (
          toKick > 0 ? <span>Kick-off in {countdown(toKick)}</span> : <span>Kick-off…</span>
        ) : (
          fx.last?.text || ""
        )}
      </div>

      <div className="flex items-center gap-2">
        <Link
          to={`/match/${fx.id}`}
          className={`${preKick ? "btn-ghost" : "btn-primary"} !min-h-10 flex-1 !py-1.5 text-xs`}
          data-testid="watch-match"
        >
          {preKick ? "Preview" : finished ? "Result" : "Watch live"}
        </Link>
        {onBet && !finished ? (
          fx.odds ? (
            <button
              type="button"
              className="btn-odds !min-h-10 !flex-row gap-2 px-3 text-xs"
              disabled={!oddsOpen || stale}
              onClick={() => onBet(fx)}
              aria-describedby={unoffered ? hintId : undefined}
              title={blocked ? "You manage a team in this fixture" : fx.odds.closed || "Bet on this match"}
              data-testid="bet-fixture"
            >
              {blocked ? (
                "Your match"
              ) : fx.odds.closed ? (
                <span className="text-[11px] font-semibold">Suspended</span>
              ) : (
                <>
                  <span className={formatOdds(fx.odds.home) ? "tabular" : "text-[11px] leading-tight"}>{selectionLabel(fx.odds.home, true)}</span>
                  <span className="opacity-50">|</span>
                  <span className={formatOdds(fx.odds.away) ? "tabular" : "text-[11px] leading-tight"}>{selectionLabel(fx.odds.away, true)}</span>
                </>
              )}
            </button>
          ) : (
            <p className="max-w-[9rem] text-center text-[11px] leading-tight text-muted" data-testid="odds-missing">
              {NO_CURRENT_PRICE}
            </p>
          )
        ) : null}
        {unoffered ? (
          <p id={hintId} className="sr-only" data-testid="unoffered-hint">
            {UNOFFERED_HINT}
          </p>
        ) : null}
      </div>
    </article>
  );
}
