"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import api from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Member = { id: string; email: string; role: string; createdAt: string; lastActiveAt: string;
  _count: { scanSessions: number; loras: number } };
type Job = { id: string; provider: string; status: string; retries: number; runpodJobId: string | null;
  startedAt: string | null; finishedAt: string | null; errorMessage: string | null;
  member: { id: string; email: string } };
type Audit = { id: string; action: string; reason: string | null; targetId: string | null; createdAt: string;
  member: { email: string | null } | null; actor: { email: string | null } | null };

export default function AdminPage() {
  const { me } = useAuth();
  const [tab, setTab] = useState<"members" | "jobs" | "audits" | "tools">("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);

  function reload() {
    if (tab === "members") api.get<{ items: Member[] }>("/admin/members").then(r => setMembers(r.data.items));
    if (tab === "jobs") api.get<{ items: Job[] }>("/admin/jobs").then(r => setJobs(r.data.items));
    if (tab === "audits") api.get<{ items: Audit[] }>("/admin/audits", { params: { limit: 200 } }).then(r => setAudits(r.data.items));
  }
  useEffect(reload, [tab]);

  const actionBars = (
    <div className="flex gap-2 mb-4 flex-wrap">
      {(["members","jobs","audits","tools"] as const).map((t) => (
        <button key={t} onClick={() => setTab(t)}
                className={`btn ${tab === t ? "bg-brand-600 text-white" : "btn-ghost"} !py-1.5 text-sm`}>
          {t === "members" && "👥 Members"}
          {t === "jobs" && "💼 Jobs"}
          {t === "audits" && "📜 Audit log"}
          {t === "tools" && "🛠️ Tools"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Admin console</h1>
        <span className="badge badge-warn">Admin view · {me?.email}</span>
      </div>

      <div className="card">
        {actionBars}

        {tab === "members" && (
          <AdminTable
            cols={["Email","Role","Scans","LoRAs","Last active","Created","Actions"]}
            rows={members.map((m) => [
              <span className="font-mono text-xs">{m.email}</span>,
              <span className={m.role === "ADMIN" ? "badge badge-warn" : "badge badge-muted"}>{m.role}</span>,
              m._count.scanSessions, m._count.loras,
              new Date(m.lastActiveAt).toLocaleString(),
              new Date(m.createdAt).toLocaleString(),
              <div className="flex gap-2 justify-end">
                <button className="btn-danger !py-1 text-xs"
                        onClick={() => wipeMember(api, m.id, reload)}
                        title="Wipes every LoRA, scan, and anonymizes account">
                  Wipe account
                </button>
              </div>,
            ])}
            empty="No members"
          />
        )}

        {tab === "jobs" && (
          <AdminTable
            cols={["Member","Provider","Status","RunPod ID","Retries","Started","Finished","Actions"]}
            rows={jobs.map((j) => [
              j.member.email,
              j.provider,
              <JobBadge status={j.status} />,
              j.runpodJobId ? <span className="font-mono text-xs">{j.runpodJobId}</span> : "—",
              `${j.retries}/2`,
              j.startedAt ? new Date(j.startedAt).toLocaleString() : "—",
              j.finishedAt ? new Date(j.finishedAt).toLocaleString() : "—",
              <div className="flex gap-2 justify-end">
                <button className="btn-ghost !py-1 text-xs"
                        onClick={() => api.post(`/admin/jobs/${j.id}/retry`).then(reload)}>↻ Retry</button>
                <button className="btn-danger !py-1 text-xs"
                        onClick={() => api.post(`/admin/jobs/${j.id}/cancel`).then(reload)}>✕ Cancel</button>
              </div>,
            ])}
            empty="No jobs"
          />
        )}

        {tab === "audits" && (
          <AdminTable
            cols={["When","Actor","Member","Action","Target","Reason"]}
            rows={audits.map((a) => [
              new Date(a.createdAt).toLocaleString(),
              a.actor?.email ?? "—",
              a.member?.email ?? "—",
              <span className="badge badge-info">{a.action}</span>,
              a.targetId ? <span className="font-mono text-xs">{a.targetId.slice(0,12)}…</span> : "—",
              a.reason ?? "—",
            ])}
            empty="No audit entries yet"
          />
        )}

        {tab === "tools" && <DevTools reload={reload} />}
      </div>
    </div>
  );
}

function JobBadge({ status }: { status: string }) {
  const cls =
    status === "SUCCEEDED" ? "badge-success" :
    status === "RUNNING" || status === "QUEUED" || status === "PENDING" ? "badge-warn" :
    status === "FAILED" ? "badge-danger" : "badge-muted";
  return <span className={cls}>{status}</span>;
}

function DevTools({ reload }: { reload: () => void }) {
  const [scanSessionId, setScanSessionId] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const mockComplete = async () => {
    setErr(""); setOk("");
    if (!scanSessionId) { setErr("Provide a scan session id"); return; }
    try {
      const r = await api.post(`/admin/mock/complete-training/${scanSessionId}`, { success: true });
      setOk(`Mocked training complete.  TTL purge scheduled in ${r.data.ttlHours}h.`);
      reload();
    } catch (e: any) { setErr(e?.response?.data?.error ?? e.message); }
  };

  const mockFail = async () => {
    setErr(""); setOk("");
    if (!scanSessionId) { setErr("Provide a scan session id"); return; }
    try {
      const r = await api.post(`/admin/mock/complete-training/${scanSessionId}`, { success: false, errorMessage: "Simulated failure" });
      setOk(`Mocked training FAILED.  Retry window TTL: ${r.data.ttlHours}h.`);
      reload();
    } catch (e: any) { setErr(e?.response?.data?.error ?? e.message); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="font-semibold">Dev tool — simulate training completion</h3>
        <p className="text-sm text-white/60 mt-1">
          When <code className="px-1 py-0.5 bg-white/5 rounded">RUNPOD_ENDPOINT_ID</code> is unset,
          training jobs run in "mock" mode.  Use this to force a success or failure for E2E testing.
        </p>
        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <input className="input flex-1 font-mono text-xs" placeholder="scan_session_id"
                 value={scanSessionId} onChange={(e) => setScanSessionId(e.target.value)} />
          <button className="btn-primary" onClick={mockComplete}>✔ Mock success</button>
          <button className="btn-danger" onClick={mockFail}>✖ Mock failure</button>
        </div>
        {err && <div className="text-sm text-danger mt-2">{err}</div>}
        {ok && <div className="text-sm text-success mt-2">{ok}</div>}
      </div>
      <div className="text-xs text-white/50 border-t border-white/5 pt-4">
        Tip: view all scan sessions via the <Link className="underline" href="/scan">/scan page</Link> to get IDs.
      </div>
    </div>
  );
}

async function wipeMember(api: any, id: string, reload: () => void) {
  const reason = window.prompt("Reason for wiping this member? (recorded permanently in audit log)");
  if (!reason) return;
  try { await api.post(`/admin/members/${id}/wipe`, { reason }); reload(); }
  catch (e: any) { alert(e?.response?.data?.error ?? "Failed"); }
}

function AdminTable({ cols, rows, empty }: { cols: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm min-w-[720px]">
        <thead className="bg-white/[0.03] text-white/60 text-xs uppercase">
          <tr>{cols.map((c, i) => (
            <th key={i} className={`px-3 py-2 font-medium ${i === cols.length - 1 ? "text-right" : "text-left"}`}>{c}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols.length} className="px-3 py-10 text-center text-white/40">{empty}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5 hover:bg-white/[0.02]">
              {r.map((c, j) => (
                <td key={j} className={`px-3 py-2.5 align-top ${j === r.length - 1 ? "text-right" : ""}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
