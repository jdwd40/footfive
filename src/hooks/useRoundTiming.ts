/**
 * Shared round timing: countdown from authoritative scheduledAt + server offset.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoundStore } from "./useRoundStore";

const WARN_60 = 60_000;
const WARN_10 = 10_000;

function pad(n: number) {
  return String(Math.max(0, n)).padStart(2, "0");
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${pad(m % 60)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

export type RoundTiming = {
  serverNow: number;
  remainingMs: number;
  countdown: string;
  roundLabel: string;
  roundKey: string;
  status: string;
  scheduledAt: string | null;
  startedAt: string | null;
  announceKey: string;
  isScheduled: boolean;
  isLive: boolean;
  isWaitingPrep: boolean;
  warn60: boolean;
  warn10: boolean;
  secondsLeft: number;
  justStarted: boolean;
};

const seenAnnounce = new Set<string>();
const seenWarn60 = new Set<string>();

export function useRoundTiming(): RoundTiming {
  const { board, round, serverOffsetMs } = useRoundStore();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    void tick;
    const serverNow = Date.now() + (serverOffsetMs || 0);
    const r = round || board?.round || null;
    const status = r?.status || "";
    const scheduledAt = r?.scheduledAt || null;
    const startedAt = r?.startedAt || null;
    const announceKey = (r as { announceKey?: string } | null)?.announceKey || "";
    const label = r?.label || "Next round";
    const key = r?.key || "";

    const isLive = status === "live";
    const isScheduled = status === "scheduled" || status === "management";
    let remainingMs = 0;
    if (isScheduled && scheduledAt) {
      const t = new Date(String(scheduledAt).replace(" ", "T")).getTime();
      remainingMs = isNaN(t) ? 0 : Math.max(0, t - serverNow);
    }

    const isWaitingPrep = !r || (!isLive && !isScheduled);
    const secondsLeft = Math.ceil(remainingMs / 1000);
    const warn60 = isScheduled && remainingMs > 0 && remainingMs <= WARN_60;
    const warn10 = isScheduled && remainingMs > 0 && remainingMs <= WARN_10;

    let justStarted = false;
    if (isLive && announceKey) {
      if (!seenAnnounce.has(announceKey)) {
        seenAnnounce.add(announceKey);
        justStarted = true;
      }
    } else if (isLive && startedAt) {
      const k = `${r?.id || ""}:${startedAt}`;
      if (!seenAnnounce.has(k)) {
        // only announce if kickoff was recent (< 2 min)
        const st = new Date(String(startedAt).replace(" ", "T")).getTime();
        if (!isNaN(st) && serverNow - st < 120_000) {
          seenAnnounce.add(k);
          justStarted = true;
        } else {
          seenAnnounce.add(k);
        }
      }
    }

    // track 60s warn keys for external consumers
    if (warn60 && r?.id && scheduledAt) {
      seenWarn60.add(`${r.id}:${scheduledAt}:60`);
    }

    return {
      serverNow,
      remainingMs,
      countdown: formatCountdown(remainingMs),
      roundLabel: label,
      roundKey: key,
      status,
      scheduledAt,
      startedAt,
      announceKey,
      isScheduled,
      isLive,
      isWaitingPrep,
      warn60,
      warn10,
      secondsLeft,
      justStarted,
    };
  }, [board, round, serverOffsetMs, tick]);
}

export function roundStartMessage(label: string, key: string): string {
  const k = (key || "").toLowerCase();
  if (k === "r16") return "The Round of 16 is underway!";
  if (k === "qf") return "Quarter-finals have kicked off!";
  if (k === "sf") return "The semi-finals begin now!";
  if (k === "final") return "The Proball Final is underway!";
  return `${label || "The next round"} is underway!`;
}
