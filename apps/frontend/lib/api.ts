"use client";

import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { getTokens, setTokens, clearTokens, Tokens } from "./auth";

const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json" },
});

let refreshPromise: Promise<string> | null = null;

async function doRefresh(refreshToken: string): Promise<string> {
  const r = await axios.post<{ access: string }>("/api/auth/refresh", { refresh: refreshToken });
  return r.data.access;
}

api.interceptors.request.use((config) => {
  const t = getTokens();
  if (t?.access) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${t.access}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const status = err.response?.status;
    const original = err.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (status !== 401 || original._retry) return Promise.reject(err);

    const t = getTokens();
    if (!t?.refresh) { clearTokens(); return Promise.reject(err); }

    if (!refreshPromise) {
      refreshPromise = doRefresh(t.refresh).then((newAccess) => {
        setTokens({ access: newAccess, refresh: t.refresh });
        return newAccess;
      }).catch((e) => {
        clearTokens();
        throw e;
      }).finally(() => { refreshPromise = null; });
    }
    try {
      const access = await refreshPromise;
      original.headers = original.headers ?? {};
      original.headers.Authorization = `Bearer ${access}`;
      original._retry = true;
      return api(original);
    } catch {
      return Promise.reject(err);
    }
  }
);

export default api;
export type { Tokens };
