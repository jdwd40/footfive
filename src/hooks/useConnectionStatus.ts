/**
 * Shared connection health: ignore aborts/nav/tab-hide; threshold before warning.
 */
import { useSyncExternalStore } from "react";
import { isRateLimited } from "../lib/pocketbase";

export type ConnState = "connected" | "reconnecting" | "offline" | "auth";

type ConnStore = {
  state: ConnState;
  failCount: number;
  lastError: string;
  version: number;
};

let store: ConnStore = {
  state: "connected",
  failCount: 0,
  lastError: "",
  version: 0,
};
const listeners = new Set<() => void>();

function emit() {
  store = { ...store, version: store.version + 1 };
  for (const l of listeners) l();
}

function isAbort(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError")
    return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /abort|cancel/i.test(msg);
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unauthor|401|invalid credentials|auth/i.test(msg);
}

/** Report a successful API poll. */
export function reportConnectionOk() {
  if (store.failCount === 0 && store.state === "connected") return;
  store = { ...store, failCount: 0, lastError: "", state: "connected" };
  emit();
}

/** Report a failed poll. Aborts and hidden-tab pauses should not call this. */
export function reportConnectionFail(err: unknown) {
  if (typeof document !== "undefined" && document.hidden) return;
  if (isAbort(err)) return;
  // 429 means the server answered (busy), not that we're offline: leave the state alone.
  if (isRateLimited(err)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    store = {
      ...store,
      failCount: store.failCount + 1,
      lastError: "Browser offline",
      state: "offline",
    };
    emit();
    return;
  }
  if (isAuthError(err)) {
    store = {
      ...store,
      failCount: store.failCount + 1,
      lastError: "Session expired",
      state: "auth",
    };
    emit();
    return;
  }
  const next = store.failCount + 1;
  const msg = err instanceof Error ? err.message : "Request failed";
  let state: ConnState = "connected";
  if (next >= 3) state = "offline";
  else if (next >= 2) state = "reconnecting";
  store = { ...store, failCount: next, lastError: msg, state };
  emit();
}

export function getConnectionSnapshot() {
  return store;
}

export function subscribeConnection(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useConnectionStatus() {
  return useSyncExternalStore(subscribeConnection, getConnectionSnapshot, getConnectionSnapshot);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => reportConnectionOk());
  window.addEventListener("offline", () => {
    store = { ...store, state: "offline", lastError: "Browser offline", failCount: Math.max(store.failCount, 3) };
    emit();
  });
}
