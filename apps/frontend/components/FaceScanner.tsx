"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { checkFrame, DEFAULT_THRESHOLDS, type PhotoVerdict } from "@lora-scan/face-qc";
import type { AngleKey } from "./AngleGuide";
import AngleGuide from "./AngleGuide";

export interface CaptureResult {
  /** JPEG bytes, ready for upload */
  bytes: Blob;
  /** data URL for local preview */
  previewUrl: string;
  width: number;
  height: number;
  /** What the local check thought. The server still decides. */
  verdict?: PhotoVerdict;
}

interface Props {
  angle: AngleKey;
  onCapture: (res: CaptureResult) => void;
  /** Called every time the live verdict changes, so a parent can gate its own UI. */
  onQualityChange?: (v: PhotoVerdict) => void;
  disabled?: boolean;
  /**
   * Set false for angles a frontal detector cannot read (true profiles, backs,
   * distant full-body). Those frames are wanted in the set — the shot plan asks
   * for them — so the capture button must not be held hostage to a detector
   * that was never going to find a face in them.
   */
  faceExpected?: boolean;
}

/**
 * Webcam capture with a live framing check.
 *
 * THE CHECK HERE IS ADVISORY. It exists to give feedback while someone is still
 * standing in front of the camera, and it is deliberately the same RULES as the
 * server (imported from @lora-scan/face-qc) but NOT the same detector: this runs
 * MediaPipe BlazeFace in the browser, while training runs InsightFace. A frame
 * can satisfy BlazeFace and still yield no embedding at training time, so the
 * server re-checks everything on upload and its answer is the one that counts.
 *
 * Sharing the rules module is what keeps the two honest. The previous version of
 * this component had its own thresholds — a LINEAR box-width ratio capped at 0.7
 * — while the server judged face AREA against 0.45 and also required a clear
 * margin at every edge. A face at 0.7 width scores about 0.49 area, so the
 * camera said "Looks good — ready to capture" for framing the server then
 * rejected, and cropped-at-the-edge shots sailed through with no check at all.
 */
export default function FaceScanner({
  angle,
  onCapture,
  onQualityChange,
  disabled,
  faceExpected = true,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [ready, setReady] = useState(false);
  const [webcamErr, setWebcamErr] = useState<string | null>(null);
  const [useUploadFallback, setUseUploadFallback] = useState(false);
  const [verdict, setVerdict] = useState<PhotoVerdict>({
    file: "live",
    ok: true,
    severity: "unknown",
    width: 0,
    height: 0,
    reasons: ["Warming up…"],
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [fileVerdict, setFileVerdict] = useState<PhotoVerdict | null>(null);
  const detectorRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    onQualityChange?.(verdict);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdict.severity, verdict.reasons[0]]);

  // --- Start webcam + async load MediaPipe -----------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setReady(true);
      } catch (e: any) {
        setWebcamErr(e?.message ?? "Webcam access denied");
        setUseUploadFallback(true);
      }
    })();

    // Lazy-load MediaPipe — a feedback helper, never a requirement.
    (async () => {
      try {
        const { FilesetResolver, FaceDetector } = await import(
          /* webpackChunkName: "mediapipe" */ "@mediapipe/tasks-vision"
        );
        const wasmBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm`;
        const vision = await FilesetResolver.forVisionTasks(wasmBase);
        const detector = await FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`,
            delegate: "GPU",
          },
          runningMode: "VIDEO",
        });
        if (cancelled) return;
        detectorRef.current = detector;
      } catch (e) {
        console.warn("[FaceScanner] MediaPipe unavailable — live framing check disabled.", e);
        // `unknown`, not `ok`: the capture button unblocks (below), but the UI
        // says the framing was not checked rather than claiming it passed.
        setVerdict({
          file: "live", ok: true, severity: "unknown", width: 0, height: 0,
          reasons: ["Live check unavailable — your photo is still checked on upload."],
        });
      }
    })();

    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try { detectorRef.current?.close?.(); } catch { /* already gone */ }
    };
  }, []);

  // --- Live check loop --------------------------------------------------
  useEffect(() => {
    if (!ready || useUploadFallback) return;
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const v = videoRef.current;
      if (v && v.readyState >= 2 && detectorRef.current && now - last > 250) {
        try {
          const r = detectorRef.current.detectForVideo(v, now);
          setVerdict(evaluateLive(r?.detections ?? [], v));
        } catch { /* a dropped frame is not worth reporting */ }
        last = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [ready, useUploadFallback]);

  // --- File fallback ----------------------------------------------------
  // Checked with the same rules as the live view. Previously this path ran no
  // check at all, which meant the easiest way to submit an unusable photo was
  // to click "Use file upload".
  const handleFile = async (file: File) => {
    const img = await fileToImage(file);
    const { blob, url, w, h } = await drawAndEncode(img, img.naturalWidth, img.naturalHeight);
    const v = await evaluateStill(img, file.name, w, h);
    setFileVerdict(v);
    setPreview(url);
    onCapture({ bytes: blob, previewUrl: url, width: w, height: h, verdict: v });
  };

  // --- Capture from webcam ----------------------------------------------
  const capture = useCallback(async () => {
    if (disabled) return;
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const { blob, url } = await drawAndEncode(v, w, h);
    setPreview(url);
    onCapture({ bytes: blob, previewUrl: url, width: w, height: h, verdict: verdict });
  }, [disabled, onCapture, verdict]);

  // A hard reject blocks capture only where a face was actually expected.
  const blocked = faceExpected && verdict.severity === "reject";

  return (
    <div className="w-full">
      <div className="relative aspect-square w-full max-w-[480px] mx-auto rounded-2xl overflow-hidden border border-white/10 bg-black">
        {!useUploadFallback ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-full object-cover -scale-x-100"
            />
            <canvas ref={canvasRef} className="hidden" />
            <AngleGuide angle={angle} size={480} />
            {!ready && !webcamErr && (
              <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">
                Starting camera…
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <div className="text-3xl mb-3">📷</div>
            <p className="text-sm text-white/70">
              {webcamErr ? `Webcam unavailable (${webcamErr}). ` : ""}
              Upload a photo for this angle instead.
            </p>
            <button
              className="btn-ghost mt-4"
              onClick={() => fileInputRef.current?.click()}
            >Choose file (JPEG or PNG)</button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
          </div>
        )}
      </div>

      {!useUploadFallback && (
        <div className="mt-4 flex flex-col sm:flex-row items-center gap-3">
          <div className="flex-1 text-sm min-h-[2.2rem]">
            <VerdictBadge verdict={verdict} faceExpected={faceExpected} />
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setUseUploadFallback(true)}>Use file upload</button>
            <button
              className="btn-primary"
              disabled={disabled || !ready || blocked}
              onClick={capture}
            >Capture this angle</button>
          </div>
        </div>
      )}

      {fileVerdict && useUploadFallback && (
        <div className="mt-4 text-sm">
          <VerdictBadge verdict={fileVerdict} faceExpected={faceExpected} />
        </div>
      )}

      {preview && (
        <div className="mt-4 card !p-3 flex items-center gap-3">
          <img src={preview} alt="preview" className="w-20 h-20 rounded-lg object-cover border border-white/10" />
          <div className="text-sm text-white/70 flex-1">
            Preview captured. Click <b>Next</b> below to continue, or capture again to replace.
          </div>
        </div>
      )}
    </div>
  );
}

function VerdictBadge({ verdict, faceExpected }: { verdict: PhotoVerdict; faceExpected: boolean }) {
  if (verdict.severity === "ok") {
    return <span className="badge badge-success">Looks good — ready to capture</span>;
  }
  if (verdict.severity === "unknown") {
    return <span className="badge">{verdict.reasons[0]}</span>;
  }
  // On an angle where no face is expected, a "reject" is the detector doing
  // exactly what it should on a profile or a back. Saying "rejected" there
  // teaches the user to distrust a shot the plan asked them for.
  if (verdict.severity === "reject" && !faceExpected) {
    return <span className="badge">No face in frame — expected for this angle</span>;
  }
  return (
    <span className={verdict.severity === "reject" ? "badge badge-warn" : "badge"}>
      {verdict.reasons[0]}
    </span>
  );
}

/** MediaPipe detections -> the shared rules. */
function evaluateLive(detections: any[], v: HTMLVideoElement): PhotoVerdict {
  const w = v.videoWidth;
  const h = v.videoHeight;
  return checkFrame(
    {
      file: "live",
      width: w,
      height: h,
      faces: detections.map((d) => {
        const b = d.boundingBox ?? {};
        // MediaPipe reports originX/originY plus width/height, in pixels.
        const x1 = b.originX ?? 0;
        const y1 = b.originY ?? 0;
        return { x1, y1, x2: x1 + (b.width ?? 0), y2: y1 + (b.height ?? 0) };
      }),
    },
    // The live view is a preview, not the stored frame: skip the minimum-size
    // rule so a 720p webcam is not permanently scolded for a rule the uploaded
    // JPEG will satisfy anyway.
    { ...DEFAULT_THRESHOLDS, minDimension: 0 },
  );
}

/**
 * One-shot check of a still, used for the file-upload path.
 * Loads its own detector in IMAGE mode; falls back to `unknown` if unavailable.
 */
async function evaluateStill(
  img: HTMLImageElement,
  name: string,
  w: number,
  h: number,
): Promise<PhotoVerdict> {
  try {
    const { FilesetResolver, FaceDetector } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    );
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "GPU",
      },
      runningMode: "IMAGE",
    });
    const r = detector.detect(img);
    const faces = (r?.detections ?? []).map((d: any) => {
      const b = d.boundingBox ?? {};
      const x1 = b.originX ?? 0;
      const y1 = b.originY ?? 0;
      return { x1, y1, x2: x1 + (b.width ?? 0), y2: y1 + (b.height ?? 0) };
    });
    detector.close();
    return checkFrame({ file: name, width: w, height: h, faces });
  } catch {
    // No `faces` key at all -> the shared rules return `unknown`, which is the
    // truth: this photo has not been checked yet, and the server will do it.
    return checkFrame({ file: name, width: w, height: h });
  }
}

function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't load image")); };
    img.src = url;
  });
}

async function drawAndEncode(source: HTMLVideoElement | HTMLImageElement, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  if ((source as HTMLVideoElement).videoWidth !== undefined) {
    // mirror selfie
    ctx.translate(w, 0); ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0, w, h);
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92)
  );
  const url = canvas.toDataURL("image/jpeg", 0.8);
  return { blob, url, w, h };
}
