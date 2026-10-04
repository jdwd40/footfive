import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MatchEvent, MatchView } from "../lib/pocketbase";

const team = (n: string) => ({ id: n, slug: n, name: n, abbreviation: n.slice(0, 3).toUpperCase(), primary_color: "#fff" }) as unknown as MatchView["fixture"]["home"];
const names = (p: string) => Array.from({ length: 5 }, (_, i) => ({ name: `${p} P${i}`, no: i + 1, role: i === 0 ? "gk" : "util", starter: true }));
const st = { ph: "first_half", sc: [0, 0], pos: 50, x: [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]] } as unknown as MatchView["fixture"]["st"];
const ev = (seq: number, at: number, text: string): MatchEvent => ({ seq, at, t: "pass", min: 1, side: "home", p: "Home P3", p2: "Home P4", from: [40, 30], ball: [55, 35], text, st: st! });

function view(events: MatchEvent[], lineups: MatchView["lineups"], serverTimeMs: number): MatchView {
  return {
    serverTimeMs,
    round: { id: "r", key: "r1", label: "Round 1", status: "live" },
    fixture: { id: "fx1", slot: "a", index: 0, home: team("Home"), away: team("Away"), status: "live", kickoffAt: 0, st, seq: 1 } as unknown as MatchView["fixture"],
    events,
    lineups,
    sentOff: [],
    managedSide: null,
    coach: null,
  };
}

vi.mock("../lib/live", async (orig) => ({ ...(await orig<typeof import("../lib/live")>()), useLive: () => ({ live: null }), useNow: () => Date.now() }));
// jsdom's opaque origin has no localStorage.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../components/MarketsPanel", () => ({ default: () => null }));
vi.mock("../lib/pocketbase", async (orig) => {
  const m = await orig<typeof import("../lib/pocketbase")>();
  return { ...m, footfiveApi: { ...m.footfiveApi, match: vi.fn() } };
});

async function mount(v: MatchView) {
  const { footfiveApi } = await import("../lib/pocketbase");
  vi.mocked(footfiveApi.match).mockResolvedValue(v);
  const { default: MatchPage } = await import("./MatchPage");
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/match/fx1"]}>
        <Routes>
          <Route path="/match/:fixtureId" element={<MatchPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe("MatchPage timeline player", () => {
  it("renders 10 players and the commentary of the event under the playhead", async () => {
    const now = Date.now();
    const events = [ev(1, now - 30000, "Older pass"), ev(2, now - 3000, "Current pass"), ev(3, now + 60000, "Future pass")];
    await mount(view(events, { home: names("Home"), away: names("Away") }, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.getAllByTestId("player")).toHaveLength(10);
    expect(screen.getByTestId("commentary").textContent).toBe("Current pass");
  });

  it("renders the pitch with ball only when lineups are missing", async () => {
    const now = Date.now();
    await mount(view([ev(1, now - 3000, "Pass")], null, now));
    expect(screen.getByTestId("pitch")).toBeTruthy();
    expect(screen.queryAllByTestId("player")).toHaveLength(0);
  });
});
