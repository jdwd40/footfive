import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { TickerItem } from "../lib/pocketbase";
import { serverNow } from "../lib/live";

const HOLD_MS = 5000;
/** #206: an item this recent (server time) when the ticker first appears is still news: the match page only mounts its
 * "Around the grounds" ticker with the first item, so that goal must flash too. Older history never does. */
const FRESH_MS = 8000;

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
 * Recent-events ticker. Each new item holds for a readable time; when several
 * arrive together they queue (bounded) and the expandable feed lets users catch up.
 * #207: one fixed line whatever it shows (the empty note, an item, a long item), so the first item never moves the page;
 * `badgeFor` labels each item (the match page's one ticker carries this match and the other matches) in a fixed-width badge.
 */
export default function Ticker({
  items,
  label = "Round events",
  badge = "Live feed",
  empty = "Goals, penalties, red cards and results from every match appear here.",
  flashGoals = false,
  badgeFor,
}: {
  items: TickerItem[];
  label?: string;
  badge?: string;
  empty?: string;
  flashGoals?: boolean | ((i: TickerItem) => boolean) /* #206: a goal that arrives while watching flashes the row once (only those this picks) */;
  badgeFor?: (i: TickerItem) => string;
}) {
  const [shown, setShown] = useState<TickerItem | null>(items[0] || null);
  const [open, setOpen] = useState(false);
  const queue = useRef<TickerItem[]>([]);
  const seen = useRef<Set<string>>(new Set(items.map((i) => i.id)));
  // ids that are news, not history: first seen after mount, or already just in when the ticker appeared
  const arrived = useRef<Set<string> | null>(null);
  if (!arrived.current) {
    const since = serverNow() - FRESH_MS;
    arrived.current = new Set(items.filter((i) => i.at >= since).map((i) => i.id));
  }
  const lastSwap = useRef(0);

  useEffect(() => {
    // items arrive newest-first; enqueue unseen ones oldest-first, keep the queue short
    const fresh = items.filter((i) => !seen.current.has(i.id)).reverse();
    fresh.forEach((i) => {
      seen.current.add(i.id);
      arrived.current!.add(i.id);
    });
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
  const flashes = typeof flashGoals === "function" ? flashGoals : () => flashGoals;
  const flash = !!shown && (shown.t === "goal" || shown.t === "penalty_goal") && flashes(shown) && arrived.current!.has(shown.id);
  const tag = badgeFor && shown ? badgeFor(shown) : badge;
  return (
    <section className="panel relative overflow-hidden" aria-label={label} data-testid="ticker">
      {flash ? <span key={shown!.id} className="goal-flash pointer-events-none absolute inset-0" data-testid="ticker-flash" aria-hidden /> : null}
      <div className="flex items-stretch">
        <div className={`flex shrink-0 items-center bg-live/90 px-3 font-display text-[11px] font-bold uppercase tracking-widest text-white ${badgeFor ? "w-[7.5rem] justify-center px-1 text-[10px] tracking-wider" : ""}`} data-testid="ticker-badge">{tag}</div>
        {/* One line at one height: an item, a long item and the empty note all fit it (#207: no shift at the first item). */}
        <div className="flex h-9 min-w-0 flex-1 items-center px-3 text-sm leading-5" aria-live="polite">
          {shown ? (
            <Link key={shown.id} to={`/match/${shown.fixtureId}`} className={`event-enter flex min-w-0 items-center gap-2 font-semibold ${tone(shown.t)}`} data-testid="ticker-current">
              <span aria-hidden>{icon(shown.t)}</span>
              <span className="truncate">{shown.text}</span>
            </Link>
          ) : (
            <span className="truncate text-muted" title={empty}>{empty}</span>
          )}
        </div>
        <button type="button" className="w-[5.5rem] shrink-0 border-l border-line px-2 text-center text-xs text-muted hover:text-white" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="ticker-toggle">
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
                {badgeFor ? <span className="w-[5.5rem] shrink-0 text-[10px] font-bold uppercase tracking-wider text-muted">{badgeFor(i)}</span> : null}
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
