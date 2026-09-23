"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PHOTO_GUIDANCE, type PhotoVerdict } from "@lora-scan/face-qc";
import { useAuth } from "@/lib/auth";
import FaceScanner, { type CaptureResult } from "@/components/FaceScanner";
import VideoShoot from "@/components/VideoShoot";
import { useScanSession, type Slot } from "@/lib/hooks/useScanSession";
import PrivacyNotice from "@/components/PrivacyNotice";

type Mode = "photo" | "video";

export default function ScanWizardPage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const {
    session, busy, error, lastVerdict, readiness, progress,
    start, uploadAngle, finalize, refreshReadiness, slots, missingSlots,
  } = useScanSession();

  const [mode, setMode] = useState<Mode>("photo");
  const [stepIdx, setStepIdx] = useState(0);
  const [deIdentify, setDeIdentify] = useState(false);
  const [captured, setCaptured] = useState<Record<number, CaptureResult>>({});
  const [pending, setPending] = useState<{ slot: Slot; capture: CaptureResult; verdict: PhotoVerdict } | null>(null);
  const [trainingOpts, setTrainingOpts] = useState({ steps: 2000, rank: 16, learningRate: 0.0001 });
  const [finalizing, setFinalizing] = useState(false);
  const [notReady, setNotReady] = useState<{ usable: number; minUsable: number } | null>(null);
  const [done, setDone] = useState<{ loraId: string; mock?: boolean } | null>(null);

  const slot = slots[stepIdx];

  useEffect(() => {
    if (loading) return;
    if (!me) { router.replace("/login"); return; }
    if (!session) start().catch(() => {});
  }, [loading, me, router, session, start]);

  // Readiness is the server's answer, so it is re-read after anything that
  // changes the set rather than guessed from local state.
  useEffect(() => {
    if (session) refreshReadiness();
  }, [session, refreshReadiness]);

  const send = useCallback(
    async (s: Slot, capture: CaptureResult, acceptAnyway = false) => {
      try {
        await uploadAngle(s.angle, capture, deIdentify, {
          distance: s.distance,
          acceptAnyway,
        });
        setCaptured((c) => ({ ...c, [stepIdx]: capture }));
        setPending(null);
        await refreshReadiness();
        // Advance to the next slot that has nothing in it.
        const next = slots.findIndex((x, i) => i > stepIdx && missingSlots.includes(x));
        if (next >= 0) setStepIdx(next);
        else if (stepIdx < slots.length - 1) setStepIdx(stepIdx + 1);
      } catch (e: any) {
        // 422: the server refused the framing. Hold it so the user can see why
        // and decide, instead of losing the shot to a silent failure.
        if (e?.verdict) setPending({ slot: s, capture, verdict: e.verdict });
      }
    },
    [uploadAngle, deIdentify, stepIdx, slots, missingSlots, refreshReadiness],
  );

  async function handleFinalize(force = false) {
    setFinalizing(true);
    setNotReady(null);
    try {
      const r = await finalize({ ...trainingOpts, force });
      setDone({ loraId: r.loraId, mock: r.mock });
    } catch (e: any) {
      if (e?.notReady) setNotReady({ usable: e.usable, minUsable: e.minUsable });
    } finally { setFinalizing(false); }
  }

  if (loading || !session) {
    return (
      <div className="max-w-3xl mx-auto mt-10 card">
        <p className="text-white/70">Setting up your private scan session…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="max-w-3xl mx-auto mt-10 space-y-5">
        <div className="card border-success/30 bg-success/5">
          <h1 className="text-2xl font-semibold">🎉 Training submitted!</h1>
          <p className="text-white/80 mt-2">
            Your LoRA is queued for training. Your raw face scans are AES-256 encrypted
            and scheduled for auto-deletion in 24 hours after training completes.
          </p>
          {done.mock && (
            <p className="badge badge-warn mt-3">
              Mock mode — no RunPod credentials provided. Use the Admin panel →
              &quot;Mock complete training&quot; to simulate a finished job for E2E testing.
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <Link className="btn-primary" href={`/lora/${done.loraId}`}>Go to my LoRA →</Link>
            <Link className="btn-ghost" href="/dashboard">Back to dashboard</Link>
          </div>
        </div>
        <PrivacyNotice />
      </div>
    );
  }

  const pct = Math.min(100, Math.round((progress.usable / Math.max(1, readiness?.summary.minUsable ?? 15)) * 100));

  return (
    <div className="max-w-5xl mx-auto mt-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Face Scan</h1>
        <span className="badge badge-info">Session {session.id.slice(0, 8)}…</span>
      </div>

      {/* Progress is measured in USABLE FACES, not frames taken. 25 photos that
          the detector cannot read are 25 photos that teach nothing, and a bar
          that fills up regardless is a bar that lies. */}
      <div className="card mb-6">
        <div className="flex items-center justify-between text-sm text-white/70 mb-2">
          <span>{progress.message}</span>
          <span>{progress.usable} usable · {progress.taken} taken</span>
        </div>
        <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all ${progress.ready ? "bg-success" : "bg-gradient-to-r from-brand-500 to-fuchsia-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          className={mode === "photo" ? "btn-primary" : "btn-ghost"}
          onClick={() => setMode("photo")}
        >Photo shoot</button>
        <button
          className={mode === "video" ? "btn-primary" : "btn-ghost"}
          onClick={() => setMode("video")}
        >Video shoot</button>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6">
          {mode === "video" ? (
            <VideoShoot sessionId={session.id} keep={20} onImported={() => refreshReadiness()} />
          ) : (
            <div className="card !p-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="font-semibold">
                  {stepIdx + 1} / {slots.length} · {slot.label}
                </h2>
                <div className="flex gap-2">
                  <button className="btn-ghost !py-1 text-xs" disabled={stepIdx === 0}
                          onClick={() => setStepIdx(Math.max(0, stepIdx - 1))}>← Prev</button>
                  <button className="btn-ghost !py-1 text-xs" disabled={stepIdx === slots.length - 1}
                          onClick={() => setStepIdx(Math.min(slots.length - 1, stepIdx + 1))}>Next →</button>
                </div>
              </div>
              <p className="text-sm text-white/60 mb-4">{slot.hint}</p>

              <FaceScanner
                angle={slot.angle}
                disabled={busy}
                faceExpected={slot.faceExpected}
                onCapture={(c) => send(slot, c)}
              />

              {/* The server refused this frame. Show the reason and let the user
                  keep it anyway — some rejections are a deliberate artistic
                  choice, and a dead end here just loses the shot. */}
              {pending && (
                <div className="mt-4 card !p-4 border-amber-500/40 bg-amber-500/5">
                  <p className="text-sm font-medium text-amber-300">
                    This frame was rejected: {pending.verdict.reasons[0]}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button className="btn-primary !py-1 text-xs" onClick={() => setPending(null)}>
                      Retake
                    </button>
                    <button
                      className="btn-ghost !py-1 text-xs"
                      onClick={() => send(pending.slot, pending.capture, true)}
                    >Keep it anyway</button>
                  </div>
                </div>
              )}

              {error && !pending && <div className="mt-3 text-sm text-danger">{error}</div>}
              {lastVerdict?.severity === "warn" && !pending && (
                <p className="mt-3 text-sm text-amber-300">{lastVerdict.reasons[0]}</p>
              )}

              <div className="mt-6 flex items-start gap-2 text-xs text-white/60">
                <input type="checkbox" className="mt-1" id="deid"
                       checked={deIdentify} onChange={(e) => setDeIdentify(e.target.checked)} />
                <label htmlFor="deid">
                  <b className="text-white/80">Enable face de-identification (experimental)</b><br />
                  Pixelates the face region before encryption. <em>May reduce LoRA quality —
                  recommended only if you are extremely privacy-sensitive.</em>
                </label>
              </div>
            </div>
          )}

          <div className="card !p-6">
            <h2 className="font-semibold">Train</h2>
            <p className="text-sm text-white/60 mt-1">
              {progress.ready
                ? "This set has enough usable face data to train."
                : `${progress.usable} usable so far. Training works best from about ${PHOTO_GUIDANCE.planTotal}.`}
            </p>

            <div className="grid sm:grid-cols-3 gap-3 mt-5">
              <div>
                <label className="label">Training Steps</label>
                <input className="input" type="number" min={200} max={20000} step={100}
                       value={trainingOpts.steps}
                       onChange={(e) => setTrainingOpts({ ...trainingOpts, steps: Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">LoRA Rank (dim)</label>
                <input className="input" type="number" min={4} max={64} step={1}
                       value={trainingOpts.rank}
                       onChange={(e) => setTrainingOpts({ ...trainingOpts, rank: Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">Learning Rate</label>
                <input className="input" type="number" step="0.00005" min="0.00001" max="0.01"
                       value={trainingOpts.learningRate}
                       onChange={(e) => setTrainingOpts({ ...trainingOpts, learningRate: Number(e.target.value) })} />
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button className="btn-primary" disabled={finalizing || busy}
                      onClick={() => handleFinalize(false)}>
                {finalizing ? "Submitting training job…" : "Submit for LoRA training →"}
              </button>
              {error && !notReady && <span className="text-sm text-danger">{error}</span>}
            </div>

            {notReady && (
              <div className="mt-4 card !p-4 border-amber-500/40 bg-amber-500/5">
                <p className="text-sm text-amber-300">
                  Only {notReady.usable} of your photos show a usable face; {notReady.minUsable} are
                  needed. Training on this set will most likely produce someone who does not look
                  like you.
                </p>
                <button className="btn-ghost !py-1 text-xs mt-3"
                        disabled={finalizing}
                        onClick={() => handleFinalize(true)}>Train anyway</button>
              </div>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="card !p-4">
            <h3 className="font-semibold text-sm mb-3">Shot plan</h3>
            <ol className="space-y-2">
              {(readiness?.coverage ?? []).map((g) => (
                <li key={g.id} className={`flex items-center justify-between text-sm ${g.done ? "text-white" : "text-white/50"}`}>
                  <span>{g.label}</span>
                  <span className={g.done ? "text-success" : ""}>{g.got}/{g.want}</span>
                </li>
              ))}
            </ol>
            {readiness?.summary.advice.map((a, i) => (
              <p key={i} className="text-xs text-white/50 mt-3">{a}</p>
            ))}
          </div>

          <div className="card !p-4">
            <h3 className="font-semibold text-sm mb-2">{PHOTO_GUIDANCE.headline}</h3>
            <ul className="space-y-2">
              {PHOTO_GUIDANCE.rules.map((r) => (
                <li key={r.id} className="text-xs">
                  <span className="font-medium text-white/80">{r.title}</span>
                  <span className="block text-white/50">{r.body}</span>
                </li>
              ))}
            </ul>
          </div>

          <PrivacyNotice />
        </aside>
      </div>

      {Object.keys(captured).length > 0 && (
        <div className="card !p-4 mt-6">
          <h3 className="font-semibold text-sm mb-3">Captured</h3>
          <div className="grid grid-cols-5 sm:grid-cols-8 gap-2">
            {Object.entries(captured).map(([i, c]) => (
              <img key={i} src={c.previewUrl} alt={`shot ${i}`}
                   className="aspect-square w-full rounded-lg object-cover border border-white/10" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
