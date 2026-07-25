import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
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
  const { user, loading, mustChangePassword } = useAuth();
  if (loading) return <Fallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (!mustChangePassword) return <Navigate to="/dashboard" replace />;
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
            <RequireAuth>
              <AdminPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
