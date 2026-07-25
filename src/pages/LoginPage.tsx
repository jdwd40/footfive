import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email.trim(), password);
      // must_change_password gate handled by routes
      nav("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Log in">
      <form
        onSubmit={onSubmit}
        className="glass mx-auto max-w-md space-y-4 rounded-2xl p-5"
        data-testid="login-form"
      >
        <h1 className="font-display text-xl text-cyan">Welcome back</h1>
        {error ? (
          <p className="text-sm text-magenta" data-testid="login-error">
            {error}
          </p>
        ) : null}
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="login-email"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            data-testid="login-password"
          />
        </label>
        <button
          className="btn-primary w-full"
          type="submit"
          disabled={busy}
          data-testid="login-submit"
        >
          {busy ? "Signing in…" : "Log in"}
        </button>
        <p className="text-center text-sm text-muted">
          No account?{" "}
          <Link className="text-cyan" to="/register">
            Register
          </Link>
        </p>
      </form>
    </Layout>
  );
}
