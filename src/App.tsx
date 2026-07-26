import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";

const TeamSelectPage = lazy(() => import("./pages/TeamSelectPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const ScoreboardPage = lazy(() => import("./pages/ScoreboardPage"));
const LiveMatchPage = lazy(() => import("./pages/LiveMatchPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const BettingPage = lazy(() => import("./pages/BettingPage"));
const SquadPage = lazy(() => import("./pages/SquadPage"));
const RecordsPage = lazy(() => import("./pages/RecordsPage"));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage"));
const TournamentDetailPage = lazy(() => import("./pages/TournamentDetailPage"));
const MatchDetailPage = lazy(() => import("./pages/MatchDetailPage"));

function Fallback() {
  return (
    <div className="min-h-dvh grid place-items-center text-cyan" data-testid="route-loading">
      Loading…
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword } = useAuth();
  if (loading) {
    return (
      <div className="min-h-dvh grid place-items-center text-cyan" data-testid="auth-loading">
        Restoring session…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  return children;
}

function RequirePasswordChange({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword, isAdmin } = useAuth();
  if (loading) return <Fallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (!mustChangePassword) {
    return <Navigate to={isAdmin ? "/admin" : "/dashboard"} replace />;
  }
  return children;
}

/** Explicit admin guard — never blank. */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword, isAdmin } = useAuth();
  if (loading) {
    return (
      <div className="min-h-dvh grid place-items-center text-cyan" data-testid="admin-loading">
        Checking administrator access…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!isAdmin) {
    return (
      <div className="min-h-dvh grid place-items-center px-4" data-testid="admin-forbidden">
        <div className="glass max-w-md space-y-3 rounded-2xl p-6 text-center">
          <p className="font-display text-lg text-magenta">Administrator access required</p>
          <p className="text-sm text-muted">
            Your account does not have the application admin role.
          </p>
          <Link to="/dashboard" className="btn-primary inline-block" data-testid="admin-back-dashboard">
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }
  return children;
}

export default function App() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/change-password"
          element={
            <RequirePasswordChange>
              <ChangePasswordPage />
            </RequirePasswordChange>
          }
        />
        <Route
          path="/career/new"
          element={
            <RequireAuth>
              <TeamSelectPage />
            </RequireAuth>
          }
        />
        <Route
          path="/dashboard"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/scoreboard"
          element={
            <RequireAuth>
              <ScoreboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/match/:fixtureId"
          element={
            <RequireAuth>
              <LiveMatchPage />
            </RequireAuth>
          }
        />
        <Route
          path="/squad"
          element={
            <RequireAuth>
              <SquadPage />
            </RequireAuth>
          }
        />
        <Route
          path="/betting"
          element={
            <RequireAuth>
              <BettingPage />
            </RequireAuth>
          }
        />
        <Route
          path="/records"
          element={
            <RequireAuth>
              <RecordsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/records/teams/:id"
          element={
            <RequireAuth>
              <TeamDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/records/tournaments/:id"
          element={
            <RequireAuth>
              <TournamentDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/records/matches/:id"
          element={
            <RequireAuth>
              <MatchDetailPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
