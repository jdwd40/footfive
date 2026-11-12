/**
 * Richer live commentary (#84): a pure presentation layer over published events. The engine's `text` stays the source of
 * truth and the fallback; nothing here touches the engine, its RNG or any event. A line reads only the event it describes
 * and the events before it, so it can never give away what happens next, and variety comes from seqHash alone.
 */
import type { MatchEvent, Side } from "../lib/pocketbase";
import { seqHash } from "./scenes";

/** Short team labels, as the engine's own running commentary uses them. */
export type TeamLabels = Record<Side, string>;

const STREAK_WINDOW_S = 300; // five match minutes on the published clock, which runs on through the breaks
const STREAK_MIN = 3;
/** A penalty counts as a shot in the official stats but has no `shot` row: its result row is the kick. */
const PENALTY_KICKS = new Set(["penalty_goal", "penalty_saved", "penalty_missed", "penalty_woodwork"]);

const official = (e: MatchEvent) => (e.t === "shot" && !e.cos) || PENALTY_KICKS.has(e.t);
const choose = (seq: number, salt: number, lines: string[]) => lines[Math.floor(seqHash(seq, salt) * lines.length)];

function ordinal(n: number) {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${(!teens && ["th", "st", "nd", "rd"][n % 10]) || "th"}`;
}

/** Official shots by this shot's team in the window ending on it, itself included. Null when the history cannot prove the count:
 * a seq gap (or a feed that starts after kick-off) inside the window, or a shot with no clock. */
function shotsInWindow(events: MatchEvent[], i: number): number | null {
  const e = events[i];
  const now = e.st?.clk?.s;
  if (now == null) return null;
  let n = 1;
  for (let j = i - 1; ; j--) {
    if (j < 0) return events[0].seq === 1 ? n : null;
    const prev = events[j];
    if (prev.seq !== events[j + 1].seq - 1) return null;
    const s = prev.st?.clk?.s;
    if (s != null && now - s > STREAK_WINDOW_S) return n;
    if (official(prev) && prev.side === e.side) {
      if (s == null) return null;
      n++;
    }
  }
}

/** Says only what the row itself marks; the result is still to come, so nothing about where the shot ends up. */
function shotLine(e: MatchEvent) {
  if (!e.p) return e.text;
  if (e.header) return choose(e.seq, 841, [`Header from ${e.p}!`, `${e.p} meets it with a header!`, `${e.p} goes up for the header!`]);
  if (e.long) return choose(e.seq, 842, [`Long-range effort from ${e.p}!`, `${e.p} has a go from distance!`, `${e.p} tries it from long range!`]);
  return e.text;
}

function woodworkLine(events: MatchEvent[], i: number) {
  const e = events[i];
  const post = e.post ?? e.pen?.post;
  const where = post === "bar" ? "the crossbar" : post === "left" || post === "right" ? "the post" : null;
  if (!where || !e.p) return e.text;
  const shot = events[i - 1];
  const linked = e.t === "woodwork" && shot?.t === "shot" && !shot.cos && shot.chain === e.chain ? shot : null;
  const kind = e.t !== "woodwork" ? "penalty" : linked?.header ? "header" : linked?.long ? "long-range effort" : "effort";
  return choose(e.seq, 843, [`${e.p}'s ${kind} crashes off ${where}!`, `${e.p}'s ${kind} rattles ${where}!`, `So close! ${e.p}'s ${kind} comes back off ${where}`]);
}

/** The line for `events[i]`. `events` is the seq-ordered feed; rows after `i` are never read. */
export function commentaryLine(events: MatchEvent[], i: number, teams: TeamLabels) {
  const e = events[i];
  if (e.t === "woodwork" || e.t === "penalty_woodwork" || (e.t === "shootout_kick" && e.kick?.outcome === "woodwork")) return woodworkLine(events, i);
  if (e.t !== "shot") return e.text;
  const line = shotLine(e);
  const team = e.side ? teams[e.side] : null;
  const count = e.cos || !team ? null : shotsInWindow(events, i);
  if (count == null || count < STREAK_MIN) return line;
  const nth = ordinal(count);
  return choose(e.seq, 844, [`${nth} shot in 5 minutes for ${team}! ${line}`, `${team} keep coming, ${nth} shot in 5 minutes. ${line}`, `That's the ${nth} ${team} shot in 5 minutes. ${line}`]);
}

/** Open-play results that close the shot row right before them. */
const SHOT_RESULTS = new Set(["goal", "save", "miss", "block", "woodwork"]);
/** `e`: the row's event (time, styling, replay); `lead`: the event that opened the attack (the shot or the award), for the attacking side. */
export type FeedRow = { e: MatchEvent; lead: MatchEvent; text: string };

/**
 * #203: the Match events list shows each attack once. A shot and its result (the next seq, same chain — cosmetic pairs have none)
 * share one row, as do a penalty award and its kick: the row becomes the result's (its time, styling and replay; the badge stays
 * the attacking side's, from the shot or award) and reads
 * "what led to it — what happened". Until the result is published the row is the shot or award alone, so the list never grows
 * and then shrinks. A second (third, ...) penalty says so, so it is never mistaken for a retake: each one is a new foul in the box.
 * Events are only grouped for display: none is dropped, and rows read nothing after the events given. `events` is seq-ordered.
 */
export function feedRows(events: MatchEvent[], listed: (e: MatchEvent) => boolean): FeedRow[] {
  const rows: FeedRow[] = [];
  let pens = 0;
  for (const [i, e] of events.entries()) {
    if (!listed(e)) continue;
    const last = rows.at(-1);
    const shot = events[i - 1];
    if (SHOT_RESULTS.has(e.t) && shot?.t === "shot" && shot.seq === e.seq - 1 && shot.chain === e.chain && last?.e === shot) {
      rows[rows.length - 1] = { e, lead: last.lead, text: `${last.text} — ${e.text}` };
      continue;
    }
    if (PENALTY_KICKS.has(e.t) && last?.e.t === "penalty_awarded" && last.e.side === e.side && last.e.chain === e.chain) {
      rows[rows.length - 1] = { e, lead: last.lead, text: `${last.text} — ${e.text}` };
      continue;
    }
    if (e.t === "penalty_awarded") {
      pens += 1;
      rows.push({ e, lead: e, text: pens > 1 ? `${e.text} (${ordinal(pens)} penalty of the match, a new foul in the box)` : e.text });
      continue;
    }
    rows.push({ e, lead: e, text: e.text });
  }
  return rows;
}
