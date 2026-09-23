"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import PrivacyNotice from "@/components/PrivacyNotice";

export default function RegisterPage() {
  const { register, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (password.length < 8) { setErr("Password must be at least 8 characters"); return; }
    if (password !== password2) { setErr("Passwords don't match"); return; }
    setBusy(true);
    try { await register(email, password); }
    catch (x: any) { setErr(x?.response?.data?.error ?? x.message ?? "Registration failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="max-w-md mx-auto mt-12">
      <div className="card">
        <h1 className="text-xl font-semibold">Create an account</h1>
        <p className="text-sm text-white/60 mt-1">
          Your face scans are end-to-end encrypted and auto-deleted after training.
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Password (min 8 chars)</label>
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label">Confirm password</label>
            <input className="input" type="password" required minLength={8} value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
            <span className="text-white/80">
              I agree to the <span className="underline">privacy policy</span> and
              consent to my face scan data being encrypted, stored, and processed
              <em> only</em> for the purpose of generating my personal LoRA.
              I can revoke this consent and wipe my data at any time.
            </span>
          </label>
          {err && <div className="text-sm text-danger">{err}</div>}
          <button className="btn-primary w-full" disabled={busy || loading}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
        <div className="mt-4 text-sm text-white/60 text-center">
          Already a member? <Link className="text-brand-400 hover:underline" href="/login">Sign in</Link>
        </div>
      </div>
      <div className="mt-6"><PrivacyNotice /></div>
    </div>
  );
}
