/**
 * #208: dead time on the live pitch. Pure builders for the half-time / full-time summary (key stats, shot map, goals, top players)
 * and the pre-match line-up reveal, and the break timing. Everything is built from events and line-ups the page already holds:
 * no request, no outcome, nothing the lagged pitch has not shown (the caller passes only the events up to the break on the pitch).
 */
import type { LineupPlayer, MatchEvent, PubState, Side } from "../lib/pocketbase";

/** The large break banner has the pitch to itself for this long (pitch time) before the summary docks it at the top. */
export const SUMMARY_DELAY_MS = 5000;
/** Each summary card (a pair of them on a wide pitch) shows for this long at most. */
export const CARD_MS = 6000;
/** Shortest card time when a short break has to fit all four. */
const CARD_MIN_MS = 3000;
/** Breaks that get a summary, with their real-time length (balance.js halfTimeMs / etBreakMs; full time has no end: it holds). */
export const SUMMARY_BREAKS: Record<string, { kind: BreakKind; ms: number }> = {
  half_time: { kind: "ht", ms: 30000 },
  end_of_normal_time: { kind: "et", ms: 20000 },
  match_end: { kind: "ft", ms: Infinity },
};
export type BreakKind = "ht" | "et" | "ft";
export const CARDS = ["stats", "shots", "goals", "players"] as const;
export type CardId = (typeof CARDS)[number];

/**
 * Which summary card shows at pitch time `clock`, or null while the break banner has the pitch to itself (or this is no summary
 * break). A pure function of the pitch playhead, so a late join, a resumed tab or a clock jump lands straight on the right card.
 * `page` is the card on a narrow pitch (one at a time); `pair` the pair on a wide one (stats + shot map, then goals + players).
 */
export function breakCard(cur: MatchEvent | null | undefined, clock: number): { kind: BreakKind; page: number; pair: number; cardMs: number } | null {
  const b = cur ? SUMMARY_BREAKS[cur.t] : undefined;
  if (!cur || !b) return null;
  const since = clock - cur.at - SUMMARY_DELAY_MS;
  if (since < 0 || since >= b.ms - SUMMARY_DELAY_MS) return null;
  const cardMs = Number.isFinite(b.ms) ? Math.max(CARD_MIN_MS, Math.min(CARD_MS, (b.ms - SUMMARY_DELAY_MS) / CARDS.length)) : CARD_MS;
  // A break that ends holds its last card to the end; full time goes round again.
  const n = Number.isFinite(b.ms) ? Math.min(CARDS.length - 1, Math.floor(since / cardMs)) : Math.floor(since / cardMs);
  return { kind: b.kind, page: n % CARDS.length, pair: Math.floor(n / 2) % 2, cardMs };
}

const SHOT_RESULTS = new Set(["goal", "save", "miss", "block", "woodwork"]);
const PENS: Record<string, ShotResult> = { penalty_goal: "goal", penalty_saved: "save", penalty_missed: "miss", penalty_woodwork: "woodwork" };
export type ShotResult = "goal" | "save" | "miss" | "block" | "woodwork";
/** One attempt on the shot map: where it was struck from (canonical: home attacks x = 100) and how it ended. */
export type Shot = { seq: number; side: Side; x: number; y: number; result: ShotResult; p: string; min: number; header: boolean; pen: boolean };

const sideOf = (s: Side | null | undefined): Side | null => (s === "home" || s === "away" ? s : null);
const other = (s: Side): Side => (s === "home" ? "away" : "home");

/**
 * Every counted attempt in `events` whose result is in `events` too: a shot and the result in its chain, or a penalty (from the spot).
 * Cosmetic attempts are left out, as they are from the official statistics, so the map agrees with the Shots count.
 */
export function shotMap(events: MatchEvent[]): Shot[] {
  const out: Shot[] = [];
  for (const [i, e] of events.entries()) {
    if (e.cos) continue;
    const pen = PENS[e.t];
    if (pen && e.side) {
      out.push({ seq: e.seq, side: e.side, x: e.side === "home" ? 89 : 11, y: 32, result: pen, p: e.p ?? "", min: e.min, header: false, pen: true });
      continue;
    }
    if (e.t !== "shot" || !e.side || e.chain == null || !e.ball) continue;
    const res = events.slice(i + 1).find((r) => r.chain === e.chain && !r.cos && SHOT_RESULTS.has(r.t));
    if (!res) continue; // still in the air: its result is not shown yet
    out.push({ seq: e.seq, side: e.side, x: e.ball[0], y: e.ball[1], result: res.t as ShotResult, p: e.p ?? "", min: e.min, header: !!e.header, pen: false });
  }
  return out;
}

export type Goal = { seq: number; side: Side; p: string; min: number; pen: boolean; score: [number, number] };
/** Match goals in order, with the score each one made (shootout kicks are not goals). */
export function goalsOf(events: MatchEvent[]): Goal[] {
  return events
    .filter((e) => (e.t === "goal" || e.t === "penalty_goal") && sideOf(e.side))
    .map((e) => ({ seq: e.seq, side: e.side as Side, p: e.p ?? "", min: e.min, pen: e.t === "penalty_goal", score: [e.st.sc[0], e.st.sc[1]] }));
}

export type TopPlayer = { side: Side; name: string; rating: number; goals: number; shots: number; onTarget: number; saves: number; blocks: number; won: number; cards: number };
/**
 * The standout players so far, from what they did on the shown events: goals, attempts (on target count more), saves, blocks and
 * balls won (tackles, interceptions); a card counts against. A display ranking only, not an engine rating.
 */
export function topPlayers(events: MatchEvent[], n = 3): TopPlayer[] {
  const by = new Map<string, TopPlayer>();
  const get = (side: Side | null | undefined, name: string | undefined) => {
    const s = sideOf(side);
    if (!s || !name) return null;
    const k = `${s}:${name}`;
    let p = by.get(k);
    if (!p) by.set(k, (p = { side: s, name, rating: 0, goals: 0, shots: 0, onTarget: 0, saves: 0, blocks: 0, won: 0, cards: 0 }));
    return p;
  };
  for (const s of shotMap(events)) {
    const p = get(s.side, s.p);
    if (!p) continue;
    p.shots += 1;
    if (s.result === "goal") p.goals += 1;
    if (s.result === "goal" || s.result === "save") p.onTarget += 1;
  }
  for (const e of events) {
    if (e.cos) continue;
    // A penalty event is the taker's side; its keeper (p2) is the other side's.
    const p = e.t === "penalty_saved" ? (e.side ? get(other(e.side), e.p2) : null) : get(e.side, e.p);
    if (!p) continue;
    if (e.t === "save" || e.t === "penalty_saved") p.saves += 1;
    else if (e.t === "block") p.blocks += 1;
    else if (e.t === "tackle" || e.t === "interception") p.won += 1;
    else if (e.t === "yellow_card") p.cards += 1;
    else if (e.t === "red_card") p.cards += 3;
  }
  const list = [...by.values()];
  for (const p of list) p.rating = p.goals * 5 + p.onTarget * 1.5 + (p.shots - p.onTarget) * 0.5 + p.saves * 1.5 + p.blocks + p.won * 0.3 - p.cards;
  return list.filter((p) => p.rating > 0).sort((a, b) => b.rating - a.rating || b.goals - a.goals || a.name.localeCompare(b.name)).slice(0, n);
}

/** What the player did, in a few words ("1 goal · 3 shots"; a keeper's saves). */
export function playerLine(p: TopPlayer): string {
  const n = (k: number, one: string, many = one + "s") => (k ? `${k} ${k === 1 ? one : many}` : "");
  const target = p.onTarget > p.goals ? ` (${p.onTarget} on target)` : "";
  return [n(p.goals, "goal"), p.shots ? n(p.shots, "shot") + target : "", n(p.saves, "save"), n(p.blocks, "block"), n(p.won, "ball won", "balls won")]
    .filter(Boolean)
    .join(" · ");
}

export type BreakSummary = { kind: BreakKind; seq: number; st: PubState; shots: Shot[]; goals: Goal[]; top: TopPlayer[] };
/** The summary at the break `seq`: the break's own published state and the events up to it (never anything after the break). */
export function breakSummary(events: MatchEvent[], seq: number): BreakSummary | null {
  const upto = events.filter((e) => e.seq <= seq);
  const cur = upto.at(-1);
  const b = cur && cur.seq === seq ? SUMMARY_BREAKS[cur.t] : undefined;
  if (!cur || !b) return null;
  return { kind: b.kind, seq, st: cur.st, shots: shotMap(upto), goals: goalsOf(upto), top: topPlayers(upto) };
}

/** #189's slot order: the keeper, then defenders to attackers (unknown roles in the middle). */
const ROLE_RANK = new Map([["def", 0], ["util", 1], ["mid", 2], ["att", 3]]);
/**
 * Pre-match formation for one side (pitch units, home in the left half facing right, away mirrored): the keeper on his line, the
 * outfield starters in lines of two from the back.
 */
export function formation(list: LineupPlayer[], side: Side): Array<{ p: LineupPlayer; x: number; y: number }> {
  const starters = list.filter((p) => p.starter);
  const gk = starters.find((p) => p.role === "gk") ?? starters[0];
  if (!gk) return [];
  const rest = starters.filter((p) => p !== gk).sort((a, b) => (ROLE_RANK.get(a.role) ?? 1) - (ROLE_RANK.get(b.role) ?? 1));
  const lines = Math.max(1, Math.ceil(rest.length / 2));
  const at = (x: number, y: number) => ({ x: side === "home" ? x : 100 - x, y });
  return [
    { p: gk, ...at(6, 32) },
    ...rest.map((p, i) => {
      const line = Math.floor(i / 2);
      const inLine = Math.min(2, rest.length - line * 2);
      const y = inLine === 1 ? 32 : i % 2 ? 44 : 20;
      return { p, ...at(lines === 1 ? 28 : 19 + (line * 22) / (lines - 1), y) };
    }),
  ];
}
