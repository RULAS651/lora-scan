"use client";

export default function PrivacyNotice({ compact = false }: { compact?: boolean }) {
  const lines = [
    "🔒 Your face photos are AES-256-GCM encrypted with a per-member derived key before storage.",
    "⏰ Raw scans auto-delete 24h after successful training (72h if training fails).",
    "🚫 No other member can read your data.  Admins can force-delete only (audit-logged with reason).",
    "🧹 One-click 'Wipe Account' cascades: LoRA blobs → scan images → account records.",
    "📜 Append-only audit log tracks every access: upload, download, delete, revoke.",
  ];
  return (
    <div className="card !p-4 border-brand-500/30 bg-brand-900/10">
      <div className="flex items-center gap-2 font-semibold text-sm">
        <span>🛡️</span>
        <span>Privacy summary — how your data is handled</span>
      </div>
      <ul className={`mt-2 space-y-1 text-xs text-white/70 ${compact ? "" : "list-disc pl-5"}`}>
        {lines.slice(0, compact ? 2 : undefined).map((l) => (
          <li key={l}>{compact ? l.replace("🔒 ", "").replace("⏰ ", "") : l}</li>
        ))}
      </ul>
    </div>
  );
}
