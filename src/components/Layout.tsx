import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { ReactNode } from "react";

export default function Layout({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="sticky top-0 z-20 border-b border-cyan/15 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-3 py-3">
          <Link to={user ? "/dashboard" : "/"} className="font-display text-sm text-cyan sm:text-base">
            FOOTFIVE
          </Link>
          {title ? (
            <div className="truncate text-center text-sm uppercase tracking-widest text-muted">
              {title}
            </div>
          ) : (
            <div />
          )}
          {user ? (
            <button type="button" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs" onClick={logout}>
              Log out
            </button>
          ) : (
            <Link to="/login" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
              Log in
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-3 py-4 pb-10">{children}</main>
    </div>
  );
}
