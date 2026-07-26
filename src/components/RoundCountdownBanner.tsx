import { useEffect, useRef, useState } from "react";
import { roundStartMessage, useRoundTiming } from "../hooks/useRoundTiming";
import { useConnectionStatus } from "../hooks/useConnectionStatus";

const warned60 = new Set<string>();
const announced = new Set<string>();

export default function RoundCountdownBanner() {
  const t = useRoundTiming();
  const conn = useConnectionStatus();
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flash(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  }

  useEffect(() => {
    if (t.warn60 && t.scheduledAt && t.isScheduled) {
      const k = `${t.roundKey}:${t.scheduledAt}:60`;
      if (!warned60.has(k)) {
        warned60.add(k);
        flash("Next round begins in one minute");
      }
    }
  }, [t.warn60, t.scheduledAt, t.isScheduled, t.roundKey]);

  useEffect(() => {
    if (t.justStarted || (t.isLive && t.announceKey)) {
      const k = t.announceKey || `${t.roundKey}:${t.startedAt}`;
      if (k && !announced.has(k) && t.isLive) {
        // only flash if justStarted to avoid re-announce on every mount of old live rounds
        if (t.justStarted) {
          announced.add(k);
          flash(roundStartMessage(t.roundLabel, t.roundKey));
        } else {
          announced.add(k);
        }
      }
    }
  }, [t.justStarted, t.isLive, t.announceKey, t.roundKey, t.roundLabel, t.startedAt]);

  let bannerText = "Round schedule being prepared";
  let urgency = "normal";
  if (t.isLive) {
    bannerText = `${t.roundLabel} — LIVE`;
    urgency = "live";
  } else if (t.isScheduled && t.remainingMs > 0) {
    if (t.warn10) {
      bannerText = `${t.roundLabel} begins in ${t.secondsLeft}`;
      urgency = "critical";
    } else if (t.warn60) {
      bannerText = `${t.roundLabel} begins in ${t.countdown}`;
      urgency = "warn";
    } else {
      bannerText = `${t.roundLabel} begin in ${t.countdown}`;
      urgency = "normal";
    }
  } else if (t.isScheduled && t.remainingMs <= 0) {
    bannerText = `${t.roundLabel} starting…`;
    urgency = "warn";
  }

  const connText =
    conn.state === "offline"
      ? conn.lastError === "Browser offline"
        ? "You appear offline"
        : "Connection issue — retrying…"
      : conn.state === "reconnecting"
        ? "Reconnecting…"
        : conn.state === "auth"
          ? "Session expired — please log in again"
          : "";

  return (
    <div className="space-y-1" data-testid="round-countdown-wrap">
      <div
        className={`rounded-xl px-3 py-2 text-center text-xs font-semibold tracking-wide sm:text-sm ${
          urgency === "critical"
            ? "bg-magenta/25 text-magenta ring-1 ring-magenta/40 animate-pulse"
            : urgency === "warn"
              ? "bg-amber/20 text-amber ring-1 ring-amber/30"
              : urgency === "live"
                ? "bg-lime/15 text-lime ring-1 ring-lime/30"
                : "bg-cyan/10 text-cyan ring-1 ring-cyan/20"
        }`}
        role="status"
        aria-live="polite"
        data-testid="round-countdown-banner"
      >
        {urgency === "critical" ? (
          <span className="font-display text-lg tabular-nums sm:text-xl" data-testid="countdown-final-10">
            {t.secondsLeft}
          </span>
        ) : (
          <span data-testid="countdown-text">{bannerText}</span>
        )}
        {urgency === "critical" ? (
          <span className="ml-2 text-[11px] uppercase tracking-widest opacity-80">seconds</span>
        ) : null}
      </div>

      {connText ? (
        <div
          className="rounded-lg bg-magenta/15 px-3 py-1.5 text-center text-[11px] text-magenta"
          role="status"
          aria-live="polite"
          data-testid="connection-banner"
        >
          {connText}
        </div>
      ) : null}

      {toast ? (
        <div
          className="rounded-lg bg-ink/90 px-3 py-2 text-center text-sm text-cyan ring-1 ring-cyan/40"
          role="status"
          aria-live="assertive"
          data-testid="round-toast"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
