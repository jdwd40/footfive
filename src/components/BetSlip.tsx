/**
 * Bet slip: one selection at a time (reliable singles). The confirmed price is sent with the
 * bet; the server rejects it if the price has moved against the user and we show the new price.
 * One requestId per confirmation makes double-clicks and retries idempotent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { footfiveApi, type Bet } from "../lib/pocketbase";
import { useAuth } from "../lib/auth";
import { credits } from "../lib/live";

export type SlipPick = {
  market: string;
  marketTitle: string;
  rules: string;
  fixtureId?: string;
  fixtureLabel?: string;
  selection: string;
  label: string;
  odds: number;
};

type SlipCtx = {
  pick: SlipPick | null;
  setPick: (p: SlipPick | null) => void;
  balance: number | null;
  setBalance: (n: number) => void;
  lastWin: Bet | null;
  placed: number;
};

const Ctx = createContext<SlipCtx | null>(null);

export function useSlip() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSlip outside BetSlipProvider");
  return c;
}

/** Polls the wallet and surfaces newly-settled winning bets once. */
export function BetSlipProvider({ children }: { children: ReactNode }) {
  const [pick, setPick] = useState<SlipPick | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [lastWin, setLastWin] = useState<Bet | null>(null);
  const [placed, setPlaced] = useState(0);
  const seen = useRef<Set<string> | null>(null);
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    seen.current = null;
    if (!userId) {
      setBalance(null);
      return;
    }
    let alive = true;
    async function poll() {
      try {
        const mb = await footfiveApi.myBets();
        if (!alive) return;
        setBalance(mb.credits);
        const settledWins = mb.bets.filter((b) => b.status === "won");
        if (seen.current) {
          const fresh = settledWins.find((b) => !seen.current!.has(b.id));
          if (fresh) setLastWin(fresh);
        }
        seen.current = new Set(settledWins.map((b) => b.id));
      } catch {
        /* the live store reports connection problems */
      }
    }
    void poll();
    const id = setInterval(poll, 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [placed, userId]);

  const value = useMemo(
    () => ({
      pick,
      setPick,
      balance,
      setBalance,
      lastWin,
      placed,
    }),
    [pick, balance, lastWin, placed],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <BetSlip onPlaced={() => setPlaced((n) => n + 1)} />
      <WinToast bet={lastWin} onDone={() => setLastWin(null)} />
    </Ctx.Provider>
  );
}

function newRequestId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 32);
}

function BetSlip({ onPlaced }: { onPlaced: () => void }) {
  const { pick, setPick, balance, setBalance } = useSlip();
  const [stake, setStake] = useState("10");
  const [state, setState] = useState<"edit" | "sending" | "done">("edit");
  const [error, setError] = useState("");
  const [newOdds, setNewOdds] = useState<number | null>(null);
  const [placedBet, setPlacedBet] = useState<Bet | null>(null);
  const reqId = useRef(newRequestId());

  useEffect(() => {
    setState("edit");
    setError("");
    setNewOdds(null);
    setPlacedBet(null);
    reqId.current = newRequestId();
  }, [pick]);

  const close = useCallback(() => setPick(null), [setPick]);

  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && state !== "sending" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, state, close]);

  if (!pick) return null;
  const n = Math.floor(Number(stake));
  const valid = Number.isFinite(n) && n >= 1 && String(n) === stake.trim();
  const ret = valid ? Math.floor(n * pick.odds + 1e-9) : 0;
  const tooMuch = balance != null && valid && n > balance;

  async function confirm() {
    if (!pick || !valid || tooMuch) return;
    setState("sending");
    setError("");
    try {
      const r = await footfiveApi.placeBet({
        market: pick.market,
        fixtureId: pick.fixtureId,
        selection: pick.selection,
        stake: n,
        odds: pick.odds,
        requestId: reqId.current,
      });
      setPlacedBet(r.bet);
      setState("done");
      if (balance != null && !r.duplicate) setBalance(balance - n);
      onPlaced();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bet failed";
      const m = /Odds changed to (\d+\.\d+)/.exec(msg);
      setNewOdds(m ? Number(m[1]) : null);
      setError(msg);
      setState("edit");
      reqId.current = newRequestId(); // a rejected request may be retried as a new one
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 sm:inset-auto sm:bottom-4 sm:right-4 sm:w-[380px]" role="dialog" aria-label="Bet slip" data-testid="bet-slip">
      <div className="glass safe-bottom rounded-t-2xl border-lime/30 !bg-panel p-4 shadow-2xl sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <span className="panel-title !text-lime">Bet slip</span>
          <button type="button" className="text-sm text-muted hover:text-white" onClick={close} disabled={state === "sending"} aria-label="Close bet slip">
            ✕
          </button>
        </div>

        {state === "done" && placedBet ? (
          <div className="space-y-3" data-testid="bet-placed">
            <p className="font-display text-lime">Bet accepted</p>
            <p className="text-sm">{placedBet.label}</p>
            <p className="text-sm text-muted">
              Stake {credits(placedBet.stake)} · locked at <b className="text-white">{placedBet.odds.toFixed(2)}</b> · returns{" "}
              <b className="text-white">{credits(placedBet.potential)}</b> if it wins
            </p>
            <button type="button" className="btn-ghost w-full" onClick={close}>
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              {pick.fixtureLabel ? <p className="text-xs uppercase tracking-wider text-muted">{pick.fixtureLabel}</p> : null}
              <p className="text-sm text-muted">{pick.marketTitle}</p>
              <p className="flex items-baseline justify-between gap-2 text-lg font-bold">
                <span className="min-w-0 truncate">{pick.label}</span>
                <span className="tabular text-xl font-bold text-lime" data-testid="slip-odds">
                  {pick.odds.toFixed(2)}
                </span>
              </p>
              <details className="mt-1 text-xs text-muted">
                <summary className="cursor-pointer select-none">How this market settles</summary>
                <p className="mt-1">{pick.rules}</p>
              </details>
            </div>

            <label className="block">
              <span className="text-xs text-muted">Stake (credits{balance != null ? ` · balance ${credits(balance)}` : ""})</span>
              <input
                className="input mt-1 tabular"
                inputMode="numeric"
                value={stake}
                onChange={(e) => setStake(e.target.value.replace(/[^\d]/g, ""))}
                aria-invalid={!valid || tooMuch}
                data-testid="slip-stake"
              />
            </label>
            <div className="flex gap-2">
              {[10, 25, 50, 100].map((q) => (
                <button key={q} type="button" className="btn-ghost !min-h-9 flex-1 !px-0 !py-1 text-xs" onClick={() => setStake(String(q))}>
                  {q}
                </button>
              ))}
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-muted">Total return if it wins</span>
              <span className="tabular font-bold">{valid ? credits(ret) : "–"}</span>
            </div>
            <div className="flex justify-between text-xs text-muted">
              <span>Profit</span>
              <span className="tabular">{valid ? `+${credits(ret - n)}` : "–"}</span>
            </div>

            {tooMuch ? <p className="text-sm text-amber">Not enough credits for this stake.</p> : null}
            {error ? (
              <div className="rounded-lg border border-amber/40 bg-amber/10 p-2 text-sm text-amber" role="alert" data-testid="slip-error">
                {error}
                {newOdds ? (
                  <button
                    type="button"
                    className="btn-ghost mt-2 w-full !min-h-9 text-xs"
                    onClick={() => {
                      setPick({ ...pick, odds: newOdds });
                    }}
                    data-testid="slip-accept-new-odds"
                  >
                    Use new price {newOdds.toFixed(2)}
                  </button>
                ) : null}
              </div>
            ) : null}

            <button type="button" className="btn-primary w-full" disabled={!valid || tooMuch || state === "sending"} onClick={confirm} data-testid="slip-confirm">
              {state === "sending" ? "Placing…" : `Place ${valid ? credits(n) : ""} @ ${pick.odds.toFixed(2)}`}
            </button>
            <p className="text-center text-[11px] text-muted">Fictional credits only — no cash value.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small, tasteful win notification: total return and net profit, shown once. */
function WinToast({ bet, onDone }: { bet: Bet | null; onDone: () => void }) {
  useEffect(() => {
    if (!bet) return;
    const id = setTimeout(onDone, 7000);
    return () => clearTimeout(id);
  }, [bet, onDone]);
  if (!bet) return null;
  const colors = ["#b8ff3c", "#00f0ff", "#ff2d95", "#ffb020"];
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-50 w-[min(92vw,360px)] -translate-x-1/2" role="status" aria-live="polite" data-testid="win-toast">
      <div className="glass toast-in relative overflow-hidden rounded-2xl border-lime/40 p-4">
        <div className="confetti pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ left: `${(i * 7 + 3) % 100}%`, background: colors[i % 4], animationDelay: `${(i % 5) * 0.12}s` }} />
          ))}
        </div>
        <p className="font-display text-sm text-lime">Winning bet!</p>
        <p className="truncate text-sm">{bet.label}</p>
        <p className="mt-1 text-sm">
          Returned <b className="tabular">{credits(bet.payout)}</b> · profit <b className="tabular text-lime">+{credits(bet.payout - bet.stake)}</b>
        </p>
      </div>
    </div>
  );
}
