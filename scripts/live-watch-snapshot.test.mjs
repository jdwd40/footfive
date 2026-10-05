import { expect, it } from "vitest";
import { snapshot } from "./live-watch-snapshot.mjs";

it("live-watch snapshots capture the pitch HUD text next to the scoreboard score, so the log can prove they agree", () => {
  document.body.innerHTML = `
    <div data-testid="match-scoreboard"><span data-testid="match-score">1–2</span></div>
    <div data-testid="pitch"><div data-testid="pitch-hud"><span>OUT 1–2 MC2</span><span>87:08</span></div><svg viewBox="0 0 1 1"></svg></div>`;
  const snap = snapshot();
  expect(snap.score).toBe("1–2");
  expect(snap.hud).toBe("OUT 1–2 MC287:08");
});
