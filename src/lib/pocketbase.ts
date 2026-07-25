import PocketBase from "pocketbase";
import { POCKETBASE_URL } from "./config";

export const pb = new PocketBase(POCKETBASE_URL);
pb.autoCancellation(false);

export type TeamPublic = {
  id: string;
  name: string;
  grade: string;
  primary_color: string;
  secondary_color: string;
  badge_key: string;
  strength?: number;
  managerId?: string | null;
  managerName?: string | null;
  available?: boolean;
  eliminated?: boolean;
  slug?: string;
};

export type ScoreboardFixture = {
  fixtureId: string;
  slot: string;
  bracketIndex: number;
  home: TeamPublic;
  away: TeamPublic;
  scheduledAt: string;
  status: string;
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
  minute: number;
  phase: string;
  finished: boolean;
  winnerTeamId?: string | null;
  homeCoaching?: string;
  awayCoaching?: string;
};

export type MatchEvent = {
  seq: number;
  minute: number;
  phase: string;
  offsetMs: number;
  type: string;
  team: "home" | "away" | null;
  player: string | null;
  message: string;
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
};

export type ShootoutKick = {
  kickIndex: number;
  team: "home" | "away";
  kickNumber: number;
  suddenDeath?: boolean;
  player?: string;
  outcome: "goal" | "save" | "miss";
  mustScore?: boolean;
  decisive?: boolean;
  takenHome?: number;
  takenAway?: number;
};

export type MatchView = {
  serverTime: string;
  serverTimeMs: number;
  fixtureId: string;
  home: TeamPublic;
  away: TeamPublic;
  status: string;
  scoreHome: number;
  scoreAway: number;
  shootoutHome: number;
  shootoutAway: number;
  shootoutTakenHome?: number;
  shootoutTakenAway?: number;
  shootoutSide?: "home" | "away" | null;
  shootoutKicks?: ShootoutKick[];
  minute: number;
  phase: string;
  events: MatchEvent[];
  newEvents: MatchEvent[];
  lastSeq: number;
  finished: boolean;
  caughtUp?: boolean;
  stats: Record<string, unknown> | null;
  winnerTeamId?: string | null;
  managedSide?: "home" | "away" | null;
  homeCoaching?: string;
  awayCoaching?: string;
  canCoach?: boolean;
};

export type ScoreboardResponse = {
  serverTime: string;
  serverTimeMs: number;
  round: {
    id: string;
    key: string;
    label: string;
    status: string;
    scheduledAt: string;
    startedAt?: string;
  } | null;
  fixtures: ScoreboardFixture[];
};

export type WorldSnapshot = {
  serverTime: string;
  serverTimeMs: number;
  world: {
    pace: string;
    nextActionAt?: string;
    roundIntervalMs?: number;
    aiProgressionEnabled?: boolean;
  };
  tournament: {
    id: string;
    number: number;
    status: string;
    current_round: string;
    champion_team?: string;
  } | null;
  activeRound: {
    id: string;
    key: string;
    label: string;
    status: string;
    scheduledAt: string;
    startedAt?: string;
  } | null;
  managedTeam: (TeamPublic & { treasury?: number; battery_count?: number }) | null;
  isSpectator: boolean;
  managementOpen: boolean;
  credits: number;
  bettingCredits?: number;
  teamTreasury?: number | null;
  startingCredits: number;
  squadAverages?: { energy: number; condition: number } | null;
  commandCharge?: { points: number; max: number; nextPointInMs: number } | null;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (pb.authStore.token) {
    headers.Authorization = pb.authStore.token;
  }
  const res = await fetch(`${POCKETBASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { message?: string };
      msg = j.message || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const footfiveApi = {
  serverTime: () => api<{ serverTime: string; serverTimeMs: number }>("/api/footfive/server-time"),
  world: () => api<WorldSnapshot>("/api/footfive/world"),
  teams: () => api<{ teams: TeamPublic[] }>("/api/footfive/teams"),
  claimTeam: (teamId: string) =>
    api<{ team: TeamPublic }>(`/api/footfive/teams/${teamId}/claim`, { method: "POST" }),
  catchUp: () => api<{ ok: boolean }>("/api/footfive/catch-up", { method: "POST" }),
  tournament: () => api<WorldSnapshot>("/api/footfive/tournament"),
  scoreboard: () => api<ScoreboardResponse>("/api/footfive/scoreboard"),
  match: (fixtureId: string, sinceSeq = 0) =>
    api<MatchView>(`/api/footfive/match/${fixtureId}?sinceSeq=${sinceSeq}`),
  coaching: (fixtureId: string, stance: "defend" | "balanced" | "attack") =>
    api<{ ok: boolean; stance: string; message: string }>(
      `/api/footfive/matches/${fixtureId}/coaching`,
      { method: "POST", body: JSON.stringify({ stance }) },
    ),
  saveLineup: (teamId: string, starters: string[], subs: string[]) =>
    api<{ ok: boolean }>(`/api/footfive/teams/${teamId}/lineup`, {
      method: "POST",
      body: JSON.stringify({ starters, subs }),
    }),
  bettingFixtures: () =>
    api<{
      fixtures: Array<{
        fixtureId: string;
        home: TeamPublic;
        away: TeamPublic;
        scheduledAt: string;
        homeOdds: number;
        awayOdds: number;
      }>;
    }>("/api/footfive/betting/fixtures"),
  placeBet: (fixtureId: string, selectionTeamId: string, stake: number) =>
    api<{ bet: { id: string; stake: number; odds: number; status: string } }>(
      "/api/footfive/bets",
      {
        method: "POST",
        body: JSON.stringify({ fixtureId, selectionTeamId, stake }),
      },
    ),
  myBets: () =>
    api<{
      bets: Array<{
        id: string;
        fixtureId: string;
        selectionTeamId: string;
        stake: number;
        odds: number;
        status: string;
        settled: boolean;
      }>;
    }>("/api/footfive/bets/mine"),

  myTeam: () =>
    api<{
      team: TeamPublic & {
        treasury: number;
        battery_count: number;
        overclock_ready?: boolean;
      };
      players: Array<{
        id: string;
        name: string;
        role: string;
        attack: number;
        defence: number;
        energy: number;
        condition: number;
        intensity: string;
        is_starter: boolean;
        effective_attack: number;
        effective_defence: number;
        sort_order: number;
      }>;
      averages: { energy: number; condition: number };
      managementOpen: boolean;
      batteryCost: number;
      repairCostPerPoint: number;
    }>("/api/footfive/my-team"),

  saveMyLineup: (starters: string[], subs: string[]) =>
    api<{ ok: boolean }>("/api/footfive/my-team/lineup", {
      method: "POST",
      body: JSON.stringify({ starters, subs }),
    }),

  setIntensity: (playerId: string, intensity: string) =>
    api<{ ok: boolean }>("/api/footfive/my-team/intensity", {
      method: "POST",
      body: JSON.stringify({ playerId, intensity }),
    }),

  upgradePlayer: (playerId: string, attribute: "attack" | "defence") =>
    api<{ ok: boolean; cost: number; newValue: number }>(
      `/api/footfive/players/${playerId}/upgrade`,
      { method: "POST", body: JSON.stringify({ attribute }) },
    ),

  buyBattery: (count = 1) =>
    api<{ ok: boolean }>("/api/footfive/team-shop/batteries/buy", {
      method: "POST",
      body: JSON.stringify({ count }),
    }),

  useBattery: (playerId: string) =>
    api<{ ok: boolean }>(`/api/footfive/players/${playerId}/battery`, {
      method: "POST",
    }),

  repairPlayer: (playerId: string, points: number) =>
    api<{ ok: boolean }>(`/api/footfive/players/${playerId}/repair`, {
      method: "POST",
      body: JSON.stringify({ points }),
    }),

  teamFinances: () =>
    api<{
      treasury: number;
      entries: Array<{
        id: string;
        amount: number;
        type: string;
        description: string;
        balance_after: number;
        created: string;
      }>;
    }>("/api/footfive/my-team/finances"),

  commandCharge: () =>
    api<{ points: number; max: number; nextPointInMs: number }>(
      "/api/footfive/command-charge",
    ),

  spendCommandCharge: (
    action: string,
    playerId?: string,
    fixtureId?: string,
  ) =>
    api<Record<string, unknown>>("/api/footfive/command-charge/spend", {
      method: "POST",
      body: JSON.stringify({ action, playerId, fixtureId }),
    }),

  recordsOverview: () => api<Record<string, unknown>>("/api/footfive/records/overview"),
  recordsTeams: () =>
    api<{ teams: Array<Record<string, unknown>> }>("/api/footfive/records/teams"),
  recordsTournaments: () =>
    api<{ tournaments: Array<Record<string, unknown>> }>("/api/footfive/records/tournaments"),
  recordsMatches: (qs = "") =>
    api<{ matches: Array<Record<string, unknown>> }>(
      `/api/footfive/records/matches${qs ? `?${qs}` : ""}`,
    ),
  recordsPlayers: (qs = "") =>
    api<{ players: Array<Record<string, unknown>> }>(
      `/api/footfive/records/players${qs ? `?${qs}` : ""}`,
    ),
  recordsTeamDetail: (id: string) =>
    api<Record<string, unknown>>(`/api/footfive/records/teams/${id}`),
  recordsTournamentDetail: (id: string) =>
    api<Record<string, unknown>>(`/api/footfive/records/tournaments/${id}`),
  recordsMatchDetail: (id: string) =>
    api<Record<string, unknown>>(`/api/footfive/records/matches/${id}`),
  betsHistory: () => api<Record<string, unknown>>("/api/footfive/bets/history"),

  adminOverview: () => api<Record<string, unknown>>("/api/footfive/admin/overview"),
  adminUsers: (q = "") =>
    api<{ users: Array<Record<string, unknown>> }>(
      `/api/footfive/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ),
  adminCreateUser: (body: Record<string, unknown>) =>
    api<Record<string, unknown>>("/api/footfive/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminDisableUser: (id: string, reason: string) =>
    api(`/api/footfive/admin/users/${id}/disable`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  adminEnableUser: (id: string, reason: string) =>
    api(`/api/footfive/admin/users/${id}/enable`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  adminDeleteUser: (id: string, reason: string) =>
    api(`/api/footfive/admin/users/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    }),
  adminCredits: (id: string, mode: string, amount: number, reason: string) =>
    api(`/api/footfive/admin/users/${id}/credits`, {
      method: "POST",
      body: JSON.stringify({ mode, amount, reason }),
    }),
  adminTreasury: (id: string, mode: string, amount: number, reason: string) =>
    api(`/api/footfive/admin/teams/${id}/treasury`, {
      method: "POST",
      body: JSON.stringify({ mode, amount, reason }),
    }),
  adminAssignTeam: (teamId: string, userId: string, reason: string) =>
    api(`/api/footfive/admin/teams/${teamId}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId, reason }),
    }),
  adminReleaseTeam: (teamId: string, reason: string) =>
    api(`/api/footfive/admin/teams/${teamId}/release`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  adminResetTeam: (teamId: string, mode: string, reason: string) =>
    api(`/api/footfive/admin/teams/${teamId}/reset`, {
      method: "POST",
      body: JSON.stringify({ mode, reason }),
    }),
  adminCatchUp: () =>
    api("/api/footfive/admin/world/catch-up", { method: "POST" }),
  adminPause: () => api("/api/footfive/admin/world/pause", { method: "POST" }),
  adminResume: () => api("/api/footfive/admin/world/resume", { method: "POST" }),
  adminWorldSettings: (body: Record<string, unknown>) =>
    api("/api/footfive/admin/world/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  adminRetention: () => api<Record<string, unknown>>("/api/footfive/admin/retention"),
  adminRetentionPreview: () =>
    api("/api/footfive/admin/retention/preview", { method: "POST" }),
  adminRetentionRun: () =>
    api("/api/footfive/admin/retention/run", { method: "POST" }),
  adminAudit: () =>
    api<{ entries: Array<Record<string, unknown>> }>("/api/footfive/admin/audit"),
  adminResetPassword: (
    id: string,
    password: string,
    mustChange: boolean,
    reason: string,
  ) =>
    api(`/api/footfive/admin/users/${id}/password`, {
      method: "POST",
      body: JSON.stringify({ password, mustChange, reason }),
    }),
  adminBackfillStatus: () =>
    api<Record<string, unknown>>("/api/footfive/admin/backfill/status"),
  adminBackfillPreview: () =>
    api("/api/footfive/admin/backfill/preview", { method: "POST" }),
  adminBackfillRun: () =>
    api("/api/footfive/admin/backfill/run", { method: "POST" }),
  adminRecoveryStatus: () =>
    api<Record<string, unknown>>("/api/footfive/admin/recovery/status"),
  adminRecoveryRun: () =>
    api("/api/footfive/admin/recovery/run", { method: "POST" }),
  adminClearLock: () =>
    api("/api/footfive/admin/recovery/clear-lock", { method: "POST" }),
  me: () =>
    api<{
      id: string;
      email: string;
      display_name?: string;
      role?: string;
      credits?: number;
      must_change_password?: boolean;
    }>("/api/footfive/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: boolean }>("/api/footfive/account/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  health: () => api<Record<string, unknown>>("/api/footfive/health"),
  adminHealth: () => api<Record<string, unknown>>("/api/footfive/admin/health"),
};
