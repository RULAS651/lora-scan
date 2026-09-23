"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import PrivacyNotice from "@/components/PrivacyNotice";

export default function LoginPage() {
  const { login, loading: authLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await login(email, password); }
    catch (x: any) { setErr(x?.response?.data?.error ?? x.message ?? "Login failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="card">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm text-white/60 mt-1">Access your private LoRA library.</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {err && <div className="text-sm text-danger">{err}</div>}
          <button className="btn-primary w-full" disabled={busy || authLoading}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="mt-4 text-sm text-white/60 text-center">
          No account? <Link className="text-brand-400 hover:underline" href="/register">Create one</Link>
        </div>
      </div>
      <div className="mt-6"><PrivacyNotice compact /></div>
    </div>
  );
}
