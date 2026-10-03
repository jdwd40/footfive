import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";

export default function LandingPage() {
  const { user } = useAuth();
  return (
    <Layout>
      <section className="glass relative overflow-hidden rounded-3xl p-6 sm:p-8">
        <div
          className="pointer-events-none absolute inset-0 opacity-30"
          style={{
            backgroundImage: `url(${import.meta.env.BASE_URL}assets/arena-bg.jpg)`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
        <div className="relative">
          <p className="mb-2 text-xs uppercase tracking-[0.25em] text-magenta">Proball Manager</p>
          <h1 className="font-display text-3xl leading-tight text-white sm:text-4xl">
            Command a cyborg five.
            <span className="block text-cyan">Watch the Proball live.</span>
          </h1>
          <p className="mt-4 max-w-md text-base text-muted">
            One shared 16-team championship runs around the clock. Watch every match live,
            bet fictional credits, or claim a free team and leave it competing while you're away.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            {user ? (
              <Link to="/live" className="btn-primary">
                Watch live
              </Link>
            ) : (
              <>
                <Link to="/register" className="btn-primary">
                  Create account
                </Link>
                <Link to="/login" className="btn-ghost">
                  Log in
                </Link>
              </>
            )}
          </div>
        </div>
      </section>
    </Layout>
  );
}
