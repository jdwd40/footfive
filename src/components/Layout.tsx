import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { ReactNode } from "react";
import RoundCountdownBanner from "./RoundCountdownBanner";

export default function Layout({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  const { user, logout, isAdmin } = useAuth();
  return (
    <div className="min-h-dvh flex flex-col overflow-x-hidden">
      <header className="sticky top-0 z-20 border-b border-cyan/15 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3 py-3">
          <Link
            to={user ? "/dashboard" : "/"}
            className="font-display shrink-0 text-sm text-cyan sm:text-base"
          >
            FOOTFIVE
          </Link>
          {title ? (
            <div className="min-w-0 flex-1 truncate text-center text-sm uppercase tracking-widest text-muted">
              {title}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {user ? (
            <div className="flex shrink-0 items-center gap-1">
              {isAdmin ? (
                <NavLink
                  to="/admin"
                  data-testid="nav-admin"
                  className={({ isActive }) =>
                    `btn-ghost !min-h-9 !px-2.5 !py-1.5 text-xs font-semibold ${
                      isActive ? "text-cyan ring-1 ring-cyan/40" : "text-amber"
                    }`
                  }
                >
                  Admin
                </NavLink>
              ) : null}
              <button
                type="button"
                className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
                onClick={logout}
              >
                Log out
              </button>
            </div>
          ) : (
            <Link to="/login" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
              Log in
            </Link>
          )}
        </div>
        {user ? (
          <div className="mx-auto max-w-3xl px-3 pb-2">
            <RoundCountdownBanner />
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 pb-10">{children}</main>
    </div>
  );
}
