import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Layout from "../components/Layout";
import { postLoginPath, useAuth } from "../lib/auth";
import { footfiveApi, pb } from "../lib/pocketbase";

export default function ChangePasswordPage() {
  const { user, logout, refreshMe } = useAuth();
  const nav = useNavigate();
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword === currentPassword) {
      setError("New password must differ from temporary password");
      return;
    }
    setBusy(true);
    try {
      await footfiveApi.changePassword(currentPassword, newPassword);
      // Re-auth with new password (token may be rotated)
      if (user?.email) {
        await pb.collection("users").authWithPassword(user.email, newPassword);
      }
      const refreshed = await refreshMe();
      nav(postLoginPath(refreshed || user), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Change password">
      <form
        onSubmit={onSubmit}
        className="glass mx-auto max-w-md space-y-4 rounded-2xl p-5"
        data-testid="change-password-form"
      >
        <h1 className="font-display text-xl text-cyan">Set a new password</h1>
        <p className="text-sm text-muted">
          Your administrator set a temporary password. Choose a new one to continue.
        </p>
        {error ? (
          <p className="text-sm text-magenta" data-testid="change-password-error">
            {error}
          </p>
        ) : null}
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Temporary / current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
            required
            data-testid="current-password"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">New password (min 8)</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNew(e.target.value)}
            required
            minLength={8}
            data-testid="new-password"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-muted">Confirm new password</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={8}
            data-testid="confirm-password"
          />
        </label>
        <button
          className="btn-primary w-full"
          type="submit"
          disabled={busy}
          data-testid="change-password-submit"
        >
          {busy ? "Saving…" : "Update password"}
        </button>
        <button
          type="button"
          className="btn-ghost w-full text-xs"
          onClick={() => {
            logout();
            nav("/login");
          }}
        >
          Log out
        </button>
      </form>
    </Layout>
  );
}
