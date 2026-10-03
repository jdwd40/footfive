export const POCKETBASE_URL =
  import.meta.env.VITE_POCKETBASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8090";
