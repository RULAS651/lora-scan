"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";
import PrivacyNotice from "@/components/PrivacyNotice";

interface Me { id: string; email: string; deIdentifyDefault: boolean; ttlHoursOverride: number | null; createdAt: string; privacyConsentAt: string | null; }
interface AuditEntry { id: string; action: string; targetId: string | null; reason: string | null; createdAt: string; metadata: any; }

export default function PrivacyPage() {
  const { me, logout } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<Me | null>(null);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ member: Me }>("/members/me"),
      api.get<{ items: AuditEntry[] }>("/members/me/audits"),
    ]).then(([p, a]) => { setProfile(p.data.member); setAudits(a.data.items); });
  }, []);

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const r = await api.patch<Me>("/members/me", {
        deIdentifyDefault: profile.deIdentifyDefault,
        ttlHoursOverride: profile.ttlHoursOverride,
      });
      setProfile(r.data);
    } finally { setSaving(false); }
  };

  const wipe = async () => {
    if (!confirm) return;
    setWiping(true);
    try {
      const reason = window.prompt("Reason for wiping (optional but recorded)") ?? "member-requested erasure (GDPR)";
      await api.post("/members/me/wipe-account", { reason });
      await logout();
      router.push("/");
    } catch (e: any) {
      alert(e?.response?.data?.error ?? "Wipe failed");
    } finally { setWiping(false); }
  };

  if (!profile) return <div className="max-w-3xl mx-auto mt-10 card text-white/60">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <h1 className="text-2xl font-semibold">Privacy & data</h1>
      <PrivacyNotice />

      <div className="card">
        <h2 className="font-semibold">Scan defaults</h2>
        <p className="text-sm text-white/60 mt-1">
          Applies to future scan sessions.  Existing scans keep their settings.
        </p>
        <div className="mt-5 space-y-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1"
                   checked={profile.deIdentifyDefault}
                   onChange={(e) => setProfile({ ...profile, deIdentifyDefault: e.target.checked })} />
            <div className="text-sm">
              <div className="font-medium">Always pixelate (de-identify) my face before encryption</div>
              <div className="text-white/60">
                Experimental.  Pixelates the face region server-side <em>before</em> the AES-256 encryption step.
                May reduce LoRA training quality — recommended only for maximum privacy.
              </div>
            </div>
          </label>

          <div>
            <label className="label">Override scan retention (hours)</label>
            <input className="input max-w-xs" type="number" min={1} max={720} step={1}
                   placeholder="Use system default (24h success / 72h fail)"
                   value={profile.ttlHoursOverride ?? ""}
                   onChange={(e) => setProfile({
                     ...profile,
                     ttlHoursOverride: e.target.value ? Number(e.target.value) : null,
                   })} />
            <p className="text-xs text-white/50 mt-1">
              Raw scans are automatically deleted this many hours after training succeeds.
              Leave blank to use the system default.
            </p>
          </div>
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save preferences"}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="font-semibold">My data retention</h2>
        <ul className="mt-3 space-y-1 text-sm text-white/80 list-disc pl-5">
          <li>Consent signed: {profile.privacyConsentAt ? new Date(profile.privacyConsentAt).toLocaleString() : "—"}</li>
          <li>Account created: {new Date(profile.createdAt).toLocaleString()}</li>
          <li>LoRA artifacts are AES-256-GCM encrypted; only you (and never other members) can download them.</li>
          <li>Raw face photos are auto-deleted after training via TTL scheduler; admins cannot view your images (only encrypted metadata).</li>
        </ul>
      </div>

      <div className="card">
        <h2 className="font-semibold">Recent access log — your account</h2>
        <p className="text-sm text-white/50 mt-1">
          Last 200 actions.  Full, immutable history is kept server-side for compliance.
        </p>
        <div className="mt-3 overflow-auto max-h-80 rounded-lg border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-white/60 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Target</th>
                <th className="text-left px-3 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.id} className="border-t border-white/5">
                  <td className="px-3 py-1.5 text-white/60 text-xs whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-1.5"><span className="badge badge-info">{a.action}</span></td>
                  <td className="px-3 py-1.5 text-xs font-mono">{a.targetId ? a.targetId.slice(0, 14) + "…" : "—"}</td>
                  <td className="px-3 py-1.5 text-white/70 text-xs">{a.reason ?? a.metadata?.note ?? ""}</td>
                </tr>
              ))}
              {audits.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-8 text-center text-white/40">No activity yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card border-danger/30 bg-danger/5">
        <h2 className="font-semibold text-danger">Danger zone</h2>
        <p className="text-sm text-white/70 mt-1">
          Permanently delete <b>all</b> of your data — LoRA artifacts, encrypted face scans,
          sessions — and anonymize your account.  This cannot be undone, and the deletion
          event itself is recorded in the append-only audit log.
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I understand that this permanently erases all of my LoRAs and scans.</span>
        </label>
        <button className="btn-danger mt-4" disabled={!confirm || wiping} onClick={wipe}>
          {wiping ? "Wiping your account…" : "Wipe my account and all data"}
        </button>
      </div>
    </div>
  );
}
