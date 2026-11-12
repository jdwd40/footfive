import { useCallback, useEffect, useId, useRef, useState } from "react";
import { footfiveApi, type FixtureMarkets, type Market } from "../lib/pocketbase";
import { NOT_OFFERED, UNOFFERED_HINT, formatOdds, selectionLabel } from "../lib/priceLabel";
import { startPolling } from "../lib/polling";
import { useSlip } from "./BetSlip";

type Sel = NonNullable<Market["sel"]>[number];
/** #207: an exact score the server left out (below the offer floor, or withdrawn in play as all but certain), drawn in its place. */
type Reserved = { id: string; short: string; reserved: true };
const EXACT_SPAN = 6; // pocketbase markets.js lists home and away goals from the current score to +5

/**
 * #207: the exact-score market as a fixed 6×6 grid, home goals down and away goals across from the lowest listed score. A score the
 * server stops listing keeps its cell (drawn unavailable), so the other prices never shift. `base` is the last grid origin for
 * this fixture, kept for a refresh that lists no exact score at all. Null when the list does not fit one grid (then it is drawn as is).
 */
function exactGrid(sel: Sel[], base: [number, number] | null): { cells: Array<Sel | Reserved>; base: [number, number] } | null {
  const parsed = sel.map((s) => ({ s, hg: /^(\d+)-(\d+)$/.exec(s.id) }));
  if (parsed.some((p) => !p.hg)) return null;
  const goals = parsed.map((p) => [Number(p.hg![1]), Number(p.hg![2])] as const);
  const origin: [number, number] | null = goals.length ? [Math.min(...goals.map((g) => g[0])), Math.min(...goals.map((g) => g[1]))] : base;
  if (!origin) return null;
  if (goals.some(([h, a]) => h >= origin[0] + EXACT_SPAN || a >= origin[1] + EXACT_SPAN)) return null;
  const byId = new Map(sel.map((s) => [s.id, s]));
  const cells: Array<Sel | Reserved> = [];
  for (let h = origin[0]; h < origin[0] + EXACT_SPAN; h++)
    for (let a = origin[1]; a < origin[1] + EXACT_SPAN; a++) cells.push(byId.get(`${h}-${a}`) ?? { id: `${h}-${a}`, short: `${h}–${a}`, reserved: true });
  return { cells, base: origin };
}

/** Live/pre-match markets for one fixture. Re-fetches when the published sequence moves. */
export default function MarketsPanel({ fixtureId, seq, fixtureLabel, compact = false, onClosed }: { fixtureId: string; seq: number; fixtureLabel: string; compact?: boolean; onClosed?: (closed: string | null) => void }) {
  const [data, setData] = useState<FixtureMarkets | null>(null);
  const [error, setError] = useState("");
  const { pick, setPick } = useSlip();
  const inflight = useRef(false);
  const hintId = useId();
  const exactBase = useRef<{ id: string; base: [number, number] | null }>({ id: fixtureId, base: null });
  if (exactBase.current.id !== fixtureId) exactBase.current = { id: fixtureId, base: null };

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

  const closedNow = data && !data.blocked ? data.state.closed || null : null;
  useEffect(() => {
    onClosed?.(closedNow);
  }, [closedNow, onClosed]);

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
  const blocks = list.map((m) => {
    const disabled = !!suspended || !!m.closed;
    const grid = m.key === "exact" ? exactGrid(m.sel || [], exactBase.current.base) : null;
    if (grid) exactBase.current.base = grid.base;
    const cells: Array<Sel | Reserved> = grid ? grid.cells : m.sel || [];
    const unoffered = !disabled && cells.some((s) => "reserved" in s || !formatOdds(s.odds));
    return { m, disabled, cells, grid: !!grid, unoffered };
  });
  const unoffered = blocks.some((b) => b.unoffered);
  return (
    <div className="space-y-3" data-testid="markets">
      {/* #207: one reserved status area at a fixed height: the suspension, a failed refresh and the not-offered explanation
          (#203, now visible to sighted touch users too) come and go inside it, so none of them moves the prices below. */}
      <div className="flex h-11 flex-wrap content-start items-center gap-x-2 gap-y-0.5 overflow-hidden text-[11px] leading-tight" data-testid="markets-status">
        {error ? (
          <span className="text-xs text-amber" role="status" data-testid="markets-stale">
            Couldn't refresh — retrying…
          </span>
        ) : null}
        {suspended ? (
          <span className="chip chip-amber" data-testid="markets-suspended">
            {suspended}
          </span>
        ) : null}
        {unoffered ? (
          <span id={hintId} className="text-muted" data-testid="unoffered-hint">
            {UNOFFERED_HINT}
          </span>
        ) : null}
      </div>
      {blocks.map(({ m, disabled, cells, grid }) => (
        <MarketBlock
          key={m.key}
          m={m}
          cells={cells}
          grid={grid}
          hintId={unoffered ? hintId : undefined}
          disabled={disabled}
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
  cells,
  grid,
  hintId,
  disabled,
  selected,
  onPick,
}: {
  m: Market;
  cells: Array<Sel | Reserved>;
  grid: boolean;
  hintId?: string;
  disabled: boolean;
  selected: string | null;
  onPick: (s: Sel) => void;
}) {
  const exact = m.key === "exact";
  const open = !disabled;
  const n = cells.length;
  return (
    <section>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="shrink-0 text-sm font-bold">{m.title}</h4>
        <span className="truncate text-[11px] text-muted" title={m.rules}>
          {m.rules}
        </span>
      </div>
      <div className={`grid gap-1.5 ${grid ? "grid-cols-6 !gap-1" : exact ? "grid-cols-4 sm:grid-cols-6" : n === 3 ? "grid-cols-3" : n === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2"}`} data-testid={grid ? "exact-grid" : undefined}>
        {cells.map((s, i) => {
          // #207: grid cells are keyed by place, so a goal that moves the grid's origin relabels the cells rather than moving them.
          const key = grid ? `cell-${i}` : s.id;
          if ("reserved" in s)
            return (
              // Not a selection: the server lists no price for this score. It holds the grid in place (#207) and says so on hover.
              <div key={key} className="btn-odds min-w-0 w-full !px-0.5" aria-hidden title={`${s.short}: ${NOT_OFFERED}`} data-testid="exact-reserved" data-reserved>
                <span className="max-w-full truncate text-[11px] font-semibold opacity-80">{s.short}</span>
                <span className="text-[11px] leading-5">—</span>
              </div>
            );
          const priced = !!formatOdds(s.odds);
          const bare = open && !priced;
          return (
            <button
              key={key}
              type="button"
              className={`${priced ? "btn-odds" : "btn-odds min-w-0 w-full"} ${grid ? "min-w-0 !px-0.5" : ""}`}
              disabled={disabled || !s.odds}
              aria-pressed={selected === s.id}
              aria-label={bare ? `${s.label}, ${NOT_OFFERED}` : undefined}
              aria-describedby={bare ? hintId : undefined}
              onClick={() => onPick(s)}
              title={bare ? `${s.label} — ${UNOFFERED_HINT}` : s.label}
              data-testid={`odds-${m.key}-${s.id}`}
            >
              <span className="max-w-full truncate text-[11px] font-semibold opacity-80">{s.short}</span>
              {/* #203: one line at the price's own line height, so a price that is withdrawn (or comes back) never resizes the button. */}
              <span className={priced ? `tabular ${grid ? "text-[13px] leading-5 sm:text-sm" : "text-sm"}` : "max-w-full truncate text-center text-[11px] font-semibold leading-5"}>
                {selectionLabel(s.odds, open)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
