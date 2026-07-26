/**
 * Live match session: polling + event queue, score from revealed only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MATCH_POLL_MS } from "../lib/config";
import { createEventQueue, type EventQueue, type QueueEvent } from "../domain/eventQueue";
import { getEventDisplay } from "../domain/eventDisplay";
import { footfiveApi, type MatchView } from "../lib/pocketbase";
import { reportConnectionFail, reportConnectionOk } from "./useConnectionStatus";

export function useLiveMatch(fixtureId: string) {
  const [meta, setMeta] = useState<MatchView | null>(null);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  const [queueSnap, setQueueSnap] = useState(() =>
    createEventQueue().getState(),
  );
  const queueRef = useRef<EventQueue | null>(null);
  const reqIdRef = useRef(0);
  const failCountRef = useRef(0);
  const pollMsRef = useRef(MATCH_POLL_MS);
  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Stable queue per fixtureId
  useEffect(() => {
    const q = createEventQueue({ reducedMotion, preferCatchUp: true });
    queueRef.current = q;
    setQueueSnap(q.getState());
    const unsub = q.subscribe(() => setQueueSnap(q.getState()));
    return () => {
      unsub();
      q.dispose();
      queueRef.current = null;
    };
  }, [fixtureId, reducedMotion]);

  const load = useCallback(
    async (full: boolean) => {
      if (!fixtureId || !queueRef.current) return;
      const reqId = ++reqIdRef.current;
      try {
        const since = full ? 0 : queueRef.current.lastSeq;
        const data = await footfiveApi.match(fixtureId, since);
        if (reqId !== reqIdRef.current) return; // stale / navigated away

        setMeta(data);
        setError("");
        setOffline(false);
        failCountRef.current = 0;
        pollMsRef.current = MATCH_POLL_MS;
        reportConnectionOk();

        const incoming = (full
          ? data.events
          : data.newEvents?.length
            ? data.newEvents
            : data.events) as QueueEvent[];
        if (full) {
          // Late open: catch-up only when substantially behind server history
          const lateOpen = (incoming?.length || 0) > 12;
          queueRef.current.ingest(incoming || [], {
            reset: true,
            catchUp: lateOpen,
          });
        } else {
          // Ordinary polls: live pacing (queue decides if backlog is large)
          queueRef.current.ingest(incoming || [], { catchUp: false });
        }
      } catch (err) {
        if (reqId !== reqIdRef.current) return; // abort/stale — not a connection failure
        if (typeof document !== "undefined" && document.hidden) return;
        failCountRef.current += 1;
        reportConnectionFail(err);
        // Keep last known match state; only warn after 2+ consecutive fails
        const soft = failCountRef.current < 2;
        setOffline(failCountRef.current >= 2);
        setError(
          soft
            ? ""
            : failCountRef.current >= 3
              ? "Connection issue — retrying… (last score kept)"
              : "Reconnecting…",
        );
        pollMsRef.current = Math.min(
          15000,
          MATCH_POLL_MS * Math.pow(1.5, Math.min(failCountRef.current, 5)),
        );
      }
    },
    [fixtureId],
  );

  useEffect(() => {
    void load(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      if (typeof document === "undefined" || !document.hidden) {
        void load(false);
      }
      timer = setTimeout(tick, pollMsRef.current);
    };
    timer = setTimeout(tick, MATCH_POLL_MS);

    const onVis = () => {
      if (!document.hidden) {
        pollMsRef.current = MATCH_POLL_MS;
        void load(false);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
      reqIdRef.current++;
    };
  }, [load]);

  const catchUpToLive = useCallback(() => {
    queueRef.current?.catchUpToLive();
    void load(false);
  }, [load]);

  const display = useMemo(() => {
    const score = queueSnap.score;
    const current = queueSnap.current;
    const cfg = current ? getEventDisplay(current.type) : null;
    // Prefer queue score over meta (prevents jump-ahead)
    return {
      scoreHome: score.scoreHome,
      scoreAway: score.scoreAway,
      shootoutHome: score.shootoutHome,
      shootoutAway: score.shootoutAway,
      minute: score.minute || meta?.minute || 0,
      phase: score.phase || meta?.phase || "scheduled",
      finished: score.finished || !!meta?.finished,
      current,
      cfg,
      history: queueSnap.revealed.slice().reverse().slice(0, 30),
      behind: queueSnap.behind,
      mode: queueSnap.mode,
    };
  }, [queueSnap, meta]);

  return {
    meta,
    error,
    offline,
    display,
    catchUpToLive,
    reload: () => load(true),
    setError,
  };
}
