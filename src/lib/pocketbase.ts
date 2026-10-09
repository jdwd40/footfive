import PocketBase from "pocketbase";
import { POCKETBASE_URL } from "./config";

export const pb = new PocketBase(POCKETBASE_URL);
pb.autoCancellation(false);

export type TeamPublic = {
  id: string;
  name: string;
  abbreviation: string;
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
  mode?: "manual" | "ai";
};

export type Side = "home" | "away";

/** Published match state carried by every event (server-authoritative). */
export type PubState = {
  sc: [number, number];
  so: {
    h: number;
    a: number;
    th: number;
    ta: number;
    first: Side;
    next: Side | null;
    sd: boolean;
    k: Array<[0 | 1, "goal" | "save" | "miss" | "woodwork", string]>;
  } | null;
  ph: string;
  clk: { s: number; run: 0 | 1 } | null;
  pos: number;
  x: [number[], number[]];
  d: 0 | 1;
  win: Side | null;
  by: "normal" | "aet" | "pens" | null;
};

export type PenPlan = { col: number; height: number; dive: number; post: string | null; run: number; outcome: string };

export type MatchEvent = {
  seq: number;
  at: number;
  t: string;
  min: number;
  side?: Side | null;
  p?: string;
  p2?: string;
  ball?: [number, number];
  from?: [number, number] | null;
  target?: [number, number];
  chain?: number;
  turn?: number; // 1 on the first touch after the ball changed hands (build_up / first pass of a minute)
  header?: number;
  post?: string;
  pen?: PenPlan;
  kick?: { no: number; sd: number; must?: number; win?: number; outcome?: string; decisive?: number };
  major?: number;
  text: string;
  tick?: string;
  st: PubState;
};

export type FixtureCard = {
  id: string;
  slot: string;
  index: number;
  home: TeamPublic;
  away: TeamPublic;
  status: "scheduled" | "live" | "finished";
  kickoffAt: number;
  minuteMs: number;
  st: PubState | null;
  at: number | null;
  seq: number;
  last: { t: string; text: string; side: Side | null } | null;
  odds: { home: number | null; away: number | null; closed: string | null } | null;
  result?: { sh: number; sa: number; soh: number; soa: number; winner: Side; by: string | null };
};

export type TickerItem = { id: string; fixtureId: string; seq: number; at: number; t: string; side: Side | null; text: string; min: number };

export type BracketFixture = {
  slot: string;
  fixtureId?: string;
  home: TeamPublic | null;
  away: TeamPublic | null;
  homePending?: string | null;
  awayPending?: string | null;
  status: string;
  sh?: number | null;
  sa?: number | null;
  soh?: number;
  soa?: number;
  by?: string | null;
  winner?: Side | null;
};

export type ChampionInfo = {
  tournamentId: string;
  number: number;
  team: TeamPublic | null;
  final: { fixtureId: string; home: TeamPublic; away: TeamPublic; sh: number; sa: number; soh: number; soa: number; by: string | null } | null;
  completedAt: number;
};

export type LiveView = {
  serverTimeMs: number;
  paused: boolean;
  timing: { betweenMs: number; gapMs: number; windowMs: number; minuteMs: number; betweenMinutes: number; gapMinutes: number; windowMinutes: number; minuteSec: number };
  mode: "idle" | "champion" | "fixtures" | "live";
  championship: { id: string; number: number; startsAt: number; status: string } | null;
  round: { id: string; key: string; label: string; status: string; scheduledAt: number; finishedAt: number | null } | null;
  fixtures: FixtureCard[];
  bracket: Array<{ key: string; label: string; fixtures: BracketFixture[] }>;
  ticker: TickerItem[];
  champion: ChampionInfo | null;
  recentChampion?: ChampionInfo | null;
  nextChampionshipAt: number | null;
  fixturesAt?: number | null;
};

export type LineupPlayer = { name: string; no: number; role: string; starter: boolean };

export type MatchView = {
  serverTimeMs: number;
  round: { id: string; key: string; label: string; status: string };
  fixture: FixtureCard;
  events: MatchEvent[];
  lineups: { home: LineupPlayer[]; away: LineupPlayer[] } | null;
  sentOff: Array<{ side: Side; p: string }>;
  managedSide: Side | null;
  coach: { stance: string; pending: boolean; ai: boolean; used: number; max: number; cooldownUntil: number } | null;
};

export type Selection = { id: string; label: string; short: string; odds: number | null };
export type Market = { key: string; title: string; rules: string; closed?: string | null; closesAt?: number; sel?: Selection[]; quarters?: Array<Array<{ id: string; label: string; short: string; p: number }>> };

export type FixtureMarkets = { serverTimeMs: number; fixtureId: string; seq: number; state: { phase: string; closed: string | null }; blocked: string | null; markets: Market[] };
export type WideMarkets = { serverTimeMs: number; blocked: string | null; markets: Market[] };

export type Bet = {
  id: string;
  market: string;
  title: string;
  label: string;
  selection: string;
  fixtureId: string | null;
  stake: number;
  odds: number;
  potential: number;
  status: "open" | "won" | "lost" | "void";
  payout: number;
  note: string;
  placedAt: number | null;
  created: string;
  settledAt: string | null;
};

export type MyBets = {
  credits: number;
  bets: Bet[];
  settledStaked: number;
  settledReturned: number;
  net: number;
  topUp: { amount: number; floor: number; available: boolean; nextAt: number | null; rule: string };
};

export type WorldSnapshot = {
  serverTimeMs: number;
  credits: number;
  startingCredits: number;
  managedTeam: (TeamPublic & { treasury?: number; battery_count?: number; default_stance?: string }) | null;
  nextFixture: { fixtureId: string; status: string; kickoffAt: number; opponent: TeamPublic; home: boolean } | null;
  tournament: { id: string; number: number; current_round: string } | null;
  activeRound: { id: string; key: string; label: string; status: string; scheduledAt: string } | null;
  timing: { betweenMinutes: number; gapMinutes: number; windowMinutes: number; minuteSec: number };
  commandCharge: { points: number; max: number; nextPointInMs: number } | null;
};

export type BetRequest = { market: string; fixtureId?: string; selection: string; stake: number; odds: number; requestId: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (pb.authStore.token) {
    headers.Authorization = pb.authStore.token;
  }
  const request = () => fetch(`${POCKETBASE_URL}${path}`, {
    ...init,
    headers,
  });
  let res = await request();
  if (res.status === 429 && (init?.method || "GET") === "GET") {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter * 1000, 250), 3000) : 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await request();
  }
  if (!res.ok) {
    let msg = res.status === 429 ? "Too many requests — retry in a moment." : res.statusText;
    try {
      const j = (await res.json()) as { message?: string };
      if (res.status !== 429) msg = j.message || msg;
    } catch {
      /* ignore */
    }
    // Preserve the HTTP status so callers can distinguish a definitive auth
    // rejection (4xx) from offline/network failures (review F4).
    const err = new Error(msg || `Request failed (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const footfiveApi = {
  serverTime: () => api<{ serverTime: string; serverTimeMs: number }>("/api/footfive/server-time"),
  live: () => api<LiveView>("/api/footfive/live"),
  match: (fixtureId: string, since = 0) => api<MatchView>(`/api/footfive/match/${fixtureId}?since=${since}`),
  world: () => api<WorldSnapshot>("/api/footfive/world"),
  teams: () => api<{ teams: TeamPublic[] }>("/api/footfive/teams"),
  claimTeam: (teamId: string) => api<{ team: TeamPublic }>(`/api/footfive/teams/${teamId}/claim`, { method: "POST" }),
  coaching: (fixtureId: string, stance: "defend" | "balanced" | "attack") =>
    api<{ ok: boolean; stance: string; fromMinute: number; used: number; max: number }>(`/api/footfive/matches/${fixtureId}/coaching`, {
      method: "POST",
      body: JSON.stringify({ stance }),
    }),
  fixtureMarkets: (fixtureId: string) => api<FixtureMarkets>(`/api/footfive/markets/${fixtureId}`),
  wideMarkets: () => api<WideMarkets>("/api/footfive/markets"),
  placeBet: (body: BetRequest) => api<{ bet: Bet; duplicate: boolean }>("/api/footfive/bets", { method: "POST", body: JSON.stringify(body) }),
  myBets: () => api<MyBets>("/api/footfive/bets/mine"),
  topUp: () => api<{ ok: boolean; credits: number }>("/api/footfive/wallet/topup", { method: "POST" }),
  setMode: (mode: "manual" | "ai") => api<{ ok: boolean; mode: string; note: string }>("/api/footfive/my-team/mode", { method: "POST", body: JSON.stringify({ mode }) }),
  setDefaultStance: (stance: string) => api<{ ok: boolean; note: string }>("/api/footfive/my-team/stance", { method: "POST", body: JSON.stringify({ stance }) }),

  myTeam: () =>
    api<{
      team: TeamPublic & {
        treasury: number;
        battery_count: number;
        overclock_ready?: boolean;
        default_stance: "defend" | "balanced" | "attack";
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
        upgrade_cost: { attack: number; defence: number };
      }>;
      averages: { energy: number; condition: number };
      managementOpen: boolean;
      effectNote: string;
      aiRules: string[];
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
  adminApplyBetweenRound: (reason = "apply") =>
    api("/api/footfive/admin/world/apply-between-round", {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  loginIdentity: (identity: string, password: string) =>
    api<{ token: string; record: Record<string, unknown> }>("/api/footfive/auth/login", {
      method: "POST",
      body: JSON.stringify({ identity, password }),
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
