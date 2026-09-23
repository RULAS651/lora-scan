"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { AngleKey } from "./AngleGuide";
import AngleGuide from "./AngleGuide";

export interface CaptureResult {
  /** JPEG bytes, ready for upload */
  bytes: Blob;
  /** data URL for local preview */
  previewUrl: string;
  width: number;
  height: number;
}

export interface FaceQuality {
  ok: boolean;
  issue?: "no-face" | "multiple-faces" | "eyes-closed" | "dim" | "bad-angle" | "too-far" | "too-close";
  detail?: string;
}

interface Props {
  angle: AngleKey;
  onCapture: (res: CaptureResult) => void;
  /** When not null, this is the error message shown for the current frame quality check */
  qualityHint?: FaceQuality | null;
  /** Called every time the quality changes (used by parent to decide if capture allowed) */
  onQualityChange?: (q: FaceQuality) => void;
  disabled?: boolean;
}

/**
 * Webcam-based face capture with optional MediaPipe quality gate.
 * Designed so MediaPipe is loaded asynchronously and never required
 * (falls back to "always ok" so users on weird devices can still upload).
 */
export default function FaceScanner({ angle, onCapture, onQualityChange, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [ready, setReady] = useState(false);
  const [webcamErr, setWebcamErr] = useState<string | null>(null);
  const [useUploadFallback, setUseUploadFallback] = useState(false);
  const [quality, setQuality] = useState<FaceQuality>({ ok: false, issue: "no-face", detail: "Warming up…" });
  const [preview, setPreview] = useState<string | null>(null);
  const mpRef = useRef<{ face: any; detector: any } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => { onQualityChange?.(quality); /* eslint-disable-next-line */ }, [quality.ok, quality.issue]);

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

    // Lazy-load MediaPipe (optional — a quality helper, never required)
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
        mpRef.current = { detector };
      } catch (e) {
        console.warn("[FaceScanner] MediaPipe unavailable, quality gate disabled.", e);
        // Mark as "always ok" so the capture button is enabled
        setQuality({ ok: true });
      }
    })();

    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // --- Quality-check loop ---------------------------------------------
  useEffect(() => {
    if (!ready || useUploadFallback) return;
    let last = performance.now();

    const tick = () => {
      const now = performance.now();
      const v = videoRef.current;
      if (v && v.readyState >= 2 && mpRef.current) {
        if (now - last > 250) {
          try {
            const r = mpRef.current.detector.detectForVideo(v, now);
            const faces = r?.detections ?? [];
            setQuality(evaluate(faces, v));
          } catch {}
          last = now;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [ready, useUploadFallback]);

  // --- File fallback handler ------------------------------------------
  const handleFile = async (file: File) => {
    const img = await fileToImage(file);
    const { blob, url, w, h } = await drawAndEncode(img, img.naturalWidth, img.naturalHeight);
    setPreview(url);
    onCapture({ bytes: blob, previewUrl: url, width: w, height: h });
  };

  // --- Capture from webcam --------------------------------------------
  const capture = useCallback(async () => {
    if (disabled) return;
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    const { blob, url } = await drawAndEncode(v, w, h);
    setPreview(url);
    onCapture({ bytes: blob, previewUrl: url, width: w, height: h });
  }, [disabled, onCapture]);

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
            {quality.ok ? (
              <span className="badge badge-success">Looks good — ready to capture</span>
            ) : quality.issue ? (
              <span className="badge badge-warn">{issueText(quality)}</span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setUseUploadFallback(true)}>Use file upload</button>
            <button
              className="btn-primary"
              disabled={disabled || !ready || !quality.ok}
              onClick={capture}
            >Capture this angle</button>
          </div>
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

function issueText(q: FaceQuality) {
  switch (q.issue) {
    case "no-face":         return "No face detected — center your face in the oval";
    case "multiple-faces":  return "Multiple faces — make sure only you are in frame";
    case "eyes-closed":     return "Please keep your eyes open";
    case "dim":             return "Lighting is too dim — turn on a light";
    case "bad-angle":       return "Adjust your pose to match the guide";
    case "too-far":         return "Move closer to the camera";
    case "too-close":       return "Move a bit further away";
    default:                return q.detail ?? "Adjust position…";
  }
}

function evaluate(faces: any[], v: HTMLVideoElement): FaceQuality {
  if (faces.length === 0) return { ok: false, issue: "no-face" };
  if (faces.length > 1) return { ok: false, issue: "multiple-faces" };
  const f = faces[0];
  const box = f.boundingBox;
  if (!box) return { ok: true };
  const rel = box.width / v.videoWidth;
  if (rel < 0.2) return { ok: false, issue: "too-far" };
  if (rel > 0.7) return { ok: false, issue: "too-close" };

  // Keypoint-based lighting check via video canvas is expensive; skip by default.
  return { ok: true };
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
