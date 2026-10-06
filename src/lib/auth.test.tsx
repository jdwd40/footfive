import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "./auth";

const h = vi.hoisted(() => ({
  authRefresh: vi.fn(),
  me: vi.fn(),
  clear: vi.fn(() => {
    h.authStore.isValid = false;
    h.authStore.record = null;
  }),
  authStore: {
    isValid: true,
    token: "tok",
    record: { id: "u1", email: "u1@t.local", role: "user", must_change_password: false } as Record<
      string,
      unknown
    > | null,
  },
}));

vi.mock("./pocketbase", () => ({
  pb: {
    authStore: Object.assign(h.authStore, {
      clear: h.clear,
      save: vi.fn(),
      onChange: vi.fn(() => () => {}),
    }),
    collection: () => ({ authRefresh: h.authRefresh }),
  },
  footfiveApi: { me: h.me },
}));

import { AuthProvider, useAuth } from "./auth";

let ctx: ReturnType<typeof useAuth> | null = null;
function Probe() {
  ctx = useAuth();
  const { user, loading } = ctx;
  return <div>{loading ? "loading" : user ? user.email : "anon"}</div>;
}

async function mount() {
  h.me.mockRejectedValue(new Error("no me"));
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await screen.findByText("u1@t.local");
}

describe("refreshMe", () => {
  afterEach(() => {
    cleanup();
    ctx = null;
    h.authStore.isValid = true;
    h.authStore.record = { id: "u1", email: "u1@t.local", role: "user", must_change_password: false };
    h.authRefresh.mockReset();
    h.me.mockReset();
    h.clear.mockClear();
  });

  it("keeps the session when authRefresh succeeds", async () => {
    h.authRefresh.mockResolvedValue({ record: { id: "u1", email: "u1@t.local", role: "user" } });
    await mount();
    let out: AuthUser | null = null;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect((out as AuthUser | null)?.id).toBe("u1");
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.getByText("u1@t.local")).toBeInTheDocument();
  });

  it("drops the session when the server rejects the token (4xx)", async () => {
    h.authRefresh.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    await mount();
    let out: AuthUser | null = null as unknown as AuthUser;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect(out).toBeNull();
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText("anon")).toBeInTheDocument();
  });

  it("keeps the cached user on network failure (status 0)", async () => {
    h.authRefresh.mockRejectedValue(Object.assign(new Error("network"), { status: 0 }));
    await mount();
    let out: AuthUser | null = null;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect((out as AuthUser | null)?.id).toBe("u1");
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.getByText("u1@t.local")).toBeInTheDocument();
  });
});
