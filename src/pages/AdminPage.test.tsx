import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { footfiveApi } from "../lib/pocketbase";
import AdminPage from "./AdminPage";

vi.mock("../components/Layout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../lib/pocketbase", () => ({
  footfiveApi: {
    adminOverview: vi.fn(),
    adminUsers: vi.fn(),
    recordsTeams: vi.fn(),
    adminRetention: vi.fn(),
    adminAudit: vi.fn(),
    adminBackfillStatus: vi.fn(),
    adminRecoveryStatus: vi.fn(),
    adminHealth: vi.fn(),
    adminDisableUser: vi.fn(),
    adminDeleteUser: vi.fn(),
    adminEnableUser: vi.fn(),
    adminCredits: vi.fn(),
    adminCreateUser: vi.fn(),
    adminResetPassword: vi.fn(),
  },
}));

type Listed = { users: Array<Record<string, unknown>>; page: number; perPage: number; totalItems: number; hasMore: boolean };

function person(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id}@t.local`,
    display_name: `Name ${id}`,
    role: "user",
    credits: 40,
    disabled: false,
    team: { id: "tm", name: "Neon United" },
    ...extra,
  };
}

function listed(users: Array<Record<string, unknown>>, page: number, totalItems: number, hasMore: boolean): Listed {
  return { users, page, perPage: 200, totalItems, hasMore };
}

beforeEach(() => {
  vi.mocked(footfiveApi.adminUsers).mockReset();
  vi.mocked(footfiveApi.adminOverview).mockResolvedValue({
    users: 1,
    betweenRoundMinutes: 1,
    matchMinuteRealSeconds: 8,
    championshipGapMinutes: 10,
    fixturesWindowMinutes: 5,
  });
  vi.mocked(footfiveApi.recordsTeams).mockResolvedValue({ teams: [] });
  vi.mocked(footfiveApi.adminRetention).mockResolvedValue({});
  vi.mocked(footfiveApi.adminAudit).mockResolvedValue({ entries: [] });
  vi.mocked(footfiveApi.adminBackfillStatus).mockResolvedValue({});
  vi.mocked(footfiveApi.adminRecoveryStatus).mockResolvedValue({});
  vi.mocked(footfiveApi.adminHealth).mockResolvedValue({});
  vi.mocked(footfiveApi.adminDisableUser).mockResolvedValue({ ok: true });
  vi.mocked(footfiveApi.adminDeleteUser).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openUsers() {
  render(<MemoryRouter><AdminPage /></MemoryRouter>);
  await userEvent.click(screen.getByRole("button", { name: "Users" }));
}

describe("Admin user search and pager", () => {
  it("requests the first page and keeps the returned user row", async () => {
    vi.mocked(footfiveApi.adminUsers).mockResolvedValue(listed([person("ada")], 1, 1, false));
    await openUsers();
    expect(await screen.findByText(/ada@t\.local/)).toBeTruthy();
    expect(screen.getByText(/credits 40/)).toBeTruthy();
    expect(screen.getByText(/Neon United/)).toBeTruthy();
    expect(footfiveApi.adminUsers).toHaveBeenCalledTimes(1);
    expect(footfiveApi.adminUsers).toHaveBeenCalledWith("", 1, 200);
    expect(screen.getByTestId("admin-user-total")).toHaveTextContent("1 matching");
    expect(screen.getByTestId("admin-user-prev")).toBeDisabled();
    expect(screen.getByTestId("admin-user-next")).toBeDisabled();
  });

  it("sends a literal special-character query and resets to page 1", async () => {
    const q = "100%_a\"\\b";
    vi.mocked(footfiveApi.adminUsers).mockImplementation(async (query, page) => {
      if (query === q) return listed([person("lit", { email: "lit@t.local", display_name: q })], 1, 1, false);
      if (page === 2) return listed([person("p2")], 2, 201, false);
      return listed([person("p1")], 1, 201, true);
    });
    await openUsers();
    expect(await screen.findByText(/p1@t\.local/)).toBeTruthy();
    await userEvent.click(screen.getByTestId("admin-user-next"));
    expect(await screen.findByText(/p2@t\.local/)).toBeTruthy();
    expect(footfiveApi.adminUsers).toHaveBeenLastCalledWith("", 2, 200);
    await userEvent.type(screen.getByTestId("admin-user-search"), q);
    await userEvent.click(screen.getByTestId("admin-user-search-submit"));
    expect(await screen.findByText(/lit@t\.local/)).toBeTruthy();
    expect(footfiveApi.adminUsers).toHaveBeenLastCalledWith(q, 1, 200);
    expect(screen.queryByText(/p2@t\.local/)).toBeNull();
  });

  it("reloads the same query and page after an action", async () => {
    const q = "kept";
    vi.mocked(footfiveApi.adminUsers).mockImplementation(async (query, page) => {
      if (query === q && page === 2) return listed([person("kept")], 2, 201, false);
      if (page === 2) return listed([person("p2")], 2, 201, false);
      return listed([person("p1")], 1, 201, true);
    });
    await openUsers();
    await screen.findByText(/p1@t\.local/);
    await userEvent.click(screen.getByTestId("admin-user-next"));
    await screen.findByText(/p2@t\.local/);
    await userEvent.type(screen.getByTestId("admin-user-search"), q);
    await userEvent.click(screen.getByTestId("admin-user-search-submit"));
    await userEvent.click(screen.getByTestId("admin-user-next"));
    expect(await screen.findByText(/kept@t\.local/)).toBeTruthy();
    vi.mocked(footfiveApi.adminUsers).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(footfiveApi.adminDisableUser).toHaveBeenCalledWith("kept", "disable"));
    expect(footfiveApi.adminUsers).toHaveBeenLastCalledWith(q, 2, 200);
  });

  it("steps back one page when a delete empties the current page", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(footfiveApi.adminUsers)
      .mockResolvedValueOnce(listed([person("p1")], 1, 2, true))
      .mockResolvedValueOnce(listed([person("p2")], 2, 2, false))
      .mockResolvedValueOnce(listed([], 2, 1, false))
      .mockResolvedValueOnce(listed([person("p1")], 1, 1, false));
    try {
      await openUsers();
      await screen.findByText(/p1@t\.local/);
      await userEvent.click(screen.getByTestId("admin-user-next"));
      expect(await screen.findByText(/p2@t\.local/)).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      expect(await screen.findByText(/p1@t\.local/)).toBeTruthy();
      expect(screen.queryByText(/p2@t\.local/)).toBeNull();
      expect(footfiveApi.adminDeleteUser).toHaveBeenCalledWith("p2", "admin delete");
      expect(footfiveApi.adminUsers).toHaveBeenLastCalledWith("", 1, 200);
      expect(screen.getByTestId("admin-user-prev")).toBeDisabled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("ignores a stale list response after a newer search", async () => {
    let releaseStale: (value: Listed) => void = () => {};
    let first = true;
    vi.mocked(footfiveApi.adminUsers).mockImplementation(() => {
      if (first) {
        first = false;
        return new Promise((resolve) => {
          releaseStale = resolve;
        });
      }
      return Promise.resolve(listed([person("fresh", { email: "fresh@t.local" })], 1, 1, false));
    });
    await openUsers();
    await userEvent.type(screen.getByTestId("admin-user-search"), "fresh");
    await userEvent.click(screen.getByTestId("admin-user-search-submit"));
    expect(await screen.findByText(/fresh@t\.local/)).toBeTruthy();
    await act(async () => {
      releaseStale(listed([person("stale", { email: "stale@t.local" })], 1, 1, false));
    });
    expect(footfiveApi.adminUsers).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/fresh@t\.local/)).toBeTruthy();
    expect(screen.queryByText(/stale@t\.local/)).toBeNull();
  });
});
