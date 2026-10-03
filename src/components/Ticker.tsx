import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { TickerItem } from "../lib/pocketbase";

const HOLD_MS = 5000;

function tone(t: string) {
  if (t === "goal" || t === "penalty_goal") return "text-lime";
  if (t === "red_card") return "text-live";
  if (t.startsWith("penalty") || t.startsWith("shootout")) return "text-magenta";
  if (t === "match_end") return "text-cyan";
  return "text-white";
}

function icon(t: string) {
  if (t === "goal" || t === "penalty_goal") return "⚽";
  if (t === "red_card") return "🟥";
  if (t === "penalty_awarded") return "❗";
  if (t.startsWith("penalty_")) return "🥅";
  if (t.startsWith("shootout")) return "🎯";
  if (t === "match_end") return "🏁";
  if (t === "end_of_normal_time") return "⏱";
  return "•";
}

/**
 * Round-wide recent-events ticker. Each new item holds for a readable time; when several
 * arrive together they queue (bounded) and the expandable feed lets users catch up.
 */
export default function Ticker({ items, label = "Round events" }: { items: TickerItem[]; label?: string }) {
  const [shown, setShown] = useState<TickerItem | null>(items[0] || null);
  const [open, setOpen] = useState(false);
  const queue = useRef<TickerItem[]>([]);
  const seen = useRef<Set<string>>(new Set(items.map((i) => i.id)));
  const lastSwap = useRef(0);

  useEffect(() => {
    // items arrive newest-first; enqueue unseen ones oldest-first, keep the queue short
    const fresh = items.filter((i) => !seen.current.has(i.id)).reverse();
    fresh.forEach((i) => seen.current.add(i.id));
    queue.current = [...queue.current, ...fresh].slice(-4);
    if (!shown && items[0]) setShown(items[0]);
  }, [items, shown]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!queue.current.length) return;
      if (Date.now() - lastSwap.current < HOLD_MS) return;
      lastSwap.current = Date.now();
      setShown(queue.current.shift() || null);
    }, 250);
    return () => clearInterval(id);
  }, []);

  const pending = queue.current.length;
  return (
    <section className="panel overflow-hidden" aria-label={label} data-testid="ticker">
      <div className="flex items-stretch">
        <div className="flex shrink-0 items-center bg-live/90 px-3 font-display text-[11px] font-bold uppercase tracking-widest text-white">Live feed</div>
        <div className="min-w-0 flex-1 px-3 py-2.5" aria-live="polite">
          {shown ? (
            <Link key={shown.id} to={`/match/${shown.fixtureId}`} className={`event-enter flex items-center gap-2 font-semibold ${tone(shown.t)}`} data-testid="ticker-current">
              <span aria-hidden>{icon(shown.t)}</span>
              <span className="truncate">{shown.text}</span>
            </Link>
          ) : (
            <span className="text-sm text-muted">Goals, penalties, red cards and results from every match appear here.</span>
          )}
        </div>
        <button type="button" className="shrink-0 border-l border-line px-3 text-xs text-muted hover:text-white" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="ticker-toggle">
          {open ? "Hide" : `Recent${pending ? ` (+${pending})` : ""}`}
        </button>
      </div>
      {open ? (
        <ol className="max-h-72 space-y-1 overflow-y-auto border-t border-line px-3 py-2 text-sm" data-testid="ticker-feed">
          {items.length ? (
            items.map((i) => (
              <li key={i.id} className="flex items-baseline gap-2">
                <span aria-hidden className="w-5 shrink-0 text-center">
                  {icon(i.t)}
                </span>
                <Link to={`/match/${i.fixtureId}`} className={`min-w-0 flex-1 hover:underline ${tone(i.t)}`}>
                  {i.text}
                </Link>
              </li>
            ))
          ) : (
            <li className="text-muted">Nothing yet.</li>
          )}
        </ol>
      ) : null}
    </section>
  );
}
