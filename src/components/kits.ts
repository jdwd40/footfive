/** #204 pitch kits: pure colour logic for the shirts drawn by Pitch (presentation only). */
import type { TeamPublic } from "../lib/pocketbase";

const rgb = (hex: string): [number, number, number] => {
  const h = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim())?.[1] ?? "000000";
  const f = h.length === 3 ? h.replace(/./g, "$&$&") : h;
  const n = parseInt(f, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** Number colour from the kit fill: dark text on light kits, white on dark (relative luminance, one threshold). */
export function textOn(hex: string): string {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#0b1404" : "#fff";
}
/** "Redmean" colour distance: a cheap perceptual approximation (0 … ~765). */
export function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}
/** Below this distance two shirts read as the same team at a glance (e.g. #ff453a vs #b23a31 ≈ 132; #2f5bff vs #5856d6 ≈ 92). */
export const CLASH = 150;
const WHITE = "#f4f7ff";
const DARK = "#15181f";
/** Keeper shirts, in order of preference: lime (the old keeper colour), then orange, violet and teal. */
const GK_SHIRTS = ["#c6ff00", "#ff8c1a", "#b388ff", "#2ee6a6"];
export type Kit = { body: string; sleeves: string; trim: string; num: string };
/**
 * #204 kits, from each team's `primary_color` (fallbacks as before) and the away `secondary_color`.
 * Home: the team colour. Away keeps the house convention (scoreboard and tickers draw it the same way): a white shirt with
 * team-colour sleeves and collar. Clash rule: if the away body is within CLASH of the home body, the away side changes to the
 * first of team-colour shirt with white trim, its secondary colour, then a dark shirt, whose body is clear of the home one.
 * Keepers wear the first GK_SHIRTS colour clear of both outfield bodies (and the other keeper), with their team's collar.
 */
export function kitsFor(home: Pick<TeamPublic, "primary_color" | "secondary_color">, away: Pick<TeamPublic, "primary_color" | "secondary_color">) {
  const hc = home.primary_color || "#00f0ff";
  const ac = away.primary_color || "#ff2d95";
  const trimOn = (body: string, pref: string) => (colourDistance(body, pref) >= CLASH ? pref : textOn(body) === "#fff" ? WHITE : "#0b1404");
  const kit = (body: string, sleeves: string, trim: string): Kit => ({ body, sleeves, trim, num: textOn(body) });
  const homeKit = kit(hc, hc, trimOn(hc, home.secondary_color || DARK));
  const options = [kit(WHITE, ac, ac), kit(ac, WHITE, WHITE), ...(away.secondary_color ? [kit(away.secondary_color, ac, trimOn(away.secondary_color, ac))] : []), kit(DARK, ac, trimOn(DARK, ac))];
  const awayKit = options.find((k) => colourDistance(k.body, hc) >= CLASH) ?? options.at(-1)!;
  const clear = (c: string, avoid: string[]) => avoid.every((a) => colourDistance(c, a) >= CLASH);
  const homeGk = GK_SHIRTS.find((c) => clear(c, [homeKit.body, awayKit.body])) ?? GK_SHIRTS[0];
  const awayGk = GK_SHIRTS.find((c) => clear(c, [homeKit.body, awayKit.body, homeGk])) ?? GK_SHIRTS[1];
  return {
    home: homeKit,
    away: awayKit,
    homeGk: kit(homeGk, homeGk, trimOn(homeGk, hc)),
    awayGk: kit(awayGk, awayGk, trimOn(awayGk, ac)),
    changed: awayKit !== options[0],
  };
}

