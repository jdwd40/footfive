/**
 * Page-side snapshot for scripts/live-watch.mjs: runs inside the browser via page.evaluate, so it must be
 * self-contained (no imports, no closures). Reads the numeric scoreboard, the on-pitch HUD, banners and badges.
 */
export function snapshot() {
  const q = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
  const svg = document.querySelector('[data-testid="pitch"] svg');
  const r = svg?.getBoundingClientRect();
  const sb = document.querySelector('[data-testid="match-scoreboard"]')?.getBoundingClientRect();
  return {
    score: q("match-score"),
    hud: q("pitch-hud"),
    clock: document.querySelector('[aria-label="Match clock"]')?.textContent?.trim() ?? null,
    pens: q("match-shootout-score"),
    soTotal: q("shootout-total"),
    commentary: q("commentary"),
    banner: q("goal-banner") ?? q("ft-banner") ?? q("period-banner"),
    pen: q("pen-banner"),
    strip: q("pen-strip"),
    badge: document.querySelector('[data-testid="pitch"] span.event-enter')?.textContent?.trim() ?? null,
    final: q("final-result"),
    viewBox: svg?.getAttribute("viewBox"),
    pitchRect: r && { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) },
    scoreboardRect: sb && { top: Math.round(sb.top), h: Math.round(sb.height) },
    playerR: svg?.querySelector('[data-testid="player"] [data-kit]')?.getAttribute("r"),
    scrollY: Math.round(window.scrollY),
  };
}
