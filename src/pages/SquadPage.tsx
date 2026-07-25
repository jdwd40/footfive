import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Layout from "../components/Layout";
import { footfiveApi } from "../lib/pocketbase";

type Player = {
  id: string;
  name: string;
  role: string;
  attack: number;
  defence: number;
  energy: number;
  condition: number;
  intensity: string;
  is_starter: boolean;
  effective_attack: number;
  effective_defence: number;
  sort_order: number;
};

export default function SquadPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [team, setTeam] = useState<{
    name: string;
    treasury: number;
    battery_count: number;
    overclock_ready?: boolean;
  } | null>(null);
  const [open, setOpen] = useState(true);
  const [cc, setCc] = useState({ points: 0, max: 5, nextPointInMs: 0 });
  const [selected, setSelected] = useState<Player | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [finances, setFinances] = useState<
    Array<{ amount: number; type: string; description: string; created: string }>
  >([]);

  const load = useCallback(async () => {
    const [sq, charge, fin] = await Promise.all([
      footfiveApi.myTeam(),
      footfiveApi.commandCharge(),
      footfiveApi.teamFinances().catch(() => ({ treasury: 0, entries: [] })),
    ]);
    setPlayers(sq.players);
    setTeam(sq.team);
    setOpen(sq.managementOpen);
    setCc(charge);
    setFinances(fin.entries.slice(0, 8));
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, [load]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await fn();
      setMsg(okMsg);
      await load();
      if (selected) {
        const sq = await footfiveApi.myTeam();
        const p = sq.players.find((x) => x.id === selected.id);
        setSelected(p || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleStarter(p: Player) {
    if (!open || busy) return;
    const starters = players.filter((x) => x.is_starter).map((x) => x.id);
    let next: string[];
    if (p.is_starter) {
      next = starters.filter((id) => id !== p.id);
    } else {
      if (starters.length >= 5) {
        setError("Already 5 starters — deselect one first");
        return;
      }
      next = [...starters, p.id];
    }
    if (next.length !== 5) {
      // optimistic local only until 5 selected then save
      setPlayers((prev) =>
        prev.map((x) => ({
          ...x,
          is_starter: next.includes(x.id),
        })),
      );
      setMsg(`Starters selected: ${next.length}/5 — select 5 then Save lineup`);
      return;
    }
    const subs = players.filter((x) => !next.includes(x.id)).map((x) => x.id);
    void run(() => footfiveApi.saveMyLineup(next, subs), "Lineup saved");
  }

  function saveCurrentLineup() {
    const starters = players.filter((x) => x.is_starter).map((x) => x.id);
    if (starters.length !== 5) {
      setError("Need exactly 5 starters");
      return;
    }
    const subs = players.filter((x) => !x.is_starter).map((x) => x.id);
    void run(() => footfiveApi.saveMyLineup(starters, subs), "Lineup saved");
  }

  return (
    <Layout title="Squad">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-xl text-white">{team?.name || "Squad"}</h1>
          <p className="text-xs text-muted">
            Treasury: {team?.treasury ?? "—"} · Batteries: {team?.battery_count ?? 0} ·{" "}
            {open ? (
              <span className="text-lime">Management open</span>
            ) : (
              <span className="text-amber">Locked (live)</span>
            )}
          </p>
        </div>
        <Link to="/dashboard" className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs">
          Dashboard
        </Link>
      </div>

      {/* Command Charge */}
      <section className="glass mb-3 rounded-2xl p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] uppercase tracking-widest text-muted">Command Charge</p>
          <span className="font-display text-cyan">
            {cc.points}/{cc.max}
          </span>
        </div>
        <div className="mb-2 h-2 overflow-hidden rounded-full bg-ink">
          <div
            className="h-full bg-gradient-to-r from-cyan to-magenta transition-all"
            style={{ width: `${(cc.points / Math.max(cc.max, 1)) * 100}%` }}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!open || busy || !selected}
            className="btn-ghost !min-h-10 text-[11px]"
            onClick={() =>
              selected &&
              run(
                () => footfiveApi.spendCommandCharge("rapid_charge", selected.id),
                "Rapid Charge used",
              )
            }
          >
            Rapid Charge (1)
          </button>
          <button
            type="button"
            disabled={!open || busy || !selected}
            className="btn-ghost !min-h-10 text-[11px]"
            onClick={() =>
              selected &&
              run(
                () => footfiveApi.spendCommandCharge("field_repair", selected.id),
                "Field Repair used",
              )
            }
          >
            Field Repair (1)
          </button>
          <button
            type="button"
            disabled={!open || busy}
            className="btn-ghost !min-h-10 text-[11px]"
            onClick={() =>
              run(() => footfiveApi.spendCommandCharge("tactical_scan"), "Tactical Scan ready")
            }
          >
            Tactical Scan (1)
          </button>
          <button
            type="button"
            disabled={!open || busy}
            className="btn-ghost !min-h-10 text-[11px]"
            onClick={() =>
              run(() => footfiveApi.spendCommandCharge("overclock"), "Overclock armed")
            }
          >
            Overclock (2)
          </button>
        </div>
        {team?.overclock_ready ? (
          <p className="mt-2 text-xs text-lime">Overclock ready for next fixture</p>
        ) : null}
      </section>

      {error ? <p className="mb-2 text-sm text-magenta">{error}</p> : null}
      {msg ? <p className="mb-2 text-sm text-lime">{msg}</p> : null}

      <div className="mb-2 flex gap-2">
        <button
          type="button"
          className="btn-primary flex-1 text-xs"
          disabled={!open || busy}
          onClick={saveCurrentLineup}
        >
          Save lineup (5 starters)
        </button>
        <button
          type="button"
          className="btn-ghost flex-1 text-xs"
          disabled={!open || busy}
          onClick={() => run(() => footfiveApi.buyBattery(1), "Battery purchased")}
        >
          Buy battery
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {players.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p)}
            className={`glass rounded-2xl p-3 text-left ${
              selected?.id === p.id ? "ring-2 ring-cyan" : ""
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">
                  {p.name}{" "}
                  <span className="text-xs text-muted uppercase">{p.role}</span>
                </div>
                <div className="text-xs text-muted">
                  ATK {p.attack} (eff {p.effective_attack}) · DEF {p.defence} (eff{" "}
                  {p.effective_defence})
                </div>
              </div>
              <span
                className={`shrink-0 rounded-lg px-2 py-1 text-[10px] font-bold uppercase ${
                  p.is_starter ? "bg-cyan/20 text-cyan" : "bg-white/10 text-muted"
                }`}
              >
                {p.is_starter ? "XI" : "SUB"}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div>
                <div className="text-muted">Energy</div>
                <div className="h-1.5 rounded bg-ink">
                  <div
                    className="h-full rounded bg-lime"
                    style={{ width: `${p.energy}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="text-muted">Condition</div>
                <div className="h-1.5 rounded bg-ink">
                  <div
                    className="h-full rounded bg-amber"
                    style={{ width: `${p.condition}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {(["passive", "balanced", "aggressive"] as const).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  disabled={!open || busy}
                  className={`rounded-lg px-2 py-1 text-[10px] uppercase ${
                    p.intensity === iv
                      ? "bg-magenta/30 text-white"
                      : "bg-white/5 text-muted"
                  }`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void run(
                      () => footfiveApi.setIntensity(p.id, iv),
                      `${p.name} → ${iv}`,
                    );
                  }}
                >
                  {iv}
                </button>
              ))}
              <button
                type="button"
                disabled={!open || busy}
                className="rounded-lg bg-white/5 px-2 py-1 text-[10px] text-cyan"
                onClick={(ev) => {
                  ev.stopPropagation();
                  toggleStarter(p);
                }}
              >
                Toggle XI
              </button>
            </div>
          </button>
        ))}
      </div>

      {selected ? (
        <section className="glass sticky bottom-2 mt-3 rounded-2xl p-3 shadow-lg">
          <p className="mb-2 text-sm font-semibold">{selected.name}</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!open || busy}
              className="btn-ghost !min-h-10 text-xs"
              onClick={() =>
                run(
                  () => footfiveApi.upgradePlayer(selected.id, "attack"),
                  "Attack upgraded",
                )
              }
            >
              Upgrade ATK
            </button>
            <button
              type="button"
              disabled={!open || busy}
              className="btn-ghost !min-h-10 text-xs"
              onClick={() =>
                run(
                  () => footfiveApi.upgradePlayer(selected.id, "defence"),
                  "Defence upgraded",
                )
              }
            >
              Upgrade DEF
            </button>
            <button
              type="button"
              disabled={!open || busy}
              className="btn-ghost !min-h-10 text-xs"
              onClick={() =>
                run(() => footfiveApi.useBattery(selected.id), "Battery used")
              }
            >
              Use battery
            </button>
            <button
              type="button"
              disabled={!open || busy}
              className="btn-ghost !min-h-10 text-xs"
              onClick={() =>
                run(() => footfiveApi.repairPlayer(selected.id, 25), "Repaired +25")
              }
            >
              Repair +25
            </button>
          </div>
        </section>
      ) : null}

      {finances.length ? (
        <section className="mt-4 text-xs text-muted">
          <p className="mb-1 uppercase tracking-widest">Team treasury ledger</p>
          <ul className="space-y-1">
            {finances.map((f, i) => (
              <li key={i} className="flex justify-between gap-2 border-b border-white/5 py-1">
                <span className="truncate">{f.description || f.type}</span>
                <span className={f.amount >= 0 ? "text-lime" : "text-magenta"}>
                  {f.amount >= 0 ? "+" : ""}
                  {f.amount}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Layout>
  );
}
