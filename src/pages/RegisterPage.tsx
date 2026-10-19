import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { useAuth } from "../lib/auth";

export default function RegisterPage() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await register(email.trim(), password, displayName.trim());
      nav("/live");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Register">
      <form onSubmit={onSubmit} className="glass mx-auto max-w-md space-y-4 rounded-2xl p-5">
        <h1 className="font-display text-xl text-cyan">Create account</h1>
        {error ? <p className="text-sm text-magenta">{error}</p> : null}
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Display name</span>
          <span className="block text-xs text-muted">Public name. Sign in with your email.</span>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Email</span>
          <input
            className="input"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Password (min 8)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        <button className="btn-primary w-full" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Register"}
        </button>
        <p className="text-center text-sm text-muted">
          Have an account?{" "}
          <Link className="text-cyan" to="/login">
            Log in
          </Link>
        </p>
      </form>
    </Layout>
  );
}
