import { Link, NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { useLive, credits } from "../lib/live";
import { useSlip } from "./BetSlip";

const NAV = [
  { to: "/live", label: "Live", icon: "◉" },
  { to: "/betting", label: "Betting", icon: "◈" },
  { to: "/my-team", label: "My Team", icon: "⬡" },
  { to: "/history", label: "History", icon: "☰" },
];

/** Connection truth: never claim to be live when we aren't. */
export function ConnectionBanner() {
  const { live, stale, conn, error } = useLive();
  if ((!live && !error) || !stale) return null;
  const text =
    conn === "auth"
      ? "Session expired — please log in again."
      : conn === "offline"
        ? "Offline — scores shown may be out of date."
        : "Reconnecting… scores shown may be out of date.";
  return (
    <div className="border-b border-amber/30 bg-amber/15 px-3 py-1.5 text-center text-sm font-semibold text-amber" role="status" data-testid="conn-banner">
      {text}
    </div>
  );
}

export default function Layout({ children, wide = false }: { children: ReactNode; wide?: boolean; title?: string }) {
  const { user, logout, isAdmin } = useAuth();
  const { balance } = useSlip();
  const max = wide ? "max-w-[1400px]" : "max-w-5xl";
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur-md">
        <div className={`mx-auto flex ${max} items-center gap-3 px-3 py-2`}>
          <Link to={user ? "/live" : "/"} className="font-display shrink-0 text-base font-black tracking-widest text-cyan">
            FOOT<span className="text-magenta">FIVE</span>
          </Link>
          {user ? (
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-bold uppercase tracking-wider ${isActive ? "bg-cyan/15 text-cyan" : "text-muted hover:text-white"}`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {user ? (
              <Link to="/betting" className="chip chip-lime !text-xs tabular" title="Your fictional betting credits" data-testid="wallet-chip">
                ◈ {balance == null ? "…" : credits(balance)}
              </Link>
            ) : null}
            {isAdmin ? (
              <NavLink to="/admin" className="btn-ghost !min-h-9 !px-2.5 !py-1 text-xs text-amber" data-testid="nav-admin">
                Admin
              </NavLink>
            ) : null}
            {user ? (
              <button type="button" className="btn-ghost !min-h-9 !px-2.5 !py-1 text-xs" onClick={logout}>
                Log out
              </button>
            ) : (
              <Link to="/login" className="btn-ghost !min-h-9 !px-2.5 !py-1 text-xs">
                Log in
              </Link>
            )}
          </div>
        </div>
        {user ? <ConnectionBanner /> : null}
      </header>

      <main className={`mx-auto w-full ${max} flex-1 px-3 pb-24 pt-3 md:pb-10`}>{children}</main>

      {user ? (
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-ink/95 backdrop-blur-md md:hidden" aria-label="Main">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-bold uppercase tracking-wider ${isActive ? "text-cyan" : "text-muted"}`}
          >
            <span aria-hidden className="text-base leading-none">
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
      </nav>
      ) : null}
    </div>
  );
}
