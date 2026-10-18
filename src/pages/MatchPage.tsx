import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Layout from "../components/Layout";
import Pitch from "../components/Pitch";
import MarketsPanel from "../components/MarketsPanel";
import Ticker from "../components/Ticker";
import { MatchClock, PhaseChip, useChanged } from "../components/FixtureCard";
import { Abbr, TeamLabel } from "../components/Team";
import { sceneFor, type Pt, type Scene } from "../domain/scenes";
import { LINGER_MS, frameAt, playhead, reveal, sentOffAt, settle, smooth, type Frame } from "../domain/sim";
import { clockSeconds, countdown, eventClockTime, eventTime, minuteLabel, noteServerTime, phaseInfo, serverNow, useLive, useNow } from "../lib/live";
import { footfiveApi, type MatchEvent, type MatchView, type PubState, type Side, type TickerItem } from "../lib/pocketbase";
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
    <p className="min-w-0 flex-1 text-base font-semibold" aria-live="polite" data-testid="commentary">
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

/** What the animation loop committed last: server time it ran at, the frame it drew, whether its result may show (`revealed`: the drawn scene — live or replay; `liveRevealed`: the live playhead's), and where the drawn ball was when the current scene began. */
type Anim = { now: number; clock: number /* pitch playhead time: now − LAG_MS, or behind it while fast-forwarding a late batch */; frame: Frame | null; reached: boolean; revealed: boolean; liveSeq: number | null; liveRevealed: boolean; startBall: Pt | null; sentOff: Set<string> /* as drawn: timed cards + seeded history */; liveSentOff: Set<string> /* as the live playhead has shown them: the line-ups' set, untouched by a replay */; wonSeen?: boolean /* WON IT latched for this scene: the drawn ball has reached the winning side */ };

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
  const clockRef = useRef<{ clock: number | null; target: number | null; seq: number | null }>({ clock: null, target: null, seq: null });
  // Display floor for this fixture visit. It outlives a HUD gap and is cleared only when the route fixture changes.
  const clockHold = useRef<{ id: string; sec: number }>({ id: fixtureId, sec: 0 });
  if (clockHold.current.id !== fixtureId) clockHold.current = { id: fixtureId, sec: 0 };
  // Everything time-driven lives in one state written by the animation loop; render only reads it.
  const [anim, setAnim] = useState<Anim>(() => ({ now: serverNow(), clock: serverNow() - LAG_MS, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, sentOff: new Set(), liveSentOff: new Set() }));

  // Reset when switching fixtures.
  useEffect(() => {
    setView(null);
    setEvents([]);
    setReplay(null);
    setError("");
    setLastOk(0);
    setStay(false);
    clockRef.current = { clock: null, target: null, seq: null };
    setAnim({ now: serverNow(), clock: serverNow() - LAG_MS, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, sentOff: new Set(), liveSentOff: new Set() });
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
  const scenes = useMemo(() => {
    const m = new Map<number, Scene>();
    let prev: Pt = [50, 32];
    for (const [i, e] of events.entries()) {
      const s = sceneFor(e, prev, minuteMs, events[i + 1]) ?? idleScene(e, prev); // a cross reads its own already-fetched header
      prev = s.ball[s.ball.length - 1];
      m.set(e.seq, s);
    }
    return m;
  }, [events, minuteMs]);

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
      // Reduced motion: final frame of each event, still ticking per event (same information, no movement).
      // Live p runs past 1 so frameAt can keep routine play moving until the next event (dwell).
      const liveScene = ph ? scenes.get(ph.cur.seq) : null;
      const prevBuilt = ph?.prev && !replay ? scenes.get(ph.prev.seq) : undefined;
      // A pass that arrives after the chip has already expired must not start the 2.5 s tail again.
      const prevScene = prevBuilt && ph?.prev && clock - ph.prev.at < prevBuilt.ms + LINGER_MS ? prevBuilt : undefined;
      const liveP = sysReduced ? 1 : ph && liveScene?.ms ? ph.elapsed / liveScene.ms : 1;
      const scene = replay ? replay.scene : liveScene;
      const p = replay ? (sysReduced ? 1 : Math.min(1, (t0 - replay.startedAt) / replay.scene.ms)) : liveP;
      const elapsed = replay ? t0 - replay.startedAt : ph?.elapsed ?? 0; // real scene time: p holds at 1 under reduced motion and at a replay's end
      setAnim((a) => {
        if (!scene) return { now, clock, frame: null, reached: false, revealed: true, liveSeq: null, liveRevealed: true, startBall: null, sentOff: new Set(), liveSentOff: new Set() };
        const same = a.frame?.seq === scene.seq;
        // Skipped events (suspended tab): the drawn frame is history — snap to the scene's own start rather than chase across the gap.
        const jumped = !!a.frame && !same && Math.abs(scene.seq - a.frame.seq) > 1;
        // A new scene starts where the drawn ball actually is (the previous scene may have dwelt on), not at its authored first keyframe.
        const startBall = same ? a.startBall : jumped ? null : a.frame?.ball ?? null;
        // Red cards count from the events the playhead has shown; the card's own scene only once revealed (last tick's verdict).
        const sentOff = dismissed(same && a.revealed ? scene.seq : scene.seq - 1);
        const target = frameAt(scene, p, lineups, sentOff, sysReduced ? 0 : now, startBall ?? undefined, prevScene, elapsed);
        // A result event that landed late (scene already over) has the drawn ball still travelling: settle puts it on the impact this tick.
        const frame = settle(scene, p, sysReduced ? target : smooth(jumped ? null : a.frame, target, dt), same && a.reached);
        // Result gate is decided here, once, from the ball actually drawn; `reached` carries over within one scene.
        const gate = reveal(scene, p, frame.ball, same && a.reached);
        // The live result has its own gate: during a replay no live ball is drawn, so the live scene's flash moment alone decides.
        const liveRevealed = replay ? !liveScene || reveal(liveScene, liveP, frame.ball, true).revealed : gate.revealed;
        // The line-ups follow the live playhead: a replay of something older than a red card must not un-strike the player.
        const liveSentOff = replay && liveScene ? dismissed(liveRevealed ? liveScene.seq : liveScene.seq - 1) : sentOff;
        // WON IT waits for the drawn ball to be at a player of the winning side, then holds for its window (no flicker as he moves it on).
        const wonSeen = !!frame.won && ((same && !!a.wonSeen) || (frame.lift < 0.05 && frame.players.some((q) => q.side === frame.won && Math.hypot(q.x - frame.ball[0], q.y - frame.ball[1]) <= 1.6)));
        return { now, clock, frame: frame.won && !wonSeen ? { ...frame, won: null } : frame, wonSeen, startBall, sentOff, liveSentOff, ...gate, liveSeq: liveScene?.seq ?? null, liveRevealed };
      });
    };
    step();
    return () => cancelAnimationFrame(id);
  }, [events, scenes, lineups, serverSentOff, replay, sysReduced]);
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
          <div className="panel mt-4 h-72 animate-pulse" data-testid="match-loading" />
        )}
      </Layout>
    );
  }

  const fx = view.fixture;
  const shown: MatchView = { ...view, fixture: { ...fx, st, at: ph?.cur.at ?? fx.at } };
  const clockNow = serverNow();
  // Ignore a render that still holds the previous fixture: that view must not seed the new visit.
  if (fx.id === fixtureId && st && st.ph !== "shootout" && st.ph !== "finished") {
    const raw = clockSeconds(st, shown.fixture.at, clockNow, fx.minuteMs);
    if (raw != null && raw > clockHold.current.sec) clockHold.current.sec = raw;
  }
  const others = (live?.fixtures || []).filter((f) => f.id !== fx.id);
  const current = replay ? null : ph?.cur;
  // The shot is still travelling until the loop says the result is in: keep the previous caption until then.
  const holding = !!(current && !liveRevealed && ph?.prev);
  const presentedSeq = current ? (holding ? ph!.prev!.seq : current.seq) : null;
  const presentedText = holding ? ph!.prev!.text : current?.text ?? null;
  // Events as the playhead has shown them: nothing newer, and the current one only once its result is revealed.
  const seen = ph ? events.filter((e) => e.seq < ph.cur.seq || (liveRevealed && e.seq === ph.cur.seq)) : [];
  const recent: TickerItem[] = seen.filter((e) => e.major).slice(-30).reverse().map((e) => ({
    id: `${fx.id}:${e.seq}`, fixtureId: fx.id, seq: e.seq, at: e.at, t: e.t, side: e.side ?? null, text: e.tick || e.text, min: e.min,
  }));
  const otherTicker = live?.ticker?.filter((i) => i.fixtureId !== fx.id) ?? [];

  return (
    <Layout wide>
      <div className="match-page">
      <div className="mb-2 flex items-center gap-2 overflow-x-auto no-scrollbar" aria-label="Other matches">
        <Link to="/live" className="btn-ghost !min-h-9 shrink-0 !px-3 !py-1 text-xs">
          ← Round
        </Link>
        {others.map((o) => (
          <Link key={o.id} to={`/match/${o.id}`} className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs hover:border-cyan/50">
            <Abbr team={o.home} />
            <span className="tabular font-bold">{o.st ? `${o.st.sc[0]}–${o.st.sc[1]}` : "v"}</span>
            <Abbr team={o.away} away />
          </Link>
        ))}
      </div>
      <Ticker key={fx.id} items={recent} label="Match events" badge="This match" empty="Goals, cards and penalties from this match appear here." />
      {otherTicker.length ? <Ticker items={otherTicker} label="Other matches" badge="Around the grounds" empty="Goals, penalties, red cards and results from the other matches appear here." /> : null}

      <Scoreboard view={shown} now={now} stale={stale} />
      {finished && !stay ? (
        <div className="mt-2 text-center">
          <span className="chip chip-amber tabular" data-testid="auto-return">
            Back to the round in {countdown(finishedAt + RETURN_MS - Date.now())} · tap to stay
          </span>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          <section className="match-pitch-panel panel p-2 sm:p-3">
            {pref === "off" ? (
              <div className="grid h-40 place-items-center text-sm text-muted">Highlights off — commentary only.</div>
            ) : (
              <Pitch frame={frame} home={fx.home} away={fx.away} replay={!!replay} revealed={revealed} hud={st ? <Hud fx={shown.fixture} now={clockNow} minSec={clockHold.current.sec} /> : null} />
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <CommentaryLine
                fixtureId={fx.id}
                replayCaption={replay ? replay.scene.caption : null}
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

          <section className="panel p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="panel-title">Match events</h2>
              <span className="text-xs text-muted">Match minutes</span>
            </div>
            <EventFeed
              events={seen}
              view={view}
              onReplay={(e) => {
                const s = scenes.get(e.seq);
                if (s && s.ms > 0 && pref !== "off") setReplay({ scene: s, startedAt: performance.now() });
              }}
            />
          </section>
        </div>

        <aside className="space-y-3">
          {view.coach ? <Coaching key={fx.id} view={view} onDone={() => void refreshMatch.current?.()} /> : null}
          <section className="panel p-3">
            <h2 className="panel-title mb-2">Statistics</h2>
            <Stats st={st} view={view} />
          </section>
          {!finished ? (
            <section className="panel p-3">
              <h2 className="panel-title mb-2">Bet on this match</h2>
              <MarketsPanel fixtureId={fx.id} seq={fx.seq} fixtureLabel={`${fx.home.abbreviation} v ${fx.away.abbreviation}`} />
            </section>
          ) : null}
          {view.lineups ? <Lineups view={view} sentOff={liveSentOff} /> : null}
        </aside>
      </div>
      </div>
    </Layout>
  );
}

/** Broadcast-style strip on the pitch: score and clock as the lagged pitch shows them, plus the shootout score and who is kicking, so none of it is ever out of view with the play. Reads `shown` state only. */
function Hud({ fx, now, minSec }: { fx: MatchView["fixture"]; now: number; minSec: number }) {
  const st = fx.st!;
  const so = st.so;
  const kicker = st.ph === "shootout" && so?.next ? (so.next === "home" ? fx.home : fx.away) : null;
  return (
    <>
      <span className="tabular" data-testid="hud-score">
        {fx.home.abbreviation} {st.sc[0]}–{st.sc[1]} {fx.away.abbreviation}
      </span>
      {st.ph === "shootout" ? null : <MatchClock fx={fx} now={now} minSec={minSec} />}
      {so ? (
        <span className="text-magenta" data-testid="hud-pens">
          PENS {so.h}–{so.a}
        </span>
      ) : null}
      {kicker ? (
        <span className="rounded-sm bg-white/15 px-1" data-testid="hud-kicker">
          {kicker.abbreviation} to kick
        </span>
      ) : null}
    </>
  );
}

function Scoreboard({ view, now, stale }: { view: MatchView; now: number; stale: boolean }) {
  const fx = view.fixture;
  const st = fx.st;
  const flash = useChanged(st ? st.sc.join("-") : "");
  const finished = st?.ph === "finished";
  const winner: Side | null = finished ? st!.win : null;
  return (
    <section className="panel overflow-hidden" data-testid="match-scoreboard">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs">
        <span className="uppercase tracking-widest text-muted">{view.round.label}</span>
        <div className="flex items-center gap-2">
          {stale ? <span className="chip chip-amber">Reconnecting</span> : null}
          <PhaseChip fx={fx} now={now} />
        </div>
      </div>
      <div className="match-score-row grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-2 sm:gap-4 sm:px-5">
        <TeamLabel team={fx.home} compact className={`text-base sm:text-xl ${winner === "away" ? "opacity-50" : ""}`} align="right" />
        <div className="text-center">
          {st ? (
            <div key={flash} className={`text-4xl font-bold leading-none tabular sm:text-5xl ${flash ? "score-pop" : ""}`} data-testid="match-score">
              {st.sc[0]}
              <span className="mx-1 text-muted">–</span>
              {st.sc[1]}
            </div>
          ) : (
            <div className="font-display text-2xl text-muted">vs</div>
          )}
          {st ? null : <div className="mt-0.5 text-sm text-muted">Kick-off in {countdown(fx.kickoffAt - now)}</div>}
          {st?.so ? (
            <div className="mt-1 text-sm font-bold text-magenta" data-testid="match-shootout-score">
              Pens {st.so.h}–{st.so.a}
            </div>
          ) : null}
        </div>
        <TeamLabel team={fx.away} away compact className={`text-base sm:text-xl ${winner === "home" ? "opacity-50" : ""}`} />
      </div>
      {finished && winner ? (
        <div className="border-t border-lime/30 bg-lime/10 px-3 py-2 text-center text-sm font-bold text-lime" data-testid="final-result">
          {(winner === "home" ? fx.home : fx.away).name} go through
          {st!.by === "pens" && st!.so ? ` — won the shootout ${Math.max(st!.so.h, st!.so.a)}–${Math.min(st!.so.h, st!.so.a)}` : st!.by === "aet" ? " after extra time" : ""}
        </div>
      ) : null}
    </section>
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
      {earlyPossession ? (
        <p className="text-xs text-muted">First minute</p>
      ) : (
        <>
          <div className="flex h-2 overflow-hidden rounded-full bg-panel-2">
            <div style={{ width: `${st.pos}%`, background: fx.home.primary_color }} />
            <div style={{ width: `${100 - st.pos}%`, background: "#f4f7ff" }} />
          </div>
          <div className="flex justify-between tabular text-xs text-muted">
            <span>{st.pos}%</span>
            <span>{100 - st.pos}%</span>
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
  const list = events.filter((e) => FEED_TYPES.has(e.t)).reverse();
  if (!list.length) return <p className="text-sm text-muted">{view.fixture.status === "scheduled" ? "Not kicked off yet. Goals, cards, chances and every key moment will be listed here from kick-off." : "Waiting for the first action…"}</p>;
  return (
    <ol className="max-h-80 space-y-1 overflow-y-auto pr-1 text-sm" data-testid="event-feed">
      {list.map((e) => {
        const side = e.side === "home" ? view.fixture.home : e.side === "away" ? view.fixture.away : null;
        const big = e.t === "goal" || e.t === "penalty_goal" || e.t === "red_card" || e.t === "match_end" || e.t === "shootout_end";
        return (
          <li key={e.seq} className={`flex items-start gap-2 rounded px-1 py-0.5 ${big ? "bg-lime/10" : ""}`}>
            <span className="w-11 shrink-0 tabular text-xs text-muted" data-testid="event-time" title={eventClockTime(e) || undefined}>{eventTime(e)}</span>
            {side ? <Abbr team={side} away={e.side === "away"} /> : <span className="w-[2.6rem] shrink-0" />}
            <span className={`min-w-0 flex-1 ${big ? "font-bold" : ""}`}>{e.text}</span>
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
      <div className="flex items-baseline justify-between">
        <h2 className="panel-title">Touchline</h2>
        <span className="text-xs text-muted tabular">
          {left}/{max} commands left
        </span>
      </div>
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
            {cooling ? `Recharging: ${countdown(c.cooldownUntil - now)}. ` : ""}Commands affect future play only.
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
    <section className="panel p-3">
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
