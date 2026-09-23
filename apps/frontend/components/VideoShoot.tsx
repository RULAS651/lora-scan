"use client";

import React, { useCallback, useRef, useState } from "react";
import { VIDEO_GUIDANCE, type PhotoVerdict, type SetVerdict } from "@lora-scan/face-qc";
import api from "@/lib/api";

export interface VideoScanSummary {
  extracted: number;
  fps: number;
  usable: number;
  would_keep?: number;
  stored?: number;
  summary: SetVerdict;
  frames?: { index: number; verdict: PhotoVerdict }[];
  images?: { id: string; index: number; verdict: PhotoVerdict }[];
}

interface Props {
  sessionId: string;
  /** How many frames to keep from the clip. */
  keep?: number;
  onImported?: (result: VideoScanSummary) => void;
}

/**
 * The video shoot: record one slow turn, let the scanner pull the frames.
 *
 * This is the shortest path to a varied training set. Asking someone for 25
 * deliberate photos across five angle groups loses most of them partway
 * through; asking for one 20-second turn does not.
 *
 * Every extracted frame is checked by the server with the same framing rules an
 * uploaded photo faces — coming from a video buys no leniency. The dry run
 * below exists so the cost of finding that out is a preview rather than a
 * training run.
 */
export default function VideoShoot({ sessionId, keep = 20, onImported }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<false | "checking" | "importing">(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoScanSummary | null>(null);
  const [imported, setImported] = useState(false);

  const send = useCallback(
    async (dryRun: boolean) => {
      if (!file) return;
      setBusy(dryRun ? "checking" : "importing");
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("keep", String(keep));
        fd.append("dryRun", String(dryRun));
        const r = await api.post<VideoScanSummary>(`/scan/sessions/${sessionId}/video`, fd, {
          // Frame extraction plus a face check per frame; the default axios
          // timeout gives up long before a real clip finishes.
          timeout: 10 * 60 * 1000,
        });
        setResult(r.data);
        if (!dryRun) {
          setImported(true);
          onImported?.(r.data);
        }
      } catch (e: any) {
        setError(e?.response?.data?.message ?? e?.response?.data?.error ?? e.message);
      } finally {
        setBusy(false);
      }
    },
    [file, keep, sessionId, onImported],
  );

  return (
    <div className="card">
      <h3 className="text-lg font-semibold">{VIDEO_GUIDANCE.headline}</h3>
      <p className="text-sm text-white/70 mt-1">{VIDEO_GUIDANCE.intro}</p>

      <ul className="mt-4 space-y-2">
        {VIDEO_GUIDANCE.rules.map((r) => (
          <li key={r.id} className="text-sm">
            <span className="font-medium">{r.title}</span>
            <span className="block text-white/60">{r.body}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setResult(null);
            setImported(false);
            setError(null);
          }}
        />
        <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          {file ? "Choose a different clip" : "Choose a clip"}
        </button>

        {file && (
          <>
            <span className="text-sm text-white/60">
              {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
            </span>
            <button className="btn-ghost" onClick={() => send(true)} disabled={!!busy}>
              {busy === "checking" ? "Checking…" : "Preview frames"}
            </button>
            <button className="btn-primary" onClick={() => send(false)} disabled={!!busy || imported}>
              {busy === "importing" ? "Importing…" : imported ? "Imported" : `Import best ${keep}`}
            </button>
          </>
        )}
      </div>

      {busy && (
        <p className="mt-3 text-sm text-white/60">
          Pulling frames and checking each one. A long clip can take a few minutes.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {result && (
        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-sm">
            <b>{result.extracted}</b> frames pulled at {result.fps}/s ·{" "}
            <b>{result.usable}</b> usable
            {result.stored != null && <> · <b>{result.stored}</b> added to the set</>}
            {result.would_keep != null && <> · would add <b>{result.would_keep}</b></>}
          </p>

          <p className={`mt-2 text-sm ${result.summary.ready ? "text-emerald-400" : "text-amber-400"}`}>
            {result.summary.ready
              ? "This clip alone carries enough usable face data to train."
              : `Not enough on its own — ${result.summary.usable}/${result.summary.minUsable} usable.`}
          </p>

          {result.summary.advice.map((a, i) => (
            <p key={i} className="mt-2 text-sm text-white/60">{a}</p>
          ))}

          {result.frames && <Filmstrip frames={result.frames} />}
        </div>
      )}
    </div>
  );
}

/**
 * Why frames failed, grouped.
 *
 * A per-frame list of 60 rows is unreadable and, worse, unactionable: the user
 * needs "38 of these were too tight, back up" — one fix — not 38 separate
 * complaints.
 */
function Filmstrip({ frames }: { frames: { index: number; verdict: PhotoVerdict }[] }) {
  const failed = frames.filter((f) => !f.verdict.ok);
  if (failed.length === 0) return null;

  const grouped = new Map<string, number>();
  for (const f of failed) {
    const reason = f.verdict.reasons[0] ?? "unusable";
    grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
  }

  return (
    <div className="mt-4">
      <p className="text-sm font-medium">{failed.length} frames were not usable:</p>
      <ul className="mt-2 space-y-1">
        {[...grouped.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => (
            <li key={reason} className="text-sm text-white/60">
              <b>{n}×</b> {reason}
            </li>
          ))}
      </ul>
      <p className="mt-2 text-xs text-white/40">
        Unusable frames from a turn are normal — the back and profile parts of the circle have no
        face to find. They still teach build and hair.
      </p>
    </div>
  );
}
