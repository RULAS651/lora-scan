"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import FaceScanner, { CaptureResult, FaceQuality } from "@/components/FaceScanner";
import { REQUIRED_ANGLES, useScanSession, type AngleKey } from "@/lib/hooks/useScanSession";
import PrivacyNotice from "@/components/PrivacyNotice";

const ANGLE_LABEL: Record<AngleKey, string> = {
  FRONT:     "1 · Front",
  ANGLE_45L: "2 · 45° Left",
  ANGLE_45R: "3 · 45° Right",
  PROFILE_L: "4 · Left Profile",
  PROFILE_R: "5 · Right Profile",
};

export default function ScanWizardPage() {
  const { me, loading } = useAuth();
  const router = useRouter();
  const { session, busy, error, start, uploadAngle, missingAngles, finalize } = useScanSession();
  const [stepIdx, setStepIdx] = useState(0);
  const [qualityOk, setQualityOk] = useState(false);
  const [deIdentify, setDeIdentify] = useState(false);
  const [captured, setCaptured] = useState<Partial<Record<AngleKey, CaptureResult>>>({});
  const [trainingOpts, setTrainingOpts] = useState({ steps: 2000, rank: 16, learningRate: 0.0001 });
  const [finalizing, setFinalizing] = useState(false);
  const [done, setDone] = useState<{ loraId: string; mock?: boolean } | null>(null);

  const currentAngle = REQUIRED_ANGLES[stepIdx];

  // Ensure a session exists after mount
  useEffect(() => {
    if (loading) return;
    if (!me) { router.replace("/login"); return; }
    if (!session) start().catch(() => {});
  }, [loading, me, router, session, start]);

  const remaining = missingAngles.length;
  const progress = useMemo(() => {
    const have = REQUIRED_ANGLES.length - remaining;
    return have / REQUIRED_ANGLES.length;
  }, [remaining]);

  async function onCapture(angle: AngleKey, capture: CaptureResult) {
    setCaptured((c) => ({ ...c, [angle]: capture }));
    try {
      await uploadAngle(angle, capture, deIdentify);
      // Move to the next still-missing angle, if any
      const nextMissing = REQUIRED_ANGLES.find((a, i) => i > stepIdx && missingAngles.includes(a));
      if (nextMissing) {
        setStepIdx(REQUIRED_ANGLES.indexOf(nextMissing));
      } else if (missingAngles.length === 1 && missingAngles[0] === angle) {
        // last one captured, will trigger finalize step via re-render
      }
    } catch {}
  }

  async function handleFinalize() {
    setFinalizing(true);
    try {
      const r = await finalize(trainingOpts);
      setDone({ loraId: r.loraId, mock: r.mock });
    } catch {}
    finally { setFinalizing(false); }
  }

  if (loading || !session) {
    return <div className="max-w-3xl mx-auto mt-10 card"><p className="text-white/70">Setting up your private scan session…</p></div>;
  }

  if (done) {
    return (
      <div className="max-w-3xl mx-auto mt-10 space-y-5">
        <div className="card border-success/30 bg-success/5">
          <h1 className="text-2xl font-semibold">🎉 Training submitted!</h1>
          <p className="text-white/80 mt-2">
            Your LoRA is queued for training.  Your raw face scans are AES-256 encrypted
            and scheduled for auto-deletion in 24 hours after training completes.
          </p>
          {done.mock && (
            <p className="badge badge-warn mt-3">
              Mock mode — no RunPod credentials provided.  Use the Admin panel →
              "Mock complete training" to simulate a finished job for E2E testing.
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

  const allCaptured = remaining === 0;

  return (
    <div className="max-w-5xl mx-auto mt-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Face Scan Wizard</h1>
        <span className="badge badge-info">Session {session.id.slice(0, 8)}…</span>
      </div>

      <div className="card mb-6">
        <div className="flex items-center justify-between text-sm text-white/70 mb-2">
          <span>Progress</span>
          <span>{REQUIRED_ANGLES.length - remaining} / {REQUIRED_ANGLES.length} angles</span>
        </div>
        <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-brand-500 to-fuchsia-500 transition-all"
               style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="card !p-6">
          {!allCaptured ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold">{ANGLE_LABEL[currentAngle]}</h2>
                <div className="flex gap-2">
                  <button className="btn-ghost !py-1 text-xs"
                          disabled={stepIdx === 0}
                          onClick={() => setStepIdx(Math.max(0, stepIdx - 1))}>← Prev</button>
                  <button className="btn-ghost !py-1 text-xs"
                          disabled={stepIdx === REQUIRED_ANGLES.length - 1}
                          onClick={() => setStepIdx(Math.min(REQUIRED_ANGLES.length - 1, stepIdx + 1))}>Next →</button>
                </div>
              </div>

              <FaceScanner
                angle={currentAngle}
                disabled={busy}
                onQualityChange={(q: FaceQuality) => setQualityOk(q.ok)}
                onCapture={(c) => onCapture(currentAngle, c)}
              />
              {error && <div className="mt-3 text-sm text-danger">{error}</div>}

              <div className="mt-6 flex items-start gap-2 text-xs text-white/60">
                <input type="checkbox" className="mt-1" id="deid"
                       checked={deIdentify} onChange={(e) => setDeIdentify(e.target.checked)} />
                <label htmlFor="deid">
                  <b className="text-white/80">Enable face de-identification (experimental)</b><br />
                  Pixelates the face region before encryption.  <em>May reduce LoRA quality —
                  recommended only if you are extremely privacy-sensitive.</em>
                </label>
              </div>
            </>
          ) : (
            <div>
              <h2 className="text-xl font-semibold">All angles captured!</h2>
              <p className="text-white/70 mt-1">
                Review training options, then submit for training.
              </p>

              <div className="grid grid-cols-5 gap-2 mt-5">
                {REQUIRED_ANGLES.map((a) => (
                  <div key={a} className="aspect-square rounded-lg overflow-hidden border border-white/10 bg-white/5">
                    {captured[a] ? (
                      <img src={captured[a]!.previewUrl} alt={a} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-white/40 text-xs">
                        {a}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="grid sm:grid-cols-3 gap-3 mt-6">
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
                <button className="btn-primary" disabled={finalizing || busy} onClick={handleFinalize}>
                  {finalizing ? "Submitting training job…" : "Submit for LoRA training →"}
                </button>
                {error && <span className="text-sm text-danger">{error}</span>}
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="card !p-4">
            <h3 className="font-semibold text-sm mb-3">Captured so far</h3>
            <ol className="space-y-2">
              {REQUIRED_ANGLES.map((a, i) => {
                const have = !missingAngles.includes(a);
                return (
                  <li key={a} className={`flex items-center justify-between text-sm ${have ? "text-white" : "text-white/50"}`}>
                    <button className="flex items-center gap-2 hover:text-white" onClick={() => setStepIdx(i)}>
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px]
                        ${have ? "bg-success text-black font-bold" : "border border-white/20"}`}>
                        {have ? "✓" : i + 1}
                      </span>
                      {ANGLE_LABEL[a]}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          <PrivacyNotice />
        </aside>
      </div>
    </div>
  );
}
