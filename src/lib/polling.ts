/**
 * Polite polling: setTimeout loop that pauses in hidden tabs, backs off after
 * failures and honours the API's rate-limit cooldown. One refresh on tab return.
 */
import { rateLimitRemainingMs } from "./pocketbase";

/** Hidden tabs only check back this often (and skip the request itself). */
export const HIDDEN_POLL_MS = 30000;
export const MAX_POLL_MS = 30000;

/** Base interval doubled per consecutive failure (capped), never inside a 429 cooldown. */
export function nextPollDelay(baseMs: number, fails: number, maxMs = MAX_POLL_MS): number {
  const backed = Math.min(baseMs * 2 ** Math.min(fails, 4), Math.max(baseMs, maxMs));
  return Math.max(backed, rateLimitRemainingMs());
}

function hidden() {
  return typeof document !== "undefined" && document.hidden;
}

/**
 * Run `fn` every `baseMs` (after the caller's own first call). `fn` resolves `false`
 * (or throws) on failure. Returns a stop function.
 */
export function startPolling(fn: () => Promise<boolean | void>, baseMs: number): () => void {
  let fails = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  async function tick() {
    timer = null;
    if (stopped) return;
    if (hidden()) return schedule(HIDDEN_POLL_MS);
    let ok = false;
    try {
      ok = (await fn()) !== false;
    } catch {
      ok = false;
    }
    if (stopped) return;
    fails = ok ? 0 : fails + 1;
    schedule(nextPollDelay(baseMs, fails));
  }
  const onVisible = () => {
    if (!stopped && !hidden()) schedule(Math.max(0, rateLimitRemainingMs()));
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  schedule(nextPollDelay(baseMs, 0));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
