/**
 * Ordered, paced event reveal queue — independent of React mount cycles.
 * Server events → inbox (deduped) → reveal one at a time.
 */

import {
  getEventDisplay,
  holdForCatchUp,
  type EventDisplayConfig,
} from "./eventDisplay";
import { scoreFromRevealedEvents, type ScoreableEvent } from "./scoreFromRevealed";

export type QueueEvent = ScoreableEvent & {
  player?: string | null;
  team?: string | null;
  offsetMs?: number;
};

export type EventQueueState = {
  revealed: QueueEvent[];
  pending: QueueEvent[];
  current: QueueEvent | null;
  lastSeq: number;
  behind: number;
  score: ReturnType<typeof scoreFromRevealedEvents>;
  mode: "live" | "catchup" | "history";
};

export type EventQueueOptions = {
  /** When true, use short holds */
  preferCatchUp?: boolean;
  maxHistory?: number;
  reducedMotion?: boolean;
};

export function createEventQueue(opts: EventQueueOptions = {}) {
  const maxHistory = opts.maxHistory ?? 80;
  let revealed: QueueEvent[] = [];
  let pending: QueueEvent[] = [];
  let lastSeq = 0;
  let seen = new Set<number>();
  let current: QueueEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  let mode: EventQueueState["mode"] = "live";

  function emit() {
    for (const l of listeners) l();
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function snapshot(): EventQueueState {
    const score = scoreFromRevealedEvents(revealed);
    return {
      revealed: revealed.slice(),
      pending: pending.slice(),
      current,
      lastSeq,
      behind: pending.length,
      score,
      mode,
    };
  }

  function sortUnique(list: QueueEvent[]) {
    const map = new Map<number, QueueEvent>();
    for (const e of list) {
      if (e.seq == null) continue;
      map.set(e.seq, e);
    }
    return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
  }

  /** Ingest server events (full history or delta). Does not reset already revealed. */
  function ingest(events: QueueEvent[], options?: { reset?: boolean; catchUp?: boolean }) {
    if (options?.reset) {
      clearTimer();
      revealed = [];
      pending = [];
      seen = new Set();
      lastSeq = 0;
      current = null;
    }
    if (options?.catchUp) mode = "catchup";
    else if (mode !== "catchup") mode = "live";

    const incoming = sortUnique(events);
    for (const e of incoming) {
      if (seen.has(e.seq)) continue;
      if (e.seq <= lastSeq && revealed.some((r) => r.seq === e.seq)) continue;
      seen.add(e.seq);
      pending.push(e);
    }
    pending = sortUnique(pending).filter((e) => !revealed.some((r) => r.seq === e.seq));

    // Late open only: bulk-reveal older history, keep last few for paced reveal.
    // Never suppress major events from the paced tail.
    if (options?.catchUp && pending.length > 6) {
      const keepCount = 4;
      const keep = pending.splice(-keepCount);
      for (const e of pending) {
        revealed.push(e);
        lastSeq = Math.max(lastSeq, e.seq);
      }
      pending = keep;
      revealed = sortUnique(revealed).slice(-maxHistory);
    }

    // Ordinary live polling with a small backlog stays in live mode
    if (!options?.catchUp && pending.length <= 3) {
      mode = "live";
    } else if (!options?.catchUp && pending.length > 6) {
      mode = "catchup";
    }

    scheduleNext();
    emit();
  }

  function scheduleNext() {
    if (timer || pending.length === 0) {
      if (pending.length === 0) {
        current = revealed[revealed.length - 1] || null;
        mode = "live";
      }
      return;
    }
    const next = pending[0];
    const cfg = getEventDisplay(next.type);
    const delay = opts.reducedMotion ? 0 : cfg.delayMs;
    const hold = opts.reducedMotion
      ? 350
      : holdForCatchUp(cfg, pending.length, mode);

    timer = setTimeout(() => {
      timer = null;
      pending.shift();
      revealed.push(next);
      if (revealed.length > maxHistory) {
        revealed = revealed.slice(-maxHistory);
      }
      lastSeq = Math.max(lastSeq, next.seq);
      current = next;
      emit();
      // hold then next — always one event at a time
      timer = setTimeout(() => {
        timer = null;
        scheduleNext();
        emit();
      }, hold);
    }, delay);
  }

  /**
   * User-requested catch-up: speed through minor backlog, keep majors readable.
   * Does not silently skip goals/cards/penalties/shootout/subs/phase transitions.
   */
  function catchUpToLive() {
    clearTimer();
    mode = "catchup";
    // Reveal all but last major-paced events quickly via scheduleNext with catchup holds
    // Still process one-by-one so majors stay readable
    scheduleNext();
    emit();
  }

  function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function dispose() {
    clearTimer();
    listeners.clear();
  }

  function getConfig(type: string): EventDisplayConfig {
    return getEventDisplay(type);
  }

  return {
    ingest,
    catchUpToLive,
    subscribe,
    getState: snapshot,
    dispose,
    getConfig,
    get lastSeq() {
      return lastSeq;
    },
  };
}

export type EventQueue = ReturnType<typeof createEventQueue>;
