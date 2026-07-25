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

type AuthUser = {
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
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const mapRecord = (r: {
    id: string;
    email?: string;
    display_name?: unknown;
    role?: unknown;
    must_change_password?: unknown;
  }): AuthUser => ({
    id: r.id,
    email: String(r.email || ""),
    display_name: r.display_name as string | undefined,
    role: r.role as string | undefined,
    must_change_password: !!r.must_change_password,
  });

  const refreshMe = useCallback(async () => {
    if (!pb.authStore.isValid) {
      setUser(null);
      return;
    }
    try {
      const rec = await pb.collection("users").authRefresh();
      if (rec?.record) setUser(mapRecord(rec.record as unknown as AuthUser));
    } catch {
      // fall back to store
      if (pb.authStore.record) setUser(mapRecord(pb.authStore.record as unknown as AuthUser));
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      if (pb.authStore.isValid && pb.authStore.record) {
        setUser(mapRecord(pb.authStore.record as unknown as AuthUser));
      } else {
        setUser(null);
      }
      setLoading(false);
    };
    sync();
    // Enrich with must_change_password from /me if needed
    if (pb.authStore.isValid) {
      void (async () => {
        try {
          const me = await footfiveApi.me();
          setUser((u) =>
            u
              ? {
                  ...u,
                  must_change_password: !!me.must_change_password,
                  role: String(me.role || u.role),
                  display_name: String(me.display_name || u.display_name || ""),
                }
              : u,
          );
        } catch {
          /* ignore */
        }
      })();
    }
    return pb.authStore.onChange(() => sync());
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const auth = await pb.collection("users").authWithPassword(email, password);
    const r = auth.record as unknown as AuthUser;
    setUser(mapRecord(r));
    try {
      const me = await footfiveApi.me();
      setUser(
        mapRecord({
          ...r,
          must_change_password: me.must_change_password,
        }),
      );
    } catch {
      /* store only */
    }
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    await pb.collection("users").create({
      email,
      password,
      passwordConfirm: password,
      display_name: displayName || email.split("@")[0],
    });
    await pb.collection("users").authWithPassword(email, password);
  }, []);

  const logout = useCallback(() => {
    pb.authStore.clear();
    setUser(null);
  }, []);

  const mustChangePassword = !!user?.must_change_password;

  const value = useMemo(
    () => ({
      user,
      loading,
      mustChangePassword,
      login,
      register,
      logout,
      refreshMe,
    }),
    [user, loading, mustChangePassword, login, register, logout, refreshMe],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
