import { lazy, Suspense } from "react";
import { Link, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ChangePasswordPage from "./pages/ChangePasswordPage";

const LivePage = lazy(() => import("./pages/LivePage"));
const MatchPage = lazy(() => import("./pages/MatchPage"));
const BettingPage = lazy(() => import("./pages/BettingPage"));
const MyTeamPage = lazy(() => import("./pages/MyTeamPage"));
const RecordsPage = lazy(() => import("./pages/RecordsPage"));
const TeamDetailPage = lazy(() => import("./pages/TeamDetailPage"));
const TournamentDetailPage = lazy(() => import("./pages/TournamentDetailPage"));
const MatchDetailPage = lazy(() => import("./pages/MatchDetailPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));

function Fallback() {
  return (
    <div className="min-h-dvh grid place-items-center text-cyan" data-testid="route-loading">
      Loading…
    </div>
  );
}

/** Signed-in area. */
function RequireAuth() {
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
  return <Outlet />;
}

function RequirePasswordChange({ children }: { children: React.ReactNode }) {
  const { user, loading, mustChangePassword, isAdmin } = useAuth();
  if (loading) return <Fallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (!mustChangePassword) return <Navigate to={isAdmin ? "/admin" : "/live"} replace />;
  return children;
}

/** Explicit admin guard — never blank. The server enforces the role on every admin route. */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <div className="min-h-dvh grid place-items-center px-4" data-testid="admin-forbidden">
        <div className="glass max-w-md space-y-3 rounded-2xl p-6 text-center">
          <p className="font-display text-lg text-magenta">Administrator access required</p>
          <p className="text-sm text-muted">Your account does not have the application admin role.</p>
          <Link to="/live" className="btn-primary inline-block" data-testid="admin-back-dashboard">
            Back to the live round
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
        <Route element={<RequireAuth />}>
          <Route path="/live" element={<LivePage />} />
          <Route path="/match/:fixtureId" element={<MatchPage />} />
          <Route path="/betting" element={<BettingPage />} />
          <Route path="/my-team" element={<MyTeamPage />} />
          <Route path="/history" element={<RecordsPage />} />
          <Route path="/records/teams/:id" element={<TeamDetailPage />} />
          <Route path="/records/tournaments/:id" element={<TournamentDetailPage />} />
          <Route path="/records/matches/:id" element={<MatchDetailPage />} />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            }
          />
          {/* old bookmarks */}
          <Route path="/dashboard" element={<Navigate to="/live" replace />} />
          <Route path="/scoreboard" element={<Navigate to="/live" replace />} />
          <Route path="/squad" element={<Navigate to="/my-team" replace />} />
          <Route path="/career/new" element={<Navigate to="/my-team" replace />} />
          <Route path="/records" element={<Navigate to="/history" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
