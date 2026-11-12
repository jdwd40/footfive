import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import Pitch from "../components/Pitch";
import MarketsPanel from "../components/MarketsPanel";
import Ticker from "../components/Ticker";
import { MatchClock, PhaseChip, useChanged } from "../components/FixtureCard";
import { Abbr } from "../components/Team";
import { commentaryLine, feedRows } from "../domain/commentary";
import { sampleN, sceneFor, type Pt, type Scene } from "../domain/scenes";
import { LINGER_MS, frameAt, playhead, reveal, sentOffAt, settle, smooth, type Frame, type PlayerStarts } from "../domain/sim";
import { autoReplay, replayStarted, type ReplayMemo } from "../domain/replay";
import { clockSeconds, countdown, eventClockTime, eventTime, minuteLabel, noteServerTime, phaseInfo, serverNow, useLive, useNow } from "../lib/live";
import { footfiveApi, type FixtureCard as FixtureCardData, type MatchEvent, type MatchView, type PubState, type Side, type TickerItem } from "../lib/pocketbase";
import { reportConnectionFail, reportConnectionOk } from "../hooks/useConnectionStatus";
import { startPolling } from "../lib/polling";

/** Match feed cadence; a backlog is still drained in one poll via eventsPage. */
const MATCH_POLL_MS = 2500;

const STAT_ROWS: Array<[string, number]> = [
  ["Shots", 0],
  ["On target", 1],
  ["Saves", 2],
  ["Fouls", 4],
  ["Yellow cards", 5],
  ["Red cards", 6],
];

const PREF_KEY = "ff_highlights";
type Pref = "full" | "off";
const LAG_MS = 1500; // ponytail: fixed latency buffer; make adaptive if poll jitter shows
const RETURN_MS = 20000;
/** A delayed batch of events (stale server) is played through fast rather than skipped: the pitch clock runs at least this
 * much faster than real time until it is back on `now - LAG_MS`, so a big backlog still clears in a few seconds. */
const CATCHUP_RATE = 4;
const CATCHUP_TARGET_MS = 5000;
/** Further behind than this (reconnect after an outage, a long missed backlog) the clock snaps to live instead of fast-forwarding. */
const CATCHUP_MAX_MS = 30000;

/** Advance the pitch clock by `dt` real ms towards `target`; rewinds to `rewindTo` (first unshown event) when a late batch would be skipped.
 * A clock that itself leapt (resumed tab, server-time correction) still snaps: that is history, not a late batch. */
function advanceClock(clock: number | null, target: number, prevTarget: number | null, dt: number, rewindTo: number | null): number {
  if (clock === null || prevTarget === null || dt > 1000 || target - prevTarget > dt + 1000) return target;
  const c = rewindTo !== null && rewindTo < clock ? rewindTo : clock;
  const behind = target - c;
  if (behind <= 0 || behind > CATCHUP_MAX_MS) return target;
  return Math.min(target, c + dt * (behind > 250 ? 1 + Math.max(CATCHUP_RATE - 1, behind / CATCHUP_TARGET_MS) : 1));
}

/** Period restarts are published running, but the engine holds the kick-off (walk-on) before the first play starts the minute.
 * The HUD clock stays on the restart's own time until that play rather than run on and then wait for it (#182). */
const RESTARTS = new Set(["kickoff", "second_half", "extra_time", "et_second_half"]);

/** Live caption lifetime from the first moment that event seq is actually shown. Dwell after this is an ellipsis. */
const CAPTION_MS = 5000;

/** One visit's live captions, keyed by event seq. A clock rewind or a repeat poll must not start the lifetime again.
 * Replay text is passed in and is not recorded. A fixture id change clears the visit. The reveal gate still selects the previous event until its result is ready. */
function CommentaryLine({ fixtureId, replayCaption, seq, text, idle }: {
  fixtureId: string;
  replayCaption: string | null;
  seq: number | null;
  text: string | null;
  idle: string;
}) {
  const mem = useRef<{ id: string; shown: Map<number, number> }>({ id: fixtureId, shown: new Map() });
  const [, bump] = useState(0);
  if (mem.current.id !== fixtureId) mem.current = { id: fixtureId, shown: new Map() };
  const record = replayCaption == null && seq != null;
  if (record && !mem.current.shown.has(seq)) mem.current.shown.set(seq, performance.now());
  const started = record ? mem.current.shown.get(seq)! : null;
  useEffect(() => {
    if (!record || started == null) return;
    const left = CAPTION_MS - (performance.now() - started);
    if (left <= 0) return;
    const id = window.setTimeout(() => bump((n) => n + 1), left);
    return () => window.clearTimeout(id);
  }, [fixtureId, seq, replayCaption, started, record]);
  const age = started == null ? 0 : performance.now() - started;
  const body = replayCaption != null ? replayCaption : text && started != null && age < CAPTION_MS ? text : seq != null ? "…" : idle;
  return (
    // #207: two lines are always held (a longer caption is clamped visually, still read in full), so a caption that wraps never
    // moves what is under the pitch.
    <p className="line-clamp-2 min-h-12 min-w-0 flex-1 text-base font-semibold" aria-live="polite" data-testid="commentary">
      {body}
    </p>
  );
}

/** Pitch on/off preference: presentation only, never changes the match. Legacy "quick" counts as "full". */
function usePref(): [Pref, (p: Pref) => void, boolean] {
  const sysReduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [p, setP] = useState<Pref>(() => (localStorage.getItem(PREF_KEY) === "off" ? "off" : "full"));
  return [
    p,
    (v) => {
      localStorage.setItem(PREF_KEY, v);
      setP(v);
    },
    !!sysReduced,
  ];
}

/** Period markers, coaching, ...: ball held where it was, caption only. */
function idleScene(e: MatchEvent, ball: Pt): Scene {
  return { key: `${e.seq}`, seq: e.seq, type: e.t, phase: e.st?.ph, ms: 0, ball: [ball], actors: [], caption: e.text, side: e.side ?? null };
}

/** What the animation loop committed last: server time it ran at, the frame it drew, whether its result may show (`revealed`: the drawn scene — live or replay; `liveRevealed`: the live playhead's), and where the drawn ball and players were when the current scene began. */
type Anim = { now: number; clock: number /* pitch playhead time: now − LAG_MS, or behind it while fast-forwarding a late batch */; frame: Frame | null; reached: boolean; revealed: boolean; liveSeq: number | null; liveRevealed: boolean; startBall: Pt | null; startPlayers: PlayerStarts | null /* #189: drawn player spots (side:no) as this scene began, held for its life */; src: number | null /* what drew `frame`: the replay's startedAt, or null for the live playhead */; sentOff: Set<string> /* as drawn: timed cards + seeded history */; liveSentOff: Set<string> /* as the live playhead has shown them: the line-ups' set, untouched by a replay */; auto?: string | null /* #206: the automatic goal replay being drawn (its caption), else null */; replayed?: boolean /* #206: this goal's replay has started: its big screen and cheer are over */; wonSeen?: boolean /* WON IT latched for this scene: the drawn ball has reached the winning side */ };

/** #189: a copy of every drawn player's spot, keyed side:no (pitch units, before any camera projection). */
function starts(frame: Frame): PlayerStarts {
  return Object.freeze(Object.fromEntries(frame.players.map((p) => [`${p.side}:${p.no}`, [p.x, p.y] as Pt])));
}

/** Public state as the pitch shows it: the current event's snapshot, or its predecessor's while a result is still hidden. */
function shownState(ph: ReturnType<typeof playhead>, revealed: boolean): PubState | null {
  if (!ph) return null;
  return revealed || !ph.prev ? ph.cur.st : ph.prev.st;
}

export default function MatchPage() {
  const { fixtureId = "" } = useParams();
  const navigate = useNavigate();
  const { live } = useLive();
  const [view, setView] = useState<MatchView | null>(null);
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [error, setError] = useState("");
  const [lastOk, setLastOk] = useState(0);
  const [pref, setPref, sysReduced] = usePref();
  const [replay, setReplay] = useState<{ scene: Scene; startedAt: number } | null>(null);
  const [stay, setStay] = useState(false);
  const refreshMatch = useRef<(() => Promise<unknown>) | null>(null);
  // #206: this visit's automatic goal replays, by celebration seq: the plan (once started; null = none fits) and the ones skipped by catch-up.
  const autoRef = useRef<ReplayMemo & { id: string }>({ id: fixtureId, plans: new Map(), skipped: new Set() });
  if (autoRef.current.id !== fixtureId) autoRef.current = { id: fixtureId, plans: new Map(), skipped: new Set() };
  const clockRef = useRef<{ clock: number | null; target: number | null; seq: number | null }>({ clock: null, target: null, seq: null });
  // Display floor for this fixture visit. It outlives a HUD gap and is cleared only when the route fixture changes.
  const clockHold = useRef<{ id: string; sec: number }>({ id: fixtureId, sec: 0 });
  if (clockHold.current.id !== fixtureId) clockHold.current = { id: fixtureId, sec: 0 };
  // Everything time-driven lives in one state written by the animation loop; render only reads it.
  const [anim, setAnim] = useState<Anim>(() => ({ now: serverNow(), clock: serverNow() - LAG_MS, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, startPlayers: null, src: null, sentOff: new Set(), liveSentOff: new Set() }));

  // Reset when switching fixtures.
  useEffect(() => {
    setView(null);
    setEvents([]);
    setReplay(null);
    setError("");
    setLastOk(0);
    setStay(false);
    clockRef.current = { clock: null, target: null, seq: null };
    setAnim({ now: serverNow(), clock: serverNow() - LAG_MS, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, startPlayers: null, src: null, sentOff: new Set(), liveSentOff: new Set() });
  }, [fixtureId]);
  useEffect(() => {
    setAnim((a) => ({ ...a, frame: null })); // replay start/end jumps the timeline: no chase across it
  }, [replay]);

  useEffect(() => {
    // Each fixture visit owns its cursor and request lock. Cleanup fences every page,
    // including a late response after navigating away and back to the same fixture.
    let cancelled = false;
    let inflight = false;
    let lastSeq = 0;
    const poll = async () => {
      if (inflight) return;
      inflight = true;
      try {
        let cursor = lastSeq;
        let throughMs: number | undefined;
        let v: MatchView;
        const fresh: MatchEvent[] = [];
        for (;;) {
          v = await footfiveApi.match(fixtureId, cursor, throughMs);
          if (cancelled || v.fixture.id !== fixtureId) return;
          fresh.push(...v.events.filter((e) => e.seq > cursor));
          const page = v.eventsPage;
          if (page.hasMore && page.nextSeq <= cursor) throw new Error("Match history did not advance");
          cursor = page.nextSeq;
          throughMs = page.throughMs;
          if (!page.hasMore) break;
        }
        // Keep the current timeline until the whole backlog is available. A failed
        // page leaves the committed cursor intact so the next poll can retry safely.
        lastSeq = cursor;
        noteServerTime(v.serverTimeMs);
        reportConnectionOk();
        setLastOk(Date.now());
        setError("");
        setView(v);
        if (fresh.length) setEvents((old) => {
          const seen = new Set(old.map((e) => e.seq));
          return [...old, ...fresh.filter((e) => !seen.has(e.seq))];
        });
        return true;
      } catch (err) {
        if (cancelled) return;
        reportConnectionFail(err);
        setError(err instanceof Error ? err.message : "Match unavailable");
        return false;
      } finally {
        inflight = false;
      }
    };
    refreshMatch.current = poll;
    void poll();
    const stop = startPolling(poll, MATCH_POLL_MS);
    return () => { cancelled = true; refreshMatch.current = null; stop(); };
  }, [fixtureId]);

  // Scene per event, chained so the ball carries over between scenes, lengths scaled to the match pace.
  const minuteMs = view?.fixture.minuteMs ?? 15000;
  const homeLabel = view?.fixture.home.abbreviation ?? "";
  const awayLabel = view?.fixture.away.abbreviation ?? "";
  const scenes = useMemo(() => {
    const m = new Map<number, Scene>();
    let prev: Pt = [50, 32];
    let lift = 0; // #190: a result carries on a lifted shot (header, long shot) from its height
    for (const [i, e] of events.entries()) {
      const s = sceneFor(e, prev, minuteMs, events[i + 1], lift) ?? idleScene(e, prev); // a cross reads its own already-fetched header
      prev = s.ball[s.ball.length - 1];
      lift = sampleN(s.ballHeight, 1);
      m.set(e.seq, { ...s, caption: commentaryLine(events, i, { home: homeLabel, away: awayLabel }) });
    }
    return m;
  }, [events, minuteMs, homeLabel, awayLabel]);
  // #206: each event's match minute, for the goal screen.
  const minutes = useMemo(() => new Map(events.map((e) => [e.seq, e.min])), [events]);

  const lineups = view?.lineups ?? null;
  const serverSentOff = view?.sentOff;
  // Animation loop: one rAF per frame computes the target frame and chases it; the committed `anim` is all render sees.
  useEffect(() => {
    let id = 0;
    let last = performance.now();
    // Dismissals whose detailed red_card event is no longer retained on the server.
    const seeded = (serverSentOff ?? []).filter((s) => !events.some((e) => e.t === "red_card" && e.side === s.side && e.p === s.p)).map((s) => s.side + ":" + s.p);
    const dismissed = (seq: number) => {
      const out = sentOffAt(events, seq);
      for (const k of seeded) out.add(k);
      return out;
    };
    const step = () => {
      id = requestAnimationFrame(step);
      const t0 = performance.now();
      const dt = Math.max(0, t0 - last); // smooth() clamps a stutter and snaps after a long gap
      last = t0;
      const now = serverNow();
      if (replay && (t0 - replay.startedAt) / replay.scene.ms >= 1 + 900 / replay.scene.ms) return setReplay(null);
      // Pitch clock: normally now − LAG_MS. If a batch arrived late with events after the one on the pitch already in the
      // past, rewind to the first of them and fast-forward, so the real passes are shown instead of snapped over.
      const ck = clockRef.current;
      const next = ck.seq === null || replay ? undefined : events.find((e) => e.seq > ck.seq!);
      const clock = advanceClock(ck.clock, now - LAG_MS, ck.target, dt, next ? next.at : null);
      ck.clock = clock;
      ck.target = now - LAG_MS;
      const ph = playhead(events, clock);
      ck.seq = ph ? ph.cur.seq : ck.seq;
      // #206: the automatic goal replay, a pure function of this playhead: drawn only while it is still on the goal's celebration
      // (the next event being due ends it), never under reduced motion or with highlights off, never instead of a requested replay,
      // and skipped for good if any of that celebration is fast-forwarded (catch-up). It never touches the clock above.
      const ar = !replay && !sysReduced && pref !== "off" ? autoReplay(autoRef.current, events, scenes, ph?.cur ?? null, clock, now - LAG_MS) : null;
      const auto = ar ? { scene: ar.scene, p: ar.p, src: -ar.plan.goalSeq, caption: ar.plan.caption } : null;
      // Reduced motion: final frame of each event, still ticking per event (same information, no movement).
      // Live p runs past 1 so frameAt can keep routine play moving until the next event (dwell).
      const liveScene = ph ? scenes.get(ph.cur.seq) : null;
      const replaying = !!replay || !!auto;
      const prevBuilt = ph?.prev && !replaying ? scenes.get(ph.prev.seq) : undefined;
      // A pass that arrives after the chip has already expired must not start the 2.5 s tail again.
      const prevScene = prevBuilt && ph?.prev && clock - ph.prev.at < prevBuilt.ms + LINGER_MS ? prevBuilt : undefined;
      const liveP = sysReduced ? 1 : ph && liveScene?.ms ? ph.elapsed / liveScene.ms : 1;
      const scene = replay ? replay.scene : auto ? auto.scene : liveScene;
      const p = replay ? (sysReduced ? 1 : Math.min(1, (t0 - replay.startedAt) / replay.scene.ms)) : auto ? auto.p : liveP;
      const elapsed = replay ? t0 - replay.startedAt : auto ? auto.p * auto.scene.ms : ph?.elapsed ?? 0; // real scene time: p holds at 1 under reduced motion and at a replay's end
      const src = replay ? replay.startedAt : auto ? auto.src : null;
      const autoCaption = auto ? auto.caption : null;
      // After its replay (a late restart), the live celebration comes back without its big screen or a second cheer.
      const replayed = !replay && !auto && replayStarted(autoRef.current, ph?.cur ?? null, clock);
      setAnim((a) => {
        if (!scene) return { now, clock, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, startPlayers: null, src: null, sentOff: new Set(), liveSentOff: new Set(), auto: null, replayed: false };
        // One scene of one source (live, or one replay): switching source is a cut, never a chase or a carried verdict.
        const same = a.frame?.seq === scene.seq && a.src === src;
        // Skipped events (suspended tab): the drawn frame is history — snap to the scene's own start rather than chase across the gap.
        const jumped = !!a.frame && !same && (Math.abs(scene.seq - a.frame.seq) > 1 || a.src !== src);
        // A new scene starts where the drawn ball actually is (the previous scene may have dwelt on), not at its authored first keyframe.
        const startBall = same ? a.startBall : jumped ? null : a.frame?.ball ?? null;
        // #189: the named players start where they are drawn too. Taken once, from the frame drawn just before a contiguous new scene
        // by the same source (live, or this one replay), and held for the scene's life. Late join, a skip, reduced motion and any
        // switch between live and a replay (or between replays) get none: the scene's authored starts.
        const fresh = !same && !jumped && !!a.frame && a.src === src;
        const startPlayers = sysReduced ? null : same && a.src === src ? a.startPlayers : fresh ? starts(a.frame!) : null;
        // Red cards count from the events the playhead has shown; the card's own scene only once revealed (last tick's verdict).
        const sentOff = dismissed(same && a.revealed ? scene.seq : scene.seq - 1);
        const target = frameAt(scene, p, lineups, sentOff, sysReduced ? 0 : now, startBall ?? undefined, prevScene, elapsed, startPlayers ?? undefined);
        // A result event that landed late (scene already over) has the drawn ball still travelling: settle puts it on the impact this tick.
        const frame = settle(scene, p, sysReduced ? target : smooth(jumped ? null : a.frame, target, dt), same && a.reached);
        // Result gate is decided here, once, from the ball actually drawn; `reached` carries over within one scene.
        const gate = reveal(scene, p, frame.ball, same && a.reached);
        // The live result has its own gate: during a replay no live ball is drawn, so the live scene's flash moment alone decides.
        const liveRevealed = replaying ? !liveScene || reveal(liveScene, liveP, frame.ball, true).revealed : gate.revealed;
        // The line-ups follow the live playhead: a replay of something older than a red card must not un-strike the player.
        const liveSentOff = replaying && liveScene ? dismissed(liveRevealed ? liveScene.seq : liveScene.seq - 1) : sentOff;
        // WON IT waits for the drawn ball to be at a player of the winning side, then holds for its window (no flicker as he moves it on).
        const wonSeen = !!frame.won && ((same && !!a.wonSeen) || (frame.lift < 0.05 && frame.players.some((q) => q.side === frame.won && Math.hypot(q.x - frame.ball[0], q.y - frame.ball[1]) <= 1.6)));
        return { now, clock, frame: frame.won && !wonSeen ? { ...frame, won: null } : frame, wonSeen, startBall, startPlayers, src, sentOff, liveSentOff, ...gate, liveSeq: liveScene?.seq ?? null, liveRevealed, auto: autoCaption, replayed };
      });
    };
    step();
    return () => cancelAnimationFrame(id);
  }, [events, scenes, lineups, serverSentOff, replay, sysReduced, pref]);
  const { now, frame, revealed, liveSentOff } = anim;
  const ph = playhead(events, anim.clock);
  // A newly fetched playhead must not inherit the previous scene's reveal verdict:
  // the ticker retains shown/queued items even after a later render removes them.
  const liveRevealed = !!ph && anim.liveSeq === ph.cur.seq && anim.liveRevealed;

  // Back to the round RETURN_MS after the final whistle; any interaction after full time cancels it.
  // Public state as the lagged pitch shows it: every event carries its own snapshot, held back until the result is revealed. Auto-return keys off the real state.
  const st: PubState | null = shownState(ph, liveRevealed) ?? (events.length ? null : view?.fixture.st ?? null);
  const finished = view?.fixture.st?.ph === "finished";
  const finishedAt = useMemo(() => (finished ? Date.now() : 0), [finished]);
  useEffect(() => {
    if (!finished) return;
    const cancel = () => setStay(true);
    const evs = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, cancel, { passive: true, once: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, cancel));
  }, [finished]);
  useEffect(() => {
    if (!finished || stay) return;
    const id = setTimeout(() => {
      if (!document.querySelector('[data-testid="bet-slip"]')) navigate("/live");
    }, RETURN_MS);
    return () => clearTimeout(id);
  }, [finished, stay, navigate]);

  const stale = !lastOk || Date.now() - lastOk > 8000;

  if (!view) {
    return (
      <Layout wide>
        {error ? (
          <div className="panel mx-auto mt-10 max-w-md p-6 text-center" role="alert">
            <p className="font-display text-amber">Match unavailable</p>
            <p className="mt-2 text-sm text-muted">{error}</p>
            <Link to="/live" className="btn-ghost mt-4 inline-flex">
              Back to the round
            </Link>
          </div>
        ) : (
          // #207: the skeleton sits where the page will (same wrapper, same top), so the loaded page does not jump up from it.
          <div className="match-page">
            <div className="panel h-72 animate-pulse" data-testid="match-loading" />
          </div>
        )}
      </Layout>
    );
  }

  const fx = view.fixture;
  const shown: MatchView = { ...view, fixture: { ...fx, st, at: ph?.cur.at ?? fx.at } };
  // HUD clock and its floor run on the pitch playhead (lagged, fast-forwarding a late batch), so they match the play shown.
  // Never ahead of the synced lagged time: the first render after loading still holds the loading frame's clock.
  const clockEvent = ph ? (liveRevealed || !ph.prev ? ph.cur : ph.prev) : null;
  const clockNow = ph && clockEvent && RESTARTS.has(clockEvent.t) ? ph.cur.at : Math.min(anim.clock, serverNow() - LAG_MS);
  // Ignore a render that still holds the previous fixture: that view must not seed the new visit.
  if (fx.id === fixtureId && st && st.ph !== "shootout" && st.ph !== "finished") {
    const raw = clockSeconds(st, shown.fixture.at, clockNow, fx.minuteMs);
    if (raw != null && raw > clockHold.current.sec) clockHold.current.sec = raw;
  }
  const others = (live?.fixtures || []).filter((f) => f.id !== fx.id);
  // A requested replay, or the automatic goal replay the loop is drawing (#206).
  const replayCaption = replay ? replay.scene.caption : anim.auto ?? null;
  const current = replayCaption != null ? null : ph?.cur;
  // The shot is still travelling until the loop says the result is in: keep the previous caption until then.
  const holding = !!(current && !liveRevealed && ph?.prev);
  const presentedSeq = current ? (holding ? ph!.prev!.seq : current.seq) : null;
  const presentedText = presentedSeq == null ? null : scenes.get(presentedSeq)?.caption ?? null;
  // Events as the playhead has shown them: nothing newer, and the current one only once its result is revealed.
  const seen = ph ? events.filter((e) => e.seq < ph.cur.seq || (liveRevealed && e.seq === ph.cur.seq)) : [];
  const recent: TickerItem[] = seen.filter((e) => e.major).slice(-30).reverse().map((e) => ({
    id: `${fx.id}:${e.seq}`, fixtureId: fx.id, seq: e.seq, at: e.at, t: e.t, side: e.side ?? null, text: e.tick || e.text, min: e.min,
  }));
  const otherTicker = live?.ticker?.filter((i) => i.fixtureId !== fx.id) ?? [];
  // #207: one ticker row for this match (as the lagged pitch has shown it) and the other matches, newest first.
  const tickerItems = [...recent, ...otherTicker].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));

  return (
    <Layout wide>
      <div className="match-page">
      {/* #207: the other matches' scores and the one merged ticker share a row on desktop; on phones they are two slim rows. */}
      <div className="match-top" data-testid="match-top">
        <div className="match-others flex items-center gap-1.5 overflow-x-auto no-scrollbar" aria-label="Other matches">
          <Link to="/live" className="btn-ghost !min-h-8 shrink-0 !px-2.5 !py-0.5 text-xs">
            ← Round
          </Link>
          {others.map((o) => (
            <OtherMatch key={o.id} fx={o} />
          ))}
        </div>
        <Ticker
          key={fx.id}
          items={tickerItems}
          label="Live events"
          badge="Live"
          badgeFor={(i) => (i.fixtureId === fx.id ? "This match" : "Elsewhere")}
          flashGoals={(i) => i.fixtureId !== fx.id}
          empty="Goals, cards and penalties from this match and the round appear here."
        />
      </div>

      <Scoreboard view={shown} events={seen} now={now} clockNow={clockNow} minSec={clockHold.current.sec} stale={stale} autoReturn={finished && !stay ? countdown(finishedAt + RETURN_MS - Date.now()) : null} />

      <div className="match-grid mt-2 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <section className="match-pitch-panel panel p-2 sm:p-3">
            {pref === "off" ? (
              <div className="grid h-40 place-items-center text-sm text-muted">Highlights off — commentary only.</div>
            ) : (
              // #207: the score and clock live on the one scoreboard above the pitch; the pitch carries no score strip.
              <Pitch frame={frame} home={fx.home} away={fx.away} replay={replayCaption != null} replayed={!!anim.replayed} revealed={revealed} minute={frame ? minutes.get(frame.seq) : undefined} />
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <CommentaryLine
                fixtureId={fx.id}
                replayCaption={replayCaption}
                seq={presentedSeq}
                text={presentedText}
                idle={fx.status === "scheduled" ? "Waiting for kick-off" : "…"}
              />
              <div className="flex gap-1" role="group" aria-label="Highlights">
                {(["full", "off"] as const).map((p) => (
                  <button key={p} type="button" className={`chip ${pref === p ? "chip-lime" : "chip-muted"}`} onClick={() => setPref(p)} aria-pressed={pref === p}>
                    {p === "full" ? "Full" : "Off"}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {st?.so || st?.ph === "shootout" ? <ShootoutBoard view={shown} events={seen} /> : null}
        </div>

        {/* #207: beside the pitch on desktop, stacked under it on phones: betting (folded), the events, line-ups and statistics. */}
        <aside className="match-side min-w-0 space-y-3">
          {view.coach ? <Coaching key={fx.id} view={view} onDone={() => void refreshMatch.current?.()} /> : null}
          <BetTab key={fx.id} fx={fx} finished={finished} />
          <section className="panel p-3">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h2 className="panel-title">Match events</h2>
              <span className="text-xs text-muted">Match minutes</span>
            </div>
            {/* The feed lists FEED_TYPES only; routine play is on the pitch and in the stats (#181). */}
            <p className="mb-2 text-[11px] leading-snug text-muted" data-testid="feed-note">
              Key moments: every shot and its result, plus goals, cards and penalties. Passes, tackles and fouls are left out, so quiet spells are normal. Statistics are match totals.
            </p>
            {/* #207: a fixed-height list, so a new row never pushes the line-ups and statistics below it. */}
            <div className="match-feed h-64 overflow-y-auto overscroll-contain pr-1">
              <EventFeed
                events={seen}
                view={view}
                onReplay={(e) => {
                  const s = scenes.get(e.seq);
                  if (s && s.ms > 0 && pref !== "off") setReplay({ scene: s, startedAt: performance.now() });
                }}
              />
            </div>
          </section>
          {view.lineups ? <Lineups view={view} sentOff={liveSentOff} /> : null}
          <section className="panel p-3">
            <h2 className="panel-title mb-2">Statistics</h2>
            <Stats st={st} view={view} />
          </section>
        </aside>
      </div>
      </div>
    </Layout>
  );
}

const BET_TAB_KEY = "ff_bet_tab";

/**
 * #207: betting for this match folded into one tab. Open, its body is a fixed-height scroll area, so markets that are withdrawn,
 * suspended or collapse (a shootout leaves only "To qualify") change nothing outside it. The markets stay mounted while it is
 * folded, so their requests and polling are exactly as before; a finished match drops them, as before.
 */
function BetTab({ fx, finished }: { fx: MatchView["fixture"]; finished: boolean }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(BET_TAB_KEY) === "open";
    } catch {
      return false;
    }
  });
  const [closed, setClosed] = useState<string | null>(null);
  const onClosed = useCallback((c: string | null) => setClosed(c), []);
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(BET_TAB_KEY, o ? "closed" : "open");
      } catch {
        /* a blocked store only forgets the choice */
      }
      return !o;
    });
  const bodyId = `bet-tab-${fx.id}`;
  return (
    <section className="panel overflow-hidden" data-testid="bet-tab">
      <button type="button" className="flex h-11 w-full items-center gap-2 px-3 text-left" aria-expanded={open} aria-controls={bodyId} onClick={toggle} data-testid="bet-tab-toggle">
        <h2 className="panel-title min-w-0 flex-1 truncate">Bet on this match</h2>
        {!finished && closed ? (
          <span className="chip chip-amber max-w-[11rem] truncate" data-testid="bet-tab-suspended">
            <span className="truncate">{closed}</span>
          </span>
        ) : null}
        <span aria-hidden className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="match-bet-body h-80 overflow-y-auto overscroll-contain border-t border-line px-3 py-2" data-testid="bet-tab-body">
        {finished ? (
          <p className="text-sm text-muted">Betting has closed — this match is over.</p>
        ) : (
          <MarketsPanel fixtureId={fx.id} seq={fx.seq} fixtureLabel={`${fx.home.abbreviation} v ${fx.away.abbreviation}`} onClosed={onClosed} />
        )}
      </div>
    </section>
  );
}

/** One other match of the round, from the round snapshot already polled. #206: a goal there (its score changes) flashes the chip. */
function OtherMatch({ fx }: { fx: FixtureCardData }) {
  const score = fx.st ? `${fx.st.sc[0]}–${fx.st.sc[1]}` : "";
  const flash = useChanged(fx.st ? fx.st.sc.join("-") : "0-0"); // kick-off (no state yet → 0–0) is not a goal
  return (
    <Link to={`/match/${fx.id}`} className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs hover:border-cyan/50" data-testid="other-match">
      <Abbr team={fx.home} />
      <span key={flash} className={`tabular inline-block min-w-[2.25rem] rounded px-0.5 text-center font-bold ${flash ? "goal-flash" : ""}`} data-testid="other-score" data-flash={flash || undefined}>
        {score || "v"}
      </span>
      <Abbr team={fx.away} away />
    </Link>
  );
}

/** #207: one side of the scoreboard. The badge (crest) sits on the outer edge, the name between it and the score, so no team
 * colour ever sits beside the score or the clock. Phones show the badge alone, still at the outer edge. */
function ScoreTeam({ team, side, dim }: { team: MatchView["fixture"]["home"]; side: Side; dim: boolean }) {
  const home = side === "home";
  return (
    <div className={`score-team flex min-w-0 items-center gap-2 ${home ? "justify-start sm:justify-end" : "flex-row-reverse justify-start sm:justify-end"} ${dim ? "opacity-50" : ""}`} data-testid={`score-team-${side}`}>
      <span className="score-crest shrink-0">
        <Abbr team={team} away={!home} />
      </span>
      <span className={`hidden min-w-0 truncate font-semibold sm:inline sm:text-lg lg:text-xl ${home ? "text-right" : ""}`} title={team.name}>
        {team.name}
      </span>
    </div>
  );
}

/**
 * #207: the one score on the page, as the lagged pitch shows it, with the big clock (or the shootout score), the match timeline
 * and the phase. Every row has a fixed height whatever it shows, so nothing here moves the pitch during a match.
 */
function Scoreboard({ view, events, now, clockNow, minSec, stale, autoReturn }: { view: MatchView; events: MatchEvent[]; now: number; clockNow: number; minSec: number; stale: boolean; autoReturn: string | null }) {
  const fx = view.fixture;
  const st = fx.st;
  const flash = useChanged(st ? st.sc.join("-") : "");
  const finished = st?.ph === "finished";
  const winner: Side | null = finished ? st!.win : null;
  const so = st?.so;
  const shootout = !finished && (st?.ph === "shootout" || !!so);
  const kicker = st?.ph === "shootout" && so?.next ? (so.next === "home" ? fx.home : fx.away) : null;
  const sec = st && !shootout && !finished ? clockSeconds(st, fx.at, clockNow, fx.minuteMs) : null;
  return (
    <section className="panel overflow-hidden" data-testid="match-scoreboard">
      <div className="match-score-row grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 pt-1.5 sm:gap-4 sm:px-4">
        <ScoreTeam team={fx.home} side="home" dim={winner === "away"} />
        <div className="flex items-center gap-2.5 sm:gap-4">
          <div className="flex h-10 w-[5.5rem] items-center justify-center">
            {st ? (
              <div key={flash} className={`w-full text-center text-4xl font-bold leading-none tabular ${flash ? "score-pop" : ""}`} data-testid="match-score">
                {st.sc[0]}
                <span className="mx-1 text-muted">–</span>
                {st.sc[1]}
              </div>
            ) : (
              <div className="text-center font-display text-2xl leading-none text-muted">vs</div>
            )}
          </div>
          <span aria-hidden className="h-8 w-px bg-line" />
          <div className="match-clock flex h-9 w-[5.75rem] items-center text-[28px] font-bold leading-none sm:text-[32px]" data-testid="match-clock">
            {!st ? (
              <span className="text-xs font-semibold leading-tight text-muted">
                Kick-off in
                <br />
                <b className="tabular text-sm text-white">{countdown(fx.kickoffAt - now)}</b>
              </span>
            ) : shootout ? (
              <span className="font-display text-lg font-bold leading-none text-magenta tabular" data-testid="match-shootout-score">
                PENS{so ? ` ${so.h}–${so.a}` : ""}
              </span>
            ) : (
              <MatchClock fx={fx} now={clockNow} minSec={minSec} sizeClass="text-[28px] leading-none sm:text-[32px]" />
            )}
          </div>
        </div>
        <ScoreTeam team={fx.away} side="away" dim={winner === "home"} />
      </div>
      <div className="flex h-7 items-center gap-2 px-3 sm:px-4">
        <span className="hidden w-24 shrink-0 truncate text-[10px] font-bold uppercase tracking-widest text-muted sm:block" title={view.round.label}>
          {view.round.label}
        </span>
        <Timeline fx={fx} events={events} sec={sec} />
        <span className="flex w-[5.75rem] shrink-0 justify-end">
          {stale ? (
            <span className="chip chip-amber">Reconnecting</span>
          ) : kicker ? (
            <span className="chip chip-magenta" data-testid="match-kicker">
              {kicker.abbreviation} to kick
            </span>
          ) : (
            <PhaseChip fx={fx} now={now} />
          )}
        </span>
      </div>
      {(finished && winner) || autoReturn ? (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-lime/30 bg-lime/10 px-3 py-1 text-center text-sm font-bold text-lime">
          {finished && winner ? (
            <span data-testid="final-result">
              {(winner === "home" ? fx.home : fx.away).name} go through
              {st!.by === "pens" && st!.so ? ` — won the shootout ${Math.max(st!.so.h, st!.so.a)}–${Math.min(st!.so.h, st!.so.a)}` : st!.by === "aet" ? " after extra time" : ""}
            </span>
          ) : null}
          {autoReturn ? (
            <span className="chip chip-amber tabular" data-testid="auto-return">
              Back to the round in {autoReturn} · tap to stay
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const ET_PHASES = new Set(["et_break", "extra_time_1", "et_half_time", "extra_time_2", "shootout"]);
const MARKS: Record<string, "goal" | "yellow" | "red"> = { goal: "goal", penalty_goal: "goal", yellow_card: "yellow", red_card: "red" };
const MARK_NAME = { goal: "Goal", yellow: "Yellow card", red: "Red card" } as const;

/**
 * #207: the match on one bar under the score: 90 minutes, or 120 once extra time is reached, with each goal and card the pitch has
 * shown at its minute (home above the line, away below) and the current minute as the filled part and its head. The fill and head
 * move by transform only, so the running clock never counts as a layout shift.
 */
function Timeline({ fx, events, sec }: { fx: MatchView["fixture"]; events: MatchEvent[]; sec: number | null }) {
  const st = fx.st;
  const et = (!!st && (ET_PHASES.has(st.ph) || (st.ph === "finished" && (st.by === "aet" || st.by === "pens")))) || events.some((e) => e.min > 90 && !!MARKS[e.t]);
  const total = et ? 120 : 90;
  const minute = !st ? 0 : st.ph === "finished" || st.ph === "shootout" || st.ph === "et_break" ? (st.ph === "et_break" ? 90 : total) : sec == null ? 0 : Math.min(total, sec / 60);
  const marks = events.filter((e) => MARKS[e.t]).map((e) => ({ e, kind: MARKS[e.t], pct: (Math.min(Math.max(e.min, 0), total) / total) * 100 }));
  const team = (s: Side | null | undefined) => (s === "home" ? fx.home.abbreviation : s === "away" ? fx.away.abbreviation : "");
  const describe = marks.map(({ e, kind }) => `${MARK_NAME[kind]} ${team(e.side)} ${minuteLabel(e.min)}`.replace("  ", " "));
  const ticks = et ? [45, 90, 105] : [45];
  return (
    <div
      className="match-timeline relative h-5 min-w-0 flex-1"
      role="img"
      aria-label={`Match timeline, ${total} minutes${st ? `, now ${Math.floor(minute)}′` : ""}: ${describe.join(", ") || "no goals or cards yet"}`}
      data-testid="timeline"
      data-total={total}
    >
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-panel-2 ring-1 ring-line">
        {et ? <div className="absolute inset-y-0 right-0 bg-magenta/20" style={{ left: "75%" }} data-testid="timeline-et" /> : null}
        <div className="absolute inset-0 origin-left bg-cyan/55" style={{ transform: `scaleX(${(minute / total).toFixed(4)})` }} data-testid="timeline-progress" data-minute={Math.floor(minute)} />
      </div>
      {ticks.map((m) => (
        <span key={m} aria-hidden className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-muted/50" style={{ left: `${(m / total) * 100}%` }} />
      ))}
      {st ? (
        <span aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: `translateX(${((minute / total) * 100).toFixed(3)}%)` }}>
          <span className="absolute left-0 top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow" data-testid="timeline-now" />
        </span>
      ) : null}
      {marks.map(({ e, kind, pct }) => (
        <span
          key={e.seq}
          className={`absolute -translate-x-1/2 ${e.side === "away" ? "bottom-0" : "top-0"} ${kind === "goal" ? "h-2 w-2 rounded-full border border-ink bg-white" : `h-2 w-1.5 rounded-[1px] ${kind === "red" ? "bg-[#ff3344]" : "bg-[#ffd400]"}`}`}
          style={{ left: `${pct}%` }}
          title={`${MARK_NAME[kind]} · ${team(e.side)} · ${minuteLabel(e.min)}`}
          data-testid="timeline-mark"
          data-kind={kind}
          data-side={e.side ?? undefined}
          data-min={e.min}
        />
      ))}
    </div>
  );
}

function ShootoutBoard({ view, events }: { view: MatchView; events: MatchEvent[] }) {
  const fx = view.fixture;
  const so = fx.st?.so;
  const lastSetup = [...events].reverse().find((e) => e.t === "shootout_setup" || e.t === "shootout_kick" || e.t === "shootout_end");
  if (!so) {
    return (
      <section className="panel border-magenta/40 p-3" data-testid="shootout">
        <h2 className="font-display text-lg text-magenta">Penalty shootout</h2>
        <p className="text-sm text-muted">The teams are preparing…</p>
      </section>
    );
  }
  const rows: Array<{ side: Side; team: typeof fx.home; kicks: string[] }> = [
    { side: "home", team: fx.home, kicks: so.k.filter((k) => k[0] === 0).map((k) => k[1]) },
    { side: "away", team: fx.away, kicks: so.k.filter((k) => k[0] === 1).map((k) => k[1]) },
  ];
  const pending = lastSetup?.t === "shootout_setup" ? lastSetup : null;
  const done = fx.st?.ph === "finished" || lastSetup?.t === "shootout_end";
  const winner = done ? (so.h > so.a ? fx.home : fx.away) : null;
  return (
    <section className="panel border-magenta/40 p-3" data-testid="shootout">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg text-magenta">Penalty shootout</h2>
        <span className="text-3xl font-bold tabular" data-testid="shootout-total">
          {so.h} – {so.a}
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const slots = Math.max(5, so.th, so.ta);
          return (
            <div key={r.side} className="flex items-center gap-2">
              <span className="w-12 shrink-0">
                <Abbr team={r.team} away={r.side === "away"} />
              </span>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: slots }, (_, i) => {
                  const k = r.kicks[i];
                  const now = pending && pending.side === r.side && i === r.kicks.length;
                  return (
                    <span
                      key={i}
                      className={`grid h-6 w-6 place-items-center rounded-full border text-xs font-bold ${
                        k === "goal" ? "border-lime bg-lime text-ink" : k ? "border-live bg-live/80 text-white" : now ? "border-amber text-amber" : "border-line text-muted"
                      } ${i >= 5 ? "ring-1 ring-magenta/50" : ""}`}
                      title={k ? (k === "goal" ? "Scored" : k === "save" ? "Saved" : k === "woodwork" ? "Hit the woodwork" : "Missed") : now ? "Taking now" : "To come"}
                    >
                      {k === "goal" ? "✓" : k ? "✕" : now ? "●" : ""}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-sm" aria-live="polite">
        {winner ? (
          <b className="text-lime">
            {winner.name} win the shootout {Math.max(so.h, so.a)}–{Math.min(so.h, so.a)}!
          </b>
        ) : pending ? (
          <>
            <b>{pending.p}</b> ({(pending.side === "home" ? fx.home : fx.away).abbreviation}) is taking kick {pending.kick?.no}
            {pending.kick?.sd ? <span className="chip chip-magenta ml-2">Sudden death</span> : null}
            {pending.kick?.win ? <span className="ml-2 text-lime">— score to win it</span> : pending.kick?.must ? <span className="ml-2 text-amber">— must score</span> : null}
          </>
        ) : so.next ? (
          <>
            Next: <b>{(so.next === "home" ? fx.home : fx.away).name}</b>
            {so.sd ? <span className="chip chip-magenta ml-2">Sudden death</span> : null}
          </>
        ) : null}
      </p>
      <p className="mt-1 text-[11px] text-muted">Shootout goals are separate from the match score.</p>
    </section>
  );
}

function Stats({ st, view }: { st: PubState | null; view: MatchView }) {
  if (!st) return <p className="text-sm text-muted">Statistics appear at kick-off.</p>;
  const fx = view.fixture;
  const published = st.clk?.s;
  const earlyPossession = (st.ph === "pre" || st.ph === "first_half") && typeof published === "number" && Number.isFinite(published) && published < 60;
  return (
    <div className="space-y-1.5 text-sm" data-testid="stats">
      <div className="flex justify-between text-xs font-bold">
        <Abbr team={fx.home} />
        <span className="text-muted">Possession</span>
        <Abbr team={fx.away} away />
      </div>
      {/* #207: "First minute" holds the bar's own height, so the bar's arrival never moves the rows below. */}
      {earlyPossession ? (
        <p className="flex h-[26px] items-center text-xs text-muted">First minute</p>
      ) : (
        <>
          <div className="h-[26px]">
          <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
            <div style={{ width: `${st.pos}%`, background: fx.home.primary_color }} />
            <div style={{ width: `${100 - st.pos}%`, background: "#f4f7ff" }} />
          </div>
          <div className="mt-0.5 flex justify-between tabular text-xs text-muted">
            <span>{st.pos}%</span>
            <span>{100 - st.pos}%</span>
          </div>
          </div>
        </>
      )}
      {STAT_ROWS.map(([label, i]) => (
        <div key={label} className="grid grid-cols-[2rem_1fr_2rem] items-center text-center tabular">
          <span className="font-bold">{st.x[0][i]}</span>
          <span className="text-xs text-muted">{label}</span>
          <span className="font-bold">{st.x[1][i]}</span>
        </div>
      ))}
    </div>
  );
}

const FEED_TYPES = new Set([
  "kickoff",
  "goal",
  "penalty_goal",
  "penalty_awarded",
  "penalty_saved",
  "penalty_missed",
  "penalty_woodwork",
  "save",
  "woodwork",
  "miss",
  "block",
  "shot",
  "yellow_card",
  "red_card",
  "half_time",
  "second_half",
  "end_of_normal_time",
  "extra_time",
  "et_half_time",
  "et_second_half",
  "shootout_start",
  "shootout_kick",
  "shootout_end",
  "match_end",
  "coaching",
]);
const REPLAYABLE = new Set(["goal", "penalty_goal", "save", "woodwork", "miss", "block", "penalty_saved", "penalty_missed", "penalty_woodwork", "shootout_kick"]);

function EventFeed({ events, view, onReplay }: { events: MatchEvent[]; view: MatchView; onReplay: (e: MatchEvent) => void }) {
  const list = feedRows(events, (e) => FEED_TYPES.has(e.t)).reverse();
  if (!list.length) return <p className="text-sm text-muted">{view.fixture.status === "scheduled" ? "Not kicked off yet. Goals, cards, chances and every key moment will be listed here from kick-off." : "Waiting for the first action…"}</p>;
  return (
    <ol className="space-y-1 text-sm" data-testid="event-feed">
      {list.map(({ e, lead, text }) => {
        // A merged row is the attacking side's: a save or block is the defenders' event, but the attack was the shooter's.
        const sideKey = lead.side;
        const side = sideKey === "home" ? view.fixture.home : sideKey === "away" ? view.fixture.away : null;
        const big = e.t === "goal" || e.t === "penalty_goal" || e.t === "red_card" || e.t === "match_end" || e.t === "shootout_end";
        return (
          <li key={e.seq} className={`flex items-start gap-2 rounded px-1 py-0.5 ${big ? "bg-lime/10" : ""}`}>
            <span className="w-11 shrink-0 tabular text-xs text-muted" data-testid="event-time" title={eventClockTime(e) || undefined}>{eventTime(e)}</span>
            {side ? <Abbr team={side} away={sideKey === "away"} /> : <span className="w-[2.6rem] shrink-0" />}
            <span className={`min-w-0 flex-1 ${big ? "font-bold" : ""}`}>
              {/* #206: cards are marked on the match's timeline (this feed) with the card itself */}
              {e.t === "yellow_card" || e.t === "red_card" ? <span className={`mr-1.5 inline-block h-3.5 w-2.5 rounded-[2px] align-[-0.15em] ${e.t === "red_card" ? "bg-[#ff3344]" : "bg-[#ffd400]"}`} data-testid="feed-card" data-card={e.t === "red_card" ? "red" : "yellow"} aria-label={e.t === "red_card" ? "Red card" : "Yellow card"} role="img" /> : null}
              {text}
            </span>
            {REPLAYABLE.has(e.t) ? (
              <button type="button" className="shrink-0 text-xs text-cyan hover:underline" onClick={() => onReplay(e)} aria-label={`Replay: ${e.text}`}>
                ▶ Replay
              </button>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

type CommandStance = "defend" | "balanced" | "attack";
type AcceptedCommand = { stance: CommandStance; fromMinute: number; used: number; max: number };

function commandStance(s: string): CommandStance | null {
  return s === "defend" || s === "balanced" || s === "attack" ? s : null;
}

function stanceLabel(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function Coaching({ view, onDone }: { view: MatchView; onDone: () => void }) {
  const c = view.coach!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [accepted, setAccepted] = useState<AcceptedCommand | null>(null);
  const now = useNow(1000);
  // The accepted response is the usage truth until a snapshot has used at least that many.
  // A failed refresh never arrives; a stale one must not put the spent command back.
  const caughtUp = !accepted || c.used >= accepted.used;
  const used = caughtUp ? c.used : accepted.used;
  const max = caughtUp ? c.max : accepted.max;
  const left = max - used;
  const cooling = c.cooldownUntil > now;
  const ph = view.fixture.st?.ph;
  const open = ph && phaseInfo(view.fixture.st).live && ph !== "shootout";
  const queued = !caughtUp ? accepted.stance : c.pending ? commandStance(c.stance) : null;
  const active = caughtUp && !c.pending ? commandStance(c.stance) : null;
  // fromMinute belongs to the accepted command. A later snapshot can queue the same stance at a higher used count.
  const queuedMinute = accepted && queued === accepted.stance && (!caughtUp || c.used === accepted.used) ? accepted.fromMinute : null;
  const instruction = queued
    ? `Queued: ${stanceLabel(queued)}${queuedMinute == null ? "" : ` from ${minuteLabel(queuedMinute)}`}.`
    : active
      ? `Active: ${stanceLabel(active)}.`
      : "";
  async function send(s: CommandStance) {
    setBusy(true);
    setNote(null);
    try {
      const r = await footfiveApi.coaching(view.fixture.id, s);
      if (!r.ok) throw new Error("Command failed");
      const stance = commandStance(r.stance) ?? s;
      setAccepted({ stance, fromMinute: r.fromMinute, used: r.used, max: r.max });
      setNote({ tone: "ok", text: `${stanceLabel(stance)} accepted from ${minuteLabel(r.fromMinute)}.` });
      onDone();
    } catch (err) {
      setNote({ tone: "err", text: err instanceof Error ? err.message : "Command failed" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel border-cyan/40 p-3" data-testid="coaching">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="panel-title">Live coaching</h2>
        <span className="min-w-0 text-xs text-muted tabular">
          {left}/{max} coaching commands left this match
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        These commands are for this match only and are separate from Command Charge on My Team.
      </p>
      {c.ai ? (
        <p className="mt-2 text-sm text-muted">
          Your team is on Full AI. Switch to My settings in{" "}
          <Link to="/my-team" className="text-cyan underline">
            My Team
          </Link>{" "}
          to coach live.
        </p>
      ) : (
        <>
          {note?.tone === "ok" ? (
            <p className="mt-1 text-sm text-cyan" role="status" aria-live="polite" data-testid="coaching-feedback">
              {note.text}
            </p>
          ) : null}
          {note?.tone === "err" ? (
            <p className="mt-1 text-sm text-amber" role="alert" data-testid="coaching-feedback">
              {note.text}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted" data-testid="coaching-hint">
            Attack opens up chances at both ends; Defend slows chances at both ends.
          </p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {(["defend", "balanced", "attack"] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={`btn-ghost !min-h-10 !px-1 text-xs ${active === s ? "!border-cyan !bg-cyan/20 text-cyan" : ""}`}
                disabled={busy || !open || left <= 0 || cooling || active === s || queued === s}
                onClick={() => send(s)}
                aria-pressed={active === s}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted" data-testid="coaching-state">
            {instruction ? `${instruction} ` : ""}
            {cooling ? `Coaching cooldown: ${countdown(c.cooldownUntil - now)}. ` : ""}Commands affect future play only.
          </p>
        </>
      )}
    </section>
  );
}

/** `sentOff` is the live playhead's set (cards as the lagged pitch has shown them), so the strike-through never beats the pitch — and a replay of older play never lifts it. */
function Lineups({ view, sentOff: off }: { view: MatchView; sentOff: Set<string> }) {
  const fx = view.fixture;
  return (
    <section className="panel p-3" data-testid="lineups">
      <h2 className="panel-title mb-2">Line-ups</h2>
      <div className="grid grid-cols-2 gap-3 text-sm">
        {(["home", "away"] as const).map((side) => {
          const t = side === "home" ? fx.home : fx.away;
          const list = (view.lineups?.[side] || []).filter((p) => p.starter);
          return (
            <div key={side}>
              <div className="mb-1">
                <Abbr team={t} away={side === "away"} />
              </div>
              <ul className="space-y-0.5">
                {list.map((p) => (
                  <li key={p.name} className={`truncate ${off.has(side + ":" + p.name) ? "text-live line-through" : ""}`}>
                    <span className="tabular text-muted">{p.no}</span> {p.name}
                    {p.role === "gk" ? <span className="text-muted"> (GK)</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
