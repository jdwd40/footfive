import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function resetMocks() {
  h.authStore.isValid = true;
  h.authStore.record = { id: "u1", email: "u1@t.local", role: "user", must_change_password: false };
  h.authRefresh.mockReset();
  h.me.mockReset();
  h.clear.mockClear();
  // Default: healthy session — bootstrap's auth-refresh succeeds, /me fails
  // without a status (offline-tolerant enrichment fallback).
  h.authRefresh.mockResolvedValue({ record: { id: "u1", email: "u1@t.local", role: "user" } });
  h.me.mockRejectedValue(new Error("no me"));
}

async function mount() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await screen.findByText(/u1@t\.local|anon/);
}

describe("bootstrap", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    cleanup();
    ctx = null;
  });

  it("restores a healthy session through the validated refresh path", async () => {
    await mount();
    expect(h.authRefresh).toHaveBeenCalledTimes(1);
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.getByText("u1@t.local")).toBeInTheDocument();
  });

  it("clears a server-rejected (revoked/disabled) session instead of restoring the cache", async () => {
    h.authRefresh.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await screen.findByText("anon");
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.authStore.isValid).toBe(false);
  });

  it("keeps the cached user on network failure (status 0)", async () => {
    h.authRefresh.mockRejectedValue(Object.assign(new Error("network"), { status: 0 }));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await screen.findByText("u1@t.local");
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe("refreshMe", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    cleanup();
    ctx = null;
  });

  it("keeps the session when authRefresh succeeds", async () => {
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
    await mount();
    h.authRefresh.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    let out: AuthUser | null = null as unknown as AuthUser;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect(out).toBeNull();
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText("anon")).toBeInTheDocument();
  });

  it("drops the session when /me rejects with 4xx after a successful refresh", async () => {
    await mount();
    h.me.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    let out: AuthUser | null = null as unknown as AuthUser;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect(out).toBeNull();
    expect(h.clear).toHaveBeenCalled();
    expect(screen.getByText("anon")).toBeInTheDocument();
  });

  it("keeps the cached user on network failure (status 0)", async () => {
    await mount();
    h.authRefresh.mockRejectedValue(Object.assign(new Error("network"), { status: 0 }));
    let out: AuthUser | null = null;
    await act(async () => {
      out = await ctx!.refreshMe();
    });
    expect((out as AuthUser | null)?.id).toBe("u1");
    expect(h.clear).not.toHaveBeenCalled();
    expect(screen.getByText("u1@t.local")).toBeInTheDocument();
  });
});
