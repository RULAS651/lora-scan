"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import api from "@/lib/api";

type Status = "TRAINING" | "READY" | "FAILED" | "REVOKED" | "DELETED";
interface LoRADetail {
  id: string; memberId: string; status: Status; triggerWord: string;
  blobSizeBytes: number | null; trainingSteps: number | null; rank: number | null; learningRate: number | null;
  createdAt: string; updatedAt: string;
  scanSession: {
    id: string; status: string; deIdentified: boolean; purgeScheduledAt: string | null;
    images: { id: string; angle: string; width: number | null; height: number | null }[];
    job: { id: string; status: string; runpodJobId: string | null; retries: number; startedAt: string | null; finishedAt: string | null } | null;
  };
}

const STATUS_BADGE: Record<Status, string> = {
  TRAINING: "badge-warn", READY: "badge-success", FAILED: "badge-danger", REVOKED: "badge-muted", DELETED: "badge-muted",
};

function fmtBytes(n: number | null) {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function LoRADetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;
  const [lora, setLora] = useState<LoRADetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<LoRADetail>(`/lora/${id}`).then(r => setLora(r.data)).catch(() => setLora(null));
  }, [id]);

  const download = async () => {
    setBusy("download");
    try {
      const r = await api.get(`/lora/${id}/download`, { responseType: "blob" });
      const cd = r.headers["content-disposition"] ?? "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const fname = m?.[1] ?? `${lora?.triggerWord ?? "lora"}.safetensors`;
      const url = URL.createObjectURL(r.data as Blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname; document.body.appendChild(a); a.click();
      URL.revokeObjectURL(url); a.remove();
    } finally { setBusy(null); }
  };

  const revoke = async () => {
    setBusy("revoke");
    try {
      await api.post(`/lora/${id}/revoke`);
      const r = await api.get<LoRADetail>(`/lora/${id}`);
      setLora(r.data);
    } finally { setBusy(null); }
  };

  const del = async () => {
    setBusy("delete");
    try {
      await api.delete(`/lora/${id}`, { data: { reason: "member self-delete" } });
      router.push("/dashboard");
    } finally { setBusy(null); }
  };

  if (!lora) return <div className="max-w-3xl mx-auto mt-10 card text-white/60">Loading…</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3 text-sm">
        <Link href="/dashboard" className="text-white/60 hover:text-white">← Dashboard</Link>
      </div>
      <div className="card">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-semibold font-mono">{lora.triggerWord}</h1>
              <span className={STATUS_BADGE[lora.status]}>{lora.status}</span>
              {lora.scanSession.deIdentified && <span className="badge badge-info">De-identified</span>}
            </div>
            <p className="text-sm text-white/60 mt-1">
              Trigger word — use this token in your ComfyUI prompts to invoke the trained identity.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {lora.status === "READY" && (
              <button className="btn-primary" onClick={download} disabled={busy === "download"}>
                {busy === "download" ? "Preparing…" : "⬇  Download .safetensors"}
              </button>
            )}
            {lora.status !== "DELETED" && lora.status !== "REVOKED" && (
              <button className="btn-ghost" onClick={revoke} disabled={!!busy}>
                🔒 Revoke access
              </button>
            )}
            <button className="btn-danger" onClick={() => setConfirmDelete(true)} disabled={!!busy}>
              🗑 Delete forever
            </button>
          </div>
        </div>

        {confirmDelete && (
          <div className="mt-6 border border-danger/40 bg-danger/5 rounded-xl p-4">
            <h3 className="font-semibold">Delete LoRA + associated face scans?</h3>
            <p className="text-sm text-white/70 mt-1">
              This will permanently delete the encrypted LoRA artifact, all raw scan images,
              and cascade the deletion to the scan session.  This action is audit-logged and
              cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button className="btn-danger" onClick={del} disabled={busy === "delete"}>
                {busy === "delete" ? "Deleting…" : "Yes, permanently delete"}
              </button>
              <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Info title="Size">{fmtBytes(lora.blobSizeBytes)}</Info>
        <Info title="Training">{lora.trainingSteps ?? "—"} steps · rank {lora.rank ?? "—"} · LR {lora.learningRate ?? "—"}</Info>
        <Info title="Created">{new Date(lora.createdAt).toLocaleString()}</Info>
      </div>

      <div className="card">
        <h2 className="font-semibold">Face scan session</h2>
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-sm">
          <Info compact title="Session">{lora.scanSession.id}</Info>
          <Info compact title="Status">{lora.scanSession.status}</Info>
          <Info compact title="Angles captured">{lora.scanSession.images.length}</Info>
          <Info compact title="Purge scheduled">
            {lora.scanSession.purgeScheduledAt
              ? new Date(lora.scanSession.purgeScheduledAt).toLocaleString()
              : "—"}
          </Info>
          <Info compact title="RunPod job">
            {lora.scanSession.job?.runpodJobId ?? "N/A"}
            {lora.scanSession.job && (
              <div className="text-white/50 mt-0.5 text-xs">
                {lora.scanSession.job.status} · retries {lora.scanSession.job.retries}
              </div>
            )}
          </Info>
          <Info compact title="Session link">
            <Link className="text-brand-400 hover:underline" href="/scan">Open scan sessions →</Link>
          </Info>
        </div>
      </div>
    </div>
  );
}

function Info({ title, children, compact }: { title: string; children: React.ReactNode; compact?: boolean }) {
  return (
    <div className={compact ? "" : "card !p-4"}>
      <div className="text-[11px] uppercase tracking-wider text-white/50">{title}</div>
      <div className={`${compact ? "mt-0.5" : "mt-2"} text-sm text-white break-all`}>{children}</div>
    </div>
  );
}
