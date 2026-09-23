"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

type LoRAStatus = "TRAINING" | "READY" | "FAILED" | "REVOKED" | "DELETED";
interface LoRAItem {
  id: string; status: LoRAStatus; triggerWord: string; createdAt: string;
  trainingSteps: number | null; rank: number | null;
  scanSession: { status: string; deIdentified: boolean;
                 images: { angle: string }[] };
}
interface Me { id: string; email: string; role: string; createdAt: string; deIdentifyDefault: boolean; }
interface Summary { loraCounts: Record<string, number>; scanSessions: number; storageBytes: number; }

const STATUS_BADGE: Record<LoRAStatus, string> = {
  TRAINING: "badge-warn",
  READY: "badge-success",
  FAILED: "badge-danger",
  REVOKED: "badge-muted",
  DELETED: "badge-muted",
};

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function DashboardPage() {
  const { me } = useAuth();
  const [profile, setProfile] = useState<Me | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loras, setLoras] = useState<LoRAItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ member: Me; summary: Summary }>("/members/me"),
      api.get<{ items: LoRAItem[] }>("/lora"),
    ]).then(([p, l]) => {
      setProfile(p.data.member);
      setSummary(p.data.summary);
      setLoras(l.data.items);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            Hi, {profile?.email?.split("@")[0] ?? "there"} 👋
          </h1>
          <p className="text-sm text-white/60">
            Your personal LoRA studio.  Scan → Train → Generate — all encrypted.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/privacy" className="btn-ghost">Privacy settings</Link>
          <Link href="/scan/new" className="btn-primary">＋ New face scan</Link>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Ready LoRAs" value={summary?.loraCounts?.READY ?? 0} tone="success" />
        <Stat label="Training now" value={summary?.loraCounts?.TRAINING ?? 0} tone="warn" />
        <Stat label="Scan sessions" value={summary?.scanSessions ?? 0} tone="info" />
        <Stat label="Storage used" value={fmtBytes(summary?.storageBytes ?? 0)} tone="muted" />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Your LoRAs</h2>
          <Link className="text-xs text-brand-400 hover:underline" href="/scan/new">Start new scan →</Link>
        </div>
        {loading ? (
          <div className="text-sm text-white/50">Loading…</div>
        ) : loras.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.03] text-white/60 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Trigger word</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Settings</th>
                  <th className="text-left px-4 py-2 font-medium">Angles</th>
                  <th className="text-right px-4 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {loras.map((l) => (
                  <tr key={l.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <Link className="text-brand-300 hover:underline font-mono" href={`/lora/${l.id}`}>
                        {l.triggerWord}
                      </Link>
                    </td>
                    <td className="px-4 py-3"><span className={STATUS_BADGE[l.status] ?? "badge-muted"}>{l.status}</span></td>
                    <td className="px-4 py-3 text-white/70">
                      {l.rank && l.trainingSteps ? `rank=${l.rank}, ${l.trainingSteps} steps` : "—"}
                    </td>
                    <td className="px-4 py-3 text-white/70">
                      {l.scanSession.images.length} · {l.scanSession.deIdentified ? <span className="badge badge-info ml-1">de-id</span> : null}
                    </td>
                    <td className="px-4 py-3 text-right text-white/50 text-xs">
                      {new Date(l.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone: "success" | "warn" | "info" | "muted" }) {
  const toneClass =
    tone === "success" ? "text-success" :
    tone === "warn"    ? "text-amber-300" :
    tone === "info"    ? "text-sky-300" : "text-white/70";
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wider text-white/50">{label}</div>
      <div className={`mt-2 text-3xl font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-dashed border-white/15 rounded-xl py-14 px-6 text-center">
      <div className="text-4xl mb-3">🧬</div>
      <h3 className="font-semibold">No LoRAs yet</h3>
      <p className="text-sm text-white/60 mt-1">
        Run a 5-angle face scan to train your first personal LoRA.
      </p>
      <Link className="btn-primary mt-5" href="/scan/new">Start first scan</Link>
    </div>
  );
}
