// Calibration must use the same timestamp boundary as worldService.lastPublished: at <= now, highest seq wins.
// Input events are real (noncosmetic) rows in publication/sequence order with nondecreasing at values.
export function lastPublishedIndex(events, at) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (events[mid].at <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Published row and timestamp when the public clock first reaches minute M. */
export function snapshotAtMinute(events, minute, clockMinute, minuteMs) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i], c = e.st && e.st.clk;
    if (!c) continue;
    if (c.s >= minute * 60) return { i: lastPublishedIndex(events, e.at), t: e.at };
    const nextAt = i + 1 < events.length ? events[i + 1].at : Infinity;
    if (c.run && clockMinute(c, e.at, nextAt, minuteMs) >= minute) {
      const t = e.at + ((minute * 60 - c.s) / 60) * minuteMs;
      return { i: lastPublishedIndex(events, t), t };
    }
  }
  return null;
}

/** First timestamp at or after at whose latest published row leaves markets open; null if none exists. */
export function openPublishedSnapshot(events, at) {
  let i = lastPublishedIndex(events, at), t = at, moved = false;
  if (i < 0) return null;
  while (events[i].st.d) {
    if (i + 1 >= events.length) return null;
    t = events[i + 1].at;
    i = lastPublishedIndex(events, t);
    moved = true;
  }
  return { i, t, moved };
}
