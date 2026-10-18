import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { Kit, TeamLabel } from "../components/Team";
import { countdown, credits, ukTime, useNow } from "../lib/live";
import { footfiveApi, type EffectiveModifiers, type ManagementHelp, type TacticalScan, type TacticalScanReport, type TeamPublic, type WorldSnapshot } from "../lib/pocketbase";

type Squad = Awaited<ReturnType<typeof footfiveApi.myTeam>>;
type Player = Squad["players"][number];
type Stance = "defend" | "balanced" | "attack";

function integerCost(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Math.floor(n) === n ? n : fallback;
}

function finitePair(x: { attack: number; defence: number } | undefined): x is { attack: number; defence: number } {
  return !!x && typeof x.attack === "number" && Number.isFinite(x.attack) && typeof x.defence === "number" && Number.isFinite(x.defence);
}

function modifiersFrom(m: EffectiveModifiers | undefined): EffectiveModifiers | null {
  if (!m || !finitePair(m.base) || !finitePair(m.role) || !finitePair(m.intensity)) return null;
  if (![m.energy, m.condition, m.overclock].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return m;
}

function helpFrom(h: ManagementHelp | undefined): ManagementHelp | null {
  if (!h) return null;
  if (![h.overclockBonus, h.overclockEnergyCost, h.overclockChargeCost, h.tacticalScanChargeCost].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return h;
}

/** Display only. Server factors stay exact; this trims binary noise such as 0.7130000000000001. */
function times(n: number): string {
  return `×${Number(n.toFixed(4))}`;
}

type SavedScan = { id: string; fixtureId: string; report: TacticalScanReport; created: string };
type ShownScan = { id: string | null; report: TacticalScanReport; created: string | null };

function snapshotReport(value: unknown): TacticalScanReport | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  return {
    teamName: typeof r.teamName === "string" ? r.teamName : "",
    grade: typeof r.grade === "string" ? r.grade : "",
    approxAttack: typeof r.approxAttack === "number" ? r.approxAttack : Number.NaN,
    approxDefence: typeof r.approxDefence === "number" ? r.approxDefence : Number.NaN,
    energyRange: r.energyRange as TacticalScanReport["energyRange"],
    conditionRange: r.conditionRange as TacticalScanReport["conditionRange"],
    confidence: typeof r.confidence === "string" ? r.confidence : "",
  };
}

function sameReport(a: TacticalScanReport, b: TacticalScanReport): boolean {
  return a.teamName === b.teamName
    && a.grade === b.grade
    && a.approxAttack === b.approxAttack
    && a.approxDefence === b.approxDefence
    && a.confidence === b.confidence
    && JSON.stringify(a.energyRange) === JSON.stringify(b.energyRange)
    && JSON.stringify(a.conditionRange) === JSON.stringify(b.conditionRange);
}

/** Server order, at most the five the GET already limited. Incomplete rows are skipped. */
function savedFrom(data: { scans?: TacticalScan[] } | null): SavedScan[] {
  if (!data || !Array.isArray(data.scans)) return [];
  const out: SavedScan[] = [];
  for (const row of data.scans) {
    const report = snapshotReport(row?.report);
    if (!report || typeof row?.id !== "string") continue;
    out.push({
      id: row.id,
      fixtureId: typeof row.fixtureId === "string" ? row.fixtureId : "",
      report,
      created: typeof row.created === "string" ? row.created : "",
    });
    if (out.length === 5) break;
  }
  return out;
}

function statText(n: number): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "unavailable";
}

/** Reversed or malformed ranges stay unavailable. The client does not swap or clamp them. */
function rangeText(range: unknown): string {
  if (!Array.isArray(range) || range.length !== 2) return "unavailable";
  const [lo, hi] = range;
  if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return "unavailable";
  return `${lo}–${hi}%`;
}

function createdLabel(created: string | null): string | null {
  if (!created) return null;
  const parsed = Date.parse(created.includes("T") ? created : created.replace(" ", "T"));
  if (!Number.isFinite(parsed)) return "time unavailable";
  const d = new Date(parsed);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export default function MyTeamPage() {
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setWorld(await footfiveApi.world());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your team");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout>
      {error ? <p className="panel p-4 text-amber">{error}</p> : null}
      {!world ? <div className="panel h-48 animate-pulse" /> : world.managedTeam ? <Manage world={world} /> : <Claim onClaimed={load} />}
    </Layout>
  );
}

function Claim({ onClaimed }: { onClaimed: () => void }) {
  const [teams, setTeams] = useState<TeamPublic[] | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    footfiveApi
      .teams()
      .then((r) => setTeams(r.teams))
      .catch((err) => setMsg(err instanceof Error ? err.message : "Could not load teams"));
  }, []);
  async function claim(t: TeamPublic) {
    setBusy(t.id);
    setMsg("");
    try {
      await footfiveApi.claimTeam(t.id);
      onClaimed();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Claim failed");
      footfiveApi.teams().then((r) => setTeams(r.teams)).catch(() => {});
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="space-y-3">
      <section className="panel p-4">
        <h1 className="font-display text-xl">Claim a team</h1>
        <p className="mt-1 text-sm text-muted">
          Optional. Pick any team nobody manages. It keeps playing with your settings while you're away — or hand it to Full AI. Managers can't bet on their own team's
          fixtures or on championship futures while they manage a team in that championship.
        </p>
        {msg ? (
          <p className="mt-2 rounded-lg border border-amber/30 bg-amber/10 p-2 text-sm text-amber" role="alert" data-testid="claim-error">
            {msg}
          </p>
        ) : null}
      </section>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="team-list">
        {(teams || []).map((t) => (
          <div key={t.id} className="panel flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <TeamLabel team={t} />
              <p className="mt-0.5 text-xs text-muted">
                Grade {t.grade} · {t.available ? "Available" : `Managed by ${t.managerName || "another player"}`}
              </p>
            </div>
            <button type="button" className="btn-primary !min-h-10 !px-3 text-xs" disabled={!t.available || !!busy} onClick={() => claim(t)} data-testid={`claim-${t.abbreviation}`}>
              {busy === t.id ? "Claiming…" : t.available ? "Claim" : "Taken"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Manage({ world }: { world: WorldSnapshot }) {
  const [sq, setSq] = useState<Squad | null>(null);
  const [cc, setCc] = useState({ points: 0, max: 5, nextPointInMs: 0 });
  const [fin, setFin] = useState<Array<{ amount: number; type: string; description: string }>>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null); // starter ids while editing
  const [savedScans, setSavedScans] = useState<SavedScan[]>([]);
  const [shownScan, setShownScan] = useState<ShownScan | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // Matches a purchase to its saved row. Never rendered.
  const purchaseMatch = useRef<{ fixtureId: string; report: TacticalScanReport } | null>(null);
  const scanGen = useRef(0);
  const now = useNow(1000);

  const load = useCallback(async () => {
    const [s, c, f] = await Promise.all([footfiveApi.myTeam(), footfiveApi.commandCharge(), footfiveApi.teamFinances().catch(() => ({ treasury: 0, entries: [] }))]);
    setSq(s);
    setCc(c);
    setFin(f.entries.slice(0, 8));
    return s;
  }, []);
  useEffect(() => {
    load().catch((err) => setMsg({ ok: false, text: err instanceof Error ? err.message : "Load failed" }));
  }, [load]);

  const refreshScans = useCallback(async () => {
    const token = ++scanGen.current;
    try {
      const data = await footfiveApi.tacticalScans();
      if (token !== scanGen.current) return;
      const list = savedFrom(data);
      setSavedScans(list);
      setScanNote(null);
      setShownScan((cur) => {
        const pending = purchaseMatch.current;
        if (!cur || cur.id || !pending || pending.fixtureId === "") return cur;
        const match = list.find((s) => s.fixtureId === pending.fixtureId && sameReport(s.report, pending.report));
        if (!match) return cur;
        return { id: match.id, report: pending.report, created: match.created || null };
      });
    } catch (err) {
      if (token !== scanGen.current) return;
      setScanNote(err instanceof Error ? err.message : "Could not load saved scans");
    }
  }, []);
  useEffect(() => {
    void refreshScans();
  }, [refreshScans]);

  async function buyScan() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await footfiveApi.spendCommandCharge("tactical_scan");
      const report = snapshotReport(res.report);
      if (!res.ok || !report) throw new Error("Scan did not return a report");
      scanGen.current += 1;
      purchaseMatch.current = { fixtureId: typeof res.fixtureId === "string" ? res.fixtureId : "", report };
      setShownScan({ id: null, report, created: null });
      setScanNote(null);
      try {
        await load();
        setMsg({ ok: true, text: "Tactical scan ready." });
      } catch {
        setMsg({ ok: false, text: "Saved the scan, but the squad could not refresh." });
      }
      // A slow saved-report read must not keep scan, Overclock, battery, or line-up disabled.
      void refreshScans();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  function selectSaved(s: SavedScan) {
    purchaseMatch.current = null;
    setShownScan({ id: s.id, report: s.report, created: s.created || null });
  }

  function clearScan() {
    purchaseMatch.current = null;
    setShownScan(null);
  }

  async function run(fn: () => Promise<unknown>, ok: string | ((reloaded: Squad) => string)) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      const reloaded = await load();
      setMsg({ ok: true, text: typeof ok === "string" ? ok : ok(reloaded) });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  if (!sq) return <div className="panel h-48 animate-pulse" />;
  const t = sq.team;
  // Older servers don't send the battery amount; the copy then names no number.
  const restore = typeof sq.batteryRestore === "number" && Number.isFinite(sq.batteryRestore) && sq.batteryRestore > 0 ? sq.batteryRestore : null;
  const help = helpFrom(sq.managementHelp);
  const scanCost = integerCost(help?.tacticalScanChargeCost, 1);
  const overclockCost = integerCost(help?.overclockChargeCost, 2);
  const overclockBonus = help && help.overclockBonus > 0 ? help.overclockBonus : null;
  const overclockEnergy = help && help.overclockEnergyCost > 0 ? help.overclockEnergyCost : null;
  const ai = t.mode === "ai";
  const next = world.nextFixture;
  const starters = draft || sq.players.filter((p) => p.is_starter).map((p) => p.id);
  // The five must start exactly one goalkeeper; a saved lineup from before this rule can break it.
  const gks = sq.players.filter((p) => p.role === "gk" && starters.includes(p.id)).length;

  function toggle(p: Player) {
    const cur = draft || sq!.players.filter((x) => x.is_starter).map((x) => x.id);
    setDraft(cur.includes(p.id) ? cur.filter((x) => x !== p.id) : cur.length < 5 ? [...cur, p.id] : cur);
  }

  return (
    <div className="space-y-3">
      <section className="panel overflow-hidden" data-testid="my-team">
        <div className="h-1.5" style={{ background: t.primary_color }} />
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted">You manage</p>
            <h1 className="flex items-center gap-2 font-display text-2xl">
              <Kit team={t} size={18} /> {t.name}
            </h1>
            <p className="text-sm text-muted">
              Treasury <b className="text-white tabular">{credits(t.treasury)}</b> · Batteries <b className="text-white">{t.battery_count}</b> · Grade {t.grade}
            </p>
          </div>
          <div className="text-right text-sm">
            {next ? (
              <>
                <p className="text-muted">{next.status === "live" ? "Playing now" : "Next match"}</p>
                <p className="font-semibold">
                  {next.home ? "vs" : "at"} {next.opponent.name}
                </p>
                {next.status === "live" ? (
                  <Link to={`/match/${next.fixtureId}`} className="btn-primary mt-1 !min-h-9 !py-1 text-xs">
                    Watch & coach
                  </Link>
                ) : (
                  <p className="text-xs text-muted tabular">
                    {ukTime(next.kickoffAt)} UK · in {countdown(next.kickoffAt - now)}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted">{t.eliminated ? "Knocked out — back next championship" : "Waiting for the next draw"}</p>
            )}
          </div>
        </div>
      </section>

      {msg ? (
        <p className={`rounded-lg border p-2 text-sm ${msg.ok ? "border-lime/30 bg-lime/10 text-lime" : "border-amber/30 bg-amber/10 text-amber"}`} role="status" data-testid="team-msg">
          {msg.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          <section className="panel p-4">
            <h2 className="panel-title">Management mode</h2>
            <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Management mode">
              {(
                [
                  ["manual", "My settings", "Your line-up and tactics, played automatically — even when you're offline."],
                  ["ai", "Full AI", "AI picks the line-up and in-match tactics and maintains the squad from the team treasury."],
                ] as const
              ).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={t.mode === m}
                  disabled={busy || t.mode === m}
                  onClick={() => run(() => footfiveApi.setMode(m), `${label} on — applies from your next kick-off. Your saved setup is kept.`)}
                  className={`rounded-xl border p-3 text-left ${t.mode === m ? "border-cyan bg-cyan/10" : "border-line hover:border-cyan/40"}`}
                  data-testid={`mode-${m}`}
                >
                  <span className="font-bold">{label}</span>
                  {t.mode === m ? <span className="chip chip-lime ml-2">Active</span> : null}
                  <span className="mt-1 block text-xs text-muted">{hint}</span>
                </button>
              ))}
            </div>
            {ai ? (
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="ai-rules">
                {sq.aiRules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="panel-title">Squad</h2>
              <span className="text-xs text-muted">Five starters (one goalkeeper) and two reserves · {sq.effectNote}</span>
            </div>
            <p className="mt-1 text-xs text-muted" data-testid="reserves-note">
              Reserves are kept for future starting line-ups. In-match substitutions are not active.
            </p>
            {ai ? <p className="mt-2 text-xs text-amber">Full AI chooses the five each kick-off. Your saved line-up below is kept for when you switch back.</p> : null}
            <ul className="mt-3 space-y-2">
              {sq.players.map((p) => (
                <PlayerRow key={p.id} p={p} starter={starters.includes(p.id)} busy={busy} batteries={t.battery_count} restore={restore} onToggle={() => toggle(p)} run={run} />
              ))}
            </ul>
            {draft ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || draft.length !== 5 || gks !== 1}
                  onClick={() =>
                    run(
                      () =>
                        footfiveApi.saveMyLineup(
                          draft,
                          sq.players.filter((p) => !draft.includes(p.id)).map((p) => p.id),
                        ),
                      "Line-up saved — applies from your next kick-off.",
                    ).then(() => setDraft(null))
                  }
                  data-testid="save-lineup"
                >
                  Save line-up ({draft.length}/5)
                </button>
                <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                {gks === 0 ? <span className="text-sm text-amber">Include a goalkeeper.</span> : null}
                {gks > 1 ? <span className="text-sm text-amber">Only one goalkeeper can start — you have {gks} in your five.</span> : null}
              </div>
            ) : gks !== 1 ? (
              <p className="mt-3 rounded-lg border border-amber/30 bg-amber/10 p-2 text-sm text-amber" role="alert" data-testid="lineup-gk-warning">
                Your saved line-up has {gks || "no"} goalkeepers, but the five must start exactly one. Tap Starter or Reserve to fix it, then save.
              </p>
            ) : null}
          </section>
        </div>

        <aside className="space-y-3">
          <section className="panel p-4">
            <h2 className="panel-title">Kick-off tactics</h2>
            <p className="mt-1 text-xs text-muted">How your team starts each match in My settings. In a live match you can change it from the touchline (limited commands).</p>
            <p className="mt-1 text-xs text-muted" data-testid="stance-hint">
              Attack opens up chances at both ends — useful when chasing a game. Defend slows chances at both ends — useful protecting a lead. Balanced is neutral.
            </p>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(["defend", "balanced", "attack"] as Stance[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn-ghost !min-h-10 !px-1 text-xs ${t.default_stance === s ? "!border-cyan !bg-cyan/20 text-cyan" : ""}`}
                  aria-pressed={t.default_stance === s}
                  disabled={busy || ai || t.default_stance === s}
                  onClick={() => run(() => footfiveApi.setDefaultStance(s), `${s[0].toUpperCase() + s.slice(1)} from your next kick-off.`)}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section className="panel p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="panel-title">Command Charge</h2>
              <span className="text-lg font-bold tabular text-cyan">
                {cc.points}/{cc.max}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink">
              <div className="h-full bg-gradient-to-r from-cyan to-magenta" style={{ width: `${(cc.points / Math.max(cc.max, 1)) * 100}%` }} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <button type="button" className="btn-ghost !min-h-10 text-[11px]" disabled={busy || cc.points < scanCost} onClick={() => void buyScan()}>
                Tactical scan ({scanCost})
              </button>
              <button type="button" className="btn-ghost !min-h-10 text-[11px]" disabled={busy || cc.points < overclockCost || t.overclock_ready} onClick={() => run(() => footfiveApi.spendCommandCharge("overclock"), "Overclock armed for your next kick-off.")}>
                Overclock ({overclockCost})
              </button>
            </div>
            {t.overclock_ready ? <p className="mt-2 text-xs text-lime">Overclock armed for your next kick-off.</p> : null}
            <details className="mt-2 text-xs text-muted" data-testid="charge-help">
              <summary className="cursor-pointer select-none">What do these do?</summary>
              <p className="mt-1" data-testid="scan-help">
                Tactical scan ({scanCost} Charge): an approximate report on your next opponent — team strength and their starters&apos; energy and condition. It gives your team no boost.
              </p>
              <p className="mt-1" data-testid="overclock-help">
                Overclock ({overclockCost} Charge): for your next fixture only,{" "}
                {overclockBonus != null ? `effective ATK/DEF ×${overclockBonus} (+${Number(((overclockBonus - 1) * 100).toFixed(1))}%)` : "a boost to effective ATK/DEF"}. At that kick-off each of the five who actually start pays {overclockEnergy != null ? `${overclockEnergy} energy` : "an energy cost"}. Arming does not spend that energy, and it does not change a match already being played.
              </p>
            </details>
            <div className="mt-2 text-xs" data-testid="scan-reports">
              <h3 className="font-semibold text-white">Tactical scans</h3>
              {shownScan ? (
                <div data-testid="scan-report" className="mt-1 rounded-lg border border-line p-2">
                  <p className="font-semibold text-white">
                    {shownScan.report.teamName || "Opponent unavailable"}{" "}
                    <span className="font-normal text-muted">Grade {shownScan.report.grade || "unavailable"}</span>
                  </p>
                  <p>
                    Approx attack {statText(shownScan.report.approxAttack)} · Approx defence {statText(shownScan.report.approxDefence)}
                  </p>
                  <p>
                    Energy {rangeText(shownScan.report.energyRange)} · Condition {rangeText(shownScan.report.conditionRange)}
                  </p>
                  <p>
                    Confidence {shownScan.report.confidence || "unavailable"}
                    {createdLabel(shownScan.created) ? ` · ${createdLabel(shownScan.created)}` : ""}
                  </p>
                  <p className="text-muted">Reports are snapshots taken at purchase and do not update live.</p>
                  <button type="button" className="btn-ghost mt-1 !min-h-9 text-[11px]" onClick={clearScan}>
                    Hide report
                  </button>
                </div>
              ) : null}
              {savedScans.length > 0 ? (
                <ul data-testid="scan-list" className="mt-2 space-y-1">
                  {savedScans.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-pressed={shownScan?.id === s.id}
                        className={`btn-ghost !min-h-9 w-full text-left text-[11px] ${shownScan?.id === s.id ? "!border-cyan text-cyan" : ""}`}
                        onClick={() => selectSaved(s)}
                      >
                        {s.report.teamName || "Opponent unavailable"} · Grade {s.report.grade || "unavailable"}
                        {createdLabel(s.created) ? ` · ${createdLabel(s.created)}` : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {!shownScan && savedScans.length === 0 && !scanNote ? <p data-testid="scan-empty">No saved tactical scans.</p> : null}
              {scanNote ? (
                <p data-testid="scan-error" role="alert" className="mt-2 text-amber">
                  {scanNote}{" "}
                  <button type="button" className="btn-ghost !min-h-9 text-[11px]" onClick={() => void refreshScans()}>
                    Retry
                  </button>
                </p>
              ) : null}
            </div>
          </section>

          <section className="panel p-4">
            <h2 className="panel-title">Garage</h2>
            <p className="mt-1 text-xs text-muted" data-testid="battery-note">
              Each battery adds {restore ? `up to ${restore}` : "some"} energy to one player, capped at 100%.
            </p>
            <p className="mt-1 text-xs text-muted">
              Battery {credits(sq.batteryCost)} · repairs {sq.repairCostPerPoint}/point · from the team treasury, never your betting wallet.
            </p>
            <button type="button" className="btn-ghost mt-2 w-full !min-h-10 text-xs" disabled={busy || t.treasury < sq.batteryCost} onClick={() => run(() => footfiveApi.buyBattery(1), "Battery bought.")}>
              Buy battery ({credits(sq.batteryCost)})
            </button>
            {fin.length ? (
              <ul className="mt-3 space-y-1 text-xs">
                {fin.map((f, i) => (
                  <li key={i} className="flex justify-between gap-2 border-b border-line/60 py-1">
                    <span className="truncate text-muted">{f.description || f.type}</span>
                    <span className={`tabular ${f.amount >= 0 ? "text-lime" : "text-magenta"}`}>
                      {f.amount >= 0 ? "+" : ""}
                      {credits(f.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </aside>
      </div>
    </div>
  );
}

function StatHelp({ p }: { p: Player }) {
  const mods = modifiersFrom(p.effective_modifiers);
  const rows: Array<[string, string, string]> = mods
    ? [
        ["Base", String(mods.base.attack), String(mods.base.defence)],
        [`Role (${(p.role || "util").toUpperCase()})`, times(mods.role.attack), times(mods.role.defence)],
        [`Intensity (${p.intensity})`, times(mods.intensity.attack), times(mods.intensity.defence)],
        [`Energy ${p.energy}%`, times(mods.energy), times(mods.energy)],
        [`Condition ${p.condition}%`, times(mods.condition), times(mods.condition)],
        [mods.overclock === 1 ? "Overclock (not armed)" : "Overclock (armed)", times(mods.overclock), times(mods.overclock)],
      ]
    : [];
  return (
    <details className="text-xs text-muted" data-testid="stat-help">
      <summary className="cursor-pointer select-none">Why these numbers?</summary>
      {mods ? (
        <table className="mt-1 w-full tabular" data-testid="stat-breakdown" aria-label={`${p.name} effective stats breakdown`}>
          <thead>
            <tr>
              <th scope="col" className="text-left font-normal">Factor</th>
              <th scope="col" className="text-right font-normal">ATK</th>
              <th scope="col" className="text-right font-normal">DEF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, atk, def]) => (
              <tr key={label}>
                <th scope="row" className="text-left font-normal">{label}</th>
                <td className="text-right">{atk}</td>
                <td className="text-right">{def}</td>
              </tr>
            ))}
            <tr className="font-semibold text-white">
              <th scope="row" className="text-left">Effective (rounded)</th>
              <td className="text-right">{p.effective_attack}</td>
              <td className="text-right">{p.effective_defence}</td>
            </tr>
          </tbody>
        </table>
      ) : null}
      {mods ? <p className="mt-1">Displayed multipliers are rounded to 4 decimal places.</p> : null}
      <p className="mt-1" data-testid="energy-help">
        Energy recovers automatically over time, so effective ATK/DEF can rise without you doing anything. Playing matches uses it up.
      </p>
      <p className="mt-1" data-testid="condition-help">
        Condition is wear from playing. It doesn&apos;t recover on its own — Repair restores it.
      </p>
      {mods && mods.overclock !== 1 ? (
        <p className="mt-1" data-testid="overclock-preview-help">
          This armed preview already includes the Overclock factor. The energy cost is paid at kick-off by the five who actually start, so these energy numbers do not include that debit yet.
        </p>
      ) : null}
      <p className="mt-1" data-testid="estimate-help">
        These are estimates for your squad right now. Kick-off tactics change the match&apos;s chance tempo. These individual ATK/DEF numbers follow role, intensity, energy, condition and Overclock. A match already being played keeps the setup from its own kick-off.
      </p>
    </details>
  );
}

function Bar({ v, cls }: { v: number; cls: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded bg-ink">
      <div className={`h-full ${cls}`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
    </div>
  );
}

function PlayerRow({
  p,
  starter,
  busy,
  batteries,
  restore,
  onToggle,
  run,
}: {
  p: Player;
  starter: boolean;
  busy: boolean;
  batteries: number;
  restore: number | null;
  onToggle: () => void;
  run: (fn: () => Promise<unknown>, ok: string | ((reloaded: Squad) => string)) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const need = Math.min(30, 100 - p.condition);
  // Report the energy the server reloaded, not a client sum, so a near-full player isn't promised the whole amount.
  const batteryUsed = (s: Squad) => {
    const energy = s.players.find((x) => x.id === p.id)?.energy;
    return `Battery used on ${p.name}${restore ? ` (up to +${restore})` : ""}${energy != null ? ` — energy now ${energy}%` : ""}.`;
  };
  // Why the battery button is off, shown under it; lasting reasons first so a moment of busy doesn't flicker over them.
  const batteryOff = p.energy >= 100 ? "Energy is full — no battery needed." : batteries < 1 ? "No batteries in stock — buy one in the Garage." : busy ? "Wait for the current action to finish." : null;
  const batteryOffId = `battery-reason-${p.id}`;
  return (
    <li className={`rounded-xl border p-3 ${starter ? "border-cyan/40 bg-cyan/5" : "border-line"}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`chip ${starter ? "chip-lime" : "chip-muted"} !min-h-8 shrink-0`}
          onClick={onToggle}
          disabled={busy}
          aria-pressed={starter}
          title={starter ? "In the five — tap to rest" : "Reserve — tap to start"}
        >
          {starter ? "Starter" : "Reserve"}
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="font-semibold">{p.name}</span> <span className="text-xs uppercase text-muted">{p.role}</span>
          <span className="block text-xs text-muted tabular">
            ATK {p.attack} · DEF {p.defence} · {p.intensity}
          </span>
        </button>
        <div className="w-24 shrink-0 space-y-1 text-[10px] text-muted">
          <div title={`Energy ${p.energy}%`}>
            <Bar v={p.energy} cls="bg-lime" />
          </div>
          <div title={`Condition ${p.condition}%`}>
            <Bar v={p.condition} cls="bg-amber" />
          </div>
        </div>
      </div>
      {open ? (
        <div className="mt-2 space-y-2 border-t border-line pt-2">
          <p className="text-xs text-muted">
            Energy {p.energy}% · condition {p.condition}% · effective ATK {p.effective_attack} / DEF {p.effective_defence}
          </p>
          <p className="text-xs text-muted" data-testid="effective-hint">
            Effective ATK/DEF is the base stat adjusted for role, intensity, energy and condition (and Overclock when armed).
          </p>
          <StatHelp p={p} />
          <div className="flex flex-wrap gap-1">
            {(["passive", "balanced", "aggressive"] as const).map((iv) => (
              <button
                key={iv}
                type="button"
                className={`chip ${p.intensity === iv ? "chip-magenta" : "chip-muted"}`}
                disabled={busy || p.intensity === iv}
                onClick={() => run(() => footfiveApi.setIntensity(p.id, iv), `${p.name}: ${iv} from the next kick-off.`)}
              >
                {iv}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted" data-testid="intensity-hint">
            Aggressive presses harder now but wears energy and condition faster. Passive saves fitness but gives up some immediate performance.
          </p>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy} onClick={() => run(() => footfiveApi.upgradePlayer(p.id, "attack"), `${p.name} attack upgraded.`)}>
              ATK +1 ({credits(p.upgrade_cost.attack)})
            </button>
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy} onClick={() => run(() => footfiveApi.upgradePlayer(p.id, "defence"), `${p.name} defence upgraded.`)}>
              DEF +1 ({credits(p.upgrade_cost.defence)})
            </button>
            <button
              type="button"
              className="btn-ghost !min-h-9 !px-1 text-[11px]"
              disabled={batteryOff !== null}
              aria-describedby={batteryOff ? batteryOffId : undefined}
              onClick={() => run(() => footfiveApi.useBattery(p.id), batteryUsed)}
            >
              {restore ? `Battery (up to +${restore})` : "Use battery"}
            </button>
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy || need <= 0} onClick={() => run(() => footfiveApi.repairPlayer(p.id, need), `${p.name} repaired +${need}.`)}>
              Repair +{Math.max(need, 0)}
            </button>
          </div>
          {batteryOff ? (
            <p id={batteryOffId} className="text-xs text-muted" data-testid="battery-reason">
              {batteryOff}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
