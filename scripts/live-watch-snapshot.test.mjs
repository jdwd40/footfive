import { expect, it } from "vitest";
import { snapshot } from "./live-watch-snapshot.mjs";

it("live-watch snapshots capture the scoreboard score and clock", () => {
  document.body.innerHTML = `
    <div data-testid="match-scoreboard">
      <span data-testid="match-score">1–2</span>
      <span aria-label="Match clock">87:08</span>
    </div>`;
  const snap = snapshot();
  expect(snap.score).toBe("1–2");
  expect(snap.clock).toBe("87:08");
});
