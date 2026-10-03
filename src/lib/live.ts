/**
 * Shared, server-authoritative live state for every screen.
 * One poller per tab; the UI never advances matches, it only renders published state.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { footfiveApi, type LiveView, type PubState } from "./pocketbase";
import { reportConnectionFail, reportConnectionOk, useConnectionStatus } from "../hooks/useConnectionStatus";

/** A client that hasn't heard from the server for this long stops claiming to be live. */
export const STALE_AFTER_MS = 8000;

type Store = { live: LiveView | null; error: string; lastOkAt: number; offsetMs: number };
let store: Store = { live: null, error: "", lastOkAt: 0, offsetMs: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let subs = 0;
let inflight = false;

function set(p: Partial<Store>) {
  store = { ...store, ...p };
  listeners.forEach((l) => l());
}

/** Server time estimate (ms). Countdowns and clocks use this, never the raw device clock. */
export function serverNow() {
  return Date.now() + store.offsetMs;
}

export function noteServerTime(serverMs: number) {
  // Smooth small jitter; accept big corrections at once.
  const off = serverMs - Date.now();
  store.offsetMs = Math.abs(off - store.offsetMs) > 1500 ? off : store.offsetMs * 0.7 + off * 0.3;
}

async function poll() {
  if (inflight) return;
  inflight = true;
  try {
    const live = await footfiveApi.live();
    noteServerTime(live.serverTimeMs);
    reportConnectionOk();
    set({ live, error: "", lastOkAt: Date.now() });
  } catch (err) {
    reportConnectionFail(err);
    set({ error: err instanceof Error ? err.message : "Live feed unavailable" });
  } finally {
    inflight = false;
  }
}

function interval() {
  const m = store.live?.mode;
  if (typeof document !== "undefined" && document.hidden) return 10000;
  return m === "live" ? 1500 : 3000;
}

function loop() {
  timer = setTimeout(async () => {
    await poll();
    if (subs > 0) loop();
  }, interval());
}

export function refreshLive() {
  void poll();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  subs += 1;
  if (subs === 1) {
    void poll();
    loop();
  }
  return () => {
    listeners.delete(fn);
    subs -= 1;
    if (subs === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && subs > 0) void poll();
  });
}

export function useLive() {
  const s = useSyncExternalStore(subscribe, () => store);
  const conn = useConnectionStatus();
  const now = useNow(1000);
  const stale = !s.lastOkAt || Date.now() - s.lastOkAt > STALE_AFTER_MS || conn.state !== "connected";
  return { live: s.live, error: s.error, stale, conn: conn.state, now };
}

/** Re-render every `ms` and return the current server-time estimate. */
export function useNow(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return serverNow();
}

// ---------------------------------------------------------------- formatting

const PERIOD_END: Record<string, number> = { first_half: 2700, second_half: 5400, extra_time_1: 6300, extra_time_2: 7200 };

/** Match clock in seconds from the last published event; frozen when paused, capped at the period end. */
export function clockSeconds(st: PubState | null, at: number | null, now: number, minuteMs: number): number | null {
  if (!st || !st.clk) return null;
  let s = st.clk.s;
  if (st.clk.run && at != null && minuteMs > 0) s += ((now - at) / minuteMs) * 60;
  const end = PERIOD_END[st.ph];
  if (end != null) s = Math.min(s, end);
  return Math.max(0, Math.floor(s));
}

export function clockText(sec: number | null) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Short broadcast label + tone for a public phase. */
export function phaseInfo(st: PubState | null): { label: string; tone: "live" | "muted" | "amber" | "magenta" | "lime"; live: boolean } {
  if (!st) return { label: "Scheduled", tone: "muted", live: false };
  switch (st.ph) {
    case "pre":
      return { label: "Kick-off", tone: "amber", live: true };
    case "first_half":
      return { label: "1st half", tone: "live", live: true };
    case "half_time":
      return { label: "Half-time", tone: "amber", live: true };
    case "second_half":
      return { label: "2nd half", tone: "live", live: true };
    case "et_break":
      return { label: "End of 90", tone: "amber", live: true };
    case "extra_time_1":
      return { label: "Extra time 1", tone: "magenta", live: true };
    case "et_half_time":
      return { label: "ET half-time", tone: "amber", live: true };
    case "extra_time_2":
      return { label: "Extra time 2", tone: "magenta", live: true };
    case "shootout":
      return { label: "Penalties", tone: "magenta", live: true };
    case "finished":
      return { label: st.by === "pens" ? "FT · Pens" : st.by === "aet" ? "AET" : "Full-time", tone: "lime", live: false };
    default:
      return { label: st.ph, tone: "muted", live: false };
  }
}

/** Remaining time as "4:05" / "1:02:03". */
export function countdown(ms: number) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Explicit UK wall-clock time for scheduled events. */
export function ukTime(ms: number, withDay = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    ...(withDay ? { weekday: "short", day: "numeric", month: "short" } : {}),
  }).format(new Date(ms));
}

export function credits(n: number) {
  return new Intl.NumberFormat("en-GB").format(Math.round(n));
}
