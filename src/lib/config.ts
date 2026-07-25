export const POCKETBASE_URL =
  import.meta.env.VITE_POCKETBASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8090";

export const SCOREBOARD_POLL_MS = 3000;
export const MATCH_POLL_MS = 2000;
