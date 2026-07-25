/** Focus strip for in-match penalty sequences */

export default function PenaltyFocus({
  stage,
  message,
}: {
  stage: string;
  message: string;
}) {
  const label =
    stage === "penalty_scored"
      ? "GOAL"
      : stage === "penalty_saved"
        ? "SAVED"
        : stage === "penalty_missed"
          ? "MISS"
          : stage === "penalty_run_up"
            ? "STRIKE"
            : stage === "penalty_walkup"
              ? "TAKER"
              : "PENALTY";

  return (
    <section
      className="glass relative overflow-hidden rounded-2xl border border-amber/40 p-4"
      style={{
        backgroundImage:
          `linear-gradient(180deg, rgba(7,11,20,0.75), rgba(20,10,5,0.9)), url(${import.meta.env.BASE_URL}assets/penalty-scene.jpg)`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      aria-live="assertive"
    >
      <div className="relative text-center">
        <p className="font-display text-xs tracking-[0.3em] text-amber">{label}</p>
        <p className="mt-2 text-lg font-semibold leading-snug text-white">{message}</p>
      </div>
    </section>
  );
}
