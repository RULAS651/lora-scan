"use client";

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";

export interface Tokens { access: string; refresh: string; }

const TOKENS_KEY = "lsp_tokens";
const ME_KEY     = "lsp_me";

export interface Me { id: string; email: string; role: "MEMBER" | "ADMIN"; }

export function getTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(TOKENS_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function setTokens(t: Tokens) { localStorage.setItem(TOKENS_KEY, JSON.stringify(t)); }
export function clearTokens() { localStorage.removeItem(TOKENS_KEY); localStorage.removeItem(ME_KEY); }
export function getMe(): Me | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ME_KEY);
  return raw ? JSON.parse(raw) : null;
}
export function setMe(m: Me) { localStorage.setItem(ME_KEY, JSON.stringify(m)); }

interface Ctx {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setMeExplicit: (m: Me) => void;
}

const AuthCtx = createContext<Ctx | null>(null);

const PUBLIC_ROUTES = new Set(["/login", "/register", "/"]);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMeState] = useState<Me | null>(() => getMe());
  const [loading, setLoading] = useState<boolean>(true);
  const router = useRouter();
  const pathname = usePathname();

  const refreshMe = useCallback(async () => {
    const t = getTokens();
    if (!t) { setMeState(null); setLoading(false); return; }
    try {
      const { default: api } = await import("./api");
      const r = await api.get<{ member: Me }>("/members/me");
      setMeState(r.data.member);
      setMe(r.data.member);
    } catch {
      clearTokens();
      setMeState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe]);

  useEffect(() => {
    if (loading) return;
    if (!me && !PUBLIC_ROUTES.has(pathname)) {
      router.replace("/login");
    } else if (me && (pathname === "/login" || pathname === "/register")) {
      router.replace("/dashboard");
    }
  }, [me, loading, pathname, router]);

  const login = useCallback(async (email: string, password: string) => {
    const { default: api } = await import("./api");
    const r = await api.post<{ access: string; refresh: string; member: Me }>("/auth/login", { email, password });
    setTokens({ access: r.data.access, refresh: r.data.refresh });
    setMeState(r.data.member); setMe(r.data.member);
    router.push("/dashboard");
  }, [router]);

  const register = useCallback(async (email: string, password: string) => {
    const { default: api } = await import("./api");
    await api.post("/auth/register", { email, password, privacyConsent: true });
    // Auto login after register
    const r = await api.post<{ access: string; refresh: string; member: Me }>("/auth/login", { email, password });
    setTokens({ access: r.data.access, refresh: r.data.refresh });
    setMeState(r.data.member); setMe(r.data.member);
    router.push("/dashboard");
  }, [router]);

  const logout = useCallback(async () => {
    try {
      const { default: api } = await import("./api");
      await api.post("/auth/logout");
    } catch {}
    clearTokens(); setMeState(null);
    router.push("/login");
  }, [router]);

  return (
    <AuthCtx.Provider value={{ me, loading, login, register, logout, setMeExplicit: setMeState }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
