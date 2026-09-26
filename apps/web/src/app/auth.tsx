import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Parse, initParse } from "@/lib/parse";
import { queryClient } from "@/lib/queryClient";

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  name: string;
  sessionToken: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  loginWithSessionToken: (token: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toAuthUser(u: Parse.User): AuthUser {
  return {
    id: u.id ?? "",
    username: u.getUsername() ?? "",
    email: u.getEmail() ?? u.get("email") ?? "",
    name: u.get("name") ?? "",
    sessionToken: u.getSessionToken() ?? ""
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  initParse();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const current = Parse.User.current();
    if (!current) {
      setUser(null);
      return;
    }
    try {
      await current.fetch();
      setUser(toAuthUser(current));
    } catch {
      await Parse.User.logOut().catch(() => undefined);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setReady(true));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const u = await Parse.User.logIn(username.trim(), password);
    const au = toAuthUser(u);
    setUser(au);
    return au;
  }, []);

  const loginWithSessionToken = useCallback(async (token: string) => {
    const u = await Parse.User.become(token);
    const au = toAuthUser(u);
    setUser(au);
    return au;
  }, []);

  const logout = useCallback(async () => {
    await Parse.User.logOut().catch(() => undefined);
    queryClient.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, login, loginWithSessionToken, logout, refresh }),
    [user, ready, login, loginWithSessionToken, logout, refresh]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Route guard: redirects to /login (remembering where we were) until signed in. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  return <>{children}</>;
}
