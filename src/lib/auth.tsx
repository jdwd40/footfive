import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { footfiveApi, pb } from "./pocketbase";

export type AuthUser = {
  id: string;
  email: string;
  display_name?: string;
  role?: string;
  must_change_password?: boolean;
};

type AuthCtx = {
  user: AuthUser | null;
  loading: boolean;
  mustChangePassword: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<AuthUser | null>;
};

const Ctx = createContext<AuthCtx | null>(null);

function mapRecord(r: {
  id: string;
  email?: string;
  display_name?: unknown;
  role?: unknown;
  must_change_password?: unknown;
}): AuthUser {
  return {
    id: r.id,
    email: String(r.email || ""),
    display_name: r.display_name as string | undefined,
    role: String(r.role || "user"),
    must_change_password: !!r.must_change_password,
  };
}

// Definitive auth rejections are surface-specific (review F8): a 429 from the
// rate limiter is NOT evidence of dead credentials, and PocketBase's native
// auth-refresh answers 400 (not 401) for an invalid/revoked/disabled token,
// while the custom /me route answers 401 (requireAuth) or 403 (disabled).
function isDefinitiveAuthRejection(status: number | undefined, surface: "me" | "refresh"): boolean {
  if (typeof status !== "number") return false;
  if (status === 401 || status === 403) return true;
  return surface === "refresh" && status === 400;
}

async function enrichFromMe(base: AuthUser): Promise<AuthUser> {
  try {
    const me = await footfiveApi.me();
    return {
      ...base,
      must_change_password: !!me.must_change_password,
      role: String(me.role || base.role || "user"),
      display_name: String(me.display_name || base.display_name || ""),
      email: String(me.email || base.email),
    };
  } catch (err) {
    // A definitive auth rejection (401/403 on /me) must propagate so the
    // session is cleared; throttling (429), offline/network and server
    // failures fall back to the cached record.
    const status = (err as { status?: number } | null)?.status;
    if (isDefinitiveAuthRejection(status, "me")) throw err;
    return base;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    if (!pb.authStore.isValid) {
      setUser(null);
      return null;
    }
    try {
      const rec = await pb.collection("users").authRefresh();
      let mapped = mapRecord((rec?.record || pb.authStore.record) as unknown as AuthUser);
      mapped = await enrichFromMe(mapped);
      setUser(mapped);
      return mapped;
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (isDefinitiveAuthRejection(status, "refresh")) {
        // Server definitively rejected the token (disabled/deleted/revoked):
        // drop the session instead of silently keeping the cached user
        // (review B2). Throttling (429) is not a rejection.
        pb.authStore.clear();
        setUser(null);
        return null;
      }
      // Network/server/throttle errors: tolerate with the cached record.
      if (pb.authStore.record) {
        let mapped = mapRecord(pb.authStore.record as unknown as AuthUser);
        try {
          mapped = await enrichFromMe(mapped);
        } catch {
          // enrichFromMe only rethrows definitive /me rejections (401/403):
          // the cached record belongs to a revoked session, so clear it here
          // instead of letting the throw escape this catch block and hang
          // bootstrap (review F8 follow-up).
          pb.authStore.clear();
          setUser(null);
          return null;
        }
        setUser(mapped);
        return mapped;
      }
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      // Bootstrap goes through the same validated refresh path as refreshMe:
      // a revoked/disabled session is rejected by the server and cleared here
      // instead of being restored from the cached record (review F4). Deliberate
      // offline/network fallback to the cached record is preserved inside
      // refreshMe (status 0 / 5xx), without swallowing 4xx auth failures.
      await refreshMe();
      if (active) setLoading(false);
    };
    void boot();
    const unsub = pb.authStore.onChange(() => {
      if (pb.authStore.isValid && pb.authStore.record) {
        setUser(mapRecord(pb.authStore.record as unknown as AuthUser));
      } else {
        setUser(null);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, [refreshMe]);

  const login = useCallback(async (identity: string, password: string) => {
    const id = identity.trim();
    let mapped: AuthUser;
    try {
      if (id.includes("@")) {
        const auth = await pb.collection("users").authWithPassword(id, password);
        mapped = mapRecord(auth.record as unknown as AuthUser);
      } else {
        const res = await footfiveApi.loginIdentity(id, password);
        pb.authStore.save(res.token, res.record as never);
        mapped = mapRecord(res.record as unknown as AuthUser);
      }
    } catch {
      const res = await footfiveApi.loginIdentity(id, password);
      pb.authStore.save(res.token, res.record as never);
      mapped = mapRecord(res.record as unknown as AuthUser);
    }
    mapped = await enrichFromMe(mapped);
    setUser(mapped);
    return mapped;
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    await pb.collection("users").create({
      email,
      password,
      passwordConfirm: password,
      display_name: displayName || email.split("@")[0],
    });
    await pb.collection("users").authWithPassword(email, password);
    const mapped = await enrichFromMe(mapRecord(pb.authStore.record as unknown as AuthUser));
    setUser(mapped);
  }, []);

  const logout = useCallback(() => {
    pb.authStore.clear();
    setUser(null);
  }, []);

  const mustChangePassword = !!user?.must_change_password;
  const isAdmin = (user?.role || "") === "admin";

  const value = useMemo(
    () => ({
      user,
      loading,
      mustChangePassword,
      isAdmin,
      login,
      register,
      logout,
      refreshMe,
    }),
    [user, loading, mustChangePassword, isAdmin, login, register, logout, refreshMe],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}

/** Post-login destination. */
export function postLoginPath(user: AuthUser | null | undefined): string {
  if (!user) return "/login";
  if (user.must_change_password) return "/change-password";
  if (user.role === "admin") return "/admin";
  return "/live";
}
