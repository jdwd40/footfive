/**
 * Single shared current-round state for scoreboard, ticker, switcher.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { SCOREBOARD_POLL_MS } from "../lib/config";
import { footfiveApi, type ScoreboardFixture, type ScoreboardResponse } from "../lib/pocketbase";

type RoundStore = {
  board: ScoreboardResponse | null;
  error: string;
  version: number;
  serverOffsetMs: number;
};

let store: RoundStore = {
  board: null,
  error: "",
  version: 0,
  serverOffsetMs: 0,
};
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inflight = 0;
let lastRequestId = 0;
let subscribers = 0;

function emit() {
  for (const l of listeners) l();
}

function setStore(partial: Partial<RoundStore>) {
  store = { ...store, ...partial, version: store.version + 1 };
  emit();
}

async function fetchBoard() {
  const reqId = ++lastRequestId;
  inflight++;
  try {
    const data = await footfiveApi.scoreboard();
    if (reqId < lastRequestId) return; // stale
    const offset = data.serverTimeMs - Date.now();
    setStore({ board: data, error: "", serverOffsetMs: offset });
  } catch (err) {
    if (reqId < lastRequestId) return;
    setStore({
      error: err instanceof Error ? err.message : "Scoreboard failed",
    });
  } finally {
    inflight--;
  }
}

function ensurePolling() {
  if (pollTimer) return;
  void fetchBoard();
  pollTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void fetchBoard();
  }, SCOREBOARD_POLL_MS);
}

function stopPollingIfIdle() {
  if (subscribers > 0) return;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  subscribers++;
  ensurePolling();
  return () => {
    listeners.delete(fn);
    subscribers--;
    stopPollingIfIdle();
  };
}

function getSnapshot() {
  return store;
}

export function useRoundStore() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    void fetchBoard();
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) void fetchBoard();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  return {
    board: snap.board,
    fixtures: snap.board?.fixtures ?? ([] as ScoreboardFixture[]),
    round: snap.board?.round ?? null,
    error: snap.error,
    version: snap.version,
    serverOffsetMs: snap.serverOffsetMs,
    refresh,
  };
}

/** Non-hook refresh for one-shots */
export function refreshRoundStore() {
  return fetchBoard();
}
