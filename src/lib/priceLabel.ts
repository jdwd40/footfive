/** Visible price copy. The server decides which selections have a number. */

export const NOT_OFFERED = "Not offered";
export const NO_CURRENT_PRICE = "No current price";
export const UNOFFERED_HINT =
  "Very unlikely selections may not be offered. Other prices stay open.";

/** Finite price above zero, or null when the server sent no price. */
export function formatOdds(odds: number | null | undefined): string | null {
  if (typeof odds !== "number" || !Number.isFinite(odds) || odds <= 0) return null;
  return odds.toFixed(2);
}

/** Open market: a null price is unoffered. Other selections can stay priced. */
export function openSelectionLabel(odds: number | null | undefined): string {
  return formatOdds(odds) ?? NOT_OFFERED;
}

/**
 * Whole-market closure, or no odds payload. A null here is not evidence the
 * selection sits below the offer floor.
 */
export function closedSelectionLabel(odds: number | null | undefined): string {
  return formatOdds(odds) ?? NO_CURRENT_PRICE;
}

export function selectionLabel(odds: number | null | undefined, open: boolean): string {
  return open ? openSelectionLabel(odds) : closedSelectionLabel(odds);
}
