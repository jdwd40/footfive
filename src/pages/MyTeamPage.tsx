import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { Kit, TeamLabel } from "../components/Team";
import { countdown, credits, ukTime, useNow } from "../lib/live";
import { footfiveApi, type TeamPublic, type WorldSnapshot } from "../lib/pocketbase";

type Squad = Awaited<ReturnType<typeof footfiveApi.myTeam>>;
type Player = Squad["players"][number];
type Stance = "defend" | "balanced" | "attack";

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
  const now = useNow(1000);

  const load = useCallback(async () => {
    const [s, c, f] = await Promise.all([footfiveApi.myTeam(), footfiveApi.commandCharge(), footfiveApi.teamFinances().catch(() => ({ treasury: 0, entries: [] }))]);
    setSq(s);
    setCc(c);
    setFin(f.entries.slice(0, 8));
  }, []);
  useEffect(() => {
    load().catch((err) => setMsg({ ok: false, text: err instanceof Error ? err.message : "Load failed" }));
  }, [load]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ ok: true, text: ok });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Action failed" });
    } finally {
      setBusy(false);
    }
  }

  if (!sq) return <div className="panel h-48 animate-pulse" />;
  const t = sq.team;
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
            {ai ? <p className="mt-2 text-xs text-amber">Full AI chooses the five each kick-off. Your saved line-up below is kept for when you switch back.</p> : null}
            <ul className="mt-3 space-y-2">
              {sq.players.map((p) => (
                <PlayerRow key={p.id} p={p} starter={starters.includes(p.id)} busy={busy} onToggle={() => toggle(p)} run={run} />
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
              <button type="button" className="btn-ghost !min-h-10 text-[11px]" disabled={busy || cc.points < 1} onClick={() => run(() => footfiveApi.spendCommandCharge("tactical_scan"), "Tactical scan ready.")}>
                Tactical scan (1)
              </button>
              <button type="button" className="btn-ghost !min-h-10 text-[11px]" disabled={busy || cc.points < 2 || t.overclock_ready} onClick={() => run(() => footfiveApi.spendCommandCharge("overclock"), "Overclock armed for your next kick-off.")}>
                Overclock (2)
              </button>
            </div>
            {t.overclock_ready ? <p className="mt-2 text-xs text-lime">Overclock armed for your next kick-off.</p> : null}
          </section>

          <section className="panel p-4">
            <h2 className="panel-title">Garage</h2>
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
  onToggle,
  run,
}: {
  p: Player;
  starter: boolean;
  busy: boolean;
  onToggle: () => void;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const need = Math.min(30, 100 - p.condition);
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
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy} onClick={() => run(() => footfiveApi.upgradePlayer(p.id, "attack"), `${p.name} attack upgraded.`)}>
              ATK +1 ({credits(p.upgrade_cost.attack)})
            </button>
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy} onClick={() => run(() => footfiveApi.upgradePlayer(p.id, "defence"), `${p.name} defence upgraded.`)}>
              DEF +1 ({credits(p.upgrade_cost.defence)})
            </button>
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy || p.energy >= 100} onClick={() => run(() => footfiveApi.useBattery(p.id), `Battery used on ${p.name}.`)}>
              Use battery
            </button>
            <button type="button" className="btn-ghost !min-h-9 !px-1 text-[11px]" disabled={busy || need <= 0} onClick={() => run(() => footfiveApi.repairPlayer(p.id, need), `${p.name} repaired +${need}.`)}>
              Repair +{Math.max(need, 0)}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
