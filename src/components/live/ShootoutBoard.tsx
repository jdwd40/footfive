/**
 * Shootout board using authoritative per-kick records from the server.
 */

export type ShootoutKick = {
  kickIndex: number;
  team: "home" | "away";
  kickNumber: number;
  suddenDeath?: boolean;
  player?: string;
  outcome: "goal" | "save" | "miss";
  mustScore?: boolean;
  decisive?: boolean;
  takenHome?: number;
  takenAway?: number;
};

export type KickMark = "pending" | "goal" | "miss" | "current";

function marksFromKicks(
  kicks: ShootoutKick[],
  side: "home" | "away",
  nextSide: "home" | "away" | null,
): KickMark[] {
  const sideKicks = kicks.filter((k) => k.team === side);
  const marks: KickMark[] = sideKicks.map((k) =>
    k.outcome === "goal" ? "goal" : "miss",
  );
  const n = Math.max(5, marks.length + (nextSide === side ? 1 : 0));
  while (marks.length < n) {
    if (marks.length === sideKicks.length && nextSide === side) {
      marks.push("current");
    } else {
      marks.push("pending");
    }
  }
  return marks.slice(0, Math.min(8, n));
}

function KickRow({
  label,
  marks,
  score,
}: {
  label: string;
  marks: KickMark[];
  score: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 shrink-0 truncate text-xs font-semibold sm:w-24">{label}</div>
      <div className="flex flex-1 flex-wrap gap-1" aria-label={`${label} kick markers`}>
        {marks.map((m, i) => (
          <span
            key={i}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md border text-[10px] font-bold ${
              m === "goal"
                ? "border-lime bg-lime/20 text-lime"
                : m === "miss"
                  ? "border-magenta/50 bg-magenta/10 text-magenta"
                  : m === "current"
                    ? "border-cyan bg-cyan/20 text-cyan animate-pulse"
                    : "border-white/15 text-muted"
            }`}
            title={m}
          >
            {m === "goal" ? "●" : m === "miss" ? "×" : m === "current" ? "›" : "·"}
          </span>
        ))}
      </div>
      <div className="font-display w-6 text-right text-lg tabular-nums text-amber">{score}</div>
    </div>
  );
}

export default function ShootoutBoard({
  homeName,
  awayName,
  shootoutHome,
  shootoutAway,
  kicks = [],
  shootoutSide,
  currentMessage,
}: {
  homeName: string;
  awayName: string;
  shootoutHome: number;
  shootoutAway: number;
  kicks?: ShootoutKick[];
  shootoutSide?: "home" | "away" | null;
  suddenDeath?: boolean;
  currentMessage?: string;
}) {
  const anySudden = kicks.some((k) => k.suddenDeath);
  const nextSide = shootoutSide || null;
  const last = kicks[kicks.length - 1];

  return (
    <section
      className="glass rounded-2xl border border-magenta/30 p-3"
      aria-label="Penalty shootout"
    >
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-widest">
        <span className="text-magenta">Penalty shootout</span>
        {anySudden || (last && last.kickNumber > 5) ? (
          <span className="font-bold text-amber">Sudden death</span>
        ) : (
          <span className="text-muted">Best of 5</span>
        )}
      </div>
      <div className="mb-3 text-center font-display text-3xl tabular-nums text-white">
        {shootoutHome}
        <span className="mx-2 text-muted">–</span>
        {shootoutAway}
      </div>
      <div className="space-y-2">
        <KickRow
          label={homeName.split(" ").slice(-1)[0]}
          marks={marksFromKicks(kicks, "home", nextSide)}
          score={shootoutHome}
        />
        <KickRow
          label={awayName.split(" ").slice(-1)[0]}
          marks={marksFromKicks(kicks, "away", nextSide)}
          score={shootoutAway}
        />
      </div>
      {last?.mustScore ? (
        <p className="mt-2 text-center text-xs font-bold uppercase text-amber">Must score</p>
      ) : null}
      {last?.decisive ? (
        <p className="mt-1 text-center text-xs font-bold uppercase text-lime">Decisive kick</p>
      ) : null}
      {currentMessage ? (
        <p className="mt-3 text-center text-sm font-semibold text-white/90" aria-live="polite">
          {currentMessage}
        </p>
      ) : null}
      <p className="mt-2 text-center text-[10px] text-muted">
        Full-time score unchanged during shootout · kicks {kicks.length}
      </p>
    </section>
  );
}
