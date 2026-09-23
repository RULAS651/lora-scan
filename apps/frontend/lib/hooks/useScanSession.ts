"use client";

import { useCallback, useMemo, useState } from "react";
import api from "@/lib/api";
import type { CaptureResult } from "@/components/FaceScanner";
import type { AngleKey } from "@/components/AngleGuide";

export type SessionStatus = "DRAFT" | "FINALIZED" | "TRAINING" | "COMPLETE" | "FAILED" | "PURGED" | "DELETED";

export interface ScanImage { id: string; angle: string; }
export interface ScanSession { id: string; triggerWord: string; status: SessionStatus; images: ScanImage[]; }

export interface FinalizeResult {
  loraId: string;
  jobId: string;
  runpodId?: string;
  status: string;
  mock?: boolean;
}

export const REQUIRED_ANGLES: AngleKey[] = ["FRONT", "ANGLE_45L", "ANGLE_45R", "PROFILE_L", "PROFILE_R"];

export function useScanSession() {
  const [session, setSession] = useState<ScanSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<ScanSession>("/scan/sessions");
      setSession({ ...r.data, images: [] });
      return r.data;
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
      throw e;
    } finally { setBusy(false); }
  }, []);

  const uploadAngle = useCallback(async (angle: AngleKey, capture: CaptureResult, deIdentify: boolean) => {
    if (!session) throw new Error("No scan session");
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("file", new File([capture.bytes], `${angle}.jpg`, { type: "image/jpeg" }));
      fd.append("angle", angle);
      fd.append("deIdentify", String(deIdentify));
      const r = await api.post<{ id: string; angle: string; size: number; deIdentified: boolean }>(
        `/scan/sessions/${session.id}/image`, fd,
      );
      setSession((s) => s ? { ...s, images: [...s.images, { id: r.data.id, angle: r.data.angle }] } : s);
      return r.data;
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
      throw e;
    } finally { setBusy(false); }
  }, [session]);

  const missingAngles = useMemo(() => {
    if (!session) return REQUIRED_ANGLES;
    const have = new Set(session.images.map((i) => i.angle));
    return REQUIRED_ANGLES.filter((a) => !have.has(a));
  }, [session]);

  const finalize = useCallback(async (opts?: { steps?: number; rank?: number; learningRate?: number }) => {
    if (!session) throw new Error("No scan session");
    setBusy(true); setError(null);
    try {
      const r = await api.post<FinalizeResult>(`/scan/sessions/${session.id}/finalize`, opts ?? {});
      return r.data;
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e.message);
      throw e;
    } finally { setBusy(false); }
  }, [session]);

  return { session, busy, error, start, uploadAngle, missingAngles, finalize, setSession };
}
