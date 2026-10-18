import { useCallback, useEffect, useId, useRef, useState } from "react";
import { footfiveApi, type FixtureMarkets, type Market } from "../lib/pocketbase";
import { NOT_OFFERED, UNOFFERED_HINT, formatOdds, selectionLabel } from "../lib/priceLabel";
import { startPolling } from "../lib/polling";
import { useSlip } from "./BetSlip";

/** Live/pre-match markets for one fixture. Re-fetches when the published sequence moves. */
export default function MarketsPanel({ fixtureId, seq, fixtureLabel, compact = false }: { fixtureId: string; seq: number; fixtureLabel: string; compact?: boolean }) {
  const [data, setData] = useState<FixtureMarkets | null>(null);
  const [error, setError] = useState("");
  const { pick, setPick } = useSlip();
  const inflight = useRef(false);

  useEffect(() => {
    setData(null);
    setError("");
  }, [fixtureId]);

  const load = useCallback(async () => {
    if (inflight.current) return true;
    inflight.current = true;
    try {
      setData(await footfiveApi.fixtureMarkets(fixtureId));
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Markets unavailable");
      return false;
    } finally {
      inflight.current = false;
    }
  }, [fixtureId]);

  useEffect(() => {
    void load();
  }, [load, seq]);

  useEffect(() => startPolling(load, 5000), [load]);

  // Keep the last good markets on a failed refresh; only a never-loaded panel shows the bare error.
  if (error && !data) return <p className="text-sm text-amber">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading markets…</p>;
  if (data.blocked)
    return (
      <p className="rounded-lg border border-amber/30 bg-amber/10 p-3 text-sm text-amber" data-testid="markets-blocked">
        {data.blocked}
      </p>
    );
  if (!data.markets.length) return <p className="text-sm text-muted">No markets — {data.state.closed || "this match is over"}.</p>;

  const suspended = data.state.closed;
  const list = compact ? data.markets.filter((m) => m.key === "winner" || m.key === "next_goal") : data.markets;
  return (
    <div className="space-y-3" data-testid="markets">
      {error ? (
        <p className="text-xs text-amber" role="status" data-testid="markets-stale">
          Couldn't refresh — retrying…
        </p>
      ) : null}
      {suspended ? (
        <p className="chip chip-amber" data-testid="markets-suspended">
          {suspended}
        </p>
      ) : null}
      {list.map((m) => (
        <MarketBlock
          key={m.key}
          m={m}
          disabled={!!suspended || !!m.closed}
          selected={pick?.fixtureId === fixtureId && pick.market === m.key ? pick.selection : null}
          onPick={(s) =>
            s.odds &&
            setPick({
              market: m.key,
              marketTitle: m.title,
              rules: m.rules,
              fixtureId,
              fixtureLabel,
              selection: s.id,
              label: s.label,
              odds: s.odds,
            })
          }
        />
      ))}
    </div>
  );
}

function MarketBlock({
  m,
  disabled,
  selected,
  onPick,
}: {
  m: Market;
  disabled: boolean;
  selected: string | null;
  onPick: (s: NonNullable<Market["sel"]>[number]) => void;
}) {
  const hintId = useId();
  const sel = m.sel || [];
  const exact = m.key === "exact";
  const open = !disabled;
  const unoffered = open && sel.some((s) => !formatOdds(s.odds));
  return (
    <section>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="shrink-0 text-sm font-bold">{m.title}</h4>
        <span className="truncate text-[11px] text-muted" title={m.rules}>
          {m.rules}
        </span>
      </div>
      <div className={`grid gap-1.5 ${exact ? "grid-cols-4 sm:grid-cols-6" : sel.length === 3 ? "grid-cols-3" : sel.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2"}`}>
        {sel.map((s) => {
          const priced = !!formatOdds(s.odds);
          const bare = open && !priced;
          return (
            <button
              key={s.id}
              type="button"
              className={priced ? "btn-odds" : "btn-odds min-w-0 w-full"}
              disabled={disabled || !s.odds}
              aria-pressed={selected === s.id}
              aria-label={bare ? `${s.label}, ${NOT_OFFERED}` : undefined}
              aria-describedby={bare ? hintId : undefined}
              onClick={() => onPick(s)}
              title={s.label}
              data-testid={`odds-${m.key}-${s.id}`}
            >
              <span className="max-w-full truncate text-[11px] font-semibold opacity-80">{exact ? s.short : s.short}</span>
              <span className={priced ? "tabular text-sm" : "max-w-full text-center text-[11px] font-semibold leading-tight whitespace-normal"}>
                {selectionLabel(s.odds, open)}
              </span>
            </button>
          );
        })}
      </div>
      {unoffered ? (
        <p id={hintId} className="mt-1 text-[11px] leading-tight text-muted" data-testid="unoffered-hint">
          {UNOFFERED_HINT}
        </p>
      ) : null}
    </section>
  );
}
