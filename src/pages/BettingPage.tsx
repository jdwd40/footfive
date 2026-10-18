import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { useSlip } from "../components/BetSlip";
import { Kit } from "../components/Team";
import { countdown, credits, ukTime, useLive } from "../lib/live";
import { footfiveApi, type Bet, type FixtureCard, type Market, type MyBets, type WideMarkets } from "../lib/pocketbase";
import { NOT_OFFERED, UNOFFERED_HINT, formatOdds, selectionLabel } from "../lib/priceLabel";
import { startPolling } from "../lib/polling";

const STATUS: Record<Bet["status"], { label: string; cls: string }> = {
  open: { label: "Pending", cls: "chip-amber" },
  won: { label: "Won", cls: "chip-lime" },
  lost: { label: "Lost", cls: "chip-muted" },
  void: { label: "Refunded", cls: "chip-magenta" },
};

export default function BettingPage() {
  const { live, now, stale } = useLive();
  const { placed, setBalance } = useSlip();
  const [mine, setMine] = useState<MyBets | null>(null);
  const [wide, setWide] = useState<WideMarkets | null>(null);
  const [tab, setTab] = useState<"open" | "settled">("open");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([footfiveApi.myBets(), footfiveApi.wideMarkets()]);
      setMine(m);
      setWide(w);
      setBalance(m.credits);
      return true;
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not load bets");
      return false;
    }
  }, [setBalance]);

  useEffect(() => {
    void load();
    return startPolling(load, 5000);
  }, [load, placed]);

  async function topUp() {
    setMsg("");
    try {
      const r = await footfiveApi.topUp();
      setMsg(`Added test credits — balance ${credits(r.credits)}.`);
      void load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Top-up unavailable");
    }
  }

  const open = mine?.bets.filter((b) => b.status === "open") || [];
  const settled = mine?.bets.filter((b) => b.status !== "open") || [];
  const fixtures = live?.fixtures || [];
  const bettable = fixtures.filter((f) => f.odds && f.status !== "finished");

  return (
    <Layout>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <section className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h1 className="font-display text-xl">Betting</h1>
              {live?.round ? (
                <span className="text-sm text-muted">
                  {live.round.label}
                  {live.round.status === "scheduled" ? ` · kick-off ${ukTime(live.round.scheduledAt)} UK (${countdown(live.round.scheduledAt - now)})` : live.mode === "live" ? " · live" : ""}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-muted">Tap a price to add it to your slip. Every bet shows its settlement rule before you confirm.</p>
          </section>

          {wide?.markets.length ? <WideBets wide={wide} /> : null}
          {wide?.blocked && live?.round?.status === "scheduled" ? (
            <p className="panel border-amber/30 p-3 text-sm text-amber" data-testid="futures-blocked">
              {wide.blocked}
            </p>
          ) : null}

          <section className="panel p-4">
            <h2 className="panel-title mb-3">Match markets</h2>
            {stale ? <p className="mb-2 text-sm text-amber">Reconnecting — prices may be out of date.</p> : null}
            {bettable.length ? (
              <div className="space-y-2">
                {bettable.map((f) => (
                  <FixtureRow key={f.id} f={f} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">
                {live?.mode === "champion" ? "The next fixtures appear five minutes before the next championship." : "No match markets are open right now."}
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-3">
          <section className="panel p-4" data-testid="wallet">
            <h2 className="panel-title">Wallet</h2>
            <p className="mt-1 text-4xl font-bold tabular text-lime" data-testid="wallet-balance">
              {mine ? credits(mine.credits) : "…"}
            </p>
            <p className="text-xs text-muted">Fictional credits · no cash value · separate from any team treasury</p>
            {mine ? (
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <dt className="text-muted">Staked</dt>
                  <dd className="tabular font-bold">{credits(mine.settledStaked)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Returned</dt>
                  <dd className="tabular font-bold">{credits(mine.settledReturned)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Net</dt>
                  <dd className={`tabular font-bold ${mine.net >= 0 ? "text-lime" : "text-live"}`}>
                    {mine.net >= 0 ? "+" : ""}
                    {credits(mine.net)}
                  </dd>
                </div>
              </dl>
            ) : null}
            {mine ? (
              <div className="mt-3 rounded-lg border border-line p-2 text-xs text-muted">
                <p>{mine.topUp.rule}</p>
                <button type="button" className="btn-ghost mt-2 w-full !min-h-9 text-xs" disabled={!mine.topUp.available} onClick={topUp} data-testid="topup">
                  {mine.topUp.available ? `Claim ${credits(mine.topUp.amount)} test credits` : mine.credits >= mine.topUp.floor ? "Top-up available below " + mine.topUp.floor : `Next top-up ${mine.topUp.nextAt ? ukTime(mine.topUp.nextAt) : "later"}`}
                </button>
              </div>
            ) : null}
            {msg ? <p className="mt-2 text-sm text-cyan">{msg}</p> : null}
          </section>

          <section className="panel p-4">
            <div className="mb-2 flex gap-1" role="tablist">
              {(["open", "settled"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} className={`chip ${tab === t ? "chip-lime" : "chip-muted"}`} onClick={() => setTab(t)}>
                  {t === "open" ? `Active (${open.length})` : `Settled (${settled.length})`}
                </button>
              ))}
            </div>
            <ul className="space-y-2" data-testid={`bets-${tab}`}>
              {(tab === "open" ? open : settled).map((b) => (
                <BetRow key={b.id} b={b} />
              ))}
              {(tab === "open" ? open : settled).length === 0 ? <li className="text-sm text-muted">{tab === "open" ? "No active bets." : "No settled bets yet."}</li> : null}
            </ul>
          </section>
        </aside>
      </div>
    </Layout>
  );
}

function BetRow({ b }: { b: Bet }) {
  const s = STATUS[b.status];
  return (
    <li className="rounded-lg border border-line p-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-semibold">{b.label}</span>
        <span className={`chip ${s.cls}`}>{s.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted tabular">
        <span>
          Stake {credits(b.stake)} @ {b.odds.toFixed(2)}
        </span>
        {b.status === "open" ? <span>Returns {credits(b.potential)}</span> : null}
        {b.status === "won" ? (
          <span className="text-lime">
            Returned {credits(b.payout)} (+{credits(b.payout - b.stake)})
          </span>
        ) : null}
        {b.status === "void" ? <span>Stake refunded</span> : null}
      </div>
      {b.note ? <p className="mt-1 text-xs text-muted">{b.note}</p> : null}
      {b.fixtureId ? (
        <Link to={`/match/${b.fixtureId}`} className="mt-1 inline-block text-xs text-cyan hover:underline">
          View match
        </Link>
      ) : null}
    </li>
  );
}

function FixtureRow({ f }: { f: FixtureCard }) {
  const { setPick, pick } = useSlip();
  const hintId = useId();
  const closed = f.odds?.closed;
  const open = !!f.odds && !closed;
  const unoffered = open && (formatOdds(f.odds?.home) == null || formatOdds(f.odds?.away) == null);
  const label = `${f.home.abbreviation} v ${f.away.abbreviation}`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
        <Kit team={f.home} />
        <span className="min-w-0 truncate font-semibold" title={f.home.name}>
          <span className="sm:hidden">{f.home.abbreviation}</span>
          <span className="hidden sm:inline">{f.home.name}</span>
        </span>
        <span className="shrink-0 tabular text-muted">{f.st ? `${f.st.sc[0]}–${f.st.sc[1]}` : "v"}</span>
        <span className="min-w-0 truncate font-semibold" title={f.away.name}>
          <span className="sm:hidden">{f.away.abbreviation}</span>
          <span className="hidden sm:inline">{f.away.name}</span>
        </span>
        <Kit team={f.away} away />
      </div>
      <div className="flex w-full items-center gap-1.5 sm:w-auto">
        {(["home", "away"] as const).map((side) => {
          const odds = f.odds?.[side];
          const team = side === "home" ? f.home : f.away;
          const priced = !!formatOdds(odds);
          const bare = open && !priced;
          return (
            <button
              key={side}
              type="button"
              className={priced ? "btn-odds flex-1 sm:w-20 sm:flex-none" : "btn-odds min-w-0 flex-1 sm:w-20 sm:flex-none"}
              disabled={!!closed || !odds}
              aria-pressed={pick?.fixtureId === f.id && pick.market === "winner" && pick.selection === side}
              aria-label={bare ? `${team.name}, ${NOT_OFFERED}` : undefined}
              aria-describedby={bare ? hintId : undefined}
              onClick={() =>
                odds &&
                setPick({
                  market: "winner",
                  marketTitle: "To qualify",
                  rules: "Team that goes through, including extra time and penalties.",
                  fixtureId: f.id,
                  fixtureLabel: label,
                  selection: side,
                  label: team.name,
                  odds,
                })
              }
            >
              <span className="text-[11px] opacity-80">{team.abbreviation}</span>
              <span className={priced ? "tabular text-sm" : "max-w-full text-center text-[11px] font-semibold leading-tight whitespace-normal"}>
                {selectionLabel(odds, open)}
              </span>
            </button>
          );
        })}
        <Link to={`/match/${f.id}`} className="btn-ghost !min-h-11 !px-3 text-xs" title="All markets for this match">
          More
        </Link>
      </div>
      {unoffered ? (
        <p id={hintId} className="w-full text-[11px] leading-tight text-muted" data-testid="unoffered-hint">
          {UNOFFERED_HINT}
        </p>
      ) : null}
      {closed ? <p className="w-full text-xs text-amber">{closed}</p> : null}
    </div>
  );
}

function WideMarket({ m }: { m: Market }) {
  const { setPick } = useSlip();
  const hintId = useId();
  const selections = m.sel || [];
  const open = !m.closed;
  const unoffered = open && selections.some((s) => !formatOdds(s.odds));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">{m.title}</h3>
        {m.closesAt ? <span className="text-[11px] text-muted">Closes {ukTime(m.closesAt)} UK</span> : null}
      </div>
      <p className="text-xs text-muted">{m.rules}</p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {selections.map((s) => {
          const priced = !!formatOdds(s.odds);
          const bare = open && !priced;
          return (
            <button
              key={s.id}
              type="button"
              className={priced ? "btn-odds !flex-row !justify-between gap-2 px-2" : "btn-odds min-w-0 !flex-row !justify-between gap-2 px-2"}
              disabled={!open || !s.odds}
              aria-label={bare ? `${s.label}, ${NOT_OFFERED}` : undefined}
              aria-describedby={bare ? hintId : undefined}
              onClick={() => open && s.odds && setPick({ market: m.key, marketTitle: m.title, rules: m.rules, selection: s.id, label: s.label, odds: s.odds })}
              title={s.label}
            >
              <span className="truncate font-display text-xs" title={s.label}>
                {s.short}
              </span>
              <span className={priced ? "tabular text-sm" : "min-w-0 text-center text-[11px] font-semibold leading-tight whitespace-normal"}>
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
      {m.closed ? <p className="mt-1 text-xs text-amber">{m.closed}</p> : null}
    </div>
  );
}

/** Round-first, championship winner and semi-finalist predictions (pre-round only). */
function WideBets({ wide }: { wide: WideMarkets }) {
  const { setPick } = useSlip();
  const [semis, setSemis] = useState<string[]>(["", "", "", ""]);
  const [semiPrice, setSemiPrice] = useState<string>("");
  return (
    <section className="panel p-4" data-testid="wide-markets">
      <h2 className="panel-title mb-3">Round & championship</h2>
      <div className="space-y-4">
        {wide.markets.map((m) =>
          m.key === "semis" && m.quarters ? (
            <div key={m.key}>
              <h3 className="text-sm font-bold">{m.title}</h3>
              <p className="text-xs text-muted">{m.rules}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {m.quarters.map((q, qi) => (
                  <label key={qi} className="text-xs text-muted">
                    Quarter {qi + 1}
                    <select
                      className="input mt-1 !min-h-10 !py-1"
                      value={semis[qi]}
                      onChange={(e) => {
                        const next = [...semis];
                        next[qi] = e.target.value;
                        setSemis(next);
                        setSemiPrice("");
                      }}
                    >
                      <option value="">Choose…</option>
                      {q.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label} ({Math.round(t.p * 100)}%)
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost mt-2 w-full"
                disabled={semis.some((s) => !s)}
                onClick={() => {
                  const ps = semis.map((id, qi) => m.quarters![qi].find((t) => t.id === id)!.p);
                  const p = ps.reduce((a, b) => a * b, 1);
                  const odds = Math.round(Math.min(500, Math.max(1.01, 0.94 / p)) * 100) / 100;
                  setSemiPrice(odds.toFixed(2));
                  setPick({
                    market: "semis",
                    marketTitle: m.title,
                    rules: m.rules,
                    selection: semis.join(","),
                    label: semis.map((id, qi) => m.quarters![qi].find((t) => t.id === id)!.short).join(", "),
                    odds,
                  });
                }}
                data-testid="semis-add"
              >
                Add semi-finalists to slip{semiPrice ? ` @ ${semiPrice}` : ""}
              </button>
            </div>
          ) : (
            <WideMarket key={m.key} m={m} />
          ),
        )}
      </div>
    </section>
  );
}
